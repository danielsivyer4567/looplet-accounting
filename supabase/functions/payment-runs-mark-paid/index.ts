/**
 * payment-runs-mark-paid
 *
 * Marks a payment run and all its bills as paid after successful bank upload.
 *
 * Input:
 *   { payment_run_id: string }
 *
 * Output:
 *   { ok: true, bills_updated: number }
 * | { ok: false, error: string }
 *
 * Behaviour:
 *   1. Verifies caller is authenticated.
 *   2. Loads payment_run → derives org for auth check.
 *   3. Validates status is 'exported' (must have generated the ABA file first).
 *   4. For every payment_run_items.bill_id: sets bills.status='paid', bills.paid_at=pay_date.
 *   5. Sets payment_runs.status='paid'.
 *   6. Returns count of bills updated.
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

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey     = Deno.env.get('SUPABASE_ANON_KEY');

  if (!supabaseUrl || !serviceKey || !anonKey) {
    return json({ ok: false, error: 'Server config missing' }, 500);
  }

  // Authenticate
  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) {
    return json({ ok: false, error: 'Unauthenticated' }, 401);
  }

  let body: { payment_run_id: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const { payment_run_id } = body;
  if (!payment_run_id) {
    return json({ ok: false, error: 'payment_run_id is required' }, 400);
  }

  const admin = createClient(supabaseUrl, serviceKey);

  // Load payment_run to get org + status + pay_date
  const { data: run, error: runErr } = await admin
    .from('payment_runs')
    .select('id, organization_id, status, pay_date')
    .eq('id', payment_run_id)
    .maybeSingle();

  if (runErr || !run) {
    return json({ ok: false, error: 'Payment run not found' }, 404);
  }

  const runRow = run as Record<string, unknown>;
  const organization_id = runRow['organization_id'] as string;
  const status   = runRow['status'] as string;
  const pay_date = runRow['pay_date'] as string;

  // Marking a run paid settles its bills in the books: accepted admins and owners only.
  const access = await authorizeOrgMember(user.id, organization_id, supabaseOrgAccessDeps(admin, serviceKey), 'admin');
  if (!access.ok) return json({ ok: false, error: access.error }, access.status);

  // Allow marking as paid from approved or exported state
  if (status !== 'exported' && status !== 'approved') {
    return json({
      ok: false,
      error: `Payment run status is "${status}". Must be "approved" or "exported" to mark as paid.`,
    }, 409);
  }

  // Load bill IDs from items
  const { data: items, error: itemsErr } = await admin
    .from('payment_run_items')
    .select('bill_id')
    .eq('payment_run_id', payment_run_id);

  if (itemsErr) {
    return json({ ok: false, error: `Failed to load items: ${itemsErr.message}` }, 500);
  }
  if (!items || items.length === 0) {
    return json({ ok: false, error: 'Payment run has no items' }, 422);
  }

  const billIds = (items as Record<string, unknown>[]).map((r) => r['bill_id'] as string);

  // Update bills: paid_at = pay_date, status = 'paid'
  const { error: billsErr, count } = await admin
    .from('bills')
    .update({ status: 'paid', paid_at: pay_date })
    .in('id', billIds);

  if (billsErr) {
    return json({ ok: false, error: `Failed to update bills: ${billsErr.message}` }, 500);
  }

  // Update payment_run status
  await admin
    .from('payment_runs')
    .update({ status: 'paid' })
    .eq('id', payment_run_id);

  return json({ ok: true, bills_updated: count ?? billIds.length });
});
