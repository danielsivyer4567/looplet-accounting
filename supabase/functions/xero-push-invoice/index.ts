/**
 * xero-push-invoice — POSTs a single customer invoice as ACCREC to Xero.
 *
 * Input:  { organization_id: string, invoice_id: string }
 * Output: { ok: true, xero_invoice_id: string }
 *
 * Behaviour mirrors xero-push-bill:
 *   - Resolves customer → Xero Contact (creates if missing, stores xero_contact_id)
 *   - Account code priority: intake_rules.xero_account_code_override → '200' (AU sales default)
 *   - Tax type: 'OUTPUT' (GST on sales, AU default) unless overridden
 *   - On success: sets invoices.xero_invoice_id, xero_status='synced', xero_synced_at
 *   - On failure: sets xero_status='failed', increments metadata.xero_attempts (max 3)
 *
 * Idempotent: already-synced invoices return immediately.
 *
 * Called fire-and-forget when invoice.status transitions to 'sent',
 * or from the "Re-push to Xero" button.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { requireEnv } from '../_shared/env.ts';
import { callXeroWithRetry, xeroFetch, XeroApiError } from '../_shared/xero/auth.ts';
import { computeNextAttemptAt, deriveXeroIdempotencyKey } from '../_shared/xero/idempotency.ts';

const MAX_ATTEMPTS = 3;
const DEFAULT_ACCOUNT_CODE = Deno.env.get('XERO_DEFAULT_INCOME_ACCOUNT_CODE') ?? '200';
const DEFAULT_TAX_TYPE = 'OUTPUT'; // GST on sales (AU)

interface InvoiceRow {
  id: string;
  organization_id: string;
  customer_id: string;
  invoice_number: string;
  issue_date: string;
  due_date: string;
  total_inc_gst_cents: number;
  gst_cents: number;
  subtotal_ex_gst_cents: number;
  currency_code: string;
  notes: string | null;
  status: string;
  xero_status: string | null;
  xero_invoice_id: string | null;
  metadata: Record<string, unknown>;
  customer: {
    id: string;
    name: string;
    email: string | null;
    xero_contact_id: string | null;
  } | null;
}

interface InvoiceLineItem {
  description: string;
  quantity: number;
  unit_price_cents: number;
  line_total_inc_gst_cents: number;
  line_gst_cents: number;
  account_code: string | null;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ ok: false, error: 'Unauthorized' }, 401);

  const supabaseUrl = requireEnv('SUPABASE_URL');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = requireEnv('SUPABASE_ANON_KEY');

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  try {
    const body = (await req.json()) as { organization_id?: string; invoice_id?: string };
    if (!body.organization_id || !body.invoice_id) {
      return json({ ok: false, error: 'organization_id and invoice_id required' }, 400);
    }
    const { organization_id, invoice_id } = body;

    // Verify caller has org access
    const { data: org } = await userClient
      .from('organizations')
      .select('id')
      .eq('id', organization_id)
      .maybeSingle();
    if (!org) return json({ ok: false, error: 'Organisation not accessible' }, 403);

    // Load invoice with customer
    const { data: invoice, error: invErr } = await admin
      .from('invoices')
      .select(`
        id, organization_id, customer_id, invoice_number, issue_date, due_date,
        total_inc_gst_cents, gst_cents, subtotal_ex_gst_cents, currency_code, notes,
        status, xero_status, xero_invoice_id, metadata,
        customer:customers!invoices_customer_id_fkey(id, name, email, xero_contact_id)
      `)
      .eq('id', invoice_id)
      .eq('organization_id', organization_id)
      .maybeSingle();

    if (invErr) return json({ ok: false, error: invErr.message }, 500);
    if (!invoice) return json({ ok: false, error: 'Invoice not found' }, 404);

    const inv = invoice as unknown as InvoiceRow;

    // Idempotency: already synced
    if (inv.xero_status === 'synced' && inv.xero_invoice_id) {
      return json({ ok: true, xero_invoice_id: inv.xero_invoice_id, already_synced: true });
    }

    // Check attempt cap
    const attempts = ((inv.metadata?.xero_attempts as number) ?? 0);
    if (attempts >= MAX_ATTEMPTS) {
      return json({
        ok: false,
        error: `Max push attempts (${MAX_ATTEMPTS}) reached. Fix the error then use Re-push.`,
        xero_attempts: attempts,
      }, 409);
    }

    // Validate
    if (!inv.customer) {
      return json({ ok: false, error: 'Invoice has no customer — cannot push to Xero' }, 422);
    }
    if (!inv.issue_date) {
      return json({ ok: false, error: 'Invoice has no issue date — cannot push to Xero' }, 422);
    }

    // Check Xero integration active
    const { data: integration } = await admin
      .from('xero_integrations')
      .select('id, is_enabled, xero_tenant_id')
      .eq('organization_id', organization_id)
      .eq('is_enabled', true)
      .maybeSingle();

    if (!integration?.xero_tenant_id) {
      return json({ ok: false, error: 'Xero is not connected for this organisation' }, 400);
    }

    // Resolve account code from intake_rules (customer-level overrides)
    let accountCode = DEFAULT_ACCOUNT_CODE;
    let taxType = DEFAULT_TAX_TYPE;

    if (inv.customer_id) {
      const { data: rule } = await admin
        .from('intake_rules')
        .select('xero_account_code_override, xero_tax_type_override')
        .eq('organization_id', organization_id)
        .eq('customer_id', inv.customer_id)
        .eq('is_active', true)
        .order('matcher_priority', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (rule?.xero_account_code_override) accountCode = rule.xero_account_code_override;
      if (rule?.xero_tax_type_override) taxType = rule.xero_tax_type_override;
    }

    // Resolve or create Xero contact for customer
    const contactId = await resolveOrCreateContact(
      admin,
      organization_id,
      inv.customer.name,
      inv.customer.id,
      inv.customer.xero_contact_id,
      false, // isSupplier = false
    );

    // Load line items
    const { data: lineItems } = await admin
      .from('invoice_line_items')
      .select('description, quantity, unit_price_cents, line_total_inc_gst_cents, line_gst_cents, account_code')
      .eq('invoice_id', invoice_id)
      .order('line_number');

    const lines = (lineItems ?? []) as InvoiceLineItem[];

    const xeroLines =
      lines.length > 0
        ? lines.map((li) => ({
            Description: li.description,
            Quantity: li.quantity,
            UnitAmount: li.unit_price_cents / 100,
            LineAmount: li.line_total_inc_gst_cents / 100,
            AccountCode: li.account_code ?? accountCode,
            TaxType: taxType,
          }))
        : [
            {
              Description: `Invoice ${inv.invoice_number}`,
              Quantity: 1,
              UnitAmount: inv.total_inc_gst_cents / 100,
              LineAmount: inv.total_inc_gst_cents / 100,
              AccountCode: accountCode,
              TaxType: taxType,
            },
          ];

    const xeroInvoice = {
      Type: 'ACCREC',
      Contact: { ContactID: contactId },
      Date: inv.issue_date,
      DueDate: inv.due_date,
      LineAmountTypes: 'Inclusive',
      Reference: inv.invoice_number,
      InvoiceNumber: inv.invoice_number,
      CurrencyCode: inv.currency_code || 'AUD',
      LineItems: xeroLines,
      Status: 'AUTHORISED',
    };

    // STABLE Xero Idempotency-Key: derived from org+kind+id so every retry of
    // this push REUSES the same key. Xero dedupes server-side, so a retry after
    // a timeout / unknown-result returns the existing invoice rather than
    // creating a DUPLICATE ACCREC. Persisted on the durable push queue.
    const idempotencyKey = await deriveXeroIdempotencyKey(organization_id, 'invoice', invoice_id);
    const nowIso = new Date().toISOString();
    await admin.from('xero_push_queue').upsert(
      {
        organization_id,
        record_type: 'invoice',
        record_id: invoice_id,
        idempotency_key: idempotencyKey,
        status: 'pending',
        attempts: attempts + 1,
        max_attempts: MAX_ATTEMPTS,
        last_attempt_at: nowIso,
      },
      { onConflict: 'organization_id,record_type,record_id' },
    );

    try {
      const data = await callXeroWithRetry<{ Invoices: { InvoiceID?: string }[] }>(
        admin,
        organization_id,
        (ctx) =>
          xeroFetch(ctx, '/api.xro/2.0/Invoices', {
            method: 'POST',
            headers: { 'Idempotency-Key': idempotencyKey },
            body: JSON.stringify({ Invoices: [xeroInvoice] }),
          }),
      );

      const xeroInvoiceId = data?.Invoices?.[0]?.InvoiceID;
      if (!xeroInvoiceId) {
        throw new XeroApiError('Xero did not return an InvoiceID', 502);
      }

      // Success — update invoice
      await admin.from('invoices').update({
        xero_invoice_id: xeroInvoiceId,
        xero_status: 'synced',
        xero_synced_at: new Date().toISOString(),
        metadata: { ...inv.metadata, xero_attempts: attempts + 1, last_xero_error: null },
      }).eq('id', invoice_id);

      // Mark the durable queue row synced.
      await admin.from('xero_push_queue').update({
        status: 'synced',
        xero_invoice_id: xeroInvoiceId,
        last_error: null,
        last_http_status: null,
        next_attempt_at: null,
      }).eq('organization_id', organization_id).eq('record_type', 'invoice').eq('record_id', invoice_id);

      // Append to sync log (per-attempt UNIQUE audit row — NOT the Xero header key).
      await admin.from('xero_sync_log').insert({
        organization_id,
        record_type: 'invoice',
        record_id: invoice_id,
        xero_id: xeroInvoiceId,
        operation: 'push',
        status: 'success',
        payload_hash: idempotencyKey,
        idempotency_key: crypto.randomUUID(),
        request: xeroInvoice,
        response: data,
      });

      return json({ ok: true, xero_invoice_id: xeroInvoiceId, was_stub: false });
    } catch (pushErr) {
      const msg = pushErr instanceof Error ? pushErr.message : String(pushErr);
      const httpStatus = pushErr instanceof XeroApiError ? pushErr.status : null;

      await admin.from('invoices').update({
        xero_status: 'failed',
        metadata: {
          ...inv.metadata,
          xero_attempts: attempts + 1,
          last_xero_error: msg.slice(0, 500),
        },
      }).eq('id', invoice_id);

      // Mark the durable queue row failed + record HTTP status for backoff.
      await admin.from('xero_push_queue').update({
        status: 'failed',
        last_error: msg.slice(0, 500),
        last_http_status: httpStatus,
        next_attempt_at: computeNextAttemptAt(httpStatus, attempts + 1),
      }).eq('organization_id', organization_id).eq('record_type', 'invoice').eq('record_id', invoice_id);

      await admin.from('xero_sync_log').insert({
        organization_id,
        record_type: 'invoice',
        record_id: invoice_id,
        xero_id: null,
        operation: 'push',
        status: 'failed',
        error_message: msg.slice(0, 500),
        payload_hash: idempotencyKey,
        idempotency_key: crypto.randomUUID(),
        request: xeroInvoice,
        response: null,
      });

      return json({ ok: false, error: msg, xero_attempts: attempts + 1 }, 500);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

/**
 * Same contact resolution logic as xero-push-bill.
 * Searches Xero by name, creates if not found, persists ContactID locally.
 */
