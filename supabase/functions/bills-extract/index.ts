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
import { isExactServiceRoleBearer } from '../_shared/serviceRole.ts';
import { extractBillData } from '../_shared/ocr/index.ts';
import { extractTextFromPdf } from '../_shared/ocr/textExtract.ts';
import { parseBillHeaders } from '../_shared/ocr/headerParser.ts';
import type { DocumentKind, ExtractedBill } from '../_shared/ocr/prompt.ts';
import { NON_FINANCIAL_KINDS } from '../_shared/ocr/prompt.ts';
import { routeBill, type RouterResult } from '../_shared/bills/router.ts';

interface RequestBody {
  bill_id?: string;
  // force: skip the SHA-256 dedup cache and re-run real OCR. Used by the
  // repair backfill so a bill can't copy a failed duplicate's null values.
  force?: boolean;
  // extract_only: OCR a stored file and RETURN the structured data WITHOUT
  // creating/updating any bill row (no cache, no persist, no routing). Used by
  // the Receipt Hub photo capture, which feeds the result into receipt-webhook
  // (which owns the single bill). Requires storage_key + mime_type +
  // organization_id instead of bill_id.
  extract_only?: boolean;
  storage_key?: string;
  mime_type?: string;
  organization_id?: string;
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

    // Accept either a real user JWT or the exact service-role bearer used by
    // backend edge functions. Never trust a self-asserted JWT role payload.
    const isServiceRole = isExactServiceRoleBearer(authHeader, serviceKey);

    let dbClient: SupabaseClient;
    if (isServiceRole) {
      dbClient = admin;
    } else {
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const {
        data: { user },
        error: userErr,
      } = await userClient.auth.getUser();
      if (userErr || !user) return json({ ok: false, error: 'Invalid token' }, 401);
      dbClient = userClient;
    }

    const body = (await req.json()) as RequestBody;

    // extract_only: OCR a stored file and return structured data, no bill row.
    if (body.extract_only) {
      if (!body.storage_key || !body.mime_type || !body.organization_id) {
        return json(
          { ok: false, error: 'extract_only requires storage_key, mime_type, organization_id' },
          400,
        );
      }
      // Authorize: the caller must be able to access organization_id, and the
      // storage path must live under that org's prefix (the bills bucket RLS
      // enforces org-<id>/ — re-checking here blocks a member of org A from
      // OCR'ing org B's object via the service-role download below).
      if (!body.storage_key.startsWith(`org-${body.organization_id}/`)) {
        return json({ ok: false, error: 'storage_key does not belong to organization_id' }, 403);
      }
      if (!isServiceRole) {
        const { data: orgIds } = await dbClient.rpc('get_accessible_org_ids');
        const accessible = (orgIds ?? []) as string[];
        if (!accessible.includes(body.organization_id)) {
          return json({ ok: false, error: 'Forbidden' }, 403);
        }
      }

      const { data: fileBlob, error: storageErr } = await admin.storage
        .from('bills')
        .download(body.storage_key);
      if (storageErr || !fileBlob) {
        return json({ ok: false, error: `Storage read failed: ${storageErr?.message}` }, 500);
      }
      const bytes = new Uint8Array(await fileBlob.arrayBuffer());

      // Text-first for born-digital PDFs, else vision — same routing as the
      // bill path, but nothing is persisted.
      if (body.mime_type === 'application/pdf') {
        const textRes = await extractTextFromPdf(bytes);
        if (!textRes.empty) {
          const headers = parseBillHeaders(textRes.fullText);
          if (headers.confidence >= TEXT_CONFIDENCE_THRESHOLD) {
            const extracted = headers.data as ExtractedBill;
            extracted._extraction_method = 'text';
            return json({
              ok: true,
              method: 'text',
              cache_hit: false,
              provider: 'text-only',
              extracted,
              confidence_score: headers.confidence,
            });
          }
        }
      }
      const { data: extracted, raw, provider } = await extractBillData(bytes, body.mime_type);
      extracted._extraction_method = 'vision';
      return json({
        ok: true,
        method: 'vision',
        cache_hit: false,
        provider,
        extracted,
        raw_length: raw.length,
      });
    }

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

