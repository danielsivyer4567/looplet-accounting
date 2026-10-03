/**
 * Xero adapter — REAL implementation.
 * Deno port of Loopletnumero `services/accounting/XeroAdapter.ts`.
 *
 * Single-shot ACCPAY push on bill attachment to a job. Original-dated so
 * GST input credits land in the correct BAS quarter.
 *
 * A bill is only ever reported as synced with an InvoiceID that Xero returned.
 * When Xero is not set up, turned off (XERO_STUB_MODE) or not connected for the
 * organisation, nothing is sent and the result says `not_connected`; callers
 * leave the bill `pending` (billXeroSyncUpdate). There is no placeholder id.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { callXeroWithRetry, xeroFetch, XeroApiError } from './auth.ts';
import { resolveXeroIdempotencyKey } from './idempotency.ts';

interface BillForPush {
  id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  total_inc_gst_cents: number | null;
  gst_cents: number | null;
  subtotal_ex_gst_cents: number | null;
  currency_code: string;
  supplier_name_raw: string | null;
  job_reference_raw: string | null;
  line_items?: {
    description: string;
    quantity: number;
    unit_price_cents: number;
    total_cents: number;
    gst_cents: number;
    account_code: string | null;
    category: string | null;
  }[];
}

interface PushArgs {
  admin: SupabaseClient;
  organizationId: string;
  bill: BillForPush;
  job: { id: string; job_number: string; name: string };
}

/** Outcome of a push: `synced` only when Xero accepted the bill and returned its id. */
export type PushResult =
  | { status: 'synced'; xeroInvoiceId: string }
  | { status: 'not_connected'; reason: string };

async function loadGlEvidence(
  admin: SupabaseClient,
  organizationId: string,
  sourceType: 'bill' | 'invoice',
  sourceId: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await admin
    .from('journal_entries')
    .select('id, status, posted_at, entry_date, source_type, source_id')
    .eq('organization_id', organizationId)
    .eq('source_type', sourceType)
    .eq('source_id', sourceId)
    .order('entry_date', { ascending: false })
    .limit(10);

  if (error) {
    return {
      source_type: sourceType,
      source_id: sourceId,
      lookup_error: error.message,
      journal_entries: [],
      posted_count: 0,
    };
  }

  const rows = (data ?? []) as Record<string, unknown>[];
  return {
    source_type: sourceType,
    source_id: sourceId,
    journal_entries: rows,
    posted_count: rows.filter((row) => row.status === 'posted').length,
  };
}

/** Why a bill cannot be sent to Xero for this organisation, or null when it can. */
async function xeroNotConnectedReason(
  admin: SupabaseClient,
  organizationId: string,
): Promise<string | null> {
  if (Deno.env.get('XERO_STUB_MODE') === 'true') {
    return 'Xero sync is turned off on this server, so nothing was sent to Xero.';
  }
  if (!Deno.env.get('XERO_CLIENT_ID')) {
    return 'Xero is not set up on this server, so nothing was sent to Xero.';
  }
  const { data: integ } = await admin
    .from('xero_integrations')
    .select('id, xero_tenant_id, is_enabled')
    .eq('organization_id', organizationId)
    .eq('is_enabled', true)
    .maybeSingle();
  if (!integ?.xero_tenant_id) {
    return 'Xero is not connected for this organisation, so nothing was sent to Xero.';
  }
  return null;
}

/**
 * The bills columns to write after a push. Only an id Xero returned marks the
 * bill synced; otherwise it stays pending (not connected is not a failure).
 */
export function billXeroSyncUpdate(
  result: PushResult,
  syncedAtIso: string,
):
  | { xero_status: 'synced'; xero_invoice_id: string; xero_synced_at: string }
  | { xero_status: 'pending' } {
  if (result.status === 'synced') {
    return {
      xero_status: 'synced',
      xero_invoice_id: result.xeroInvoiceId,
      xero_synced_at: syncedAtIso,
    };
  }
  return { xero_status: 'pending' };
}

function validateBillForXero(bill: BillForPush): string | null {
  if (!bill.supplier_name_raw) return 'NO_SUPPLIER: Supplier name required for Xero sync';
  if (bill.total_inc_gst_cents == null) return 'NO_TOTAL: Total amount required';
  if (!bill.invoice_date) return 'NO_DATE: Invoice date required';
  return null;
}

export async function pushBillToXero(args: PushArgs): Promise<PushResult> {
  // Not connected: send nothing, log nothing, invent no id.
  const reason = await xeroNotConnectedReason(args.admin, args.organizationId);
  if (reason) return { status: 'not_connected', reason };

  const v = validateBillForXero(args.bill);
  if (v) throw new Error(v);

  const xeroInvoiceId = await pushBillReal(args);
  return { status: 'synced', xeroInvoiceId };
}

