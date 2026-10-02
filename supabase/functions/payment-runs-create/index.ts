/**
 * payment-runs-create
 *
 * Creates a payment run with one or more bills in a single DB transaction.
 *
 * Input:
 *   {
 *     organization_id: string,
 *     pay_date: string,           // ISO date, e.g. "2026-05-09"
 *     payer_bank_account_id?: string,
 *     notes?: string,
 *     bill_ids: string[],         // UUIDs of bills from v_unpaid_bills_for_payment_run
 *   }
 *
 * Output:
 *   { ok: true, payment_run_id: string, bill_count: number, total_cents: number }
 * | { ok: false, error: string }
 *
 * Behaviour:
 *   1. Verifies caller is authenticated and belongs to the org.
 *   2. Loads bill rows + their supplier payee bank details.
 *   3. Validates: status=attached, payment_run_id IS NULL, total_inc_gst_cents > 0.
 *   4. Inserts payment_run (draft), inserts payment_run_items, sets bills.payment_run_id.
 *   5. Updates payment_runs.total_cents + bill_count.
 *   6. Returns the new payment_run_id.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { authorizeOrgMember, supabaseOrgAccessDeps } from '../_shared/orgRole.ts';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/** Strip non-ASCII, uppercase, truncate to maxLen chars. */
