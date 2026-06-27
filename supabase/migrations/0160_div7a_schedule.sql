-- 0160_div7a_schedule.sql — SC-5.E.02 (Phase 5, Div 7A — benchmark rates + MYR schedule)
--
-- Two things, both feeding the Div 7A breach engine (SC-5.E.03) and the loan-agreement
-- document (SC-5.F.01):
--   1. div7a_benchmark_rates — the ATO Division 7A benchmark interest rate per income
--      year, as effective-dated GLOBAL reference data (the 0155 resident_marginal_rates
--      pattern: RLS select-true, writes revoked). Updated annually by the ATO; keyed by
--      AU FY start year (e.g. 2024 => FY2024-25). This is the authoritative rate the
--      schedule RPC reads — div7a_loans.benchmark_rate_basis_points (0159) is only the
--      figure recorded on the loan, which the breach engine can later compare against this.
--   2. div7a_min_repayment(org, loan) — the minimum yearly repayment (MYR) SCHEDULE for a
--      complying Division 7A loan under ITAA 1936 s109E. Pure read; no writes.
--
-- ── THE MYR FORMULA (ITAA 1936 s109E(5)) ───────────────────────────────────────
-- For each income year after the loan was made, the minimum yearly repayment is the
-- amortising-loan payment that retires the balance over the remaining term at that
-- year's benchmark rate:
--
--                       opening_balance x r
--     MYR  =  ----------------------------------------
--             1 - (1 + r) ^ -(remaining_years)
--
-- where r = the benchmark rate for THAT income year, and remaining_years counts the
-- income years left in the loan's maximum term (term_years) from the current year.
-- Each year: interest = opening x r; principal = MYR - interest; closing = opening -
-- principal. The schedule is the canonical declining-balance amortisation, so it is
-- hand-computable and independently assertable (the SC-5.E.02 DONE criterion). The math
-- mirrors the rigor of the depreciation calc (SC-1.G.01 / 0095): deterministic, AU
-- convention documented, whole-cent rounding with a final-year clear so closing lands
-- exactly on 0.
--
-- ── AU / s109E CONVENTIONS (documented so the math is reviewable) ───────────────
--   * The loan is "made" in income year loan_year (0159). The FIRST repayment year is
--     the NEXT income year (loan_year + 1); no MYR is due in the year the loan is made.
--   * The maximum term runs term_years income years from the year AFTER the loan is made
--     (7 unsecured / 25 secured). remaining_years for repayment year k (k = 1..term) is
--     (term_years - k + 1).
--   * Each year uses its OWN benchmark rate (the rate floats year to year), looked up
--     from div7a_benchmark_rates by that income year. A missing rate is surfaced as an
--     error row (rate_missing), never silently treated as 0 (that would understate MYR).
--   * Whole-cent math: MYR and interest are rounded to cents each year; principal is the
--     remainder, and the FINAL year's principal is forced to the closing balance so the
--     loan retires to exactly 0 cents despite rounding (the lifetime-cap analogue of 0095).
--   * The schedule assumes the benchmark rate as the loan's actual rate (a complying loan
--     must charge at least the benchmark). Extra repayments / actual payments are the
--     breach engine's concern (SC-5.E.03), not this minimum schedule.
--
-- SECURITY INVOKER + STABLE — RLS on div7a_loans scopes the loan lookup to the caller's
-- org (a foreign loan yields an empty schedule, not a leak); the rate table is world-
-- readable reference. No writes. Revoke public/anon + grant authenticated on the fn.
--
-- MIGRATION NUMBER: the ledger Files line planned 0152, long taken (0152_trust_deed_fte).
-- Reassigned to 0160 per the drift rule — the sequential repo head is 0159_div7a_tables
-- (0178/0179 are late hotfixes that sort after). Verified live (dxoikltymmknxqpkpyhi,
-- read-only): div7a_benchmark_rates + div7a_min_repayment ABSENT (no drift); div7a_loans
-- (dep) is repo-only (0159, not yet deployed) — the schedule fn reads it, created here via
-- create-or-replace (body resolves at call time), and the rolled-back test stubs it.

-- ── 1. ATO Div 7A benchmark interest rate per income year (global reference) ────
create table public.div7a_benchmark_rates (
  id                 uuid primary key default gen_random_uuid(),
  -- AU income year, as the FY start year (2024 => FY2024-25).
  fy_start_year      int  not null unique,
  -- The benchmark rate in basis points (875 = 8.75%) — integer, exact, no float drift.
  rate_basis_points  int  not null check (rate_basis_points >= 0),
  notes              text
);

