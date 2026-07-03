-- Live pending migration bundle for Supabase SQL editor fallback.
-- Generated from local migration files. Apply only to project dxoikltymmknxqpkpyhi.
-- Preferred path remains: supabase db push with a valid SUPABASE_DB_PASSWORD.
-- This fallback is for the current invalid DB-password blocker.
--
-- Safety notes:
-- - Review before running.
-- - Do not run on the wrong project.
-- - Most blocks are CREATE OR REPLACE / CREATE IF NOT EXISTS / guarded cron.
-- - Migration history is recorded after each migration so readiness checks can see the applied versions.


-- ============================================================================
-- BEGIN 20260701070000_reconcile_evidence_atomic
-- Source: supabase/migrations/20260701070000_reconcile_evidence_atomic.sql
-- ============================================================================

-- 20260701070000_reconcile_evidence_atomic.sql
--
-- Auto-reconcile must never apply a bank match without the proof row that
-- explains why it was safe. The edge function used to apply matches first and
-- batch-insert reconciliation_evidence afterwards, so an evidence write failure
-- could leave a matched transaction with no audit trail.
--
-- These SECURITY DEFINER wrappers keep the mutation and evidence insert in one
-- database transaction. If the evidence insert fails, Postgres aborts the whole
-- function call and rolls the match back.

