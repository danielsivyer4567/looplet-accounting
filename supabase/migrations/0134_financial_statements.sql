-- 0134_financial_statements.sql — SC-4.B.01 (Phase 4, statutory statements)
--
-- generate_statutory_statements(org, fy_start_year) — a P&L + Balance Sheet from the
-- REAL GL trial balance (v_trial_balance, 0074), NOT the approximate v_balance_sheet
-- (0041, which its own COMMENT says is pre-GL). Returns jsonb: P&L (revenue/expenses/
-- net profit) and BS (assets/liabilities/equity + current-year earnings), with line
-- items per account and a `balances` flag (assets = liabilities + equity + earnings).
--
-- SECTION MAP — the account_type enum has exactly 5 values (verified live: asset,
-- liability, equity, income, expense), so the statement section IS the account_type and
-- the partition is trivially exhaustive. Sign each line to its statement-positive amount:
--   asset, expense            → debit-normal  (amount =  net_cents)
--   liability, equity, income → credit-normal (amount = -net_cents)
-- Since a trial balance nets to zero and the 5 sections partition ALL accounts,
-- total_assets = total_liabilities + total_equity + net_profit (current-year earnings)
-- holds for any balanced GL — that is the `balances` assertion.
--
-- LIMITATION: v_trial_balance is CUMULATIVE (no date filter — see its 0074 def), so
-- these statements are an as-at-now snapshot. The fy_start_year only labels the period;
-- true per-FY statements need a date-scoped trial balance (a documented refinement).
-- 'basis':'cumulative_to_date' surfaces this in the payload.
--
-- SECURITY INVOKER + STABLE (read-only): v_trial_balance is RLS-scoped to the caller.
-- MIGRATION NUMBER: Phase-4 plan said 0126, taken; 0134 per the drift rule.

create or replace function public.generate_statutory_statements(p_org uuid, p_fy_start_year integer)
  returns jsonb
  language sql
  stable
  security invoker
  set search_path = public
as $$
  with classified as (
    select
      account_code,
      account_name,
      account_type::text as section,
      -- Sign each line into its statement-positive amount (debit-normal vs credit-normal).
      case when account_type in ('asset', 'expense') then net_cents else -net_cents end as amount_cents
    from v_trial_balance
    where organization_id = p_org
  ),
  agg as (
    select
      coalesce(jsonb_agg(jsonb_build_object('account_code', account_code, 'account_name', account_name, 'amount_cents', amount_cents)
               order by account_code) filter (where section = 'asset'), '[]'::jsonb)     as assets,
      coalesce(sum(amount_cents) filter (where section = 'asset'), 0)                      as total_assets,
      coalesce(jsonb_agg(jsonb_build_object('account_code', account_code, 'account_name', account_name, 'amount_cents', amount_cents)
               order by account_code) filter (where section = 'liability'), '[]'::jsonb) as liabilities,
      coalesce(sum(amount_cents) filter (where section = 'liability'), 0)                  as total_liab,
      coalesce(jsonb_agg(jsonb_build_object('account_code', account_code, 'account_name', account_name, 'amount_cents', amount_cents)
               order by account_code) filter (where section = 'equity'), '[]'::jsonb)    as equity,
      coalesce(sum(amount_cents) filter (where section = 'equity'), 0)                     as total_equity,
      coalesce(jsonb_agg(jsonb_build_object('account_code', account_code, 'account_name', account_name, 'amount_cents', amount_cents)
               order by account_code) filter (where section = 'income'), '[]'::jsonb)    as revenue,
      coalesce(sum(amount_cents) filter (where section = 'income'), 0)                     as total_rev,
      coalesce(jsonb_agg(jsonb_build_object('account_code', account_code, 'account_name', account_name, 'amount_cents', amount_cents)
               order by account_code) filter (where section = 'expense'), '[]'::jsonb)   as expenses,
      coalesce(sum(amount_cents) filter (where section = 'expense'), 0)                    as total_exp
    from classified
  ),
  final as (
    select *, (total_rev - total_exp) as net_profit from agg
  )
  select jsonb_build_object(
    'organization_id', p_org,
    'fy_start_year', p_fy_start_year,
    'period_start', make_date(p_fy_start_year, 7, 1),
    'period_end', make_date(p_fy_start_year + 1, 6, 30),
    'basis', 'cumulative_to_date',
    'profit_and_loss', jsonb_build_object(
      'revenue', revenue,
      'total_revenue_cents', total_rev,
      'expenses', expenses,
      'total_expenses_cents', total_exp,
      'net_profit_cents', net_profit
    ),
    'balance_sheet', jsonb_build_object(
      'assets', assets,
      'total_assets_cents', total_assets,
      'liabilities', liabilities,
      'total_liabilities_cents', total_liab,
      'equity', equity,
      'total_equity_cents', total_equity,
      'current_year_earnings_cents', net_profit,
      'total_equity_and_earnings_cents', total_equity + net_profit,
      'balances', (total_assets = total_liab + total_equity + net_profit)
    )
  )
  from final;
$$;

comment on function public.generate_statutory_statements(uuid, integer) is
  'Statutory P&L + Balance Sheet (jsonb) from the real GL trial balance '
  '(v_trial_balance, 0074) — line items + section totals + a balances flag (assets = '
  'liabilities + equity + current-year earnings). v_trial_balance is cumulative, so '
  'these are an as-at snapshot (basis=cumulative_to_date); FY-scoping is a refinement. '
  'SECURITY INVOKER.';

revoke all on function public.generate_statutory_statements(uuid, integer) from public, anon;
grant execute on function public.generate_statutory_statements(uuid, integer) to authenticated;