    // Only reuse a duplicate that actually captured a total — never copy a
    // failed (null-amount) extraction. `force` skips the cache entirely.
    const { data: cacheRow } = body.force
      ? { data: null }
      : await admin
          .from('bills')
          .select(
            'supplier_name_raw, supplier_abn, invoice_number, invoice_date, due_date, total_inc_gst_cents, gst_cents, subtotal_ex_gst_cents, gst_estimated, currency_code, job_reference_raw, document_kind, is_probable_bill, notes, raw_extracted, ocr_provider, ocr_confidence',
          )
          .eq('organization_id', bill.organization_id)
          .eq('content_sha256', contentSha256)
          .neq('id', bill.id)
          .is('deleted_at', null)
          .not('raw_extracted', 'is', null)
          .not('total_inc_gst_cents', 'is', null)
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
      void fireAndForgetIntakeRouting(
        supabaseUrl,
        serviceKey,
        bill.organization_id,
        'bill',
        bill.id,
      );
      void writeDecision(
        admin,
        bill.id,
        bill.organization_id,
        undefined,
        routing.outcome,
        'cache',
        true,
        false,
      );
      void writeExtractionVersion(
        admin,
        bill.id,
        bill.organization_id,
        'cache',
        cacheRow.ocr_provider ?? 'unknown',
        cacheRow.ocr_confidence ?? null,
        cacheRow.raw_extracted,
      );
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

