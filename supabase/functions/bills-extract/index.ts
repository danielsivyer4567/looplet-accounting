/**
 * bills-extract — runs OCR on an uploaded bill, writes extracted data to the
 * `bills` row, and returns the structured result.
 *
 * **Once-off OCR per file:** computes SHA-256 of the file bytes and looks up
 * any prior bill in the same organization with the same hash and a real
 * extraction. If found, copies the extraction onto the current bill and
 * skips the OCR call entirely. Saves cost + latency on re-uploads of the
 * same supplier statement / invoice / receipt.
 *
 * Trigger: invoked from frontend after a bill upload. Async; the bill row
 * status transitions: received → verified (during cache check) →
 * verified (with extraction) on success.
 *
 * Auth: requires the user's JWT; RLS does the org-scoping when we read/write
 * `bills`.
 *
 * Input:  { bill_id: UUID }
 * Output: { ok: true, extracted: { ... }, cache_hit: boolean, provider?: string }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { extractBillData } from '../_shared/ocr/index.ts';

interface RequestBody {
  bill_id: string;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ ok: false, error: 'Unauthorized' }, 401);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!supabaseUrl || !serviceKey || !anonKey) {
      return json({ ok: false, error: 'Server config missing' }, 500);
    }

    // Service-role client for storage + cross-row writes (RLS bypassed; we
    // MUST scope manually by the caller's accessible orgs).
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // User-scoped client for the initial bill read (RLS enforced).
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
      error: userErr,
    } = await userClient.auth.getUser();
    if (userErr || !user) return json({ ok: false, error: 'Invalid token' }, 401);

    const body = (await req.json()) as RequestBody;
    if (!body.bill_id) return json({ ok: false, error: 'bill_id required' }, 400);

    // Read the bill — RLS ensures the caller is in the right org.
    const { data: bill, error: billErr } = await userClient
      .from('bills')
      .select('id, organization_id, storage_key, mime_type, status, content_sha256')
      .eq('id', body.bill_id)
      .single();
    if (billErr || !bill) return json({ ok: false, error: 'Bill not found' }, 404);

    // Move to verifying state.
    await admin
      .from('bills')
      .update({ status: 'verified', updated_at: new Date().toISOString() })
      .eq('id', bill.id);

    // Pull file bytes from storage.
    const { data: fileBlob, error: storageErr } = await admin.storage
      .from('bills')
      .download(bill.storage_key);
    if (storageErr || !fileBlob) {
      return json({ ok: false, error: `Storage read failed: ${storageErr?.message}` }, 500);
    }
    const bytes = new Uint8Array(await fileBlob.arrayBuffer());

    // Compute SHA-256 of bytes (hex, lowercase, 64 chars).
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    const contentSha256 = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    // Cache lookup: any prior bill in this org with the same content hash
    // and a real extraction → copy it. Strict org scope; never cross-tenant.
    const { data: cacheRow } = await admin
      .from('bills')
      .select(
        'supplier_name_raw, supplier_abn, invoice_number, invoice_date, due_date, total_inc_gst_cents, gst_cents, subtotal_ex_gst_cents, currency_code, job_reference_raw, notes, raw_extracted, ocr_provider, ocr_confidence',
      )
      .eq('organization_id', bill.organization_id)
      .eq('content_sha256', contentSha256)
      .neq('id', bill.id)
      .is('deleted_at', null)
      .not('raw_extracted', 'is', null)
      .limit(1)
      .maybeSingle();

    if (cacheRow) {
      // Cache hit. Copy fields, set the hash on this row, return.
      const { error: copyErr } = await admin
        .from('bills')
        .update({
          ...cacheRow,
          content_sha256: contentSha256,
          updated_at: new Date().toISOString(),
        })
        .eq('id', bill.id);
      if (copyErr) {
        return json({ ok: false, error: `Cache copy failed: ${copyErr.message}` }, 500);
      }
      return json({
        ok: true,
        cache_hit: true,
        provider: cacheRow.ocr_provider,
        extracted: cacheRow.raw_extracted,
      });
    }

    // Cache miss — run OCR.
    const { data: extracted, raw, provider } = await extractBillData(bytes, bill.mime_type);

    const { error: updateErr } = await admin
      .from('bills')
      .update({
        content_sha256: contentSha256,
        supplier_name_raw: extracted.supplier_name,
        supplier_abn: extracted.supplier_abn,
        invoice_number: extracted.invoice_number,
        invoice_date: extracted.invoice_date,
        due_date: extracted.due_date,
        total_inc_gst_cents:
          extracted.total_inc_gst != null ? Math.round(extracted.total_inc_gst * 100) : null,
        gst_cents: extracted.gst_amount != null ? Math.round(extracted.gst_amount * 100) : null,
        subtotal_ex_gst_cents:
          extracted.subtotal_ex_gst != null ? Math.round(extracted.subtotal_ex_gst * 100) : null,
        currency_code: extracted.currency || 'AUD',
        job_reference_raw: extracted.job_reference,
        notes: extracted.notes || null,
        raw_extracted: extracted,
        ocr_provider: provider,
        ocr_confidence:
          extracted.confidence === 'high' ? 0.9 : extracted.confidence === 'low' ? 0.4 : 0.7,
        updated_at: new Date().toISOString(),
      })
      .eq('id', bill.id);
    if (updateErr) return json({ ok: false, error: `DB write failed: ${updateErr.message}` }, 500);

    return json({
      ok: true,
      cache_hit: false,
      provider,
      extracted,
      raw_length: raw.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