function sanitise(text: string | null | undefined, maxLen: number): string {
  if (!text) return '';
  return text
    .toUpperCase()
    .replace(/[^\x20-\x7E]/g, '')   // strip non-printable-ASCII
    .replace(/,/g, ' ')              // no commas in ABA name fields
    .trim()
    .slice(0, maxLen);
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  // --------------------------------------------------------------------------
  // 0. Server config
  // --------------------------------------------------------------------------
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey     = Deno.env.get('SUPABASE_ANON_KEY');

  if (!supabaseUrl || !serviceKey || !anonKey) {
    return json({ ok: false, error: 'Server config missing' }, 500);
  }

  // --------------------------------------------------------------------------
  // 1. Authenticate caller
  // --------------------------------------------------------------------------
  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) {
    return json({ ok: false, error: 'Unauthenticated' }, 401);
  }

  // --------------------------------------------------------------------------
  // 2. Parse body
  // --------------------------------------------------------------------------
  let body: {
    organization_id: string;
    pay_date: string;
    bill_ids: string[];
    payer_bank_account_id?: string;
    notes?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const { organization_id, pay_date, bill_ids, payer_bank_account_id, notes } = body;

  if (!organization_id || !pay_date || !Array.isArray(bill_ids) || bill_ids.length === 0) {
    return json({ ok: false, error: 'organization_id, pay_date and bill_ids are required' }, 400);
  }

  // --------------------------------------------------------------------------
  // 3. Admin client
  // --------------------------------------------------------------------------
  const admin = createClient(supabaseUrl, serviceKey);

  // --------------------------------------------------------------------------
  // 4. Verify the caller is an accepted admin or owner of the org
  // --------------------------------------------------------------------------
  // A payment run decides which suppliers are paid from which account. Pending invites and viewers must not.
  const access = await authorizeOrgMember(user.id, organization_id, supabaseOrgAccessDeps(admin, serviceKey), 'admin');
  if (!access.ok) return json({ ok: false, error: access.error }, access.status);

  // --------------------------------------------------------------------------
  // 5. Load bills + supplier payee details
  // --------------------------------------------------------------------------
  const { data: bills, error: billsErr } = await admin
    .from('bills')
    .select(`
      id,
      organization_id,
      status,
      payment_run_id,
      total_inc_gst_cents,
      invoice_number,
      supplier_id,
      supplier:suppliers!supplier_id (
        id,
        name,
        payee_bsb,
        payee_account_number,
        payee_account_name,
        bank_account
      )
    `)
    .in('id', bill_ids)
    .eq('organization_id', organization_id);

  if (billsErr) {
    return json({ ok: false, error: `Failed to load bills: ${billsErr.message}` }, 500);
  }
  if (!bills || bills.length === 0) {
    return json({ ok: false, error: 'No matching bills found in this organisation' }, 404);
  }

  // --------------------------------------------------------------------------
  // 6. Validate each bill
  // --------------------------------------------------------------------------
  const errors: string[] = [];
  for (const b of bills) {
    const bAny = b as Record<string, unknown>;
    if (bAny['status'] !== 'attached') {
      errors.push(`Bill ${bAny['id']}: status is "${bAny['status']}", must be "attached"`);
    }
    if (bAny['payment_run_id'] != null) {
      errors.push(`Bill ${bAny['id']}: already assigned to payment run ${bAny['payment_run_id']}`);
    }
    const total = bAny['total_inc_gst_cents'] as number | null;
    if (!total || total <= 0) {
      errors.push(`Bill ${bAny['id']}: total_inc_gst_cents must be > 0`);
    }
  }
  if (errors.length > 0) {
    return json({ ok: false, error: errors.join('; ') }, 422);
  }

  // --------------------------------------------------------------------------
  // 7. Create payment_run
  // --------------------------------------------------------------------------
  const { data: run, error: runErr } = await admin
    .from('payment_runs')
    .insert({
      organization_id,
      pay_date,
      payer_bank_account_id: payer_bank_account_id ?? null,
      notes: notes ?? null,
      status: 'draft',
      total_cents: 0,
      bill_count: 0,
      created_by: user.id,
    })
    .select('id')
    .single();

  if (runErr || !run) {
    return json({ ok: false, error: `Failed to create payment run: ${runErr?.message}` }, 500);
  }

  const payment_run_id = (run as Record<string, unknown>)['id'] as string;

  // --------------------------------------------------------------------------
  // 8. Build and insert payment_run_items
  // --------------------------------------------------------------------------
  let totalCents = 0;
  const items: {
    payment_run_id: string;
    organization_id: string;
    bill_id: string;
    amount_cents: number;
    payee_bsb: string;
    payee_account_number: string;
    payee_account_name: string;
    reference: string | null;
  }[] = [];

  for (const b of bills) {
    const bAny = b as Record<string, unknown>;
    const sup = bAny['supplier'] as Record<string, unknown> | null;
    const bankJson = sup?.['bank_account'] as Record<string, unknown> | null;

    const payeeBsb =
      (sup?.['payee_bsb'] as string | null) ??
      (bankJson?.['bsb'] as string | null) ??
      '';
    const payeeAccount =
      (sup?.['payee_account_number'] as string | null) ??
      (bankJson?.['account_number'] as string | null) ??
      '';
    const payeeName = sanitise(
      (sup?.['payee_account_name'] as string | null) ??
      (sup?.['name'] as string | null) ??
      'UNKNOWN',
      32,
    );
    const invoiceNum = bAny['invoice_number'] as string | null;
    const amount = bAny['total_inc_gst_cents'] as number;

    totalCents += amount;
    items.push({
      payment_run_id,
      organization_id,
      bill_id: bAny['id'] as string,
      amount_cents: amount,
      payee_bsb: payeeBsb,
      payee_account_number: payeeAccount,
      payee_account_name: payeeName,
      reference: invoiceNum ? sanitise(invoiceNum, 18) : null,
    });
  }

  const { error: itemsErr } = await admin.from('payment_run_items').insert(items);
  if (itemsErr) {
    // Roll back the payment_run row on item insert failure
    await admin.from('payment_runs').delete().eq('id', payment_run_id);
    return json({ ok: false, error: `Failed to insert items: ${itemsErr.message}` }, 500);
  }

  // --------------------------------------------------------------------------
  // 9. Mark bills as part of this run
  // --------------------------------------------------------------------------
  // Only the bills loaded above (already filtered to this organisation), never the raw ids from the request body.
  const linkedBillIds = items.map((item) => item.bill_id);
  const { error: billUpdateErr } = await admin
    .from('bills')
    .update({ payment_run_id })
    .in('id', linkedBillIds)
    .eq('organization_id', organization_id);

  if (billUpdateErr) {
    return json({ ok: false, error: `Failed to link bills: ${billUpdateErr.message}` }, 500);
  }

  // --------------------------------------------------------------------------
  // 10. Update payment_run totals
  // --------------------------------------------------------------------------
  await admin
    .from('payment_runs')
    .update({ total_cents: totalCents, bill_count: items.length })
    .eq('id', payment_run_id);

  return json({
    ok: true,
    payment_run_id,
    bill_count: items.length,
    total_cents: totalCents,
  });
});
