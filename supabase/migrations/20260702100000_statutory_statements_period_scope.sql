-- 20260702100000_statutory_statements_period_scope.sql
--
-- Fix generate_statutory_statements(org, fy_start_year) so an FY-labelled
-- report is not built from the cumulative v_trial_balance snapshot.
--
-- New semantics:
--   * Profit & Loss is scoped to the requested AU financial year.
--   * Balance Sheet is as-at the requested FY end date.
--   * Prior-period income/expense balances are carried as opening retained
--     earnings so the balance sheet still balances when no year-end closing
--     journal has been posted.

CREATE INDEX IF NOT EXISTS journal_entries_org_status_entry_date_idx
  ON public.journal_entries (organization_id, status, entry_date);

CREATE OR REPLACE FUNCTION public.generate_statutory_statements(
  p_org uuid,
  p_fy_start_year integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH bounds AS (
    SELECT
      p_org AS organization_id,
      make_date(p_fy_start_year, 7, 1) AS period_start,
      make_date(p_fy_start_year + 1, 6, 30) AS period_end
  ),
  account_activity AS (
    SELECT
      coa.code AS account_code,
      coa.name AS account_name,
      coa.account_type::text AS section,
      COALESCE(SUM(
        CASE
          WHEN je.id IS NOT NULL AND je.entry_date <= b.period_end
          THEN jl.debit_cents - jl.credit_cents
          ELSE 0
        END
      ), 0)::bigint AS as_at_net_cents,
      COALESCE(SUM(
        CASE
          WHEN je.id IS NOT NULL AND je.entry_date BETWEEN b.period_start AND b.period_end
          THEN jl.debit_cents - jl.credit_cents
          ELSE 0
        END
      ), 0)::bigint AS period_net_cents,
      COALESCE(SUM(
        CASE
          WHEN je.id IS NOT NULL AND je.entry_date < b.period_start
          THEN jl.credit_cents - jl.debit_cents
          ELSE 0
        END
      ), 0)::bigint AS opening_credit_normal_cents
    FROM bounds b
    JOIN public.chart_of_accounts coa
      ON coa.organization_id = b.organization_id
    LEFT JOIN public.journal_lines jl
      ON jl.account_id = coa.id
    LEFT JOIN public.journal_entries je
      ON je.id = jl.journal_entry_id
     AND je.organization_id = b.organization_id
     AND je.status = 'posted'
     AND je.entry_date <= b.period_end
    GROUP BY coa.code, coa.name, coa.account_type
  ),
  signed AS (
    SELECT
      account_code,
      account_name,
      section,
      CASE
        WHEN section IN ('asset', 'expense') THEN as_at_net_cents
        ELSE -as_at_net_cents
      END AS balance_sheet_amount_cents,
      CASE
        WHEN section = 'expense' THEN period_net_cents
        WHEN section = 'income' THEN -period_net_cents
        ELSE NULL
      END AS pnl_amount_cents,
      CASE
        WHEN section IN ('income', 'expense') THEN opening_credit_normal_cents
        ELSE 0
      END AS opening_retained_component_cents
    FROM account_activity
  ),
  agg AS (
    SELECT
      COALESCE(jsonb_agg(jsonb_build_object(
        'account_code', account_code,
        'account_name', account_name,
        'amount_cents', balance_sheet_amount_cents
      ) ORDER BY account_code) FILTER (WHERE section = 'asset'), '[]'::jsonb) AS assets,
      COALESCE(SUM(balance_sheet_amount_cents) FILTER (WHERE section = 'asset'), 0)::bigint AS total_assets,
      COALESCE(jsonb_agg(jsonb_build_object(
        'account_code', account_code,
        'account_name', account_name,
        'amount_cents', balance_sheet_amount_cents
      ) ORDER BY account_code) FILTER (WHERE section = 'liability'), '[]'::jsonb) AS liabilities,
      COALESCE(SUM(balance_sheet_amount_cents) FILTER (WHERE section = 'liability'), 0)::bigint AS total_liab,
      COALESCE(jsonb_agg(jsonb_build_object(
        'account_code', account_code,
        'account_name', account_name,
        'amount_cents', balance_sheet_amount_cents
      ) ORDER BY account_code) FILTER (WHERE section = 'equity'), '[]'::jsonb) AS equity,
      COALESCE(SUM(balance_sheet_amount_cents) FILTER (WHERE section = 'equity'), 0)::bigint AS total_equity,
      COALESCE(jsonb_agg(jsonb_build_object(
        'account_code', account_code,
        'account_name', account_name,
        'amount_cents', pnl_amount_cents
      ) ORDER BY account_code) FILTER (WHERE section = 'income'), '[]'::jsonb) AS revenue,
      COALESCE(SUM(pnl_amount_cents) FILTER (WHERE section = 'income'), 0)::bigint AS total_rev,
      COALESCE(jsonb_agg(jsonb_build_object(
        'account_code', account_code,
        'account_name', account_name,
        'amount_cents', pnl_amount_cents
      ) ORDER BY account_code) FILTER (WHERE section = 'expense'), '[]'::jsonb) AS expenses,
      COALESCE(SUM(pnl_amount_cents) FILTER (WHERE section = 'expense'), 0)::bigint AS total_exp,
      COALESCE(SUM(opening_retained_component_cents), 0)::bigint AS opening_retained
    FROM signed
  ),
  final AS (
    SELECT
      *,
      (total_rev - total_exp)::bigint AS net_profit
    FROM agg
  )
  SELECT jsonb_build_object(
    'organization_id', p_org,
    'fy_start_year', p_fy_start_year,
    'period_start', make_date(p_fy_start_year, 7, 1),
    'period_end', make_date(p_fy_start_year + 1, 6, 30),
    'basis', 'fy_period_and_as_at',
    'profit_and_loss', jsonb_build_object(
      'basis', 'fy_period',
      'revenue', revenue,
      'total_revenue_cents', total_rev,
      'expenses', expenses,
      'total_expenses_cents', total_exp,
      'net_profit_cents', net_profit
    ),
    'balance_sheet', jsonb_build_object(
      'basis', 'as_at_period_end',
      'assets', assets,
      'total_assets_cents', total_assets,
      'liabilities', liabilities,
      'total_liabilities_cents', total_liab,
      'equity', equity,
      'total_equity_cents', total_equity,
      'opening_retained_earnings_cents', opening_retained,
      'current_year_earnings_cents', net_profit,
      'total_equity_and_earnings_cents', total_equity + opening_retained + net_profit,
      'balances', (total_assets = total_liab + total_equity + opening_retained + net_profit)
    )
  )
  FROM final;
$$;

COMMENT ON FUNCTION public.generate_statutory_statements(uuid, integer) IS
  'Statutory P&L + Balance Sheet (jsonb) from posted GL lines. P&L is scoped to '
  'the requested AU financial year; Balance Sheet is as-at FY end. Prior-period '
  'income/expense balances are surfaced as opening_retained_earnings_cents so '
  'the balance sheet can balance before formal year-end closing journals. '
  'SECURITY INVOKER.';

REVOKE ALL ON FUNCTION public.generate_statutory_statements(uuid, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.generate_statutory_statements(uuid, integer) TO authenticated;