CREATE OR REPLACE FUNCTION public.reconcile_match_bill_with_evidence(
  p_bank_transaction_id uuid,
  p_bill_id uuid,
  p_match_confidence numeric DEFAULT 1.0,
  p_manually_matched boolean DEFAULT false,
  p_reason_codes text[] DEFAULT '{}',
  p_score_components jsonb DEFAULT '{}'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
  v_org uuid;
  v_gl_evidence jsonb;
BEGIN
  v_result := public.reconcile_match_bill(
    p_bank_transaction_id,
    p_bill_id,
    p_match_confidence,
    p_manually_matched
  );

  IF COALESCE((v_result ->> 'ok')::boolean, false) IS NOT TRUE THEN
    RETURN v_result;
  END IF;

  SELECT organization_id
    INTO v_org
  FROM public.bank_transactions
  WHERE id = p_bank_transaction_id;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'bank transaction % missing after bill match', p_bank_transaction_id;
  END IF;

  SELECT jsonb_build_object(
    'source_type', 'bill',
    'source_id', p_bill_id,
    'journal_entries', COALESCE(
      jsonb_agg(jsonb_build_object(
        'id', je.id,
        'status', je.status,
        'posted_at', je.posted_at,
        'entry_date', je.entry_date,
        'source_type', je.source_type,
        'source_id', je.source_id
      ) ORDER BY je.entry_date DESC, je.created_at DESC) FILTER (WHERE je.id IS NOT NULL),
      '[]'::jsonb
    ),
    'posted_count', COUNT(*) FILTER (WHERE je.status = 'posted')
  )
    INTO v_gl_evidence
  FROM public.journal_entries je
  WHERE je.organization_id = v_org
    AND je.source_type = 'bill'
    AND je.source_id = p_bill_id;

  INSERT INTO public.reconciliation_evidence (
    bank_transaction_id,
    organization_id,
    reason_codes,
    score_components,
    auto_applied,
    skipped_reason
  )
  VALUES (
    p_bank_transaction_id,
    v_org,
    COALESCE(p_reason_codes, '{}'::text[]),
    jsonb_set(
      COALESCE(p_score_components, '{}'::jsonb),
      '{gl_evidence}',
      v_gl_evidence,
      true
    ),
    true,
    NULL
  );

  RETURN v_result || jsonb_build_object('evidence_recorded', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_match_invoice_with_evidence(
  p_bank_transaction_id uuid,
  p_invoice_id uuid,
  p_amount_cents bigint,
  p_match_confidence numeric DEFAULT 1.0,
  p_manually_matched boolean DEFAULT false,
  p_reason_codes text[] DEFAULT '{}',
  p_score_components jsonb DEFAULT '{}'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
  v_org uuid;
  v_gl_evidence jsonb;
BEGIN
  v_result := public.reconcile_match_invoice(
    p_bank_transaction_id,
    p_invoice_id,
    p_amount_cents,
    p_match_confidence,
    p_manually_matched
  );

  IF COALESCE((v_result ->> 'ok')::boolean, false) IS NOT TRUE THEN
    RETURN v_result;
  END IF;

  SELECT organization_id
    INTO v_org
  FROM public.bank_transactions
  WHERE id = p_bank_transaction_id;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'bank transaction % missing after invoice match', p_bank_transaction_id;
  END IF;

  SELECT jsonb_build_object(
    'source_type', 'invoice',
    'source_id', p_invoice_id,
    'journal_entries', COALESCE(
      jsonb_agg(jsonb_build_object(
        'id', je.id,
        'status', je.status,
        'posted_at', je.posted_at,
        'entry_date', je.entry_date,
        'source_type', je.source_type,
        'source_id', je.source_id
      ) ORDER BY je.entry_date DESC, je.created_at DESC) FILTER (WHERE je.id IS NOT NULL),
      '[]'::jsonb
    ),
    'posted_count', COUNT(*) FILTER (WHERE je.status = 'posted')
  )
    INTO v_gl_evidence
  FROM public.journal_entries je
  WHERE je.organization_id = v_org
    AND je.source_type = 'invoice'
    AND je.source_id = p_invoice_id;

  INSERT INTO public.reconciliation_evidence (
    bank_transaction_id,
    organization_id,
    reason_codes,
    score_components,
    auto_applied,
    skipped_reason
  )
  VALUES (
    p_bank_transaction_id,
    v_org,
    COALESCE(p_reason_codes, '{}'::text[]),
    jsonb_set(
      COALESCE(p_score_components, '{}'::jsonb),
      '{gl_evidence}',
      v_gl_evidence,
      true
    ),
    true,
    NULL
  );

  RETURN v_result || jsonb_build_object('evidence_recorded', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_reconciliation_skip_evidence(
  p_bank_transaction_id uuid,
  p_org_id uuid,
  p_reason_codes text[] DEFAULT '{}',
  p_score_components jsonb DEFAULT '{}',
  p_skipped_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_is_service boolean := (auth.role() = 'service_role');
BEGIN
  SELECT organization_id
    INTO v_org
  FROM public.bank_transactions
  WHERE id = p_bank_transaction_id;

  IF v_org IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'transaction not found');
  END IF;
  IF v_org <> p_org_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'org mismatch');
  END IF;
  IF NOT v_is_service AND v_org NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF COALESCE(trim(p_skipped_reason), '') = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'skipped_reason required');
  END IF;

  INSERT INTO public.reconciliation_evidence (
    bank_transaction_id,
    organization_id,
    reason_codes,
    score_components,
    auto_applied,
    skipped_reason
  )
  VALUES (
    p_bank_transaction_id,
    v_org,
    COALESCE(p_reason_codes, '{}'::text[]),
    COALESCE(p_score_components, '{}'::jsonb),
    false,
    p_skipped_reason
  );

  RETURN jsonb_build_object('ok', true, 'evidence_recorded', true);
END;
$$;

COMMENT ON FUNCTION public.reconcile_match_bill_with_evidence IS
  'Applies a bill bank match and writes reconciliation_evidence, including posted GL evidence for the bill, in the same transaction.';
COMMENT ON FUNCTION public.reconcile_match_invoice_with_evidence IS
  'Applies an invoice bank match and writes reconciliation_evidence, including posted GL evidence for the invoice, in the same transaction.';
COMMENT ON FUNCTION public.record_reconciliation_skip_evidence IS
  'Writes org-scoped reconciliation evidence for an ambiguous auto-reconcile skip.';

REVOKE ALL ON FUNCTION public.reconcile_match_bill_with_evidence(
  uuid, uuid, numeric, boolean, text[], jsonb
) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reconcile_match_invoice_with_evidence(
  uuid, uuid, bigint, numeric, boolean, text[], jsonb
) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.record_reconciliation_skip_evidence(
  uuid, uuid, text[], jsonb, text
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.reconcile_match_bill_with_evidence(
  uuid, uuid, numeric, boolean, text[], jsonb
) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_match_invoice_with_evidence(
  uuid, uuid, bigint, numeric, boolean, text[], jsonb
) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_reconciliation_skip_evidence(
  uuid, uuid, text[], jsonb, text
) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';


-- Record manual application in Supabase migration history if this bundle is applied through SQL editor.
do $$
declare
  v_has_name boolean;
  v_has_statements boolean;
begin
  if to_regclass('supabase_migrations.schema_migrations') is null then
    raise notice 'supabase_migrations.schema_migrations not found; skipping migration-history record for 20260701070000';
    return;
  end if;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'supabase_migrations'
      and table_name = 'schema_migrations'
      and column_name = 'name'
  ) into v_has_name;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'supabase_migrations'
      and table_name = 'schema_migrations'
      and column_name = 'statements'
  ) into v_has_statements;

  if v_has_name and v_has_statements then
    execute 'insert into supabase_migrations.schema_migrations(version, name, statements) values ($1, $2, $3) on conflict (version) do nothing'
      using '20260701070000', 'reconcile_evidence_atomic', array['manual SQL editor apply 20260701070000_reconcile_evidence_atomic'];
  elsif v_has_name then
    execute 'insert into supabase_migrations.schema_migrations(version, name) values ($1, $2) on conflict (version) do nothing'
      using '20260701070000', 'reconcile_evidence_atomic';
  else
    execute 'insert into supabase_migrations.schema_migrations(version) values ($1) on conflict (version) do nothing'
      using '20260701070000';
  end if;
end $$;

-- ============================================================================
-- END 20260701070000_reconcile_evidence_atomic
-- ============================================================================

-- ============================================================================
-- BEGIN 20260702090000_period_lock_money_tables
-- Source: supabase/migrations/20260702090000_period_lock_money_tables.sql
-- ============================================================================

-- 20260702090000: Period-lock enforcement for later money-moving tables.
--
-- The original 0001 trigger only saw early tables/date names
-- (invoice_date, bill_date, transaction_date, work_date) and only attached to
-- bills/customer_invoices/wage_entries. Later AR, bank, payroll, and ABA payment
-- tables and journal headers need the same close-period write guard.

BEGIN;

CREATE OR REPLACE FUNCTION public.check_period_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row jsonb;
  v_record_date date;
  v_org_id uuid;
BEGIN
  v_row := to_jsonb(NEW);
  v_org_id := nullif(v_row ->> 'organization_id', '')::uuid;

  v_record_date := CASE TG_TABLE_NAME
    WHEN 'bills' THEN nullif(v_row ->> 'invoice_date', '')::date
    WHEN 'customer_invoices' THEN nullif(v_row ->> 'invoice_date', '')::date
    WHEN 'invoices' THEN nullif(v_row ->> 'issue_date', '')::date
    WHEN 'invoice_payments' THEN (nullif(v_row ->> 'paid_at', '')::timestamptz)::date
    WHEN 'bank_transactions' THEN (nullif(v_row ->> 'posted_at', '')::timestamptz)::date
    WHEN 'wage_entries' THEN nullif(v_row ->> 'work_date', '')::date
    WHEN 'pay_runs' THEN COALESCE(
      nullif(v_row ->> 'pay_date', '')::date,
      nullif(v_row ->> 'period_end', '')::date
    )
    WHEN 'payment_runs' THEN nullif(v_row ->> 'pay_date', '')::date
    WHEN 'journal_entries' THEN nullif(v_row ->> 'entry_date', '')::date
    ELSE COALESCE(
      nullif(v_row ->> 'invoice_date', '')::date,
      nullif(v_row ->> 'bill_date', '')::date,
      nullif(v_row ->> 'transaction_date', '')::date,
      nullif(v_row ->> 'work_date', '')::date,
      nullif(v_row ->> 'issue_date', '')::date,
      (nullif(v_row ->> 'paid_at', '')::timestamptz)::date,
      (nullif(v_row ->> 'posted_at', '')::timestamptz)::date,
      nullif(v_row ->> 'pay_date', '')::date,
      nullif(v_row ->> 'period_end', '')::date,
      nullif(v_row ->> 'entry_date', '')::date
    )
  END;

  IF v_record_date IS NULL OR v_org_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.period_locks pl
     WHERE pl.organization_id = v_org_id
       AND v_record_date BETWEEN pl.period_start AND pl.period_end
       AND pl.unlocked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot modify % dated %: period is locked',
      TG_TABLE_NAME, v_record_date
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.check_period_lock() IS
  'Trigger guard that blocks writes dated inside active period_locks across bills, invoices, bank transactions, payroll runs, payment runs, and journal entries.';

REVOKE ALL ON FUNCTION public.check_period_lock() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_period_lock() TO authenticated, service_role;

DO $$
DECLARE
  t text;
  rel regclass;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'bills',
    'customer_invoices',
    'wage_entries',
    'invoices',
    'invoice_payments',
    'bank_transactions',
    'pay_runs',
    'payment_runs',
    'journal_entries'
  ]
  LOOP
    rel := to_regclass(format('public.%I', t));
    IF rel IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s;', 'trg_' || t || '_period_lock', rel);
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION public.check_period_lock();',
        'trg_' || t || '_period_lock',
        rel
      );
    END IF;
  END LOOP;
