-- 0161_div7a_breach.sql — SC-5.E.03 (Phase 5, Div 7A — breach detection)
--
-- Read-only Division 7A compliance scan for an org. Flags the three ways a Div 7A
-- position goes wrong, so EOFY readiness (Phase-4 SC-4.A.02 leaves a hook for this) and
-- the user can fix them before they crystallise into a deemed unfranked dividend:
--   1. LOAN REPAYMENT SHORTFALL — a complying loan whose actual repayment for an elapsed
--      income year fell short of the s109E minimum yearly repayment (SC-5.E.02
--      div7a_min_repayment). The unpaid shortfall is a deemed dividend in that year.
--   2. LOAN OVER TERM — a loan still on the books after its maximum term (loan_year +
--      term_years) has elapsed.
--   3. STALE UPE — an Unpaid Present Entitlement to a corporate beneficiary still
--      'unmanaged' (no complying sub-trust / Div 7A loan) past the lodgement day for the
--      year it arose, so it is treated as a Division 7A loan from the company.
--
-- ── NEW TABLE div7a_loan_repayments ────────────────────────────────────────────
-- Detecting shortfall (criterion 1) needs the ACTUAL repayment made each year, which
-- the registry (0159) does not record. This slice adds the minimal table that carries
-- it: one row per (loan, income_year) with the amount actually repaid. Kept here (not a
-- separate slice — the ledger has none) because the breach scan is its only consumer and
-- shortfall detection is meaningless without it. org-scoped RLS / audit / soft-delete per
-- the 0159 house pattern; unique on (loan_id, income_year) — one actual-repayment total
-- per loan per year.
--
-- ── div7a_breach_scan(org) ─────────────────────────────────────────────────────
-- Returns jsonb (the Phase-5 RPC house shape): a `breaches` array (one entry per flagged
-- issue, typed by `kind`) + counts. Read-only; SECURITY INVOKER + STABLE so every read
-- (div7a_loans / div7a_upe / div7a_loan_repayments via RLS; div7a_min_repayment, itself
-- INVOKER; div7a_benchmark_rates world-readable) is scoped to the caller's org — a foreign
-- org scans to an empty result, not a leak. No writes.
--
-- ── AU CONVENTIONS (documented so the flags are reviewable) ─────────────────────
--   * Current income year is derived from current_date: months Jul-Dec => that calendar
--     year; Jan-Jun => the prior calendar year (AU 1 Jul-30 Jun income year).
--   * Shortfall is checked only for ELAPSED repayment years (income_year <= current income
--     year) — a future year's repayment is not yet due. Per year: min (from
--     div7a_min_repayment.schedule) vs coalesce(actual, 0); shortfall = min - actual when
--     positive. A repayment year with a missing benchmark rate (rate_missing) is skipped
--     (can't assert a minimum), surfaced via the schedule's own ok=false.
--   * Over-term: flagged when current income year > loan_year + term_years (the maximum
--     term has fully elapsed). The loan should have been repaid by then.
--   * Stale UPE: flagged when current income year > year_arose + 1 (i.e. past the
--     lodgement day of the income year the entitlement arose — a documented approximation;
--     the precise lodgement day varies by entity/agent) AND management = 'unmanaged'.
--
-- MIGRATION NUMBER: the ledger Files line planned 0153, long taken (0153_trust_distributions).
-- Reassigned to 0161 per the drift rule — the sequential repo head is 0160_div7a_schedule
-- (0178/0179 are late hotfixes that sort after). Verified live (dxoikltymmknxqpkpyhi,
-- read-only): div7a_breach_scan + div7a_loan_repayments ABSENT (no drift); div7a_loans /
-- div7a_upe / div7a_min_repayment (deps) are repo-only (0159/0160, not deployed) — the scan
-- reads them via create-or-replace (body resolves at call time); the rolled-back test stubs them.

-- ── 1. Actual repayments made against a Div 7A loan ────────────────────────────
create table public.div7a_loan_repayments (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  loan_id           uuid not null references public.div7a_loans (id) on delete cascade,
  -- The income year the repayment is for (AU FY start year).
  income_year       int  not null,
  amount_paid_cents bigint not null default 0,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  created_by        uuid references auth.users (id),
  deleted_at        timestamptz,
  constraint div7a_loan_repayments_amount_non_negative check (amount_paid_cents >= 0)
);

comment on table public.div7a_loan_repayments is
  'Actual repayments made against a Division 7A loan per income year (SC-5.E.03). One row '
  'per (loan, income_year). Compared by div7a_breach_scan against the s109E minimum '
  '(div7a_min_repayment, SC-5.E.02) to flag repayment shortfalls.';

-- One actual-repayment total per loan per income year (a restatement soft-deletes the prior).
create unique index div7a_loan_repayments_loan_year_idx
  on public.div7a_loan_repayments (loan_id, income_year)
  where deleted_at is null;

-- Repayments listed per org (org-first also serves RLS-scoped listing).
create index div7a_loan_repayments_org_idx
  on public.div7a_loan_repayments (organization_id)
  where deleted_at is null;

create trigger div7a_loan_repayments_set_updated_at
  before update on public.div7a_loan_repayments
  for each row execute function public.set_updated_at();
create trigger div7a_loan_repayments_audit
  after insert or update or delete on public.div7a_loan_repayments
  for each row execute function public.audit_log_trigger_v2();

alter table public.div7a_loan_repayments enable row level security;

create policy div7a_loan_repayments_select on public.div7a_loan_repayments for select
  using (organization_id in (select get_accessible_org_ids()));
create policy div7a_loan_repayments_insert on public.div7a_loan_repayments for insert
  with check (organization_id in (select get_accessible_org_ids()));
create policy div7a_loan_repayments_update on public.div7a_loan_repayments for update
  using (organization_id in (select get_accessible_org_ids()))
  with check (organization_id in (select get_accessible_org_ids()));
create policy div7a_loan_repayments_delete on public.div7a_loan_repayments for delete
  using (organization_id in (select get_accessible_org_ids()));

grant select, insert, update, delete on public.div7a_loan_repayments to authenticated;

-- ── 2. Breach scan ─────────────────────────────────────────────────────────────
create or replace function public.div7a_breach_scan(
    p_org uuid, p_reference_date date default current_date)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = public
as $$
declare
  -- "Today" for the scan. Defaults to current_date; an explicit date makes the scan
  -- deterministic (testable, and lets the EOFY hook scan as-at a chosen date).
  v_now      date := p_reference_date;
  -- Current AU income year (FY start): Jul-Dec => this year; Jan-Jun => prior year.
  v_cur_fy   int  := case when extract(month from v_now) >= 7
                          then extract(year from v_now)::int
                          else extract(year from v_now)::int - 1 end;
  v_breaches jsonb := '[]'::jsonb;
  v_loan     record;
  v_sched    jsonb;
  v_line     jsonb;
  v_min      bigint;
  v_actual   bigint;
  v_short    bigint;
  v_iy       int;
  v_upe      record;
begin
  -- ---- Criterion 1 & 2: per loan ----
  for v_loan in
    select id, lender_company_name, borrower_name, loan_year, principal_cents, term_years
    from div7a_loans
    where organization_id = p_org and deleted_at is null
  loop
    -- (2) Over term: the maximum term has fully elapsed.
    if v_cur_fy > v_loan.loan_year + v_loan.term_years then
      v_breaches := v_breaches || jsonb_build_object(
        'kind',        'loan_over_term',
        'loan_id',     v_loan.id,
        'lender',      v_loan.lender_company_name,
        'borrower',    v_loan.borrower_name,
        'loan_year',   v_loan.loan_year,
        'term_years',  v_loan.term_years,
        'final_year',  v_loan.loan_year + v_loan.term_years,
        'current_income_year', v_cur_fy,
        'detail', format('Loan term (%s years from FY%s) elapsed at FY%s; loan should be fully repaid.',
                         v_loan.term_years, v_loan.loan_year, v_loan.loan_year + v_loan.term_years));
    end if;

    -- (1) Repayment shortfall: compare each ELAPSED repayment year's minimum vs actual.
    v_sched := div7a_min_repayment(p_org, v_loan.id) -> 'schedule';
    for v_line in select * from jsonb_array_elements(coalesce(v_sched, '[]'::jsonb))
    loop
      -- skip a year we couldn't compute a minimum for (missing benchmark rate)
      continue when coalesce((v_line ->> 'rate_missing')::boolean, false);
      v_iy := (v_line ->> 'income_year')::int;
      continue when v_iy > v_cur_fy;                    -- not yet due
      v_min := coalesce((v_line ->> 'min_repayment_cents')::bigint, 0);
      select coalesce(sum(amount_paid_cents), 0) into v_actual
      from div7a_loan_repayments
      where loan_id = v_loan.id and income_year = v_iy and deleted_at is null;
      v_short := v_min - v_actual;
      if v_short > 0 then
        v_breaches := v_breaches || jsonb_build_object(
          'kind',        'repayment_shortfall',
          'loan_id',     v_loan.id,
          'lender',      v_loan.lender_company_name,
          'borrower',    v_loan.borrower_name,
          'income_year', v_iy,
          'period_label', format('FY%s-%s', v_iy, v_iy + 1),
          'min_repayment_cents', v_min,
          'actual_repaid_cents', v_actual,
          'shortfall_cents',     v_short,
          'detail', format('FY%s-%s repayment $%s short of the s109E minimum $%s (deemed dividend risk).',
                           v_iy, v_iy + 1,
                           to_char(v_short / 100.0, 'FM999G999G990D00'),
                           to_char(v_min / 100.0, 'FM999G999G990D00')));
      end if;
    end loop;
  end loop;

  -- ---- Criterion 3: stale UPEs ----
  for v_upe in
    select id, trust_id, beneficiary_company_name, year_arose, unpaid_amount_cents, management
    from div7a_upe
    where organization_id = p_org and deleted_at is null
  loop
    if v_upe.management = 'unmanaged' and v_cur_fy > v_upe.year_arose + 1 then
      v_breaches := v_breaches || jsonb_build_object(
        'kind',        'stale_upe',
        'upe_id',      v_upe.id,
        'trust_id',    v_upe.trust_id,
        'beneficiary', v_upe.beneficiary_company_name,
        'year_arose',  v_upe.year_arose,
        'unpaid_amount_cents', v_upe.unpaid_amount_cents,
        'current_income_year', v_cur_fy,
        'detail', format('UPE to %s from FY%s-%s is still unmanaged past its lodgement day; treated as a Div 7A loan.',
                         v_upe.beneficiary_company_name, v_upe.year_arose, v_upe.year_arose + 1));
    end if;
  end loop;

  return jsonb_build_object(
    'ok',               true,
    'organization_id',  p_org,
    'scanned_at',       v_now,
    'current_income_year', v_cur_fy,
    'breach_count',     jsonb_array_length(v_breaches),
    -- Counts by kind in one pass. The zero-base keeps all three keys present even when a
    -- kind has no breaches (a bare group-by would omit empty kinds).
    'counts', jsonb_build_object('repayment_shortfall', 0, 'loan_over_term', 0, 'stale_upe', 0)
              || coalesce((
                   select jsonb_object_agg(kind, n)
                   from (select e ->> 'kind' as kind, count(*) as n
                         from jsonb_array_elements(v_breaches) e group by 1) g), '{}'::jsonb),
    'breaches',         v_breaches,
    'caveats', jsonb_build_array(
      'Repayment shortfall compares each elapsed income year''s actual repayment (div7a_loan_repayments) against the s109E minimum (div7a_min_repayment, SC-5.E.02). A shortfall is a deemed unfranked dividend for that year; review before lodging.',
      'Stale UPE uses a documented approximation for the lodgement-day deadline (current income year > year arose + 1). The precise lodgement day depends on the entity and whether a tax agent lodges; confirm the actual due date.',
      'A repayment year whose benchmark rate is not seeded is skipped for shortfall (no minimum to compare); seed the rate (div7a_benchmark_rates) to assess it.',
      'Read-only flagging. The remedy (top-up repayment, put a UPE on a complying footing) is a user/advisory action, not taken here.'),
    'note', 'Division 7A breach scan (SC-5.E.03): flags loan repayment shortfalls vs the s109E minimum, loans past their maximum term, and stale unmanaged UPEs. Reads div7a_loans/div7a_upe/div7a_loan_repayments (0159/this) + div7a_min_repayment (SC-5.E.02). Read-only; SECURITY INVOKER scopes the caller via RLS.');
end;
$$;

comment on function public.div7a_breach_scan(uuid, date) is
  'SC-5.E.03: read-only Division 7A breach scan (jsonb) for an org — flags loan repayment '
  'shortfalls vs the s109E minimum (div7a_min_repayment), loans past their maximum term, and '
  'stale unmanaged UPEs past their lodgement day. p_reference_date (default current_date) sets '
  'the as-at income year. Reads div7a_loans/div7a_upe/div7a_loan_repayments + div7a_min_repayment. '
  'SECURITY INVOKER — RLS scopes the caller; no writes. Feeds EOFY readiness (SC-4.A.02 hook).';

revoke all on function public.div7a_breach_scan(uuid, date) from public, anon;
grant execute on function public.div7a_breach_scan(uuid, date) to authenticated;