          await persistExtraction(
            admin,
            bill.id,
            extracted,
            contentSha256,
            'text-only',
            docMetadata,
          );
          const routing = await runRouting(admin, bill.id, bill.organization_id, {
            job_reference_raw: extracted.job_reference,
            confidence: extracted.confidence,
          });
          void fireAndForgetIntakeRouting(
            supabaseUrl,
            serviceKey,
            bill.organization_id,
            'bill',
            bill.id,
          );
          void writeDecision(
            admin,
            bill.id,
            bill.organization_id,
            extracted.confidence,
            routing.outcome,
            'text',
            true,
            false,
          );
          void writeExtractionVersion(
            admin,
            bill.id,
            bill.organization_id,
            'text',
            'text-only',
            headers.confidence,
            extracted,
          );

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
    const { isProbableBill: visProbable } = classifyBill({
      document_kind: extracted.document_kind,
      confidence: extracted.confidence,
      total_inc_gst: extracted.total_inc_gst,
      supplier_name: extracted.supplier_name,
    });
    const visGst = deriveGstCents(
      extracted.total_inc_gst != null ? Math.round(extracted.total_inc_gst * 100) : null,
      extracted.gst_amount != null ? Math.round(extracted.gst_amount * 100) : null,
      extracted.subtotal_ex_gst != null ? Math.round(extracted.subtotal_ex_gst * 100) : null,
    );
    void writeDecision(
      admin,
      bill.id,
      bill.organization_id,
      extracted.confidence,
      routing.outcome,
      'vision',
      visProbable,
      visGst.estimated,
    );
    const visConf =
      extracted.confidence === 'high' ? 0.9 : extracted.confidence === 'low' ? 0.4 : 0.7;
    void writeExtractionVersion(
      admin,
      bill.id,
      bill.organization_id,
      'vision',
      provider,
      visConf,
      extracted,
    );

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

/**
 * Capture GST even when the supplier didn't itemise it.
 *   - GST read off the document → use it verbatim (estimated=false).
 *   - total + subtotal both present → GST = total − subtotal (estimated=true).
 *   - total only → AU standard rate: GST = round(total / 11), subtotal = total − GST.
 *   - no total → leave null (nothing to derive from).
 * Estimated GST is flagged so the BAS gate / human review can correct the
 * GST-free exceptions (fresh food, some services, overseas) before lodgement.
 */
export function deriveGstCents(
  totalCents: number | null,
  gstCents: number | null,
  subtotalCents: number | null,
): { gstCents: number | null; subtotalCents: number | null; estimated: boolean } {
  if (gstCents != null) {
    return {
      gstCents,
      subtotalCents: subtotalCents ?? (totalCents != null ? totalCents - gstCents : null),
      estimated: false,
    };
  }
  if (totalCents == null) {
    return { gstCents: null, subtotalCents, estimated: false };
  }
  if (subtotalCents != null && totalCents > subtotalCents) {
    return { gstCents: totalCents - subtotalCents, subtotalCents, estimated: true };
  }
  if (subtotalCents != null) {
    // Document supplied a subtotal that equals (or exceeds) the total → the
    // supply carries NO GST (GST-free: fresh food, bank fees, overseas, rent).
    // Do NOT apply the 1/11 rule here — that would invent phantom GST and
    // over-claim input tax credits.
    return { gstCents: 0, subtotalCents, estimated: false };
  }
  // Total only, no subtotal to contradict it → assume a standard-rated taxable
  // supply: GST = 1/11 of the GST-inclusive total.
  const derivedGst = Math.round(totalCents / 11);
  return { gstCents: derivedGst, subtotalCents: totalCents - derivedGst, estimated: true };
}

/**
 * Decide whether an extracted document is a probable bill (belongs on the
 * active bills/BAS surface) or noise to keep out of sight.
 *
 * Noise = a genuinely non-financial document_kind (logo/photo/ui_screenshot/
 * other) — the mis-filed images (supplier logos, "Pay Now" buttons, photos of
 * finished fences, email-signature images) the OCR already recognises as "not a
 * financial document".
 *
 * IMPORTANT: we deliberately DO NOT hide a row just because the extraction was
 * low-confidence with no total/supplier. A real-but-unreadable invoice (a
 * skewed photo, an encrypted/corrupt PDF that fell through to the manual-entry
 * stub) looks exactly like that — low confidence, null total, null supplier,
 * document_kind='invoice' — and dropping it would silently remove a real bill
 * from the active list AND from BAS. Such rows stay is_probable_bill=true so
 * they surface as needs-review rather than vanish; the human review pass (or a
 * later re-extract) fills the amounts. Only a non-financial document_kind ever
 * sets is_probable_bill=false.
 *
 * Nothing is deleted: is_probable_bill=false just defaults the row out of the
 * active list and out of BAS scope; it can still be shown via the toggle.
 */
export function classifyBill(extracted: {
  document_kind?: DocumentKind | string | null;
  confidence?: ExtractedBill['confidence'];
  total_inc_gst?: number | null;
  supplier_name?: string | null;
}): { documentKind: DocumentKind; isProbableBill: boolean } {
  const documentKind: DocumentKind =
    NON_FINANCIAL_KINDS.has(extracted.document_kind as DocumentKind) ||
    ['invoice', 'quote', 'receipt', 'statement', 'order'].includes(
      extracted.document_kind as string,
    )
      ? (extracted.document_kind as DocumentKind)
      : 'invoice';

  // Exclude ONLY genuinely non-financial documents. A low-confidence empty
  // extraction of a real invoice must remain visible (needs-review), not hidden.
  const isProbableBill = !NON_FINANCIAL_KINDS.has(documentKind);

  return { documentKind, isProbableBill };
}

async function persistExtraction(
  admin: SupabaseClient,
  billId: string,
  extracted: ExtractedBill,
  contentSha256: string,
  provider: string,
  docMetadata?: DocMetadata | null,
): Promise<void> {
  // Backfill empty OCR fields from metadata if metadata has them
  const filledSupplier =
    extracted.supplier_name || docMetadata?.candidate_supplier || docMetadata?.author || null;
  const filledInvoiceNumber =
    extracted.invoice_number || docMetadata?.candidate_invoice_number || null;
  const filledInvoiceDate =
    extracted.invoice_date ||
    (docMetadata?.taken_at ? docMetadata.taken_at.slice(0, 10) : null) ||
    (docMetadata?.created_at ? docMetadata.created_at.slice(0, 10) : null);

  // Derive GST so the books (and BAS) fill even when the document only shows a
  // total. AU standard-rated supplies are 1/11 of the GST-inclusive total.
  const { gstCents, subtotalCents, estimated } = deriveGstCents(
    extracted.total_inc_gst != null ? Math.round(extracted.total_inc_gst * 100) : null,
    extracted.gst_amount != null ? Math.round(extracted.gst_amount * 100) : null,
    extracted.subtotal_ex_gst != null ? Math.round(extracted.subtotal_ex_gst * 100) : null,
  );

  // Classify the document so non-invoices (logos, photos of finished fences,
  // "Pay Now" UI screenshots) are kept off the active bills list and out of BAS.
  const { documentKind, isProbableBill } = classifyBill({
    document_kind: extracted.document_kind,
    confidence: extracted.confidence,
    total_inc_gst: extracted.total_inc_gst,
    supplier_name: filledSupplier,
  });

  const { error: updateErr } = await admin
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
      gst_cents: gstCents,
      subtotal_ex_gst_cents: subtotalCents,
      gst_estimated: estimated,
      currency_code: extracted.currency || 'AUD',
      job_reference_raw: extracted.job_reference,
      document_kind: documentKind,
      is_probable_bill: isProbableBill,
      notes: extracted.notes || null,
      raw_extracted: docMetadata ? { ...extracted, _document_metadata: docMetadata } : extracted,
      ocr_provider: provider,
      ocr_confidence:
        extracted.confidence === 'high' ? 0.9 : extracted.confidence === 'low' ? 0.4 : 0.7,
      updated_at: new Date().toISOString(),
    })
    .eq('id', billId);
  // Surface the failure instead of silently returning ok — a swallowed error
  // here is how the books stayed empty (e.g. a stale PostgREST schema cache).
  if (updateErr) {
    throw new Error(`Failed to persist extraction for bill ${billId}: ${updateErr.message}`);
  }
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