END $$;

COMMIT;


-- Record manual application in Supabase migration history if this bundle is applied through SQL editor.
do $$
declare
  v_has_name boolean;
  v_has_statements boolean;
begin
  if to_regclass('supabase_migrations.schema_migrations') is null then
    raise notice 'supabase_migrations.schema_migrations not found; skipping migration-history record for 20260702090000';
    return;
  end if;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'supabase_migrations'
      and table_name = 'schema_migrations'
      and column_name = 'name'
  ) into v_has_name;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'supabase_migrations'
      and table_name = 'schema_migrations'
      and column_name = 'statements'
  ) into v_has_statements;

  if v_has_name and v_has_statements then
    execute 'insert into supabase_migrations.schema_migrations(version, name, statements) values ($1, $2, $3) on conflict (version) do nothing'
      using '20260702090000', 'period_lock_money_tables', array['manual SQL editor apply 20260702090000_period_lock_money_tables'];
  elsif v_has_name then
    execute 'insert into supabase_migrations.schema_migrations(version, name) values ($1, $2) on conflict (version) do nothing'
      using '20260702090000', 'period_lock_money_tables';
  else
    execute 'insert into supabase_migrations.schema_migrations(version) values ($1) on conflict (version) do nothing'
      using '20260702090000';
  end if;
end $$;

-- ============================================================================
-- END 20260702090000_period_lock_money_tables
-- ============================================================================

-- ============================================================================
-- BEGIN 20260702100000_statutory_statements_period_scope
-- Source: supabase/migrations/20260702100000_statutory_statements_period_scope.sql
-- ============================================================================

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


-- Record manual application in Supabase migration history if this bundle is applied through SQL editor.
do $$
declare
  v_has_name boolean;
  v_has_statements boolean;
begin
  if to_regclass('supabase_migrations.schema_migrations') is null then
    raise notice 'supabase_migrations.schema_migrations not found; skipping migration-history record for 20260702100000';
    return;
  end if;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'supabase_migrations'
      and table_name = 'schema_migrations'
      and column_name = 'name'
  ) into v_has_name;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'supabase_migrations'
      and table_name = 'schema_migrations'
      and column_name = 'statements'
  ) into v_has_statements;

  if v_has_name and v_has_statements then
    execute 'insert into supabase_migrations.schema_migrations(version, name, statements) values ($1, $2, $3) on conflict (version) do nothing'
      using '20260702100000', 'statutory_statements_period_scope', array['manual SQL editor apply 20260702100000_statutory_statements_period_scope'];
  elsif v_has_name then
    execute 'insert into supabase_migrations.schema_migrations(version, name) values ($1, $2) on conflict (version) do nothing'
      using '20260702100000', 'statutory_statements_period_scope';
  else
    execute 'insert into supabase_migrations.schema_migrations(version) values ($1) on conflict (version) do nothing'
      using '20260702100000';
  end if;
end $$;

-- ============================================================================
-- END 20260702100000_statutory_statements_period_scope
-- ============================================================================

-- ============================================================================
-- BEGIN 20260702103000_bas_g10_capital_split
-- Source: supabase/migrations/20260702103000_bas_g10_capital_split.sql
-- ============================================================================

-- 20260702103000_bas_g10_capital_split.sql
--
-- Replace the original BAS GST worksheet function's documented G10 gap.
--
-- 0120 reported G10 as zero because v_bas_quarterly had no capital/non-capital
-- purchase split. Since 0116/0117 already introduced expected GST treatment at
-- supplier/account level, this function now resolves capital purchases from bill
-- line classification while preserving the existing BAS bill scope:
--   * allocation-aware bill amounts from v_bill_effective_allocations
--   * business, probable bills only
--   * AU BAS quarter from au_bas_quarter(b.invoice_date)
--   * RLS-scoped SECURITY INVOKER reads
--
-- Line-level classification uses chart_of_accounts.expected_gst_treatment first,
-- then suppliers.expected_gst_treatment. If a bill has no line totals, the
-- supplier-level treatment classifies the whole allocated bill as a fallback.

