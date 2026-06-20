/**
 * bills-extract — extracts structured data from an uploaded bill.
 *
 * Two-stage pipeline:
 *   1. Once-off SHA-256 dedup → cache hit returns instantly
 *   2. Born-digital PDFs: try text extraction first
 *        - if header parse confidence ≥ 0.8, persist and return
 *          (~100ms, $0)
 *        - otherwise fall through to vision OCR
 *   3. Vision OCR — Groq / OpenAI / Kimi via the provider router
 *
 * The text-first path covers ~70% of supplier bills (born-digital PDFs
 * from Reece, Bunnings Trade, Tradelink, etc.) at zero cost. Photos and
 * scanned PDFs always go through vision.
 *
 * Auth: requires user JWT; RLS scopes the bill row.
 *
 * Input:  { bill_id: UUID }
 * Output: { ok: true, extracted, cache_hit, method: 'cache'|'text'|'vision', provider? }
 */

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { extractBillData } from '../_shared/ocr/index.ts';
import { extractTextFromPdf } from '../_shared/ocr/textExtract.ts';
import { parseBillHeaders } from '../_shared/ocr/headerParser.ts';
import type { ExtractedBill } from '../_shared/ocr/prompt.ts';
import { routeBill, type RouterResult } from '../_shared/bills/router.ts';

interface RequestBody {
  bill_id: string;
}

interface DocMetadata {
  candidate_supplier?: string | null;
  author?: string | null;
  candidate_invoice_number?: string | null;
  taken_at?: string | null;
  created_at?: string | null;
}

