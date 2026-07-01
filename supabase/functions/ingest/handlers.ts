// ingest/handlers.ts
// Per-type write logic behind the `ingest` edge function. Extracted from index.ts
// so it is unit-testable without starting Deno.serve (mirrors _shared/gmail/*.ts,
// _shared/receipt-sync/genericApi.ts). index.ts owns auth, rate-limiting, scope
// gating, request logging, and routing; each handler here pins organization_id,
// dedupes, and triggers the same auto-routing the human importers use.
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { routeBill } from '../_shared/bills/router.ts';
import { sha256Hex } from '../_shared/apiKeys.ts';

// Caller-safe validation error: its message IS returned to the client. Raw DB
// errors are thrown as plain Error and never surfaced (see index.ts catch).
export class ValidationError extends Error {}

// Whitelisted, writable bill columns from the API. organization_id/source/
// status are forced; computed/internal columns are never accepted from callers.
const BILL_FIELDS = [
  'supplier_id',
  'job_id',
  'supplier_name_raw',
  'supplier_abn',
  'invoice_number',
  'invoice_date',
  'due_date',
  'total_inc_gst_cents',
  'gst_cents',
  'subtotal_ex_gst_cents',
  'currency_code',
  'job_reference_raw',
  'notes',
  'raw_extracted',
] as const;

// Build a stable, canonical dedupe hash from ONLY the whitelisted, persisted
// fields (sorted keys, undefined/null dropped) plus the org. This is immune to
// key order, whitespace, and any non-persisted junk a caller includes in the
// payload — two semantically-identical pushes always collide.
async function canonicalContentHash(
  orgId: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const canon: Record<string, unknown> = {};
  for (const f of BILL_FIELDS) {
    if (payload[f] !== undefined && payload[f] !== null) canon[f] = payload[f];
  }
  const sortedKeys = Object.keys(canon).sort();
  const stable = sortedKeys.map((k) => [k, canon[k]] as const);
  return await sha256Hex(JSON.stringify({ o: orgId, f: stable }));
}

export async function ingestBill(db: SupabaseClient, orgId: string, payload: Record<string, unknown>) {
  // Dedupe key: stable hash of the org + the canonicalized whitelisted bill
  // fields. Mirrors bills-extract's content_sha256 cache so a re-push is a no-op.
  const contentSha256 = await canonicalContentHash(orgId, payload);

  // Re-push? Return the existing row (idempotent).
  const { data: existing } = await db
    .from('bills')
    .select('id, status, job_reference_raw')
    .eq('organization_id', orgId)
    .eq('content_sha256', contentSha256)
    .is('deleted_at', null)
    .maybeSingle();
  if (existing) {
    const routing = await routeBill({
      admin: db,
      billId: existing.id,
      organizationId: orgId,
      jobReferenceRaw:
        (payload.job_reference_raw as string | undefined) ?? existing.job_reference_raw ?? null,
      extractedConfidence: 'medium',
    });
    await runIntakeRouting(orgId, 'bill', [existing.id]);
    return {
      status: 200,
      body: { ok: true, id: existing.id, type: 'bill', deduped: true, routing },
    };
  }

  const row: Record<string, unknown> = {
    organization_id: orgId,
    source: 'api',
    status: 'received',
    content_sha256: contentSha256,
    // NOT NULL file-evidence columns: callers pushing structured data rarely
    // have a file, so synthesise sentinels (a real upload uses bills-extract).
    storage_key: (payload.storage_key as string) ?? `api/${contentSha256}`,
    original_filename: (payload.original_filename as string) ?? 'api-ingest.json',
    mime_type: (payload.mime_type as string) ?? 'application/json',
  };
  for (const f of BILL_FIELDS) {
    if (payload[f] !== undefined) row[f] = payload[f];
  }

  const { data: inserted, error } = await db.from('bills').insert(row).select('id').single();
  if (error) {
    // UNIQUE(org, supplier_id, invoice_number) collision → treat as duplicate.
    if ((error as { code?: string }).code === '23505') {
      return { status: 200, body: { ok: true, id: null, type: 'bill', deduped: true } };
    }
    throw new Error(error.message);
  }

  // Same auto-routing as the Gmail/upload path: score the job ref, auto-attach /
  // suggest / queue, then let the intake-rules engine pick it up.
  const routing = await routeBill({
    admin: db,
    billId: inserted.id,
    organizationId: orgId,
    jobReferenceRaw: (payload.job_reference_raw as string) ?? null,
    extractedConfidence: 'medium',
  });

  await runIntakeRouting(orgId, 'bill', [inserted.id]);

  return {
    status: 201,
    body: { ok: true, id: inserted.id, type: 'bill', deduped: false, routing },
  };
}