create or replace function public.generate_bas_worksheet_gst(
  p_org uuid,
  p_fy_start_year integer,
  p_quarter integer
)
returns table (
  g1_total_sales_cents            bigint,
  g10_capital_purchases_cents     bigint,
  g11_noncapital_purchases_cents  bigint,
  label_1a_gst_on_sales_cents     bigint,
  label_1b_gst_on_purchases_cents bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  with sales as (
    select
      coalesce(bq.sales_ex_gst_cents + bq.gst_collected_cents, 0)::bigint as g1_total_sales_cents,
      coalesce(bq.gst_collected_cents, 0)::bigint as label_1a_gst_on_sales_cents
    from public.v_bas_quarterly bq
    where bq.organization_id = p_org
      and bq.fy_start_year = p_fy_start_year
      and bq.quarter_num = p_quarter
  ),
  purchase_scope as (
    select
      bea.bill_id,
      bea.organization_id,
      b.organization_id as bill_owner_org_id,
      b.supplier_id,
      s.expected_gst_treatment as supplier_expected_gst_treatment,
      bea.effective_total_inc_gst_cents,
      bea.effective_gst_cents
    from public.v_bill_effective_allocations bea
    join public.bills b on b.id = bea.bill_id
    left join public.suppliers s
      on s.id = b.supplier_id
     and s.organization_id = b.organization_id
    cross join lateral public.au_bas_quarter(b.invoice_date) q
    where bea.organization_id = p_org
      and q.fy_start_year = p_fy_start_year
      and q.quarter_num = p_quarter
      and b.deleted_at is null
      and b.is_personal = false
      and b.is_probable_bill = true
      and b.invoice_date is not null
  ),
  line_rollup as (
    select
      ps.bill_id,
      ps.organization_id,
      coalesce(sum(bli.total_cents), 0)::numeric as line_total_cents,
      coalesce(sum(bli.gst_cents), 0)::numeric as line_gst_cents,
      coalesce(sum(bli.total_cents) filter (
        where coalesce(coa.expected_gst_treatment, ps.supplier_expected_gst_treatment) = 'GST_ON_CAPITAL'
      ), 0)::numeric as capital_line_total_cents,
      coalesce(sum(bli.gst_cents) filter (
        where coalesce(coa.expected_gst_treatment, ps.supplier_expected_gst_treatment) = 'GST_ON_CAPITAL'
      ), 0)::numeric as capital_line_gst_cents
    from purchase_scope ps
    left join public.bill_line_items bli
      on bli.bill_id = ps.bill_id
    left join public.chart_of_accounts coa
      on coa.organization_id = bli.organization_id
     and coa.code = bli.account_code
    group by ps.bill_id, ps.organization_id
  ),
  classified_purchases as (
    select
      ps.effective_total_inc_gst_cents,
      ps.effective_gst_cents,
      case
        when lr.line_total_cents > 0 then
          round(
            ps.effective_total_inc_gst_cents::numeric
            * lr.capital_line_total_cents
            / lr.line_total_cents
          )::bigint
        when ps.supplier_expected_gst_treatment = 'GST_ON_CAPITAL' then
          ps.effective_total_inc_gst_cents
        else
          0::bigint
      end as capital_purchases_cents
    from purchase_scope ps
    left join line_rollup lr
      on lr.bill_id = ps.bill_id
     and lr.organization_id = ps.organization_id
  ),
  purchases as (
    select
      coalesce(sum(c.capital_purchases_cents), 0)::bigint as g10_capital_purchases_cents,
      coalesce(sum(c.effective_total_inc_gst_cents - c.capital_purchases_cents), 0)::bigint
        as g11_noncapital_purchases_cents,
      coalesce(sum(c.effective_gst_cents), 0)::bigint as label_1b_gst_on_purchases_cents
    from classified_purchases c
  )
  select
    coalesce(s.g1_total_sales_cents, 0)::bigint,
    coalesce(p.g10_capital_purchases_cents, 0)::bigint,
    coalesce(p.g11_noncapital_purchases_cents, 0)::bigint,
    coalesce(s.label_1a_gst_on_sales_cents, 0)::bigint,
    coalesce(p.label_1b_gst_on_purchases_cents, 0)::bigint
  from (select 1) base
  left join sales s on true
  left join purchases p on true;
$$;

comment on function public.generate_bas_worksheet_gst(uuid, integer, integer) is
  'BAS GST labels (G1, G10, G11, 1A, 1B) for an org + AU FY quarter. Sales/GST '
  'collected come from v_bas_quarterly. Purchases/GST paid keep the allocation-aware '
  'v_bill_effective_allocations scope, with G10 split from GST_ON_CAPITAL account '
  'or supplier treatment and all remaining purchases flowing to G11. SECURITY '
  'INVOKER -> RLS-scoped. Composed by generate_bas_worksheet (SC-3.C.03).';

revoke all on function public.generate_bas_worksheet_gst(uuid, integer, integer) from public, anon;
grant execute on function public.generate_bas_worksheet_gst(uuid, integer, integer) to authenticated;


-- Record manual application in Supabase migration history if this bundle is applied through SQL editor.
do $$
declare
  v_has_name boolean;
  v_has_statements boolean;
begin
  if to_regclass('supabase_migrations.schema_migrations') is null then
    raise notice 'supabase_migrations.schema_migrations not found; skipping migration-history record for 20260702103000';
    return;
  end if;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'supabase_migrations'
      and table_name = 'schema_migrations'
      and column_name = 'name'
  ) into v_has_name;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'supabase_migrations'
      and table_name = 'schema_migrations'
      and column_name = 'statements'
  ) into v_has_statements;

  if v_has_name and v_has_statements then
    execute 'insert into supabase_migrations.schema_migrations(version, name, statements) values ($1, $2, $3) on conflict (version) do nothing'
      using '20260702103000', 'bas_g10_capital_split', array['manual SQL editor apply 20260702103000_bas_g10_capital_split'];
  elsif v_has_name then
    execute 'insert into supabase_migrations.schema_migrations(version, name) values ($1, $2) on conflict (version) do nothing'
      using '20260702103000', 'bas_g10_capital_split';
  else
    execute 'insert into supabase_migrations.schema_migrations(version) values ($1) on conflict (version) do nothing'
      using '20260702103000';
  end if;
end $$;

-- ============================================================================
-- END 20260702103000_bas_g10_capital_split
-- ============================================================================

-- ============================================================================
-- BEGIN 20260702104500_bas_worksheet_deterministic_period
-- Source: supabase/migrations/20260702104500_bas_worksheet_deterministic_period.sql
-- ============================================================================

-- 20260702104500_bas_worksheet_deterministic_period.sql
--
-- Replace generate_bas_worksheet's period metadata lookup.
--
-- 0122 pulled quarter_start / quarter_end / due_date from v_bas_quarterly. That
-- view carries period metadata only from invoice-side rows, so a nil BAS or a
-- bills-only quarter can produce a complete money-label payload with null period
-- dates. The worksheet is the lodgement-prep artifact, so period metadata must be
-- deterministic from the requested AU FY + BAS quarter, not dependent on activity.

