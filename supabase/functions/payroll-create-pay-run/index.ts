/**
 * payroll-create-pay-run — assemble a draft pay run + payslips for a period.
 *
 * POST {
 *   organization_id: string,
 *   period_start: 'YYYY-MM-DD',
 *   period_end:   'YYYY-MM-DD',
 *   pay_date:     'YYYY-MM-DD',
 *   employee_ids: string[],
 *   frequency?:   'weekly' | 'fortnightly' | 'monthly'   // default 'weekly'
 *   claims_threshold?: boolean                            // default true
 * }
 *
 * For each employee:
 *   1. Pull approved timesheet_entries in [period_start..period_end].
 *   2. Sum hours per entry_type.
 *   3. Compute gross_* from employee.wage_components.loaded_hourly_rate_cents
 *      (split: ordinary/overtime/leave).
 *   4. Call calc_payg_tax + calc_super_ote.
 *   5. Pull YTD totals from prior pay_slips this fiscal year (1 July → 30 June).
 *   6. Insert pay_slips row.
 *
 * Then aggregate totals onto pay_runs.
 *
 * Auth: Bearer JWT, caller must be admin+ for the org.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';

type EntryType = 'ordinary' | 'overtime' | 'annual_leave' | 'sick_leave' | 'public_holiday';

interface Body {
  organization_id?: string;
  period_start?: string;
  period_end?: string;
  pay_date?: string;
  employee_ids?: string[];
  frequency?: 'weekly' | 'fortnightly' | 'monthly';
  claims_threshold?: boolean;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function fyStartFor(date: string): string {
  // FY 2025-26 starts 1 July 2025. Given any date, return the fy_start as YYYY-07-01.
  const d = new Date(date);
  const month = d.getUTCMonth() + 1;
  const year = d.getUTCFullYear();
  const fyYear = month >= 7 ? year : year - 1;
  return `${fyYear}-07-01`;
}

function statutorySuperRatePct(payDate: string): number {
  if (payDate >= '2025-07-01') return 12;
  if (payDate >= '2024-07-01') return 11.5;
  if (payDate >= '2023-07-01') return 11;
  if (payDate >= '2022-07-01') return 10.5;
  if (payDate >= '2021-07-01') return 10;
  return 9.5;
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
  const {
    data: { user },
    error: authErr,
  } = await userClient.auth.getUser();
  if (authErr || !user) return json({ ok: false, error: 'Unauthorized' }, 401);

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ---- Parse + validate body ------------------------------------------------
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const {
    organization_id,
    period_start,
    period_end,
    pay_date,
    employee_ids,
    frequency = 'weekly',
    claims_threshold = true,
  } = body;

  if (
    !organization_id ||
    !period_start ||
    !period_end ||
    !pay_date ||
    !Array.isArray(employee_ids) ||
    employee_ids.length === 0
  ) {
    return json(
      {
        ok: false,
        error: 'organization_id, period_start, period_end, pay_date, employee_ids[] are required',
      },
      400,
    );
  }

  if (!['weekly', 'fortnightly', 'monthly'].includes(frequency)) {
    return json({ ok: false, error: 'frequency must be weekly|fortnightly|monthly' }, 400);
  }

  // ---- Caller must be admin+ for this org -----------------------------------
  const { data: callerMembership, error: memErr } = await userClient
    .from('organization_memberships')
    .select('role_enum')
    .eq('user_id', user.id)
    .eq('organization_id', organization_id)
    .maybeSingle();
  if (memErr) return json({ ok: false, error: 'Failed to verify membership' }, 500);
  if (!callerMembership || !['admin', 'owner'].includes(callerMembership.role_enum ?? '')) {
    return json({ ok: false, error: 'Only admin or owner can create pay runs' }, 403);
  }

  // ---- Fetch employees ------------------------------------------------------
  const { data: employees, error: empErr } = await admin
    .from('employees')
    .select('id, full_name, wage_components')
    .eq('organization_id', organization_id)
    .in('id', employee_ids)
    .is('deleted_at', null);
  if (empErr) return json({ ok: false, error: empErr.message }, 500);
  if (!employees || employees.length === 0) {
    return json({ ok: false, error: 'No matching employees in this org' }, 400);
  }

  // ---- Create pay_runs row (draft) ------------------------------------------
  const { data: payRun, error: runErr } = await admin
    .from('pay_runs')
    .insert({
      organization_id,
      period_start,
      period_end,
      pay_date,
      status: 'draft',
      metadata: { frequency, claims_threshold },
    })
    .select('id')
    .single();
  if (runErr || !payRun) {
    return json({ ok: false, error: runErr?.message ?? 'pay_runs insert failed' }, 500);
  }

  const fyStart = fyStartFor(pay_date);
  const { data: orgRow } = await admin
    .from('organizations')
    .select('settings')
    .eq('id', organization_id)
    .maybeSingle();
  const orgSettings = (orgRow?.settings ?? {}) as { super_rate_pct?: number | string };
  const orgSuperPct =
    orgSettings.super_rate_pct == null || orgSettings.super_rate_pct === ''
      ? null
      : Number(orgSettings.super_rate_pct);
  const defaultSuperPct = Number.isFinite(orgSuperPct)
    ? Number(orgSuperPct)
    : statutorySuperRatePct(pay_date);

  // ---- For each employee, build a payslip -----------------------------------
  let totalGross = 0,
    totalTax = 0,
    totalSuper = 0,
    totalNet = 0;
  const slipResults: { employee_id: string; slip_id?: string; error?: string }[] = [];

  for (const emp of employees) {
    try {
      const wage = (emp.wage_components ?? {}) as {
        loaded_hourly_rate_cents?: number;
        base_hourly_rate?: number;
        super_pct?: number;
      };
      const loadedRate = wage.loaded_hourly_rate_cents ?? 0;

      // Aggregate timesheet hours by entry_type for this employee in the period.
      const { data: ts, error: tsErr } = await admin
        .from('timesheet_entries')
        .select('hours, entry_type, total_cost_cents')
        .eq('organization_id', organization_id)
        .eq('employee_id', emp.id)
        .gte('work_date', period_start)
        .lte('work_date', period_end)
        .is('deleted_at', null)
        .not('approved_at', 'is', null); // only approved time enters payroll
      if (tsErr) throw new Error(`timesheet fetch: ${tsErr.message}`);

      let hOrd = 0,
        hOt = 0,
        hLeave = 0;
      for (const row of ts ?? []) {
        const h = Number(row.hours);
        const et = (row.entry_type ?? 'ordinary') as EntryType;
        if (et === 'ordinary' || et === 'public_holiday') hOrd += h;
        else if (et === 'overtime') hOt += h;
        else if (et === 'annual_leave' || et === 'sick_leave') hLeave += h;
      }

      // Gross splits (overtime gets 1.5x as a default loading; tweakable).
      const grossOrd = Math.round(hOrd * loadedRate);
      const grossOt = Math.round(hOt * loadedRate * 1.5);
      const grossLeave = Math.round(hLeave * loadedRate);
      const grossTotal = grossOrd + grossOt + grossLeave;
      const ordinaryTimeEarnings = grossOrd + grossLeave;

      // PAYG tax via DB function.
      const { data: taxRes, error: taxErr } = await admin.rpc('calc_payg_tax', {
        p_gross_cents: grossTotal,
        p_frequency: frequency,
        p_claims_threshold: claims_threshold,
      });
      if (taxErr) throw new Error(`calc_payg_tax: ${taxErr.message}`);
      const paygTax = Number(taxRes ?? 0);

      // Super guarantee. Use OTE (ordinary + leave), excluding overtime.
      const empSuperPct = wage.super_pct ?? null;
      const effectiveSuperPct = empSuperPct ?? defaultSuperPct;
      const { data: supRes, error: supErr } = await admin.rpc('calc_super_ote', {
        p_ote_cents: ordinaryTimeEarnings,
        p_rate_pct: effectiveSuperPct,
        p_org_id: organization_id,
      });
      if (supErr) throw new Error(`calc_super_ote: ${supErr.message}`);
      const superGuarantee = Number(supRes ?? 0);

      const netPay = grossTotal - paygTax;

      // YTD aggregates from prior pay_slips this fiscal year.
      const { data: priorSlips } = await admin
        .from('pay_slips')
        .select(
          'gross_total_cents, payg_tax_cents, super_guarantee_cents, pay_run:pay_runs!inner(pay_date)',
        )
        .eq('organization_id', organization_id)
        .eq('employee_id', emp.id)
        .gte('pay_run.pay_date', fyStart)
        .lt('pay_run.pay_date', pay_date);
      let ytdGross = grossTotal;
      let ytdTax = paygTax;
      let ytdSuper = superGuarantee;
      for (const ps of priorSlips ?? []) {
        ytdGross += Number(ps.gross_total_cents);
        ytdTax += Number(ps.payg_tax_cents);
        ytdSuper += Number(ps.super_guarantee_cents);
      }

      const { data: slip, error: slipErr } = await admin
        .from('pay_slips')
        .insert({
          organization_id,
          pay_run_id: payRun.id,
          employee_id: emp.id,
          hours_ordinary: hOrd,
          hours_overtime: hOt,
          hours_leave: hLeave,
          gross_ordinary_cents: grossOrd,
          gross_overtime_cents: grossOt,
          gross_leave_cents: grossLeave,
          gross_total_cents: grossTotal,
          payg_tax_cents: paygTax,
          super_guarantee_cents: superGuarantee,
          super_rate_pct: effectiveSuperPct,
          net_pay_cents: netPay,
          ytd_gross_cents: ytdGross,
          ytd_tax_cents: ytdTax,
          ytd_super_cents: ytdSuper,
          metadata: {
            frequency,
            claims_threshold,
            loaded_hourly_rate_cents: loadedRate,
            ordinary_time_earnings_cents: ordinaryTimeEarnings,
            super_basis: 'ordinary_time_earnings',
            overtime_excluded_from_super_cents: grossOt,
          },
        })
        .select('id')
        .single();
      if (slipErr || !slip) throw new Error(`pay_slips insert: ${slipErr?.message ?? 'unknown'}`);

      totalGross += grossTotal;
      totalTax += paygTax;
      totalSuper += superGuarantee;
      totalNet += netPay;
      slipResults.push({ employee_id: emp.id, slip_id: slip.id });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      console.error(`payslip failed for ${emp.id}:`, err);
      slipResults.push({ employee_id: emp.id, error: err });
    }
  }

  // ---- Update pay_runs totals -----------------------------------------------
  const { error: updErr } = await admin
    .from('pay_runs')
    .update({
      total_gross_cents: totalGross,
      total_tax_cents: totalTax,
      total_super_cents: totalSuper,
      total_net_cents: totalNet,
    })
    .eq('id', payRun.id);
  if (updErr) {
    return json({ ok: false, error: updErr.message, run_id: payRun.id }, 500);
  }

  return json({
    ok: true,
    run_id: payRun.id,
    totals: {
      gross_cents: totalGross,
      tax_cents: totalTax,
      super_cents: totalSuper,
      net_cents: totalNet,
    },
    slips: slipResults,
  });
});