async function pushBillReal(args: PushArgs): Promise<string> {
  const { admin, organizationId, bill, job } = args;

  // 1. Resolve / create Xero contact for the supplier
  const supplierName = bill.supplier_name_raw ?? '';
  const contactId = await resolveOrCreateContact(admin, organizationId, supplierName);

  const defaultAccount = Deno.env.get('XERO_DEFAULT_ACCOUNT_CODE') ?? '500';
  const defaultTaxType = Deno.env.get('XERO_DEFAULT_TAX_TYPE') ?? 'INPUT'; // GST on purchases

  // 2. Build the ACCPAY payload
  const xeroInvoice = {
    Type: 'ACCPAY',
    Contact: { ContactID: contactId },
    Date: bill.invoice_date, // ORIGINAL date so BAS quarter is right
    DueDate: bill.due_date ?? bill.invoice_date,
    LineAmountTypes: 'Inclusive',
    Reference: bill.invoice_number ?? bill.job_reference_raw ?? '',
    InvoiceNumber: bill.invoice_number ?? undefined,
    CurrencyCode: bill.currency_code || 'AUD',
    LineItems: (bill.line_items ?? []).map((li) => ({
      Description: li.description,
      Quantity: li.quantity,
      UnitAmount: li.unit_price_cents / 100,
      LineAmount: li.total_cents / 100,
      AccountCode: li.account_code ?? defaultAccount,
      TaxType: defaultTaxType,
      Tracking: [{ Name: 'Job', Option: job.job_number }],
    })),
    Status: 'AUTHORISED',
  };

  // 3. POST to Xero with a STABLE idempotency-key so a retry after a lost response
  // reuses the same key and Xero dedups it, rather than creating a duplicate ACCPAY.
  const idempotencyKey = await resolveXeroIdempotencyKey(undefined, [
    'xero',
    'bill',
    organizationId,
    bill.id,
  ]);
  const glEvidence = await loadGlEvidence(admin, organizationId, 'bill', bill.id);
  const data = await callXeroWithRetry<{ Invoices: { InvoiceID?: string }[] }>(
    admin,
    organizationId,
    (ctx) =>
      xeroFetch(ctx, '/api.xro/2.0/Invoices', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ Invoices: [xeroInvoice] }),
      }),
  );

  const xeroInvoiceId = data?.Invoices?.[0]?.InvoiceID;
  if (!xeroInvoiceId) {
    throw new XeroApiError('Xero did not return an InvoiceID after push', 502);
  }

  // 4. Append to sync log
  await admin.from('xero_sync_log').insert({
    organization_id: organizationId,
    record_type: 'bill',
    record_id: bill.id,
    xero_id: xeroInvoiceId,
    operation: 'push',
    status: 'success',
    idempotency_key: idempotencyKey,
    request: xeroInvoice,
    response: { ...data, looplet_gl_evidence: glEvidence },
  });

  return xeroInvoiceId;
}

async function resolveOrCreateContact(
  admin: SupabaseClient,
  organizationId: string,
  name: string,
): Promise<string> {
  // Look up existing
  const where = `Name="${name.replace(/"/g, '\\"')}"`;
  const found = await callXeroWithRetry<{ Contacts: { ContactID?: string }[] }>(
    admin,
    organizationId,
    (ctx) =>
      xeroFetch(
        ctx,
        `/api.xro/2.0/Contacts?where=${encodeURIComponent(where)}&summaryOnly=true`,
      ),
  );

  const existing = found?.Contacts?.[0];
  if (existing?.ContactID) return existing.ContactID;

  // Create with a stable idempotency key derived from the supplier name so two
  // concurrent pushes for the same supplier don't race past the check-then-create
  // and produce duplicate Xero contacts.
  const contactIdempotencyKey = await resolveXeroIdempotencyKey(undefined, [
    'xero',
    'contact',
    organizationId,
    name.trim().toLowerCase(),
  ]);
  const created = await callXeroWithRetry<{ Contacts: { ContactID?: string }[] }>(
    admin,
    organizationId,
    (ctx) =>
      xeroFetch(ctx, '/api.xro/2.0/Contacts', {
        method: 'POST',
        headers: { 'Idempotency-Key': contactIdempotencyKey },
        body: JSON.stringify({ Contacts: [{ Name: name, IsSupplier: true }] }),
      }),
  );

  const id = created?.Contacts?.[0]?.ContactID;
  if (!id) throw new XeroApiError(`Could not create Xero contact for "${name}"`, 502);
  return id;
}