create or replace function public.generate_bas_worksheet(
  p_org uuid,
  p_fy_start_year integer,
  p_quarter integer
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with requested_anchor as (
    select case p_quarter
      when 1 then make_date(p_fy_start_year, 7, 1)
      when 2 then make_date(p_fy_start_year, 10, 1)
      when 3 then make_date(p_fy_start_year + 1, 1, 1)
      when 4 then make_date(p_fy_start_year + 1, 4, 1)
      else null::date
    end as anchor_date
  ),
  requested_period as (
    select
      q.quarter_start,
      q.quarter_end,
      q.due_date
    from requested_anchor a
    left join lateral public.au_bas_quarter(a.anchor_date) q on a.anchor_date is not null
  ),
  paygi as (
    select coalesce(bool_or(bp.is_paygi_registered), false) as is_registered
    from public.business_profile bp
    where bp.organization_id = p_org
  ),
  gst_control_accounts as (
    select
      (
        select sa.account_id
          from public.system_accounts sa
         where sa.organization_id = p_org
           and sa.role = 'gst_collected'
           and sa.deleted_at is null
         limit 1
      ) as gst_collected_account_id,
      (
        select sa.account_id
          from public.system_accounts sa
         where sa.organization_id = p_org
           and sa.role = 'gst_paid'
           and sa.deleted_at is null
         limit 1
      ) as gst_paid_account_id
  ),
  gl_control_totals as (
    select
      coalesce(sum(
        case when jl.account_id = gca.gst_collected_account_id
          then jl.credit_cents - jl.debit_cents
          else 0
        end
      ), 0)::bigint as posted_1a_gst_collected_cents,
      coalesce(sum(
        case when jl.account_id = gca.gst_paid_account_id
          then jl.debit_cents - jl.credit_cents
          else 0
        end
      ), 0)::bigint as posted_1b_gst_paid_cents
    from requested_period period
    cross join gst_control_accounts gca
    left join public.journal_entries je
      on je.organization_id = p_org
     and je.status = 'posted'
     and je.entry_date >= period.quarter_start
     and je.entry_date <= period.quarter_end
    left join public.journal_lines jl
      on jl.journal_entry_id = je.id
     and jl.account_id in (
       gca.gst_collected_account_id,
       gca.gst_paid_account_id
     )
  )
  select jsonb_build_object(
    'organization_id', p_org,
    'fy_start_year',   p_fy_start_year,
    'quarter',         p_quarter,
    'quarter_start',   period.quarter_start,
    'quarter_end',     period.quarter_end,
    'due_date',        period.due_date,
    'gst', jsonb_build_object(
      'G1',  gst.g1_total_sales_cents,
      'G10', gst.g10_capital_purchases_cents,
      'G11', gst.g11_noncapital_purchases_cents,
      '1A',  gst.label_1a_gst_on_sales_cents,
      '1B',  gst.label_1b_gst_on_purchases_cents
    ),
    'gl_reconciliation', jsonb_build_object(
      'basis', 'posted_journal_lines_by_gst_system_accounts',
      'gst_collected_account_id', controls.gst_collected_account_id,
      'gst_paid_account_id', controls.gst_paid_account_id,
      'posted_1a_gst_collected_cents', gl.posted_1a_gst_collected_cents,
      'posted_1b_gst_paid_cents', gl.posted_1b_gst_paid_cents,
      'label_1a_delta_cents',
        gst.label_1a_gst_on_sales_cents - gl.posted_1a_gst_collected_cents,
      'label_1b_delta_cents',
        gst.label_1b_gst_on_purchases_cents - gl.posted_1b_gst_paid_cents,
      'reconciles',
        gst.label_1a_gst_on_sales_cents = gl.posted_1a_gst_collected_cents
        and gst.label_1b_gst_on_purchases_cents = gl.posted_1b_gst_paid_cents
    ),
    'payg_withholding', jsonb_build_object(
      'W1', payg.w1_total_salary_wages_cents,
      'W2', payg.w2_payg_withheld_cents,
      'W4', payg.w4_no_abn_withheld_cents,
      'W5', payg.w5_total_withheld_cents,
      '4',  payg.label_4_payg_withheld_cents
    ),
    'payg_instalment',
      case when paygi.is_registered
           then jsonb_build_object('T7', 0, '5A', 0, '5B', 0)
           else null end,
    'summary', jsonb_build_object(
      '9_net_amount_cents',
        gst.label_1a_gst_on_sales_cents
        - gst.label_1b_gst_on_purchases_cents
        + payg.label_4_payg_withheld_cents
    )
  )
  from requested_period period
  cross join public.generate_bas_worksheet_gst(p_org, p_fy_start_year, p_quarter) gst
  cross join public.generate_bas_worksheet_payg(p_org, p_fy_start_year, p_quarter) payg
  cross join paygi
  cross join gst_control_accounts controls
  cross join gl_control_totals gl;
$$;

comment on function public.generate_bas_worksheet(uuid, integer, integer) is
  'Full BAS worksheet as JSONB for an org + AU FY quarter. Period dates are '
  'deterministic from the requested FY/quarter via au_bas_quarter, so nil and '
  'bills-only quarters still carry quarter_start, quarter_end, and due_date. '
  'Composes GST labels, posted-GL GST control reconciliation, PAYG-W labels, '
  'optional placeholder PAYG-I labels, and summary label 9 (= 1A-1B+4). '
  'Lodgement input for Phase 7. SECURITY INVOKER -> RLS-scoped.';

revoke all on function public.generate_bas_worksheet(uuid, integer, integer) from public, anon;
grant execute on function public.generate_bas_worksheet(uuid, integer, integer) to authenticated;


-- Record manual application in Supabase migration history if this bundle is applied through SQL editor.
do $$
declare
  v_has_name boolean;
  v_has_statements boolean;
begin
  if to_regclass('supabase_migrations.schema_migrations') is null then
    raise notice 'supabase_migrations.schema_migrations not found; skipping migration-history record for 20260702104500';
    return;
  end if;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'supabase_migrations'
      and table_name = 'schema_migrations'
      and column_name = 'name'
  ) into v_has_name;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'supabase_migrations'
      and table_name = 'schema_migrations'
      and column_name = 'statements'
  ) into v_has_statements;

  if v_has_name and v_has_statements then
    execute 'insert into supabase_migrations.schema_migrations(version, name, statements) values ($1, $2, $3) on conflict (version) do nothing'
      using '20260702104500', 'bas_worksheet_deterministic_period', array['manual SQL editor apply 20260702104500_bas_worksheet_deterministic_period'];
  elsif v_has_name then
    execute 'insert into supabase_migrations.schema_migrations(version, name) values ($1, $2) on conflict (version) do nothing'
      using '20260702104500', 'bas_worksheet_deterministic_period';
  else
    execute 'insert into supabase_migrations.schema_migrations(version) values ($1) on conflict (version) do nothing'
      using '20260702104500';
  end if;
end $$;

-- ============================================================================
-- END 20260702104500_bas_worksheet_deterministic_period
-- ============================================================================

-- ============================================================================
-- BEGIN 20260702110000_bas_lodgement_draft_rpc
-- Source: supabase/migrations/20260702110000_bas_lodgement_draft_rpc.sql
-- ============================================================================

-- 20260702110000_bas_lodgement_draft_rpc.sql
--
-- BAS lodgement draft prep.
--
-- The BAS page previously opened a Tier-2 approval against the organization id.
-- That left no durable lodgement record for the approval to point at, and the
-- Lodgements page stayed empty until a future transport flow existed. This RPC
-- creates/reuses an append-only lodgements draft row for the exact worksheet
-- payload, then opens the Tier-2 approval against that lodgement row.
--
-- Nothing is submitted to the ATO here. Real transport remains gated by the
-- Phase-7 DSP/EVTE/SBR readiness checks.