async function resolveOrCreateContact(
  admin: ReturnType<typeof createClient>,
  organizationId: string,
  name: string,
  localId: string | null,
  cachedContactId: string | null,
  isSupplier: boolean,
): Promise<string> {
  if (cachedContactId) return cachedContactId;

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
  if (existing?.ContactID) {
    if (localId) {
      const table = isSupplier ? 'suppliers' : 'customers';
      await admin.from(table).update({ xero_contact_id: existing.ContactID }).eq('id', localId);
    }
    return existing.ContactID;
  }

  const created = await callXeroWithRetry<{ Contacts: { ContactID?: string }[] }>(
    admin,
    organizationId,
    (ctx) =>
      xeroFetch(ctx, '/api.xro/2.0/Contacts', {
        method: 'POST',
        body: JSON.stringify({
          Contacts: [{ Name: name, IsSupplier: isSupplier, IsCustomer: !isSupplier }],
        }),
      }),
  );

  const id = created?.Contacts?.[0]?.ContactID;
  if (!id) throw new XeroApiError(`Could not create Xero contact for "${name}"`, 502);

  if (localId) {
    const table = isSupplier ? 'suppliers' : 'customers';
    await admin.from(table).update({ xero_contact_id: id }).eq('id', localId);
  }

  return id;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