comment on table public.div7a_benchmark_rates is
  'ATO Division 7A benchmark interest rate per income year (SC-5.E.02), as global '
  'reference data (RLS select-true, writes revoked — the 0155 pattern). Keyed by AU FY '
  'start year; rate in basis points. Updated annually by the ATO. Read by '
  'div7a_min_repayment and the breach engine (SC-5.E.03).';

-- Published ATO Div 7A benchmark rates (the RBA "indicator lending rates — banks;
-- variable; standard; owner-occupier" for May before the income year). Seeded as data so
-- the schedule is exact; add the new rate each year. Idempotent upsert.
insert into public.div7a_benchmark_rates (fy_start_year, rate_basis_points, notes) values
  (2014, 595, 'FY2014-15: 5.95%'),
  (2015, 545, 'FY2015-16: 5.45%'),
  (2016, 540, 'FY2016-17: 5.40%'),
  (2017, 530, 'FY2017-18: 5.30%'),
  (2018, 520, 'FY2018-19: 5.20%'),
  (2019, 537, 'FY2019-20: 5.37%'),
  (2020, 452, 'FY2020-21: 4.52%'),
  (2021, 452, 'FY2021-22: 4.52%'),
  (2022, 477, 'FY2022-23: 4.77%'),
  (2023, 827, 'FY2023-24: 8.27%'),
  (2024, 877, 'FY2024-25: 8.77%')
on conflict (fy_start_year) do update set
  rate_basis_points = excluded.rate_basis_points,
  notes             = excluded.notes;

alter table public.div7a_benchmark_rates enable row level security;
create policy div7a_benchmark_rates_select on public.div7a_benchmark_rates
  for select using (true);
revoke insert, update, delete on public.div7a_benchmark_rates from authenticated, anon;
grant select on public.div7a_benchmark_rates to authenticated, anon;

-- ── 2. Minimum yearly repayment schedule (ITAA 1936 s109E) ─────────────────────
create or replace function public.div7a_min_repayment(p_org uuid, p_loan_id uuid)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = public
as $$
declare
  v_loan_year   int;
  v_principal   bigint;
  v_term        int;
  v_lender      text;
  v_borrower    text;
  v_opening     bigint;     -- opening balance for the current repayment year (cents)
  v_rate        numeric;    -- this year's benchmark rate as a fraction
  v_rate_bps    int;        -- this year's benchmark rate in basis points (null => missing)
  v_remaining   int;        -- income years left in the term at the current year
  v_myr         bigint;     -- minimum yearly repayment (cents)
  v_interest    bigint;     -- interest component (cents)
  v_principal_c bigint;     -- principal component (cents)
  v_iy          int;        -- the income year (FY start) of the current repayment year
  v_k           int;        -- repayment year ordinal (1..term)
  v_rows        jsonb := '[]'::jsonb;
  v_total_int   bigint := 0;
  v_total_prin  bigint := 0;
  v_any_missing boolean := false;
begin
  -- Load the loan (RLS-scoped). Foreign/absent loan -> empty schedule, not a leak.
  select loan_year, principal_cents, term_years, lender_company_name, borrower_name
    into v_loan_year, v_principal, v_term, v_lender, v_borrower
  from div7a_loans
  where id = p_loan_id and organization_id = p_org and deleted_at is null;

  if not found then
    return jsonb_build_object(
      'ok', false, 'organization_id', p_org, 'loan_id', p_loan_id,
      'error', 'loan not found or not accessible', 'schedule', '[]'::jsonb);
  end if;

  v_opening := v_principal;

  -- Walk each repayment year k = 1..term. Repayment year k is income year loan_year + k
  -- (the first repayment is the year AFTER the loan was made). remaining_years = term-k+1.
  for v_k in 1 .. v_term loop
    exit when v_opening <= 0;                 -- loan already retired (shouldn't happen pre-term)
    v_iy        := v_loan_year + v_k;
    v_remaining := v_term - v_k + 1;

    -- This income year's benchmark rate (authoritative table). Missing -> flag, skip math.
    select rate_basis_points into v_rate_bps
    from div7a_benchmark_rates where fy_start_year = v_iy;

    if v_rate_bps is null then
      v_any_missing := true;
      v_rows := v_rows || jsonb_build_object(
        'repayment_year',  v_k,
        'income_year',     v_iy,
        'opening_balance_cents', v_opening,
        'rate_missing',    true,
        'note', format('No div7a_benchmark_rates row for FY%s-%s; seed it to compute this year.',
                       v_iy, v_iy + 1));
      continue;
    end if;

    v_rate := v_rate_bps::numeric / 10000.0;

    -- MYR = opening * r / (1 - (1+r)^-remaining). Guard r=0 (degenerate): straight-line.
    if v_rate = 0 then
      v_myr := ceil(v_opening::numeric / v_remaining)::bigint;
    else
      v_myr := round(v_opening::numeric * v_rate
                     / (1 - power(1 + v_rate, -v_remaining)))::bigint;
    end if;

    v_interest    := round(v_opening::numeric * v_rate)::bigint;
    v_principal_c := v_myr - v_interest;

    -- Final year (or if MYR would over/under-shoot): clear the balance exactly. The last
    -- scheduled payment retires the loan to 0 cents regardless of rounding (0095 cap analogue).
    if v_k = v_term or v_principal_c >= v_opening then
      v_principal_c := v_opening;
      v_myr         := v_opening + v_interest;
    end if;

    v_rows := v_rows || jsonb_build_object(
      'repayment_year',         v_k,
      'income_year',            v_iy,
      'period_label',           format('FY%s-%s', v_iy, v_iy + 1),
      'opening_balance_cents',  v_opening,
      'rate_basis_points',      v_rate_bps,
      'min_repayment_cents',    v_myr,
      'interest_cents',         v_interest,
      'principal_cents',        v_principal_c,
      'closing_balance_cents',  v_opening - v_principal_c);

    v_total_int  := v_total_int + v_interest;
    v_total_prin := v_total_prin + v_principal_c;
    v_opening    := v_opening - v_principal_c;
  end loop;

  return jsonb_build_object(
    'ok',               not v_any_missing,
    'organization_id',  p_org,
    'loan_id',          p_loan_id,
    'lender',           v_lender,
    'borrower',         v_borrower,
    'loan_year',        v_loan_year,
    'first_repayment_income_year', v_loan_year + 1,
    'principal_cents',  v_principal,
    'term_years',       v_term,
    'schedule',         v_rows,
    'totals', jsonb_build_object(
      'interest_cents',  v_total_int,
      'principal_cents', v_total_prin,
      'repaid_cents',    v_total_int + v_total_prin,
      'closing_balance_cents', v_opening),
    'rates_missing',    v_any_missing,
    'caveats', jsonb_build_array(
      'Minimum yearly repayment per ITAA 1936 s109E: opening balance x benchmark rate / (1 - (1+rate)^-remaining_years), each income year at that year''s ATO benchmark rate. The first repayment year is the income year AFTER the loan was made.',
      'This is the MINIMUM schedule assuming the benchmark rate is charged. Actual repayments and shortfall/breach detection are SC-5.E.03; a complying loan must charge at least the benchmark rate.',
      'A year with no seeded div7a_benchmark_rates row is flagged rate_missing and omitted from the math (ok=false) rather than treated as 0% — seed the rate to complete the schedule.',
      'Whole-cent rounding each year; the final scheduled payment clears the balance exactly to 0.'),
    'note', 'Div 7A minimum yearly repayment schedule (ITAA 1936 s109E) for a complying loan. Reads div7a_loans (0159) + div7a_benchmark_rates. Advisory; SECURITY INVOKER scopes the caller via RLS; no writes.');
end;
$$;

comment on function public.div7a_min_repayment(uuid, uuid) is
  'SC-5.E.02: minimum yearly repayment schedule (ITAA 1936 s109E, jsonb) for a Division 7A '
  'loan — opening x rate / (1 - (1+rate)^-remaining) each income year at that year''s ATO '
  'benchmark rate (div7a_benchmark_rates), first repayment the year after the loan was made, '
  'whole-cent with a final-year clear. Reads div7a_loans (0159). SECURITY INVOKER — RLS scopes '
  'the caller; no writes. Actual-vs-minimum breach detection is SC-5.E.03.';

revoke all on function public.div7a_min_repayment(uuid, uuid) from public, anon;
grant execute on function public.div7a_min_repayment(uuid, uuid) to authenticated;
