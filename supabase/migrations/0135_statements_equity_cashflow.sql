-- 0135_statements_equity_cashflow.sql — SC-4.B.02 (Phase 4, statutory statements)
--
-- generate_equity_and_cashflow_statements(org, fy_start_year) — the PERIOD-scoped
-- companions to SC-4.B.01's cumulative P&L + Balance Sheet (0134):
--   1. Statement of changes in equity — opening equity + movements = closing equity.
--   2. Statutory cash-flow statement (direct method) — operating / investing /
--      financing, whose net change ties to the GL cash/bank-account movement.
--
-- WHY A SEPARATE, PERIOD-SCOPED FUNCTION (not an extension of 0134):
-- 0134 reads v_trial_balance (0074), which is CUMULATIVE — no date filter. A statement
-- of changes in equity and a cash-flow statement are intrinsically PERIOD statements
-- (opening → movements → closing), so this function scans the POSTED journal lines
-- directly with their entry_date and buckets each line by the FY window:
--   opening  : entry_date <  period_start          (the as-at-start balance)
--   movement : entry_date in [period_start, end]   (the FY activity)
--   closing  : entry_date <= period_end            (= opening + movement, exactly)
-- period_start = 1 Jul fy_start_year, period_end = 30 Jun (fy_start_year + 1). Posted
-- lines only (matching v_trial_balance); no is_active / deleted filter (a later-
-- deactivated account still owns its historical postings) — verified live: these three
-- tables carry no deleted_at column.
--
-- STATEMENT OF CHANGES IN EQUITY — "total equity" is the credit-normal balance over the
-- {equity, income, expense} accounts (direct equity-account balances + accumulated
-- earnings); each such line's equity-INCREASING amount is (credit_cents - debit_cents):
-- income credits and capital credits raise equity, expense and drawings debits lower it.
-- The reconciliation opening + (profit_for_year + equity-account movements) = closing is
-- therefore a pure period-additivity identity over that partition. profit_for_year is the
-- income/expense slice; direct movements (capital, drawings, dividends, and any closing
-- entries into retained earnings) are the equity-account slice — partitioned by
-- account_type, so the two never double-count (a closing entry's income debit and its
-- 3900 credit are distinct lines that net to zero).
--
-- CASH-FLOW STATEMENT (direct method, contra-account classification) — cash/bank GL
-- accounts are asset accounts named like bank/cash (a DOCUMENTED HEURISTIC: the schema has
-- no is_cash flag, and the seed names them 'Business bank account' / 'Cash on hand'; a
-- future is_cash_equivalent flag would make this exact). For every FY journal entry that
-- touches a cash account, the cash movement is — by double-entry — the negative of that
-- entry's non-cash lines, so each non-cash line's (credit - debit) is classified by the
-- non-cash account_type:
--   income / expense       → operating
--   asset (non-cash)       → investing
--   liability / equity     → financing
-- operating + investing + financing therefore EQUALS the FY movement across the cash
-- accounts (closing_cash - opening_cash) — that exact tie-out is `ties_to_gl`. Cash-to-cash
-- transfers wash out (both legs are cash, no non-cash line) and contribute nothing.
-- LIMITATION: account_type alone cannot distinguish a trade payable (operating) from a
-- loan (financing) — both are liabilities and land in financing here. A fuller split needs
-- account sub-classification; documented, not silently misstated.
--
-- SECURITY INVOKER + STABLE (read-only): the underlying-table RLS scopes every read to the
-- caller's orgs, so a foreign org returns a safe all-zero report (no leak), exactly like
-- the 0132/0133/0134 Phase-4 siblings.
-- MIGRATION NUMBER: Phase-4 plan said 0127, taken; 0135 per the drift rule (repo head 0134).

create or replace function public.generate_equity_and_cashflow_statements(p_org uuid, p_fy_start_year integer)
  returns jsonb
  language sql
  stable
  security invoker
  set search_path = public
