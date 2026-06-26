-- 0148_book_to_tax.sql — SC-4.H.01 (Phase 4, book-to-tax reconciliation, part 1)
--
-- book_to_tax(org, fy_start_year) — reconciles ACCOUNTING profit to TAXABLE income.
-- This is the Item-7-style reconciliation that build_return (SC-4.G, 0145–0147)
-- deliberately leaves out of the Item-6 financial-accounts mapping. This first slice
-- covers two of the three legs:
--   1. non-deductible add-backs, and
--   2. the accounting-vs-tax depreciation difference.
-- CGT inclusion + carried-forward losses + franking are SC-4.H.02 (0149); offsets &
-- credits (tax payable) are SC-4.H.03 (0150). The output is therefore a TAXABLE-INCOME
-- SUBTOTAL, not final tax payable — surfaced as such in the payload.
--
-- ── SOURCE: the statutory P&L, not v_trial_balance directly ────────────────────
-- Like build_return (0145), book_to_tax re-uses generate_statutory_statements
-- (SC-4.B.01, 0134) rather than re-querying v_trial_balance — ONE signing convention,
-- and it inherits the basis=cumulative_to_date limitation (the trial balance is
-- cumulative, so fy_start_year labels the period only — a documented refinement,
-- surfaced as 'basis' in the payload). accounting profit = profit_and_loss.net_profit_cents;
-- the per-account expense lines come from profit_and_loss.expenses.
--
-- ── 1. NON-DEDUCTIBLE ADD-BACKS ────────────────────────────────────────────────
-- The GL carries no per-account deductibility flag (chart_of_accounts has no
-- tax_treatment column — a documented refinement; the clean long-term design is a
-- per-account flag a human curates). So a first-pass reconciliation matches each GL
-- EXPENSE account NAME against a curated, extensible set of well-established ITAA 1997
-- non-deductible categories (entertainment Div 32, fines/penalties s26-5, income tax
-- s26-5, private/domestic s8-1). This mirrors the altitude of 0145's catch-all label
-- mapping: exact at the level that matters (the subtotal), with finer per-account
-- classification deferred to the documented refinement. Matched name patterns use
-- POSIX word boundaries (\m…\M) to avoid spurious substring hits. Depreciation is
-- EXCLUDED from the add-back scan — it is reconciled separately below, so it is never
-- double-counted.
--
-- ── 2. ACCOUNTING-VS-TAX DEPRECIATION DIFFERENCE ───────────────────────────────
-- Book depreciation = the GL depreciation expense (account 6700 from the 0097 seed;
-- matched by name so a renamed code still resolves), already inside accounting profit.
-- Tax depreciation = the ATO-basis charge from depreciation_schedules (SC-1.E/1.G),
-- summed across the 12 FY months via compute_depreciation (0095, a per-MONTH figure
-- that returns 0 before start / once fully written off). The reconciliation DISALLOWS
-- the book charge and ALLOWS the tax charge, so the net adjustment to profit is
-- (book − tax): a positive difference increases taxable income (book over-depreciated
-- relative to the ATO basis).
--   In steady state the depreciation-run cron posts compute_depreciation() straight to
--   the GL, so book == tax and the difference is ~0 — which is correct. It diverges
--   when book policy, low-value pooling, or instant write-off differ from the schedule
--   basis. Per the slice spec, if no schedules exist the tax leg degrades cleanly to 0
--   (build stays green) — compute_depreciation is on the live chain (0095), so the
--   reference is safe; the degrade is a runtime no-rows fallback, not a missing object.
--
-- SECURITY INVOKER + STABLE (read-only): generate_statutory_statements,
-- compute_depreciation, depreciation_schedules and fixed_assets are all RLS-scoped to
-- the caller, so a foreign org reads no GL/schedules and the figures degrade to zeros
-- rather than leaking; a service_role backend bypasses RLS.
--
-- MIGRATION NUMBER: the ledger planned 0139, long taken (0139_cgt_calc_base); the
-- whole 0139–0144 block is the CGT chain. Reassigned to 0148 per the drift rule — the
-- sequential repo head is 0147_return_builder_partnership_trust (0178/0179 are late
-- hotfixes that sort after). Verified live (dxoikltymmknxqpkpyhi): book_to_tax absent;
-- generate_statutory_statements / compute_depreciation / depreciation_schedules /
-- fixed_assets / v_trial_balance / chart_of_accounts / business_profile all present;
-- live generate_statutory_statements emits profit_and_loss.{net_profit_cents,expenses
-- [account_code,account_name,amount_cents]}; fixed_asset_status enum = {proposed,
-- active,disposed}.

create or replace function public.book_to_tax(p_org uuid, p_fy_start_year integer)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = public
as $$
declare
  v_fy_start          date := make_date(p_fy_start_year, 7, 1);
  v_fy_end            date := make_date(p_fy_start_year + 1, 6, 30);
  v_stmt              jsonb;
  v_pl                jsonb;
  v_expenses          jsonb;
  v_accounting_profit bigint;
  v_add_backs         jsonb;
  v_total_add_backs   bigint;
  v_book_dep          bigint;
  v_tax_dep           bigint;
  v_dep_diff          bigint;
  v_taxable_income    bigint;