async function writeDecision(
  admin: SupabaseClient,
  billId: string,
  orgId: string,
  ocrConfidence: ExtractedBill['confidence'] | undefined,
  routingOutcome: string,
  method: 'cache' | 'text' | 'vision',
  isProbableBill: boolean,
  gstEstimated: boolean,
): Promise<void> {
  const confidence = ocrConfidence === 'high' ? 'quick_confirm' : 'review_needed';
  const reasonCodes: string[] = [];
  if (method === 'text') reasonCodes.push('ocr_text_extraction');
  else if (method === 'vision') reasonCodes.push('ocr_vision_extraction');
  else if (method === 'cache') reasonCodes.push('cache_hit');
  if (gstEstimated) reasonCodes.push('gst_derived');
  if (routingOutcome === 'auto_attached') reasonCodes.push('job_matched_exact');
  else if (routingOutcome === 'suggested') reasonCodes.push('job_matched_fuzzy');
  if (!isProbableBill) reasonCodes.push('probable_non_invoice');

  try {
    await admin.from('automation_decisions').insert({
      organization_id: orgId,
      source_kind: 'bill_upload',
      source_id: billId,
      decision_kind: 'category',
      suggested_treatment: { ocr_method: method, routing_outcome: routingOutcome },
      confidence,
      reason_codes: reasonCodes,
    });
  } catch {
    // Non-critical — never block the OCR response
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function writeExtractionVersion(
  admin: SupabaseClient,
  billId: string,
  orgId: string,
  method: 'cache' | 'text' | 'vision',
  provider: string,
  confidence: number | null,
  extractedJson: unknown,
): Promise<void> {
  try {
    await admin.from('document_extraction_versions').insert({
      bill_id: billId,
      organization_id: orgId,
      method,
      provider,
      confidence,
      extracted_json: extractedJson ?? {},
    });
  } catch {
    // Non-critical — never block the OCR response
  }
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