create or replace function public.prepare_bas_lodgement_draft(
  p_org uuid,
  p_fy_start_year integer,
  p_quarter integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
  v_payload_hash text;
  v_period_label text;
  v_lodgement_id uuid;
  v_approval_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if p_org not in (select public.get_accessible_org_ids()) then
    raise exception 'organization not accessible';
  end if;

  if not public.require_role(p_org, 'accountant'::public.org_role) then
    raise exception 'prepare_bas_lodgement_draft: accountant role required for organization %', p_org;
  end if;

  if p_quarter not between 1 and 4 then
    raise exception 'p_quarter must be between 1 and 4';
  end if;

  v_payload := public.generate_bas_worksheet(p_org, p_fy_start_year, p_quarter);
  if v_payload is null then
    raise exception 'generate_bas_worksheet returned no payload';
  end if;

  v_period_label := format(
    'Q%s FY%s-%s',
    p_quarter,
    p_fy_start_year,
    right((p_fy_start_year + 1)::text, 2)
  );
  v_payload_hash := encode(extensions.digest(v_payload::text, 'sha256'), 'hex');

  begin
    insert into public.lodgements (
      organization_id,
      lodgement_type,
      period_label,
      payload_hash,
      payload,
      status,
      created_by
    ) values (
      p_org,
      'bas'::public.lodgement_type,
      v_period_label,
      v_payload_hash,
      v_payload,
      'draft'::public.lodgement_status,
      auth.uid()
    )
    returning id into v_lodgement_id;
  exception when unique_violation then
    select l.id
      into v_lodgement_id
      from public.lodgements l
     where l.organization_id = p_org
       and l.lodgement_type = 'bas'::public.lodgement_type
       and l.period_label = v_period_label
       and l.payload_hash = v_payload_hash
     order by l.created_at desc
     limit 1;
  end;

  if v_lodgement_id is null then
    raise exception 'could not create or find BAS lodgement draft';
  end if;

  v_approval_id := public.request_approval(
    p_org,
    'bas_lodgement',
    v_lodgement_id,
    'tier2_approve'::public.approval_risk_tier,
    v_payload
  );

  return jsonb_build_object(
    'lodgement_id', v_lodgement_id,
    'approval_id', v_approval_id,
    'lodgement_type', 'bas',
    'period_label', v_period_label,
    'payload_hash', v_payload_hash,
    'status', 'draft'
  );
end;
$$;

comment on function public.prepare_bas_lodgement_draft(uuid, integer, integer) is
  'Creates/reuses a draft BAS lodgement row for generate_bas_worksheet and opens '
  'a Tier-2 approval against that lodgement id and exact payload. Requires '
  'accountant-or-higher org role. Does not transmit to the ATO; Phase-7 transport '
  'remains DSP/EVTE/SBR-gated.';

revoke all on function public.prepare_bas_lodgement_draft(uuid, integer, integer) from public, anon;
grant execute on function public.prepare_bas_lodgement_draft(uuid, integer, integer) to authenticated;

notify pgrst, 'reload schema';


-- Record manual application in Supabase migration history if this bundle is applied through SQL editor.
do $$
declare
  v_has_name boolean;
  v_has_statements boolean;
begin
  if to_regclass('supabase_migrations.schema_migrations') is null then
    raise notice 'supabase_migrations.schema_migrations not found; skipping migration-history record for 20260702110000';
    return;
  end if;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'supabase_migrations'
      and table_name = 'schema_migrations'
      and column_name = 'name'
  ) into v_has_name;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'supabase_migrations'
      and table_name = 'schema_migrations'
      and column_name = 'statements'
  ) into v_has_statements;

  if v_has_name and v_has_statements then
    execute 'insert into supabase_migrations.schema_migrations(version, name, statements) values ($1, $2, $3) on conflict (version) do nothing'
      using '20260702110000', 'bas_lodgement_draft_rpc', array['manual SQL editor apply 20260702110000_bas_lodgement_draft_rpc'];
  elsif v_has_name then
    execute 'insert into supabase_migrations.schema_migrations(version, name) values ($1, $2) on conflict (version) do nothing'
      using '20260702110000', 'bas_lodgement_draft_rpc';
  else
    execute 'insert into supabase_migrations.schema_migrations(version) values ($1) on conflict (version) do nothing'
      using '20260702110000';
  end if;
end $$;

-- ============================================================================
-- END 20260702110000_bas_lodgement_draft_rpc
-- ============================================================================

-- ============================================================================
-- BEGIN 20260702123000_orchestrator_engine_dispatch
-- Source: supabase/migrations/20260702123000_orchestrator_engine_dispatch.sql
-- ============================================================================

-- 20260702123000_orchestrator_engine_dispatch.sql
--
-- Durable engine-dispatch artifacts for accountant-orchestrator.
--
-- The orchestrator can run from cron/service context, so draft creation cannot
-- depend on auth.uid() being a browser user. This migration adds:
--   * compliance_drafts: durable draft/evidence rows written by service dispatch.
--   * request_system_approval: service_role-only approval opener with requested_by
--     NULL, still hash-bound and pending for Tier-2 actions.
--   * prepare_bas_lodgement_draft_system: service_role-only BAS draft handoff that
--     creates/reuses a lodgement draft and opens a pending BAS approval. It does
--     not lodge or transmit anything.

create table if not exists public.compliance_drafts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  engine text not null,
  action text not null,
  draft_type text not null,
  period_label text,
  source text not null default 'accountant_orchestrator',
  source_key text not null,
  resource_type text,
  resource_id uuid,
  status text not null default 'draft'
    check (status in ('draft', 'needs_review', 'blocked', 'superseded')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  deleted_at timestamptz
);

comment on table public.compliance_drafts is
  'Durable draft/evidence artifacts created by accountant-orchestrator engine dispatch. '
  'Rows are drafts only; lodgement, payment, send and registered-agent sign-off remain '
  'behind approvals and external legal gates.';

create unique index if not exists compliance_drafts_org_source_key_uniq
  on public.compliance_drafts (organization_id, source_key);

create index if not exists compliance_drafts_org_status_idx
  on public.compliance_drafts (organization_id, status, created_at desc)
  where deleted_at is null;

drop trigger if exists compliance_drafts_set_updated_at on public.compliance_drafts;
create trigger compliance_drafts_set_updated_at
  before update on public.compliance_drafts
  for each row execute function public.set_updated_at();

alter table public.compliance_drafts enable row level security;

drop policy if exists compliance_drafts_select on public.compliance_drafts;
create policy compliance_drafts_select on public.compliance_drafts
  for select to authenticated
  using (organization_id in (select public.get_accessible_org_ids()));

revoke all on public.compliance_drafts from public, anon, authenticated;
grant select on public.compliance_drafts to authenticated;
grant select, insert, update, delete on public.compliance_drafts to service_role;

