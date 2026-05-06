/**
 * payroll-export-stp — generate Single Touch Payroll (STP) Phase 2 JSON for a
 * pay run, ready for handoff to a registered tax/BAS agent for SBR lodgement.
 *
 * POST { run_id: string }
 *
 * Output structure (STP Phase 2 — simplified):
 *   {
 *     header: { abn, bms_id, software, run_date, ... },
 *     pay_event: {
 *       period_start, period_end, pay_date,
 *       totals: { gross, payg, super, net },
 *       employees: [
 *         {
 *           tfn, name, address,
 *           ytd: { gross, payg, super },
 *           pay: {
 *             gross_ordinary_cents, gross_overtime_cents, gross_leave_cents,
 *             ote_cents, payg_tax_cents, super_guarantee_cents, net_pay_cents,
 *             hours: { ordinary, overtime, leave }
 *           }
 *         }, ...
 *       ]
 *     }
 *   }
 *
 * NOTE: actual ATO submission requires SBR (Standard Business Reporting)
 * gateway integration — out of scope. This file is for tax-agent lodgement.
 *
 * Auth: Bearer JWT, caller must be admin+ for the org.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';

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

  // Caller must be admin+ for the run's org.
  const { data: run, error: runErr } = await admin
    .from('pay_runs')
    .select('*')
    .eq('id', run_id)
    .single();
  if (runErr || !run) return json({ ok: false, error: 'pay_run not found' }, 404);

  const { data: callerMembership } = await userClient
    .from('organization_memberships')
    .select('role_enum')
    .eq('user_id', user.id)
    .eq('organization_id', run.organization_id)
    .maybeSingle();
  if (!callerMembership || !['admin', 'owner'].includes(callerMembership.role_enum ?? '')) {
    return json({ ok: false, error: 'Only admin or owner can export STP' }, 403);
  }

  // Org-level info (ABN etc.) lives in organizations.settings.
  const { data: org } = await admin
    .from('organizations')
    .select('id, name, settings')
    .eq('id', run.organization_id)
    .single();

  // Fetch slips + employees joined.
  const { data: slips, error: slipsErr } = await admin
    .from('pay_slips')
    .select(`
      hours_ordinary, hours_overtime, hours_leave,
      gross_ordinary_cents, gross_overtime_cents, gross_leave_cents, gross_total_cents,
      payg_tax_cents, super_guarantee_cents, super_rate_pct, net_pay_cents,
      ytd_gross_cents, ytd_tax_cents, ytd_super_cents,
      employee:employees!inner(id, full_name, email, wage_components)
    `)
    .eq('pay_run_id', run_id);
  if (slipsErr) return json({ ok: false, error: slipsErr.message }, 500);

  type EmpJoin = {
    id: string; full_name: string; email: string | null;
    wage_components: Record<string, unknown> | null;
  };

  const stp = {
    schema: 'stp_phase2_v1',
    generated_at: new Date().toISOString(),
    generated_by: user.email ?? user.id,
    header: {
      employer_abn:   (org?.settings as Record<string, unknown> | null)?.abn ?? null,
      employer_name:  org?.name ?? null,
      bms_id:         `looplet-${org?.id ?? 'unknown'}`,
      software_name:  'Looplet Accounting',
      software_version: '0.1',
      run_date:       new Date().toISOString().slice(0, 10),
    },
    pay_event: {
      period_start: run.period_start,
      period_end:   run.period_end,
      pay_date:     run.pay_date,
      totals: {
        gross_cents: Number(run.total_gross_cents),
        payg_tax_cents: Number(run.total_tax_cents),
        super_cents: Number(run.total_super_cents),
        net_cents: Number(run.total_net_cents),
      },
      employees: (slips ?? []).map((s) => {
        const emp = s.employee as unknown as EmpJoin;
        const wage = (emp.wage_components ?? {}) as Record<string, unknown>;
        // OTE = Ordinary Time Earnings. Overtime is excluded from OTE for super.
        const ote = Number(s.gross_ordinary_cents) + Number(s.gross_leave_cents);
        return {
          // TFN intentionally not stored in our schema — placeholder for the
          // tax agent to fill from the TFN-declaration form on file.
          tfn: (wage['tfn'] as string | undefined) ?? '000000000',
          employee_id: emp.id,
          name: emp.full_name,
          email: emp.email,
          // Address: optional, falls back to placeholder so the JSON validates.
          address: {
            line1: (wage['address_line1'] as string | undefined) ?? null,
            line2: (wage['address_line2'] as string | undefined) ?? null,
            suburb: (wage['suburb'] as string | undefined) ?? null,
            state:  (wage['state'] as string | undefined) ?? null,
            postcode: (wage['postcode'] as string | undefined) ?? null,
            country: 'AU',
          },
          ytd: {
            gross_cents: Number(s.ytd_gross_cents),
            payg_tax_cents: Number(s.ytd_tax_cents),
            super_cents: Number(s.ytd_super_cents),
          },
          pay: {
            hours: {
              ordinary: Number(s.hours_ordinary),
              overtime: Number(s.hours_overtime),
              leave:    Number(s.hours_leave),
            },
            gross_ordinary_cents: Number(s.gross_ordinary_cents),
            gross_overtime_cents: Number(s.gross_overtime_cents),
            gross_leave_cents:    Number(s.gross_leave_cents),
            gross_total_cents:    Number(s.gross_total_cents),
            ote_cents:            ote,
            payg_tax_cents:       Number(s.payg_tax_cents),
            super_guarantee_cents: Number(s.super_guarantee_cents),
            super_rate_pct:        Number(s.super_rate_pct),
            net_pay_cents:         Number(s.net_pay_cents),
          },
          deductions: [],   // future: salary sacrifice / child support / etc.
        };
      }),
    },
    notes: [
      'STP Phase 2 file. Lodgement to ATO requires SBR-gateway integration ' +
        '(out of scope) — hand to your registered tax/BAS agent.',
      'TFN, address, and BMS_ID fields default to placeholders if not stored.',
    ],
  };

  return json({ ok: true, stp });
});
