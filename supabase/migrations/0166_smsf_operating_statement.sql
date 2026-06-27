-- 0166_smsf_operating_statement.sql — SC-5.J.01 (Phase 5, SMSF financials — operating statement)
--
-- smsf_operating_statement(org, fy[, fund]) — the SMSF OPERATING STATEMENT (the fund's income
-- statement) for an AU income year: contributions + investment income, less expenses, less the
-- 15% income tax, to a net result that flows to members' funds (the statement of financial
-- position / changes-in-members'-funds slices, SC-5.J.02/.03, reconcile to this). Pure read.
--
-- ── MILESTONE DECOMPOSITION (part 1 of the SMSF financials) ─────────────────────
-- Isolated so the INCOME side is assertable on its own before the balance side. A SIS-Act
-- specialisation of the general statement generator (SC-4.B, Phase 4) — but the SMSF
-- structure (contributions split, 15% concessional/earnings tax, member components) is
-- specific enough that the lines are built here from the SMSF movement tables (SC-5.H.02),
-- not from the GL statement generator. Overlap noted; no GL reuse forced.
--
-- ── LINES (from the SMSF movement tables, 0163) ────────────────────────────────
-- Income:
--   contributions_concessional      — smsf_contributions, type concessional, this FY (assessable).
--   contributions_non_concessional  — smsf_contributions, type non_concessional, this FY
--                                     (NOT assessable income — after-tax money).
--   investment_income               — accrued earnings proxy = sum(market_value - cost_base)
--                                     over smsf_investments (unrealised + realised gains held).
--   total_income = concessional + non_concessional + investment_income.
-- Expenses:
--   expenses                        — 0 (the schema has no SMSF expense table yet; a documented
--                                     caveat — admin/audit/insurance expenses are a later refinement).
-- Income tax (s295: complying SMSF accumulation rate 15%):
--   income_tax = 15% x (assessable contributions[concessional] + investment_income).
--                Non-concessional contributions are excluded (not assessable). The retirement-
--                phase (pension) earnings exemption is NOT separated here — documented caveat,
--                consistent with the member-balance roll-forward (SC-5.I.01).
-- Net result = total_income - expenses - income_tax. (Benefits paid / pensions appear in the
--   changes-in-members'-funds statement SC-5.J.03, not the operating statement.)
--
-- SECURITY INVOKER + STABLE — every read (smsf_contributions/investments + fund resolution) is
-- RLS-scoped to the caller; a foreign org/fund yields zeros. No writes. revoke public/anon +
-- grant authenticated (the trust-chain RPC posture, 0154-0160-0164-0165).
--
-- MIGRATION NUMBER: the ledger Files line planned 0158, long taken (distribution_persist).
-- Reassigned to 0166 per the drift rule — the sequential repo head is 0165_smsf_tbc_tbar
-- (0178/0179 are late hotfixes that sort after). Verified live (read-only):
-- smsf_operating_statement ABSENT (no drift); the SMSF 0162-0165 chain is repo-only.

create or replace function public.smsf_operating_statement(
    p_org uuid, p_fy_start_year integer, p_fund uuid default null)
  returns jsonb
  language plpgsql
  stable
  security invoker
  set search_path = public
as $$
declare
  v_fund          uuid;
  v_cc            bigint;   -- concessional contributions (assessable)
  v_ncc           bigint;   -- non-concessional contributions (not assessable)
  v_inv_income    bigint;   -- investment income (accrued earnings)
  v_total_income  bigint;
  v_expenses      bigint := 0;
  v_assessable    bigint;
  v_income_tax    bigint;
  v_net_result    bigint;
begin
  -- Resolve the fund (explicit, else the org's single fund, else RAISE on >1).
  if p_fund is not null then
    v_fund := p_fund;
  else
    select id into v_fund from smsf_funds
      where organization_id = p_org and deleted_at is null;
    if not found then
      return jsonb_build_object('ok', false, 'organization_id', p_org,
        'error', 'no SMSF fund for this org');
    end if;
    if (select count(*) from smsf_funds where organization_id = p_org and deleted_at is null) > 1 then
      raise exception 'org % has multiple SMSF funds; pass p_fund', p_org;
    end if;
  end if;

  -- Contributions for the income year, split by assessability.
  select
    coalesce(sum(amount_cents) filter (where contribution_type = 'concessional'), 0),
    coalesce(sum(amount_cents) filter (where contribution_type = 'non_concessional'), 0)
  into v_cc, v_ncc
  from smsf_contributions
  where fund_id = v_fund and organization_id = p_org
    and fy_start_year = p_fy_start_year and deleted_at is null;

  -- Investment income = accrued earnings (market value over cost base) on fund investments.
  select coalesce(sum(market_value_cents - cost_base_cents), 0) into v_inv_income
  from smsf_investments where fund_id = v_fund and organization_id = p_org and deleted_at is null;

  v_total_income := v_cc + v_ncc + v_inv_income;
  -- s295 complying SMSF accumulation tax (15%) on assessable income = concessional + earnings.
  v_assessable   := v_cc + v_inv_income;
  v_income_tax   := floor(v_assessable * 0.15)::bigint;
  v_net_result   := v_total_income - v_expenses - v_income_tax;

  return jsonb_build_object(
    'ok',              true,
    'organization_id', p_org,
    'fund_id',         v_fund,
    'fy_start_year',   p_fy_start_year,
    'income', jsonb_build_object(
      'contributions_concessional_cents',     v_cc,
      'contributions_non_concessional_cents', v_ncc,
      'investment_income_cents',              v_inv_income,
      'total_income_cents',                   v_total_income
    ),
    'expenses_cents',         v_expenses,
    'assessable_income_cents', v_assessable,
    'income_tax_cents',       v_income_tax,
    'net_result_cents',       v_net_result,
    'caveats', jsonb_build_array(
      'Investment income is the accrued earnings proxy (sum of market value less cost base over fund investments); a realised-vs-unrealised split and investment-by-investment income (dividends/rent/interest) are the refinement.',
      'Expenses are 0 — the schema has no SMSF expense table yet (admin/audit/insurance/adviser fees). The net result will overstate until expenses are tracked.',
      'Income tax is the complying-SMSF accumulation rate (15%) on assessable income (concessional contributions + investment income). Non-concessional contributions are not assessable. The retirement-phase (pension) earnings exemption is not separated here — a fund wholly in pension phase pays no tax on earnings; refine alongside the member-balance phase split (SC-5.I.01).',
      'Benefits paid (pension payments / lump sums) are not in the operating statement; they appear in the statement of changes in members'' funds (SC-5.J.03).'
    ),
    'note', 'SMSF operating statement / income statement (SC-5.J.01): contributions + investment income, less expenses, less 15% income tax on assessable income, to a net result. Reads smsf_contributions/investments (SC-5.H.02). Advisory; SECURITY INVOKER; no writes. Balance side is SC-5.J.02.'
  );
end;
$$;

comment on function public.smsf_operating_statement(uuid, integer, uuid) is
  'SC-5.J.01: SMSF operating statement (income statement, jsonb) for an org + AU FY — '
  'contributions (concessional/non-concessional) + investment income (accrued earnings), '
  'less expenses (0; no expense table yet), less 15% income tax on assessable income '
  '(concessional + earnings), to a net result. Reads smsf_contributions/investments (0163). '
  'SECURITY INVOKER — RLS scopes the caller; no writes. Balance side = SC-5.J.02.';

revoke all on function public.smsf_operating_statement(uuid, integer, uuid) from public, anon;
grant execute on function public.smsf_operating_statement(uuid, integer, uuid) to authenticated;