create or replace function public.request_system_approval(
  p_org uuid,
  p_resource_type text,
  p_resource_id uuid,
  p_risk_tier public.approval_risk_tier,
  p_payload jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash text;
  v_status public.approval_status;
  v_id uuid;
begin
  if not exists (
    select 1
      from public.organizations o
     where o.id = p_org
       and o.deleted_at is null
  ) then
    raise exception 'organization not found or deleted';
  end if;

  v_hash := encode(extensions.digest(p_payload::text, 'sha256'), 'hex');

  select a.id
    into v_id
    from public.approvals a
   where a.organization_id = p_org
     and a.resource_type = p_resource_type
     and a.resource_id = p_resource_id
     and a.payload_hash = v_hash
     and a.deleted_at is null;
  if v_id is not null then
    return v_id;
  end if;

  v_status := case when p_risk_tier = 'tier2_approve'
    then 'pending'::public.approval_status
    else 'approved'::public.approval_status
  end;

  begin
    insert into public.approvals (
      organization_id,
      risk_tier,
      status,
      resource_type,
      resource_id,
      payload_hash,
      requested_by,
      requested_at,
      created_by,
      resolved_at
    ) values (
      p_org,
      p_risk_tier,
      v_status,
      p_resource_type,
      p_resource_id,
      v_hash,
      null,
      now(),
      null,
      case when v_status = 'approved' then now() else null end
    )
    returning id into v_id;
  exception when unique_violation then
    select a.id
      into v_id
      from public.approvals a
     where a.organization_id = p_org
       and a.resource_type = p_resource_type
       and a.resource_id = p_resource_id
       and a.payload_hash = v_hash
       and a.deleted_at is null;
  end;

  return v_id;
end;
$$;

comment on function public.request_system_approval(
  uuid, text, uuid, public.approval_risk_tier, jsonb
) is
  'Service-role-only variant of request_approval for cron/orchestrator draft generation. '
  'It is still content-hash bound and leaves Tier-2 actions pending for a human approver; '
  'requested_by/created_by are NULL to show the request was system-opened.';

create or replace function public.prepare_bas_lodgement_draft_system(
  p_org uuid,
  p_fy_start_year integer,
  p_quarter integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
  v_payload_hash text;
  v_period_label text;
  v_lodgement_id uuid;
  v_approval_id uuid;
begin
  if not exists (
    select 1
      from public.organizations o
     where o.id = p_org
       and o.deleted_at is null
  ) then
    raise exception 'organization not found or deleted';
  end if;

  if p_quarter not between 1 and 4 then
    raise exception 'p_quarter must be between 1 and 4';
  end if;

  v_payload := public.generate_bas_worksheet(p_org, p_fy_start_year, p_quarter);
  if v_payload is null then
    raise exception 'generate_bas_worksheet returned no payload';
  end if;

  v_period_label := format(
    'Q%s FY%s-%s',
    p_quarter,
    p_fy_start_year,
    right((p_fy_start_year + 1)::text, 2)
  );
  v_payload_hash := encode(extensions.digest(v_payload::text, 'sha256'), 'hex');

  begin
    insert into public.lodgements (
      organization_id,
      lodgement_type,
      period_label,
      payload_hash,
      payload,
      status,
      created_by
    ) values (
      p_org,
      'bas'::public.lodgement_type,
      v_period_label,
      v_payload_hash,
      v_payload,
      'draft'::public.lodgement_status,
      null
    )
    returning id into v_lodgement_id;
  exception when unique_violation then
    select l.id
      into v_lodgement_id
      from public.lodgements l
     where l.organization_id = p_org
       and l.lodgement_type = 'bas'::public.lodgement_type
       and l.period_label = v_period_label
       and l.payload_hash = v_payload_hash
     order by l.created_at desc
     limit 1;
  end;

  if v_lodgement_id is null then
    raise exception 'could not create or find BAS lodgement draft';
  end if;

  v_approval_id := public.request_system_approval(
    p_org,
    'bas_lodgement',
    v_lodgement_id,
    'tier2_approve'::public.approval_risk_tier,
    v_payload
  );

  return jsonb_build_object(
    'lodgement_id', v_lodgement_id,
    'approval_id', v_approval_id,
    'lodgement_type', 'bas',
    'period_label', v_period_label,
    'payload_hash', v_payload_hash,
    'status', 'draft'
  );
end;
$$;

comment on function public.prepare_bas_lodgement_draft_system(uuid, integer, integer) is
  'Service-role-only BAS draft handoff for accountant-orchestrator. Creates/reuses a '
  'draft lodgement from generate_bas_worksheet and opens a pending system approval. '
  'Does not lodge or transmit to the ATO.';

grant execute on function public.generate_super_batch(uuid, integer, integer) to service_role;
grant execute on function public.build_return(uuid, integer) to service_role;
grant execute on function public.book_to_tax(uuid, integer) to service_role;
grant execute on function public.generate_eofy_pack(uuid, integer) to service_role;
grant execute on function public.generate_workcover_declaration(uuid, integer) to service_role;
grant execute on function public.smsf_tbc_tbar(uuid, integer, uuid) to service_role;
grant execute on function public.stream_trust_distribution(uuid, integer, uuid) to service_role;
grant execute on function public.div7a_breach_scan(uuid, date) to service_role;
grant execute on function public.cgt_calc(uuid, integer) to service_role;
grant execute on function public.asic_form484_draft(uuid, timestamptz) to service_role;

revoke all on function public.request_system_approval(
  uuid, text, uuid, public.approval_risk_tier, jsonb
) from public, anon, authenticated;
revoke all on function public.prepare_bas_lodgement_draft_system(
  uuid, integer, integer
) from public, anon, authenticated;
grant execute on function public.request_system_approval(
  uuid, text, uuid, public.approval_risk_tier, jsonb
) to service_role;
grant execute on function public.prepare_bas_lodgement_draft_system(
  uuid, integer, integer
) to service_role;

notify pgrst, 'reload schema';


-- Record manual application in Supabase migration history if this bundle is applied through SQL editor.
do $$
declare
  v_has_name boolean;
  v_has_statements boolean;
begin
  if to_regclass('supabase_migrations.schema_migrations') is null then
    raise notice 'supabase_migrations.schema_migrations not found; skipping migration-history record for 20260702123000';
    return;
  end if;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'supabase_migrations'
      and table_name = 'schema_migrations'
      and column_name = 'name'
  ) into v_has_name;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'supabase_migrations'
      and table_name = 'schema_migrations'
      and column_name = 'statements'
  ) into v_has_statements;

  if v_has_name and v_has_statements then
    execute 'insert into supabase_migrations.schema_migrations(version, name, statements) values ($1, $2, $3) on conflict (version) do nothing'
      using '20260702123000', 'orchestrator_engine_dispatch', array['manual SQL editor apply 20260702123000_orchestrator_engine_dispatch'];
  elsif v_has_name then
    execute 'insert into supabase_migrations.schema_migrations(version, name) values ($1, $2) on conflict (version) do nothing'
      using '20260702123000', 'orchestrator_engine_dispatch';
  else
    execute 'insert into supabase_migrations.schema_migrations(version) values ($1) on conflict (version) do nothing'
      using '20260702123000';
  end if;
