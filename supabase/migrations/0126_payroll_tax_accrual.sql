-- 0126_payroll_tax_accrual.sql — SC-3.I.02 (Phase 3, payroll tax)
--
-- Monthly payroll-tax accrual: a per-org period snapshot table + the RPC that
-- computes it from finalised pay runs against the per-state rate/threshold
-- (payroll_tax_rates, SC-3.I.01). This is plan §3.4's payroll_tax_periods. No UI
-- in this slice (a later slice surfaces it on a Payroll card).
--
--   payroll_tax_periods  — one row per org per month (period_month = 1st of month),
--     org-scoped RLS via get_accessible_org_ids(), money-in-cents, audited. It
--     SNAPSHOTS the rate parameters applied (state_code, annual + monthly threshold,
--     rate) alongside the taxable wages + liability, so the accrual is reproducible
--     even after the reference rates change.
--
--   accrue_payroll_tax(org, period_month) — resolves the org's
--     business_profile.state_code (0051), looks up the effective payroll_tax_rates
--     row for that state+month (half-open [effective_from, effective_to) window),
--     sums gross over the finalised (approved/paid) pay runs whose pay_date falls in
--     the month, applies the apportioned threshold, and upserts the period. Returns
--     the period id. Idempotent (re-accrual overwrites the month).
--
-- APPORTIONMENT (test-critical): the MONTHLY deduction = annual_threshold / 12 — the
-- annual threshold apportioned to the month, NOT applied in full each month. The
-- days-in-month/days-in-year method some states use is a documented refinement.
--
-- TAXABLE BASE: gross_total_cents only. AU payroll tax also includes super + certain
-- allowances/fringe benefits — a documented refinement (cf. payroll_tax_rates' rate
-- tiers), kept out of the MVP so the figure is simple and reproducible.
--
-- SECURITY INVOKER: reads (business_profile, payroll_tax_rates, pay_slips/pay_runs)
-- and the write all run under the caller's RLS — a caller can only accrue for an org
-- they can access (a foreign org's business_profile is RLS-hidden → the fn raises).
--
-- MIGRATION NUMBER: ledger planned 0117; reassigned to 0126 per the drift rule
-- (0125 = SC-3.I.01). Verified free.

create table public.payroll_tax_periods (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations (id) on delete cascade,
  period_month            date not null,                 -- first day of the accrued month
  state_code              text not null,                 -- snapshot of the org's state at accrual
  taxable_wages_cents     bigint not null default 0,
  annual_threshold_cents  bigint not null,               -- snapshot of the rate row applied
  monthly_threshold_cents bigint not null,               -- annual / 12 (apportioned)
  rate                    numeric(6, 5) not null,        -- snapshot of the rate applied
  liability_cents         bigint not null default 0,     -- max(0, taxable - monthly_threshold) * rate
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  created_by              uuid references auth.users (id),
  deleted_at              timestamptz,
  unique (organization_id, period_month),
  check (period_month = date_trunc('month', period_month)::date)
);

comment on table public.payroll_tax_periods is
  'Per-org monthly payroll-tax accrual (plan §3.4): taxable wages + liability for a '
  'month, with the applied per-state rate/threshold snapshotted for reproducibility. '
  'Computed by accrue_payroll_tax from finalised pay runs.';

create index payroll_tax_periods_org_month_idx
  on public.payroll_tax_periods (organization_id, period_month)
  where deleted_at is null;

create trigger payroll_tax_periods_set_updated_at
  before update on public.payroll_tax_periods
  for each row execute function public.set_updated_at();
create trigger payroll_tax_periods_audit
  after insert or update or delete on public.payroll_tax_periods
  for each row execute function public.audit_log_trigger_v2();

alter table public.payroll_tax_periods enable row level security;

create policy payroll_tax_periods_select on public.payroll_tax_periods for select
  using (organization_id in (select get_accessible_org_ids()));
create policy payroll_tax_periods_insert on public.payroll_tax_periods for insert
  with check (organization_id in (select get_accessible_org_ids()));
create policy payroll_tax_periods_update on public.payroll_tax_periods for update
  using (organization_id in (select get_accessible_org_ids()))
  with check (organization_id in (select get_accessible_org_ids()));
create policy payroll_tax_periods_delete on public.payroll_tax_periods for delete
  using (organization_id in (select get_accessible_org_ids()));

grant select, insert, update, delete on public.payroll_tax_periods to authenticated;

-- ---------------------------------------------------------------------------
-- accrue_payroll_tax — compute + upsert one month's accrual.
-- ---------------------------------------------------------------------------
create or replace function public.accrue_payroll_tax(
  p_org uuid,
  p_period_month date
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_month             date := date_trunc('month', p_period_month)::date;
  v_state             text;
  v_annual_threshold  bigint;
  v_rate              numeric(6, 5);
  v_monthly_threshold bigint;
  v_taxable           bigint;
  v_liability         bigint;
  v_period_id         uuid;
begin
  -- The org's state determines the rate/threshold.
  select state_code into v_state from business_profile where organization_id = p_org;
  if v_state is null then
    raise exception 'no state_code on business_profile for org % — set the business state first', p_org;
  end if;

  -- Effective per-state rate/threshold for this month (half-open window).
  select annual_threshold_cents, rate into v_annual_threshold, v_rate
  from payroll_tax_rates
  where state_code = v_state
    and effective_from <= v_month
    and (effective_to is null or v_month < effective_to)
  order by effective_from desc
  limit 1;
  if v_annual_threshold is null then
    raise exception 'no payroll_tax_rates row for state % at %', v_state, v_month;
  end if;

  -- Monthly deduction = annual threshold apportioned to the month (annual / 12).
  v_monthly_threshold := round(v_annual_threshold / 12.0);

  -- Taxable wages = gross over finalised (approved/paid) pay runs paid in the month.
  select coalesce(sum(ps.gross_total_cents), 0) into v_taxable
  from pay_slips ps
    join pay_runs pr on pr.id = ps.pay_run_id
  where ps.organization_id = p_org
    and pr.status in ('approved', 'paid')
    and pr.pay_date >= v_month
    and pr.pay_date < (v_month + interval '1 month')::date;

  v_liability := round(greatest(0, v_taxable - v_monthly_threshold) * v_rate);

  insert into payroll_tax_periods (
    organization_id, period_month, state_code, taxable_wages_cents,
    annual_threshold_cents, monthly_threshold_cents, rate, liability_cents, created_by
  ) values (
    p_org, v_month, v_state, v_taxable,
    v_annual_threshold, v_monthly_threshold, v_rate, v_liability, auth.uid()
  )
  on conflict (organization_id, period_month) do update set
    state_code = excluded.state_code,
    taxable_wages_cents = excluded.taxable_wages_cents,
    annual_threshold_cents = excluded.annual_threshold_cents,
    monthly_threshold_cents = excluded.monthly_threshold_cents,
    rate = excluded.rate,
    liability_cents = excluded.liability_cents
  returning id into v_period_id;

  return v_period_id;
end;
$$;

comment on function public.accrue_payroll_tax(uuid, date) is
  'Compute + upsert a months payroll-tax accrual for an org: gross over finalised pay '
  'runs in the month, less the apportioned (annual/12) per-state threshold, times the '
  'state rate (payroll_tax_rates). Idempotent. Returns the payroll_tax_periods id. '
  'SECURITY INVOKER — org access enforced by RLS on business_profile + the period table.';

revoke all on function public.accrue_payroll_tax(uuid, date) from public, anon;
grant execute on function public.accrue_payroll_tax(uuid, date) to authenticated;
