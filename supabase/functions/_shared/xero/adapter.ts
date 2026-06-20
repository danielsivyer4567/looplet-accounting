/**
 * Xero adapter — REAL implementation.
 * Deno port of Loopletnumero `services/accounting/XeroAdapter.ts`.
 *
 * Single-shot ACCPAY push on bill attachment to a job. Original-dated so
 * GST input credits land in the correct BAS quarter.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { callXeroWithRetry, xeroFetch, XeroApiError } from './auth.ts';

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

interface PushResult {
  xeroInvoiceId: string;
  isStub: boolean;
}

function isStubModeRequested(): boolean {
  return Deno.env.get('XERO_STUB_MODE') === 'true' || !Deno.env.get('XERO_CLIENT_ID');
}

function validateBillForXero(bill: BillForPush): string | null {
  if (!bill.supplier_name_raw) return 'NO_SUPPLIER: Supplier name required for Xero sync';
  if (bill.total_inc_gst_cents == null) return 'NO_TOTAL: Total amount required';
  if (!bill.invoice_date) return 'NO_DATE: Invoice date required';
  return null;
}

export async function pushBillToXero(args: PushArgs): Promise<PushResult> {
  const v = validateBillForXero(args.bill);
  if (v) throw new Error(v);

  // Decide stub vs real
  let useStub = isStubModeRequested();
  if (!useStub) {
    const { data: integ } = await args.admin
      .from('xero_integrations')
      .select('id, xero_tenant_id, is_enabled')
      .eq('organization_id', args.organizationId)
      .eq('is_enabled', true)
      .maybeSingle();
    if (!integ?.xero_tenant_id) {
      useStub = true; // No active integration → fall back to stub
    }
  }

  if (useStub) return pushBillStub(args);
  return pushBillReal(args);
}

async function pushBillStub(args: PushArgs): Promise<PushResult> {
  const stubId = `STUB-${args.bill.id.slice(0, 8).toUpperCase()}`;
  await args.admin.from('xero_sync_log').insert({
    organization_id: args.organizationId,
    record_type: 'bill',
    record_id: args.bill.id,
    xero_id: stubId,
    operation: 'push',
    status: 'success',
    idempotency_key: crypto.randomUUID(),
    request: { stub: true, jobNumber: args.job.job_number },
    response: { stub: true, id: stubId },
  });
  return { xeroInvoiceId: stubId, isStub: true };
}

async function pushBillReal(args: PushArgs): Promise<PushResult> {
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

  // 3. POST to Xero with idempotency-key
  const idempotencyKey = crypto.randomUUID();
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
    response: data,
  });

  return { xeroInvoiceId, isStub: false };
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

  // Create
  const created = await callXeroWithRetry<{ Contacts: { ContactID?: string }[] }>(
    admin,
    organizationId,
    (ctx) =>
      xeroFetch(ctx, '/api.xro/2.0/Contacts', {
        method: 'POST',
        body: JSON.stringify({ Contacts: [{ Name: name, IsSupplier: true }] }),
      }),
  );

  const id = created?.Contacts?.[0]?.ContactID;
  if (!id) throw new XeroApiError(`Could not create Xero contact for "${name}"`, 502);
  return id;
}