begin
  -- Accounting result + GL expense line items from the statutory statements (0134).
  v_stmt              := generate_statutory_statements(p_org, p_fy_start_year);
  v_pl                := v_stmt -> 'profit_and_loss';
  v_expenses          := coalesce(v_pl -> 'expenses', '[]'::jsonb);
  v_accounting_profit := coalesce((v_pl ->> 'net_profit_cents')::bigint, 0);

  -- 1. Non-deductible add-backs: match each expense account name against the curated
  -- ITAA non-deductible set (one row per matched account; depreciation excluded).
  with rules(ord, pattern, reason) as (
    values
      (1, '\m(entertainment)\M',                'Entertainment expense — non-deductible (ITAA 1997 Div 32)'),
      (2, '\m(fine|fines|penalty|penalties)\M', 'Fines & penalties — non-deductible (ITAA 1997 s26-5)'),
      (3, 'income tax',                         'Income tax expense — non-deductible (ITAA 1997 s26-5)'),
      (4, '\m(private|domestic)\M',             'Private/domestic portion — non-deductible (ITAA 1997 s8-1)')
  ),
  matched as (
    select
      e ->> 'account_code'           as account_code,
      e ->> 'account_name'           as account_name,
      (e ->> 'amount_cents')::bigint as amount_cents,
      r.reason
    from jsonb_array_elements(v_expenses) as e
    cross join lateral (
      select reason
      from rules
      where (e ->> 'account_name') ~* pattern
      order by ord
      limit 1
    ) r
    where (e ->> 'account_name') !~* '\mdepreciation\M'   -- reconciled separately below
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'account_code', account_code,
      'account_name', account_name,
      'amount_cents', amount_cents,
      'reason',       reason
    ) order by account_code), '[]'::jsonb),
    coalesce(sum(amount_cents), 0)
  into v_add_backs, v_total_add_backs
  from matched;

  -- 2a. Book depreciation = GL depreciation expense (account 6700; matched by name).
  select coalesce(sum((e ->> 'amount_cents')::bigint), 0)
    into v_book_dep
  from jsonb_array_elements(v_expenses) as e
  where (e ->> 'account_name') ~* '\mdepreciation\M';

  -- 2b. Tax depreciation = ATO-basis charge from active assets' live schedules, summed
  -- across the 12 FY month-ends (compute_depreciation is per-month). Degrades to 0 when
  -- the org has no eligible schedules.
  select coalesce(sum(compute_depreciation(s.id, m.month_end)), 0)
    into v_tax_dep
  from depreciation_schedules s
  join fixed_assets a on a.id = s.fixed_asset_id
  cross join (
    select (date_trunc('month', v_fy_start + (g.n || ' months')::interval)
            + interval '1 month - 1 day')::date as month_end
    from generate_series(0, 11) as g(n)
  ) m
  where s.organization_id = p_org
    and s.deleted_at is null
    and a.deleted_at is null
    and a.status = 'active';

  v_dep_diff := v_book_dep - v_tax_dep;

  -- Taxable-income SUBTOTAL after add-backs + depreciation difference. CGT inclusion,
  -- carried-forward losses and franking are SC-4.H.02; offsets/credits are SC-4.H.03.
  v_taxable_income := v_accounting_profit + v_total_add_backs + v_dep_diff;

  return jsonb_build_object(
    'organization_id',         p_org,
    'fy_start_year',           p_fy_start_year,
    'period_start',            v_fy_start,
    'period_end',              v_fy_end,
    'basis',                   coalesce(v_stmt ->> 'basis', 'cumulative_to_date'),
    'accounting_profit_cents', v_accounting_profit,
    'add_backs', jsonb_build_object(
      'lines',       v_add_backs,
      'total_cents', v_total_add_backs
    ),
    'depreciation_reconciliation', jsonb_build_object(
      'book_depreciation_cents', v_book_dep,
      'tax_depreciation_cents',  v_tax_dep,
      'difference_cents',        v_dep_diff,
      'note', 'book − tax: a positive difference increases taxable income (book over-depreciated vs the ATO schedule basis)'
    ),
    'taxable_income_subtotal_cents', v_taxable_income,
    'note', 'Subtotal = accounting profit + non-deductible add-backs + depreciation difference. Before CGT inclusion / carried-forward losses / franking (SC-4.H.02) and offsets & credits / tax payable (SC-4.H.03).'
  );
end;
$$;

comment on function public.book_to_tax(uuid, integer) is
  'SC-4.H.01: book-to-tax reconciliation (jsonb) for an org + AU FY. Starts from '
  'accounting profit (generate_statutory_statements, 0134), adds back non-deductible '
  'expenses (curated ITAA name-match over the GL expense accounts), and applies the '
  'accounting-vs-tax depreciation difference (GL book depreciation minus the ATO-basis '
  'charge from depreciation_schedules via compute_depreciation, 0095, summed over the '
  'FY). Returns a TAXABLE-INCOME SUBTOTAL — CGT/losses/franking are SC-4.H.02, '
  'offsets & credits (tax payable) are SC-4.H.03. SECURITY INVOKER — RLS scopes the '
  'caller; figures degrade to zeros for a foreign org rather than leaking.';

revoke all on function public.book_to_tax(uuid, integer) from public, anon;
grant execute on function public.book_to_tax(uuid, integer) to authenticated;
