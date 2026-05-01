/**
 * bills-extract — runs OCR on an uploaded bill, writes extracted data to the
 * `bills` row, and returns the structured result.
 *
 * Trigger: invoked from frontend after a bill upload. Async, polled or
 * subscribed-to via Supabase Realtime on the bills row.
 *
 * Auth: requires the user's JWT; RLS does the org-scoping automatically when
 * we read/write `bills`.
 *
 * Input:  { bill_id: UUID }
 * Output: { ok: true, extracted: { ... } } or { ok: false, error: '...' }
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
    if (!supabaseUrl || !serviceKey) {
      return json({ ok: false, error: 'Server config missing' }, 500);
    }

    // Service-role client for storage + cross-row writes.
    // RLS is bypassed; we MUST scope manually by the caller's accessible orgs.
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Identify caller via their JWT
    const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
      error: userErr,
    } = await userClient.auth.getUser();
    if (userErr || !user) return json({ ok: false, error: 'Invalid token' }, 401);

    const body = (await req.json()) as RequestBody;
    if (!body.bill_id) return json({ ok: false, error: 'bill_id required' }, 400);

    // Read the bill — userClient enforces RLS so non-members can't reach it
    const { data: bill, error: billErr } = await userClient
      .from('bills')
      .select('id, organization_id, storage_key, mime_type, status')
      .eq('id', body.bill_id)
      .single();
    if (billErr || !bill) return json({ ok: false, error: 'Bill not found' }, 404);

    // Move to extracting state
    await admin
      .from('bills')
      .update({ status: 'verified', updated_at: new Date().toISOString() })
      .eq('id', bill.id);

    // Pull file bytes from storage
    const { data: fileBlob, error: storageErr } = await admin.storage
      .from('bills')
      .download(bill.storage_key);
    if (storageErr || !fileBlob) {
      return json({ ok: false, error: `Storage read failed: ${storageErr?.message}` }, 500);
    }
    const bytes = new Uint8Array(await fileBlob.arrayBuffer());

    // Extract
    const { data: extracted, raw, provider } = await extractBillData(bytes, bill.mime_type);

    // Persist extracted fields
    const { error: updateErr } = await admin
      .from('bills')
      .update({
        supplier_name_raw: extracted.supplier_name,
        supplier_abn: extracted.supplier_abn,
        invoice_number: extracted.invoice_number,
        invoice_date: extracted.invoice_date,
        due_date: extracted.due_date,
        total_inc_gst_cents: extracted.total_inc_gst != null
          ? Math.round(extracted.total_inc_gst * 100)
          : null,
        gst_cents: extracted.gst_amount != null ? Math.round(extracted.gst_amount * 100) : null,
        subtotal_ex_gst_cents: extracted.subtotal_ex_gst != null
          ? Math.round(extracted.subtotal_ex_gst * 100)
          : null,
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

    return json({ ok: true, provider, extracted, raw_length: raw.length });
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