const BANK_TXN_FIELDS = [
  'posted_at',
  'description',
  'amount_cents',
  'running_balance_cents',
  'reference',
  'category_external',
  'raw',
] as const;

export async function ingestBankTransaction(
  db: SupabaseClient,
  orgId: string,
  payload: Record<string, unknown>,
) {
  const bankAccountId = payload.bank_account_id as string | undefined;
  const externalId = payload.external_id as string | undefined;
  if (!bankAccountId || !externalId) {
    throw new ValidationError('bank_account_id and external_id are required');
  }

  // The bank account must belong to the key's org (tenant pin).
  const { data: acct } = await db
    .from('bank_accounts')
    .select('id')
    .eq('id', bankAccountId)
    .eq('organization_id', orgId)
    .maybeSingle();
  if (!acct) throw new ValidationError('bank_account not found for this organization');

  const row: Record<string, unknown> = {
    organization_id: orgId,
    bank_account_id: bankAccountId,
    external_id: externalId,
    description: (payload.description as string) ?? '(no description)',
  };
  for (const f of BANK_TXN_FIELDS) {
    if (payload[f] !== undefined) row[f] = payload[f];
  }

  // Idempotent on (bank_account_id, external_id) — identical to bank-sync.
  const { data: txn, error } = await db
    .from('bank_transactions')
    .upsert(row, { onConflict: 'bank_account_id,external_id', ignoreDuplicates: false })
    .select('id')
    .single();
  if (error) throw new Error(error.message);

  await runIntakeRouting(orgId, 'bank_transaction', [txn.id]);

  return { status: 201, body: { ok: true, id: txn.id, type: 'bank_transaction' } };
}

// NOTE: `status` is deliberately NOT writable from the API — invoices always
// start at the DB default ('draft'), exactly like bills force 'received'. A
// caller must not be able to mint an invoice already 'paid'/'void'. Status
// transitions go through the authenticated app/RPCs, not raw ingest.
const INVOICE_FIELDS = [
  'customer_id',
  'job_id',
  'issue_date',
  'due_date',
  'terms_days',
  'subtotal_ex_gst_cents',
  'gst_cents',
  'total_inc_gst_cents',
  'currency_code',
  'notes',
] as const;

export async function ingestInvoice(db: SupabaseClient, orgId: string, payload: Record<string, unknown>) {
  const invoiceNumber = payload.invoice_number as string | undefined;
  const customerId = payload.customer_id as string | undefined;
  if (!invoiceNumber) throw new ValidationError('invoice_number is required');
  if (!customerId) throw new ValidationError('customer_id is required');
  if (!payload.due_date) throw new ValidationError('due_date is required');

  // Customer must belong to the key's org.
  const { data: cust } = await db
    .from('customers')
    .select('id')
    .eq('id', customerId)
    .eq('organization_id', orgId)
    .maybeSingle();
  if (!cust) throw new ValidationError('customer not found for this organization');

  // Dedupe on UNIQUE(org, invoice_number): re-push returns the existing row.
  const { data: existing } = await db
    .from('invoices')
    .select('id')
    .eq('organization_id', orgId)
    .eq('invoice_number', invoiceNumber)
    .is('deleted_at', null)
    .maybeSingle();
  if (existing) {
    return { status: 200, body: { ok: true, id: existing.id, type: 'invoice', deduped: true } };
  }

  const row: Record<string, unknown> = {
    organization_id: orgId,
    invoice_number: invoiceNumber,
    customer_id: customerId,
  };
  for (const f of INVOICE_FIELDS) {
    if (payload[f] !== undefined) row[f] = payload[f];
  }

  const { data: inserted, error } = await db.from('invoices').insert(row).select('id').single();
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      return { status: 200, body: { ok: true, id: null, type: 'invoice', deduped: true } };
    }
    throw new Error(error.message);
  }

  return { status: 201, body: { ok: true, id: inserted.id, type: 'invoice', deduped: false } };
}