const TEXT_CONFIDENCE_THRESHOLD = 0.8;

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

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Accept either user JWT or service_role (used by bills-extract-batch and Pub/Sub push).
    // Detection: (a) exact match against SUPABASE_SERVICE_ROLE_KEY env, OR
    // (b) decoded JWT claim role === 'service_role'. JWT uses base64url which
    // requires translation before atob.
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    let isServiceRole = token === serviceKey;
    if (!isServiceRole) {
      try {
        const payloadB64 = (token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
        const padded = payloadB64 + '='.repeat((4 - (payloadB64.length % 4)) % 4);
        const payload = JSON.parse(atob(padded));
        isServiceRole = payload?.role === 'service_role';
      } catch { /* fall through to user-jwt path */ }
    }

    let dbClient: SupabaseClient;
    if (isServiceRole) {
      dbClient = admin;
    } else {
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user }, error: userErr } = await userClient.auth.getUser();
      if (userErr || !user) return json({ ok: false, error: 'Invalid token' }, 401);
      dbClient = userClient;
    }

    const body = (await req.json()) as RequestBody;
    if (!body.bill_id) return json({ ok: false, error: 'bill_id required' }, 400);

    const { data: bill, error: billErr } = await dbClient
      .from('bills')
      .select('id, organization_id, storage_key, mime_type, status, content_sha256')
      .eq('id', body.bill_id)
      .single();
    if (billErr || !bill) return json({ ok: false, error: 'Bill not found' }, 404);

    await admin
      .from('bills')
      .update({ status: 'verified', updated_at: new Date().toISOString() })
      .eq('id', bill.id);

    // Pull file bytes
    const { data: fileBlob, error: storageErr } = await admin.storage
      .from('bills')
      .download(bill.storage_key);
    if (storageErr || !fileBlob) {
      return json({ ok: false, error: `Storage read failed: ${storageErr?.message}` }, 500);
    }
    const bytes = new Uint8Array(await fileBlob.arrayBuffer());

    // Extract structural metadata (PDF info dict / EXIF / XMP) — free signal
    // before any OCR. Will be merged into raw_extracted and used to pre-fill
    // supplier_name / invoice_number / invoice_date if OCR misses them.
    let docMetadata: DocMetadata | null = null;
    try {
      const { extractDocumentMetadata } = await import('../_shared/ocr/metadata.ts');
      docMetadata = await extractDocumentMetadata(bytes, bill.mime_type);
    } catch (mdErr) {
      console.warn('metadata extraction skipped:', mdErr);
    }

    // SHA-256 dedup
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
    const contentSha256 = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

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
      await admin
        .from('bills')
        .update({
          ...cacheRow,
          content_sha256: contentSha256,
          updated_at: new Date().toISOString(),
        })
        .eq('id', bill.id);
      // Run routing on the cache-hit too — same job_reference, same matching.
      const routing = await runRouting(admin, bill.id, bill.organization_id, cacheRow);
      void fireAndForgetIntakeRouting(supabaseUrl, serviceKey, bill.organization_id, 'bill', bill.id);
      return json({
        ok: true,
        method: 'cache',
        cache_hit: true,
        provider: cacheRow.ocr_provider,
        extracted: cacheRow.raw_extracted,
        routing,
      });
    }

    // Text-first path for PDFs
    if (bill.mime_type === 'application/pdf') {
      const textRes = await extractTextFromPdf(bytes);
      if (!textRes.empty) {
        const headers = parseBillHeaders(textRes.fullText);
        if (headers.confidence >= TEXT_CONFIDENCE_THRESHOLD) {
          // High-confidence text-only extraction — persist and skip vision
          const extracted = headers.data as ExtractedBill;
          extracted._extraction_method = 'text';
          extracted._extraction_meta = {
            found: headers.found,
            missing: headers.missing,
            confidence_score: headers.confidence,
            math_consistent: headers.mathConsistent,
            page_count: textRes.pageCount,
          };

          await persistExtraction(admin, bill.id, extracted, contentSha256, 'text-only', docMetadata);
          const routing = await runRouting(admin, bill.id, bill.organization_id, {
            job_reference_raw: extracted.job_reference,
            confidence: extracted.confidence,
          });
          void fireAndForgetIntakeRouting(supabaseUrl, serviceKey, bill.organization_id, 'bill', bill.id);

          return json({
            ok: true,
            method: 'text',
            cache_hit: false,
            provider: 'text-only',
            extracted,
            confidence_score: headers.confidence,
            routing,
          });
        }
        // Low-confidence text — fall through to vision (vision sees layout)
      }
    }

    // Vision path
    const { data: extracted, raw, provider } = await extractBillData(bytes, bill.mime_type);
    extracted._extraction_method = 'vision';

    await persistExtraction(admin, bill.id, extracted, contentSha256, provider, docMetadata);
    const routing = await runRouting(admin, bill.id, bill.organization_id, {
      job_reference_raw: extracted.job_reference,
      confidence: extracted.confidence,
    });
    void fireAndForgetIntakeRouting(supabaseUrl, serviceKey, bill.organization_id, 'bill', bill.id);

    return json({
      ok: true,
      method: 'vision',
      cache_hit: false,
      provider,
      extracted,
      raw_length: raw.length,
      routing,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

async function persistExtraction(
  admin: SupabaseClient,
  billId: string,
  extracted: ExtractedBill,
  contentSha256: string,
  provider: string,
  docMetadata?: DocMetadata | null,
): Promise<void> {
  // Backfill empty OCR fields from metadata if metadata has them
  const filledSupplier = extracted.supplier_name || docMetadata?.candidate_supplier || docMetadata?.author || null;
  const filledInvoiceNumber = extracted.invoice_number || docMetadata?.candidate_invoice_number || null;
  const filledInvoiceDate = extracted.invoice_date
    || (docMetadata?.taken_at ? docMetadata.taken_at.slice(0, 10) : null)
    || (docMetadata?.created_at ? docMetadata.created_at.slice(0, 10) : null);

  await admin
    .from('bills')
    .update({
      content_sha256: contentSha256,
      supplier_name_raw: filledSupplier,
      supplier_abn: extracted.supplier_abn,
      invoice_number: filledInvoiceNumber,
      invoice_date: filledInvoiceDate,
      due_date: extracted.due_date,
      total_inc_gst_cents:
        extracted.total_inc_gst != null ? Math.round(extracted.total_inc_gst * 100) : null,
      gst_cents: extracted.gst_amount != null ? Math.round(extracted.gst_amount * 100) : null,
      subtotal_ex_gst_cents:
        extracted.subtotal_ex_gst != null ? Math.round(extracted.subtotal_ex_gst * 100) : null,
      currency_code: extracted.currency || 'AUD',
      job_reference_raw: extracted.job_reference,
      notes: extracted.notes || null,
      raw_extracted: docMetadata
        ? { ...extracted, _document_metadata: docMetadata }
        : extracted,
      ocr_provider: provider,
      ocr_confidence:
        extracted.confidence === 'high' ? 0.9 : extracted.confidence === 'low' ? 0.4 : 0.7,
      updated_at: new Date().toISOString(),
    })
    .eq('id', billId);
}

async function runRouting(
  admin: SupabaseClient,
  billId: string,
  organizationId: string,
  source: { job_reference_raw?: string | null; confidence?: ExtractedBill['confidence'] },
): Promise<RouterResult> {
  return await routeBill({
    admin,
    billId,
    organizationId,
    jobReferenceRaw: source.job_reference_raw ?? null,
    extractedConfidence: source.confidence ?? 'medium',
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/**
 * Fire-and-forget call into intake-routing-apply. Mirrors the
 * fireAndForgetSubsDetect pattern in bank-sync — never block the caller's
 * response, never throw, just let the rules engine pick up the new row.
 */
async function fireAndForgetIntakeRouting(
  supabaseUrl: string,
  serviceKey: string,
  orgId: string,
  target: 'bill' | 'bank_transaction',
  targetId: string,
): Promise<void> {
  try {
    await fetch(`${supabaseUrl}/functions/v1/intake-routing-apply`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ organization_id: orgId, target, target_id: targetId }),
    });
  } catch {
    // Routing is non-critical to the OCR response.
  }
}
