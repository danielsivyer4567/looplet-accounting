/**
 * payroll-finalise-pay-run — owner-only finalisation of a draft/approved pay run.
 *
 * POST { run_id: string }
 *
 * Flow:
 *   1. Verify caller is authenticated.
 *   2. Call DB RPC payroll_finalise_pay_run(run_id) — SECURITY DEFINER, owner-only.
 *      Sets status -> 'paid', paid_at = now(), paid_by = auth.uid().
 *   3. notify() org-wide: "Pay run finalised — $X net paid to N employees".
 *
 * Note on bookkeeping side-effects: the existing v_job_pnl.cost_wages_cents
 * already aggregates from approved timesheet_entries (which the pay run sums
 * from). So no double-write into bills/bank_transactions is needed for the
 * job-level P&L — finalisation is a payroll-state transition, not a cost
 * insertion. BAS PAYG/super tracking is computed off pay_slips directly.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function fmtMoney(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !serviceKey || !anonKey) {
    return json({ ok: false, error: 'Server config missing' }, 500);
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ ok: false, error: 'Unauthorized' }, 401);

  const userClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return json({ ok: false, error: 'Unauthorized' }, 401);

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let body: { run_id?: string };
  try { body = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }
  const { run_id } = body;
  if (!run_id) return json({ ok: false, error: 'run_id is required' }, 400);

  // Owner-only check is enforced by the RPC. Call it via the user's JWT so
  // require_role() resolves to *their* role.
  const { data: finalised, error: rpcErr } = await userClient.rpc(
    'payroll_finalise_pay_run',
    { p_run_id: run_id },
  );
  if (rpcErr) {
    const status = /only owner/i.test(rpcErr.message) ? 403
                 : /not found/i.test(rpcErr.message)  ? 404
                 : 400;
    return json({ ok: false, error: rpcErr.message }, status);
  }

  // The RPC returns a single pay_runs row.
  const run = Array.isArray(finalised) ? finalised[0] : finalised;
  if (!run) return json({ ok: false, error: 'pay run not finalised' }, 500);

  // Count employees on this run for the notification.
  const { count: employeeCount } = await admin
    .from('pay_slips')
    .select('id', { count: 'exact', head: true })
    .eq('pay_run_id', run_id);

  // Notify org-wide.
  const { error: notifyErr } = await admin.rpc('notify', {
    p_org: run.organization_id,
    p_category: 'pay_run_paid',
    p_title: 'Pay run finalised',
    p_body: `Pay period ${run.period_start} → ${run.period_end}: ${fmtMoney(Number(run.total_net_cents))} net paid to ${employeeCount ?? 0} employee(s).`,
    p_link: `/payroll/${run_id}`,
    p_severity: 'info',
    p_user_id: null,
    p_resource_type: 'pay_run',
    p_resource_id: run_id,
    p_metadata: {
      total_gross_cents: run.total_gross_cents,
      total_tax_cents: run.total_tax_cents,
      total_super_cents: run.total_super_cents,
      total_net_cents: run.total_net_cents,
      pay_date: run.pay_date,
    },
  });
  if (notifyErr) {
    // Non-fatal — the run is finalised regardless.
    console.warn('notify() failed:', notifyErr.message);
  }

  return json({
    ok: true,
    run_id,
    status: run.status,
    paid_at: run.paid_at,
    totals: {
      gross_cents: Number(run.total_gross_cents),
      tax_cents:   Number(run.total_tax_cents),
      super_cents: Number(run.total_super_cents),
      net_cents:   Number(run.total_net_cents),
    },
  });
});
