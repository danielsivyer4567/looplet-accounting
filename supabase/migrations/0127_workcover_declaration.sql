-- 0127_workcover_declaration.sql — SC-3.J.01 (Phase 3, WorkCover)
--
-- generate_workcover_declaration(org, fy_start_year) — compiles an org's annual
-- declarable-wages figures for the QLD WorkCover wages declaration (due ~31 Aug),
-- from finalised pay runs over the financial year. Pure compute → returns jsonb;
-- no table (a later slice surfaces it on a Payroll card). Mirrors the BAS-worksheet
-- composer (generate_bas_worksheet, 0122) shape: a SECURITY INVOKER jsonb builder.
--
-- GATING (mirrors v_tax_calendar's workcover obligation in 0089): the declaration is
-- only meaningful for a WorkCover-registered employer in QLD, so the fn raises unless
-- business_profile.is_workcover_registered AND state_code = 'QLD'. Other states'
-- schemes (e.g. icare NSW, WorkSafe VIC) differ in declarable components + dates —
-- deferred to SC-3.M.01.
--
-- WAGES BASE: gross_total_cents (= ordinary + overtime + leave), with the ordinary/
-- overtime/leave split and super reported alongside for the operator. QLD WorkCover
-- declarable wages also include super + certain allowances — a documented refinement
-- (cf. payroll_tax_rates' rate tiers); the headline total stays Σ gross_total_cents
-- so the figure is simple + reconciles to the pay runs.
--
-- SECURITY INVOKER: reads business_profile + pay_slips/pay_runs under the caller's
-- RLS — a caller can only compile a declaration for an org they can access (a foreign
-- org's business_profile is RLS-hidden → the fn raises 'no business_profile').
--
-- MIGRATION NUMBER: ledger planned 0118; reassigned to 0127 per the drift rule
-- (0125 = SC-3.I.01, 0126 = SC-3.I.02). Verified free. Pure RPC — lands green alone.

create or replace function public.generate_workcover_declaration(
  p_org uuid,
  p_fy_start_year integer
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_state      text;
  v_registered boolean;
  v_fy_start   date := make_date(p_fy_start_year, 7, 1);
  v_fy_end     date := make_date(p_fy_start_year + 1, 6, 30);
  v_result     jsonb;
begin
  select state_code, coalesce(is_workcover_registered, false)
    into v_state, v_registered
  from business_profile
  where organization_id = p_org;

  if v_state is null then
    raise exception 'no business_profile / state for org %', p_org;
  end if;
  if not v_registered then
    raise exception 'org % is not WorkCover-registered (set business_profile.is_workcover_registered)', p_org;
  end if;
  if v_state <> 'QLD' then
    raise exception 'WorkCover declaration currently supports QLD only (org state is %)', v_state;
  end if;

  -- Declarable wages over finalised (approved/paid) pay runs paid within the FY.
  select jsonb_build_object(
    'organization_id', p_org,
    'state_code', v_state,
    'fy_start_year', p_fy_start_year,
    'fy_label', 'FY' || p_fy_start_year || '-' || lpad(((p_fy_start_year + 1) % 100)::text, 2, '0'),
    'period_start', v_fy_start,
    'period_end', v_fy_end,
    'total_wages_cents', coalesce(sum(ps.gross_total_cents), 0),
    'ordinary_wages_cents', coalesce(sum(ps.gross_ordinary_cents), 0),
    'overtime_wages_cents', coalesce(sum(ps.gross_overtime_cents), 0),
    'leave_wages_cents', coalesce(sum(ps.gross_leave_cents), 0),
    'super_cents', coalesce(sum(ps.super_guarantee_cents), 0),
    'employee_count', count(distinct ps.employee_id),
    'pay_run_count', count(distinct ps.pay_run_id)
  )
  into v_result
  from pay_slips ps
    join pay_runs pr on pr.id = ps.pay_run_id
  where ps.organization_id = p_org
    and pr.status in ('approved', 'paid')
    and pr.pay_date >= v_fy_start
    and pr.pay_date <= v_fy_end;

  return v_result;
end;
$$;

comment on function public.generate_workcover_declaration(uuid, integer) is
  'Compile QLD WorkCover annual declarable-wages figures (jsonb) for an org+FY from '
  'finalised pay runs. Gated on business_profile.is_workcover_registered + state QLD '
  '(other states = SC-3.M.01). Headline total = Σ gross_total_cents. SECURITY INVOKER.';

revoke all on function public.generate_workcover_declaration(uuid, integer) from public, anon;
grant execute on function public.generate_workcover_declaration(uuid, integer) to authenticated;