as $$
  with base as materialized (
    -- One scan of the org's POSTED ledger, tagged with class, cash flag, and the FY window.
    -- MATERIALIZED so the 3-way GL join is evaluated once and reused by every CTE below
    -- (it is multiply-referenced, so Postgres materializes it anyway — this makes it explicit).
    select
      coa.code                  as account_code,
      coa.name                  as account_name,
      coa.account_type::text    as account_type,
      (coa.account_type = 'asset'
        and (coa.name ilike '%bank%' or coa.name ilike '%cash%')) as is_cash,
      jl.journal_entry_id       as entry_id,
      je.entry_date             as entry_date,
      jl.debit_cents            as debit_cents,
      jl.credit_cents           as credit_cents,
      make_date(p_fy_start_year, 7, 1)      as period_start,
      make_date(p_fy_start_year + 1, 6, 30) as period_end
    from public.journal_lines jl
    join public.journal_entries je
      on je.id = jl.journal_entry_id
     and je.status = 'posted'
     and je.organization_id = p_org
    join public.chart_of_accounts coa
      on coa.id = jl.account_id
  ),

  -- ---- Statement of changes in equity ------------------------------------------------
  -- Per direct-equity account: opening / FY movement / closing, credit-normal (cr - dr).
  equity_accounts as (
    select
      account_code, account_name,
      coalesce(sum(credit_cents - debit_cents) filter (where entry_date < period_start), 0)                       as opening_cents,
      coalesce(sum(credit_cents - debit_cents) filter (where entry_date between period_start and period_end), 0)  as movement_cents,
      coalesce(sum(credit_cents - debit_cents) filter (where entry_date <= period_end), 0)                        as closing_cents
    from base
    where account_type = 'equity'
    group by account_code, account_name
  ),
  -- Accumulated earnings (income + expense) — the retained-earnings component; its FY slice
  -- is "profit for the year".
  retained as (
    select
      coalesce(sum(credit_cents - debit_cents) filter (where entry_date < period_start), 0)                       as opening_cents,
      coalesce(sum(credit_cents - debit_cents) filter (where entry_date between period_start and period_end), 0)  as profit_for_year_cents,
      coalesce(sum(credit_cents - debit_cents) filter (where entry_date <= period_end), 0)                        as closing_cents
    from base
    where account_type in ('income', 'expense')
  ),
  -- Total equity = direct equity accounts + the retained-earnings component. Derived from the
  -- two CTEs above rather than a third pass over base; opening + movement = closing still
  -- reconciles because it holds for each component (pure period additivity).
  equity_totals as (
    select
      (select coalesce(sum(opening_cents), 0)  from equity_accounts) + (select opening_cents from retained)         as opening_cents,
      (select coalesce(sum(movement_cents), 0) from equity_accounts) + (select profit_for_year_cents from retained) as movement_cents,
      (select coalesce(sum(closing_cents), 0)  from equity_accounts) + (select closing_cents from retained)         as closing_cents
  ),

  -- ---- Cash-flow statement -----------------------------------------------------------
  -- Cash/bank accounts: opening / closing balances, debit-normal (dr - cr).
  cash_items as (
    select
      account_code, account_name,
      coalesce(sum(debit_cents - credit_cents) filter (where entry_date < period_start), 0) as opening_cents,
      coalesce(sum(debit_cents - credit_cents) filter (where entry_date <= period_end), 0)  as closing_cents
    from base
    where is_cash
    group by account_code, account_name
  ),
  -- FY journal entries that move cash — the set whose non-cash legs explain the cash flow.
  cash_entry_ids as (
    select distinct entry_id
    from base
    where is_cash and entry_date between period_start and period_end
  ),
  -- Classify the non-cash legs of cash-moving FY entries by account_type (cr - dr = cash in).
  cf as (
    select
      coalesce(sum(credit_cents - debit_cents) filter (where account_type in ('income', 'expense')), 0)   as operating_cents,
      coalesce(sum(credit_cents - debit_cents) filter (where account_type = 'asset'), 0)                  as investing_cents,
      coalesce(sum(credit_cents - debit_cents) filter (where account_type in ('liability', 'equity')), 0) as financing_cents
    from base
    where not is_cash
      and entry_id in (select entry_id from cash_entry_ids)
  )

  select jsonb_build_object(
    'organization_id', p_org,
    'fy_start_year', p_fy_start_year,
    'period_start', make_date(p_fy_start_year, 7, 1),
    'period_end', make_date(p_fy_start_year + 1, 6, 30),
    'basis', 'fy_period',
    'statement_of_changes_in_equity', jsonb_build_object(
      'equity_accounts', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'account_code', account_code, 'account_name', account_name,
                 'opening_cents', opening_cents, 'movement_cents', movement_cents, 'closing_cents', closing_cents)
               order by account_code), '[]'::jsonb)
        from equity_accounts),
      'retained_earnings', (
        select jsonb_build_object(
                 'opening_cents', opening_cents,
                 'profit_for_year_cents', profit_for_year_cents,
                 'closing_cents', closing_cents)
        from retained),
      'opening_equity_cents', (select opening_cents from equity_totals),
      'total_movement_cents', (select movement_cents from equity_totals),
      'closing_equity_cents', (select closing_cents from equity_totals),
      'reconciles', (select opening_cents + movement_cents = closing_cents from equity_totals)
    ),
    'cash_flow_statement', jsonb_build_object(
      'cash_accounts', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'account_code', account_code, 'account_name', account_name,
                 'opening_cents', opening_cents, 'closing_cents', closing_cents)
               order by account_code), '[]'::jsonb)
        from cash_items),
      'operating_cents', (select operating_cents from cf),
      'investing_cents', (select investing_cents from cf),
      'financing_cents', (select financing_cents from cf),
      'net_change_in_cash_cents', (select operating_cents + investing_cents + financing_cents from cf),
      'opening_cash_cents', (select coalesce(sum(opening_cents), 0) from cash_items),
      'closing_cash_cents', (select coalesce(sum(closing_cents), 0) from cash_items),
      'gl_cash_movement_cents', (select coalesce(sum(closing_cents - opening_cents), 0) from cash_items),
      'ties_to_gl', (
        select (select operating_cents + investing_cents + financing_cents from cf)
                 = (select coalesce(sum(closing_cents - opening_cents), 0) from cash_items))
    )
  );
$$;

comment on function public.generate_equity_and_cashflow_statements(uuid, integer) is
  'Statement of changes in equity + statutory cash-flow statement (jsonb) for an FY, '
  'period-scoped by journal entry_date over POSTED lines (companion to 0134''s cumulative '
  'P&L + Balance Sheet). Equity reconciliation opening + movements = closing is a period '
  'identity over {equity,income,expense}. Cash flow is direct-method: non-cash legs of '
  'cash-moving FY entries classified by account_type into operating/investing/financing, '
  'whose total ties to the GL cash-account movement (ties_to_gl). Cash accounts identified '
  'by name heuristic (asset named like bank/cash); liabilities all classify as financing '
  '(trade-payable vs loan not distinguishable from account_type). SECURITY INVOKER.';

revoke all on function public.generate_equity_and_cashflow_statements(uuid, integer) from public, anon;
grant execute on function public.generate_equity_and_cashflow_statements(uuid, integer) to authenticated;
