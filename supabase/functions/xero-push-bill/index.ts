/**
 * xero-push-bill — POSTs a single bill as an ACCPAY invoice to Xero.
 *
 * Input:  { organization_id: string, bill_id: string }
 * Output: { ok: true, xero_invoice_id: string, was_stub: boolean }
 *
 * Behaviour:
 *   - Looks up the bill + its supplier (xero_contact_id).
 *   - If supplier has no xero_contact_id, creates a Xero Contact first and
 *     stores the returned ContactID back on the suppliers row.
 *   - Account code resolved in priority order:
 *       1. intake_rules.xero_account_code_override for the supplier
 *       2. suppliers.default_account_code
 *       3. XERO_DEFAULT_ACCOUNT_CODE env var (default '500')
 *   - Tax type resolved:
 *       1. intake_rules.xero_tax_type_override
 *       2. 'INPUT' (AU GST on purchases) if supplier has ABN, else 'NONE'
 *   - On success: sets bills.xero_invoice_id, xero_status='synced', xero_synced_at
 *   - On failure: sets xero_status='failed', increments metadata.xero_attempts.
 *     Refuses to push if xero_attempts >= 3 (returns 409).
 *
 * Idempotent: if xero_invoice_id already set and xero_status='synced', returns
 * immediately without re-pushing.
 *
 * Called fire-and-forget from the frontend after bills.status flips to 'paid',
 * or from the "Re-push to Xero" button on error/null status.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { callXeroWithRetry, xeroFetch, XeroApiError } from '../_shared/xero/auth.ts';
import { computeNextAttemptAt, deriveXeroIdempotencyKey } from '../_shared/xero/idempotency.ts';
import { requireEnv } from '../_shared/env.ts';

const MAX_ATTEMPTS = 3;
const DEFAULT_ACCOUNT_CODE = Deno.env.get('XERO_DEFAULT_ACCOUNT_CODE') ?? '500';
const DEFAULT_TAX_TYPE = 'INPUT'; // AU GST on purchases

interface BillRow {
  id: string;
  organization_id: string;
  supplier_id: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  total_inc_gst_cents: number | null;
  gst_cents: number | null;
  subtotal_ex_gst_cents: number | null;
  currency_code: string;
  supplier_name_raw: string | null;
  job_reference_raw: string | null;
  status: string;
  xero_status: string | null;
  xero_invoice_id: string | null;
  metadata: Record<string, unknown>;
  supplier: {
    id: string;
    name: string;
    abn: string | null;
    default_account_code: string | null;
    xero_contact_id: string | null;
  } | null;
}

interface BillLineItem {
  description: string;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
  gst_cents: number;
  account_code: string | null;
}

interface IntakeRule {
  xero_account_code_override: string | null;
  xero_tax_type_override: string | null;
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
    const body = (await req.json()) as { organization_id?: string; bill_id?: string };
    if (!body.organization_id || !body.bill_id) {
      return json({ ok: false, error: 'organization_id and bill_id required' }, 400);
    }
    const { organization_id, bill_id } = body;

    // Verify caller has org access
    const { data: org } = await userClient
      .from('organizations')
      .select('id')
      .eq('id', organization_id)
      .maybeSingle();
    if (!org) return json({ ok: false, error: 'Organisation not accessible' }, 403);

    // Load bill with supplier
    const { data: bill, error: billErr } = await admin
      .from('bills')
      .select(`
        id, organization_id, supplier_id, invoice_number, invoice_date, due_date,
        total_inc_gst_cents, gst_cents, subtotal_ex_gst_cents, currency_code,
        supplier_name_raw, job_reference_raw, status, xero_status, xero_invoice_id, metadata,
        supplier:suppliers!bills_supplier_id_fkey(
          id, name, abn, default_account_code, xero_contact_id
        )
      `)
      .eq('id', bill_id)
      .eq('organization_id', organization_id)
      .maybeSingle();

    if (billErr) return json({ ok: false, error: billErr.message }, 500);
    if (!bill) return json({ ok: false, error: 'Bill not found' }, 404);

    const b = bill as unknown as BillRow;

    // Idempotency: already synced
    if (b.xero_status === 'synced' && b.xero_invoice_id) {
      return json({ ok: true, xero_invoice_id: b.xero_invoice_id, already_synced: true });
    }

    // Check attempt count
    const attempts = ((b.metadata?.xero_attempts as number) ?? 0);
    if (attempts >= MAX_ATTEMPTS) {
      return json({
        ok: false,
        error: `Max push attempts (${MAX_ATTEMPTS}) reached. Fix the error then use Re-push.`,
        xero_attempts: attempts,
      }, 409);
    }

    // Validate bill has minimum required fields
    if (!b.total_inc_gst_cents) {
      return json({ ok: false, error: 'Bill has no total amount — cannot push to Xero' }, 422);
    }
    if (!b.invoice_date) {
      return json({ ok: false, error: 'Bill has no invoice date — cannot push to Xero' }, 422);
    }
    const supplierName = b.supplier?.name ?? b.supplier_name_raw;
    if (!supplierName) {
      return json({ ok: false, error: 'Bill has no supplier name — cannot push to Xero' }, 422);
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

    // Resolve intake rule overrides for this supplier
    let accountCode = b.supplier?.default_account_code ?? DEFAULT_ACCOUNT_CODE;
    let taxType = b.supplier?.abn ? DEFAULT_TAX_TYPE : 'NONE';

    if (b.supplier_id) {
      const { data: rule } = await admin
        .from('intake_rules')
        .select('xero_account_code_override, xero_tax_type_override')
        .eq('organization_id', organization_id)
        .eq('supplier_id', b.supplier_id)
        .eq('is_active', true)
        .order('matcher_priority', { ascending: false })
        .limit(1)
        .maybeSingle();

      const r = rule as IntakeRule | null;
      if (r?.xero_account_code_override) accountCode = r.xero_account_code_override;
      if (r?.xero_tax_type_override) taxType = r.xero_tax_type_override;
    }

    // Resolve or create Xero contact for supplier
    const contactId = await resolveOrCreateContact(
      admin,
      organization_id,
      supplierName,
      b.supplier?.id ?? null,
      b.supplier?.xero_contact_id ?? null,
      true, // isSupplier
    );

    // Load line items
    const { data: lineItems } = await admin
      .from('bill_line_items')
      .select('description, quantity, unit_price_cents, total_cents, gst_cents, account_code')
      .eq('bill_id', bill_id)
      .order('line_number');

    const lines = (lineItems ?? []) as BillLineItem[];

    // Build Xero ACCPAY payload
    const xeroLines =
      lines.length > 0
        ? lines.map((li) => ({
            Description: li.description,
            Quantity: li.quantity,
            UnitAmount: li.unit_price_cents / 100,
            LineAmount: li.total_cents / 100,
            AccountCode: li.account_code ?? accountCode,
            TaxType: taxType,
          }))
        : [
            {
              Description: b.supplier_name_raw ?? 'Bill',
              Quantity: 1,
              UnitAmount: b.total_inc_gst_cents / 100,
              LineAmount: b.total_inc_gst_cents / 100,
              AccountCode: accountCode,
              TaxType: taxType,
            },
          ];

    const xeroInvoice = {
      Type: 'ACCPAY',
      Contact: { ContactID: contactId },
      Date: b.invoice_date,
      DueDate: b.due_date ?? b.invoice_date,
      LineAmountTypes: 'Inclusive',
      Reference: b.invoice_number ?? b.job_reference_raw ?? '',
      InvoiceNumber: b.invoice_number ?? undefined,
      CurrencyCode: b.currency_code || 'AUD',
      LineItems: xeroLines,
      Status: 'AUTHORISED',
    };

    // STABLE Xero Idempotency-Key: derived from org+kind+id so every retry of
    // this push REUSES the same key. Xero dedupes server-side, so a retry after
    // a timeout / unknown-result returns the existing invoice rather than
    // creating a DUPLICATE ACCPAY. Persisted on the durable push queue.
    const idempotencyKey = await deriveXeroIdempotencyKey(organization_id, 'bill', bill_id);
    const nowIso = new Date().toISOString();
    await admin.from('xero_push_queue').upsert(
      {
        organization_id,
        record_type: 'bill',
        record_id: bill_id,
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

      // Success — update bill
      await admin.from('bills').update({
        xero_invoice_id: xeroInvoiceId,
        xero_status: 'synced',
        xero_synced_at: new Date().toISOString(),
        metadata: { ...b.metadata, xero_attempts: attempts + 1, last_xero_error: null },
      }).eq('id', bill_id);

      // Mark the durable queue row synced.
      await admin.from('xero_push_queue').update({
        status: 'synced',
        xero_invoice_id: xeroInvoiceId,
        last_error: null,
        last_http_status: null,
        next_attempt_at: null,
      }).eq('organization_id', organization_id).eq('record_type', 'bill').eq('record_id', bill_id);

      // Append to sync log (per-attempt UNIQUE audit row — NOT the Xero header key).
      await admin.from('xero_sync_log').insert({
        organization_id,
        record_type: 'bill',
        record_id: bill_id,
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

      // Update bill with failure state
      await admin.from('bills').update({
        xero_status: 'failed',
        metadata: {
          ...b.metadata,
          xero_attempts: attempts + 1,
          last_xero_error: msg.slice(0, 500),
        },
      }).eq('id', bill_id);

      // Mark the durable queue row failed + record HTTP status for backoff.
      await admin.from('xero_push_queue').update({
        status: 'failed',
        last_error: msg.slice(0, 500),
        last_http_status: httpStatus,
        next_attempt_at: computeNextAttemptAt(httpStatus, attempts + 1),
      }).eq('organization_id', organization_id).eq('record_type', 'bill').eq('record_id', bill_id);

      // Append failure to sync log (fresh UNIQUE audit key; stable key in payload_hash).
      await admin.from('xero_sync_log').insert({
        organization_id,
        record_type: 'bill',
        record_id: bill_id,
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
 * Resolves a Xero ContactID for the given name.
 * Lookup order: local DB cache → Xero search by name → create new contact.
 * Stores the resolved ContactID back on suppliers/customers row if an id provided.
 */
async function resolveOrCreateContact(
  admin: ReturnType<typeof createClient>,
  organizationId: string,
  name: string,
  localId: string | null,
  cachedContactId: string | null,
  isSupplier: boolean,
): Promise<string> {
  // 1. Use cached ID if present
  if (cachedContactId) return cachedContactId;

  // 2. Search Xero by name
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
    // Cache it back
    if (localId) {
      const table = isSupplier ? 'suppliers' : 'customers';
      await admin.from(table).update({ xero_contact_id: existing.ContactID }).eq('id', localId);
    }
    return existing.ContactID;
  }

  // 3. Create new Xero contact
  const created = await callXeroWithRetry<{ Contacts: { ContactID?: string }[] }>(
    admin,
    organizationId,
    (ctx) =>
      xeroFetch(ctx, '/api.xro/2.0/Contacts', {
        method: 'POST',
        body: JSON.stringify({
          Contacts: [
            {
              Name: name,
              IsSupplier: isSupplier,
              IsCustomer: !isSupplier,
            },
          ],
        }),
      }),
  );

  const id = created?.Contacts?.[0]?.ContactID;
  if (!id) throw new XeroApiError(`Could not create Xero contact for "${name}"`, 502);

  // Cache it back
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