end $$;

-- ============================================================================
-- END 20260702123000_orchestrator_engine_dispatch
-- ============================================================================

-- ============================================================================
-- BEGIN 20260702124500_gmail_mine_refresh_jobs
-- Source: supabase/migrations/20260702124500_gmail_mine_refresh_jobs.sql
-- ============================================================================

-- 20260702124500_gmail_mine_refresh_jobs.sql
--
-- Move A6 gmail-mine refresh behind the durable automation queue.
--
-- 20260701161000 scheduled a direct HTTP call to gmail-mine. That kept staged
-- entity triage fresh, but it bypassed B1 automation-worker, so failures had no
-- queue retry/dead-letter trail. This forward migration replaces the cron body
-- with a DB-side enqueue function. automation-worker now owns job_kind
-- `gmail_mine` and dispatches each job to the gmail-mine edge function.

create or replace function public.enqueue_gmail_mine_refresh_jobs(
  p_days integer default 14,
  p_max integer default 100
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
begin
  insert into public.automation_jobs (
    organization_id,
    job_kind,
    source_kind,
    source_id,
    priority,
    run_after,
    max_attempts,
    payload,
    enqueued_by
  )
  select
    gi.organization_id,
    'gmail_mine',
    null,
    null,
    40,
    now(),
    3,
    jsonb_build_object(
      'integration_id', gi.id,
      'days', greatest(1, least(coalesce(p_days, 14), 365)),
      'max', greatest(1, least(coalesce(p_max, 100), 200)),
      'folder', 'inbox'
    ),
    null
  from public.gmail_integrations gi
  where gi.is_active = true;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.enqueue_gmail_mine_refresh_jobs(integer, integer) is
  'Enqueues one gmail_mine automation job per active Gmail integration for the '
  'recent-window A6 refresh. Cron-safe SECURITY DEFINER; jobs are claimed by '
  'automation-worker and retain retry/dead-letter evidence.';

revoke all on function public.enqueue_gmail_mine_refresh_jobs(integer, integer)
  from public, anon, authenticated;
grant execute on function public.enqueue_gmail_mine_refresh_jobs(integer, integer)
  to service_role;

do $$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null
     or to_regprocedure('cron.unschedule(text)') is null
     or to_regprocedure('public.enqueue_gmail_mine_refresh_jobs(integer, integer)') is null then
    raise notice 'pg_cron or enqueue_gmail_mine_refresh_jobs missing; skipping gmail-mine queue cron';
    return;
  end if;

  if exists (select 1 from cron.job where jobname = 'gmail-mine-refresh') then
    perform cron.unschedule('gmail-mine-refresh');
  end if;

  perform cron.schedule(
    'gmail-mine-refresh',
    '30 4 * * *',
    $cron$
      select public.enqueue_gmail_mine_refresh_jobs(14, 100);
    $cron$
  );
  raise notice 'Scheduled gmail-mine-refresh to enqueue gmail_mine automation jobs';
end $$;

notify pgrst, 'reload schema';


-- Record manual application in Supabase migration history if this bundle is applied through SQL editor.
do $$
declare
  v_has_name boolean;
  v_has_statements boolean;
begin
  if to_regclass('supabase_migrations.schema_migrations') is null then
    raise notice 'supabase_migrations.schema_migrations not found; skipping migration-history record for 20260702124500';
    return;
  end if;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'supabase_migrations'
      and table_name = 'schema_migrations'
      and column_name = 'name'
  ) into v_has_name;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'supabase_migrations'
      and table_name = 'schema_migrations'
      and column_name = 'statements'
  ) into v_has_statements;

  if v_has_name and v_has_statements then
    execute 'insert into supabase_migrations.schema_migrations(version, name, statements) values ($1, $2, $3) on conflict (version) do nothing'
      using '20260702124500', 'gmail_mine_refresh_jobs', array['manual SQL editor apply 20260702124500_gmail_mine_refresh_jobs'];
  elsif v_has_name then
    execute 'insert into supabase_migrations.schema_migrations(version, name) values ($1, $2) on conflict (version) do nothing'
      using '20260702124500', 'gmail_mine_refresh_jobs';
  else
    execute 'insert into supabase_migrations.schema_migrations(version) values ($1) on conflict (version) do nothing'
      using '20260702124500';
  end if;
end $$;

-- ============================================================================
-- END 20260702124500_gmail_mine_refresh_jobs
-- ============================================================================


-- ============================================================================
-- BEGIN 20260702130000_invoice_zero_gst_treatment
-- Source: supabase/migrations/20260702130000_invoice_zero_gst_treatment.sql
-- ============================================================================

-- 20260702130000_invoice_zero_gst_treatment.sql
-- Preserve zero-rated invoice line GST treatment instead of collapsing it to
-- GST-free. This keeps invoice lines aligned with the UI option and allows
-- downstream reporting/adapters to distinguish the treatment.

alter type public.invoice_gst_treatment add value if not exists 'zero';

notify pgrst, 'reload schema';


-- Record manual application in Supabase migration history if this bundle is applied through SQL editor.
do $$
declare
  v_has_name boolean;
  v_has_statements boolean;
begin
  if to_regclass('supabase_migrations.schema_migrations') is null then
    raise notice 'supabase_migrations.schema_migrations not found; skipping migration-history record for 20260702130000';
    return;
  end if;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'supabase_migrations'
      and table_name = 'schema_migrations'
      and column_name = 'name'
  ) into v_has_name;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'supabase_migrations'
      and table_name = 'schema_migrations'
      and column_name = 'statements'
  ) into v_has_statements;

  if v_has_name and v_has_statements then
    execute 'insert into supabase_migrations.schema_migrations(version, name, statements) values ($1, $2, $3) on conflict (version) do nothing'
      using '20260702130000', 'invoice_zero_gst_treatment', array['manual SQL editor apply 20260702130000_invoice_zero_gst_treatment'];
  elsif v_has_name then
    execute 'insert into supabase_migrations.schema_migrations(version, name) values ($1, $2) on conflict (version) do nothing'
      using '20260702130000', 'invoice_zero_gst_treatment';
  else
    execute 'insert into supabase_migrations.schema_migrations(version) values ($1) on conflict (version) do nothing'
      using '20260702130000';
  end if;
end $$;

-- ============================================================================
-- END 20260702130000_invoice_zero_gst_treatment
-- ============================================================================