// A document/payment ingest has no pre-existing source-row uuid; the
// Idempotency-Key is the dedup handle. automation_jobs.source_id is a uuid, so
// derive a stable uuid from the key (same key -> same uuid; 128 bits from the
// SHA-256 prefix) and use it as both the dedup filter and p_source_id. This
// keeps the column a uuid (no schema change) and the API contract unchanged
// (callers still send an arbitrary Idempotency-Key string).
async function idemKeyToUuid(key: string): Promise<string> {
  const h = (await sha256Hex(key)).slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// document — idempotent via automation_jobs dedup; enqueues a bill_extract job.
// Scope: write:documents. Idempotency-Key header is required.
// ---------------------------------------------------------------------------

export async function ingestDocument(
  db: SupabaseClient,
  orgId: string,
  payload: Record<string, unknown>,
  idempotencyKey: string | undefined,
) {
  const idemKey = idempotencyKey ?? (payload.idempotency_key as string | undefined);
  if (!idemKey)
    throw new ValidationError(
      'Idempotency-Key header or payload.idempotency_key is required for document type',
    );

  const sourceId = await idemKeyToUuid(idemKey);
  const storageKey = textField(payload.storage_key);
  if (!storageKey) throw new ValidationError('storage_key is required for document type');
  if (!storageKey.startsWith(`org-${orgId}/`)) {
    throw new ValidationError('storage_key must belong to this organization');
  }
  const originalFilename =
    textField(payload.original_filename) ?? storageKey.split('/').pop() ?? 'document';
  const mimeType = textField(payload.mime_type) ?? 'application/octet-stream';

  // Dedup: if a job already exists for this idempotency key, return it.
  const { data: existing } = await db
    .from('automation_jobs')
    .select('id, payload')
    .eq('organization_id', orgId)
    .eq('source_kind', 'document')
    .eq('source_id', sourceId)
    .in('status', ['pending', 'claimed', 'completed'])
    .maybeSingle();

  if (existing) {
    const existingPayload = (existing as { payload?: Record<string, unknown> | null }).payload;
    return {
      status: 200,
      body: {
        ok: true,
        job_id: (existing as { id: string }).id,
        bill_id: textField(existingPayload?.bill_id),
        type: 'document',
        deduped: true,
      },
    };
  }

  // Create or reuse the canonical bill row first. The worker and watchdogs
  // operate on bills, so accepting a document without a bill row makes the job
  // look successful while no extractable source exists.
  let billId: string;
  const { data: existingBill, error: existingBillErr } = await db
    .from('bills')
    .select('id')
    .eq('organization_id', orgId)
    .eq('storage_key', storageKey)
    .is('deleted_at', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (existingBillErr) throw new Error(existingBillErr.message);
  if (existingBill) {
    billId = (existingBill as { id: string }).id;
  } else {
    const { data: insertedBill, error: billErr } = await db
      .from('bills')
      .insert({
        organization_id: orgId,
        source: 'api',
        status: 'received',
        storage_key: storageKey,
        original_filename: originalFilename,
        mime_type: mimeType,
        currency_code: 'AUD',
      })
      .select('id')
      .single();
    if (billErr || !insertedBill) throw new Error(billErr?.message ?? 'bill insert failed');
    billId = (insertedBill as { id: string }).id;
  }

  const { data: job, error } = await db.rpc('enqueue_automation_job', {
    p_org_id: orgId,
    p_job_kind: 'bill_extract',
    p_source_kind: 'document',
    p_source_id: sourceId,
    p_priority: 5,
    p_run_after: new Date().toISOString(),
    p_max_attempts: 3,
    p_payload: {
      bill_id: billId,
      storage_key: storageKey,
      original_filename: originalFilename,
      mime_type: mimeType,
      idempotency_key: idemKey,
    },
  });
  if (error) throw new Error(error.message);

  const jobId = (job as { id?: string } | null)?.id ?? null;
  return {
    status: 202,
    body: { ok: true, job_id: jobId, bill_id: billId, type: 'document', deduped: false },
  };
}

// ---------------------------------------------------------------------------
// payment — idempotent via automation_jobs dedup; enqueues a payment_record job
// for AR invoice receipts. AP bill settlement must go through bank
// reconciliation or payment runs so amount/source evidence guards stay intact.
// Scope:
// write:payments. Idempotency-Key header is required.
// ---------------------------------------------------------------------------

export async function ingestPayment(
  db: SupabaseClient,
  orgId: string,
  payload: Record<string, unknown>,
  idempotencyKey: string | undefined,
) {
  const idemKey = idempotencyKey ?? (payload.idempotency_key as string | undefined);
  if (!idemKey)
    throw new ValidationError(
      'Idempotency-Key header or payload.idempotency_key is required for payment type',
    );

  const sourceId = await idemKeyToUuid(idemKey);

  // Dedup: return the existing job if already enqueued.
  const { data: existing } = await db
    .from('automation_jobs')
    .select('id')
    .eq('organization_id', orgId)
    .eq('source_kind', 'payment')
    .eq('source_id', sourceId)
    .maybeSingle();

  if (existing) {
    return {
      status: 200,
      body: { ok: true, job_id: (existing as { id: string }).id, type: 'payment', deduped: true },
    };
  }

  const billId = payload.bill_id as string | undefined;
  const invoiceId = payload.invoice_id as string | undefined;
  if (billId) {
    throw new ValidationError(
      'bill payments require bank reconciliation or payment runs; payment ingest supports invoice_id only',
    );
  }
  if (!invoiceId) throw new ValidationError('invoice_id is required for payment type');
  const amountCents = Number(payload.amount_cents);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new ValidationError('amount_cents must be a positive integer');
  }
  if (!payload.payment_date) throw new ValidationError('payment_date is required for payment type');

  const { data: job, error } = await db.rpc('enqueue_automation_job', {
    p_org_id: orgId,
    p_job_kind: 'payment_record',
    p_source_kind: 'payment',
    p_source_id: sourceId,
    p_priority: 5,
    p_run_after: new Date().toISOString(),
    p_max_attempts: 3,
    p_payload: {
      invoice_id: invoiceId,
      amount_cents: amountCents,
      payment_date: payload.payment_date,
      payment_method: payload.payment_method ?? null,
      reference: payload.reference ?? null,
      idempotency_key: idemKey,
    },
  });
  if (error) throw new Error(error.message);

  const jobId = (job as { id?: string } | null)?.id ?? null;
  return { status: 202, body: { ok: true, job_id: jobId, type: 'payment', deduped: false } };
}

async function runIntakeRouting(
  orgId: string,
  target: 'bill' | 'bank_transaction',
  targetIds: string[],
): Promise<void> {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (targetIds.length === 0) return;
  if (!url || !serviceKey) throw new Error('intake routing config missing');
  const response = await fetch(`${url}/functions/v1/intake-routing-apply`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ organization_id: orgId, target, target_ids: targetIds }),
  });
  if (!response.ok) {
    throw new Error(
      `intake-routing-apply failed: ${response.status} ${await response.text().catch(() => '')}`.trim(),
    );
  }
}

function textField(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
