-- ============================================================================
-- 0219_payment_run_payroll_gl_posting.sql  (P2-01c)
--
-- Source posting for AP payment runs and payroll pay runs.
--
-- Both functions are explicit RPC surfaces over create_and_post_journal(). They
-- are intentionally not triggers: finalisation/mark-paid workflows still run
-- through edge functions and approval gates, and those callers must opt in to GL
-- posting through a human JWT or org-scoped backend token.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. AP payment-run settlement posting.
--
-- Payment runs pay bills that should already have posted Dr expense/GST and
-- Cr AP. This function posts the cash settlement:
--
-- Dr Accounts payable (2000)
-- Cr Business bank account (1000)
--
-- Idempotency key: settlement:v1
-- Source event:    payment_run:<payment_run_id>:settlement:v1
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_payment_run_journal(p_payment_run_id uuid)
RETURNS public.journal_entries
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_run                  public.payment_runs%ROWTYPE;
  v_entry                public.journal_entries;
  v_item_count           integer;
  v_item_total_cents     bigint;
  v_bad_bills            text;
  v_reconciled_bills     text;
  v_direct_bank_bills    text;
  v_unposted_ap_bills    text;
  v_mismatched_ap_bills  text;
  v_ap_account_id        uuid;
  v_bank_account_id      uuid;
BEGIN
  IF p_payment_run_id IS NULL THEN
    RAISE EXCEPTION 'payment_run_id is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  SELECT *
    INTO v_run
    FROM public.payment_runs
   WHERE id = p_payment_run_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'payment run % not found or not accessible', p_payment_run_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_run.status <> 'paid'::public.payment_run_status THEN
    RAISE EXCEPTION 'payment run % must be paid before GL settlement posting', p_payment_run_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_run.total_cents <= 0 THEN
    RAISE EXCEPTION 'payment run % total must be positive', p_payment_run_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT COUNT(*)::integer, COALESCE(SUM(pri.amount_cents), 0)::bigint
    INTO v_item_count, v_item_total_cents
    FROM public.payment_run_items pri
   WHERE pri.payment_run_id = p_payment_run_id;

  IF v_item_count = 0 THEN
    RAISE EXCEPTION 'payment run % has no items to post', p_payment_run_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_item_count <> v_run.bill_count OR v_item_total_cents <> v_run.total_cents THEN
    RAISE EXCEPTION
      'payment run % item totals do not match header totals',
      p_payment_run_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT string_agg(pri.bill_id::text, ', ' ORDER BY pri.bill_id::text)
    INTO v_bad_bills
    FROM public.payment_run_items pri
    LEFT JOIN public.bills b
      ON b.id = pri.bill_id
   WHERE pri.payment_run_id = p_payment_run_id
     AND (
       b.id IS NULL
       OR pri.organization_id <> v_run.organization_id
       OR b.organization_id <> v_run.organization_id
       OR b.payment_run_id IS DISTINCT FROM v_run.id
       OR b.deleted_at IS NOT NULL
       OR b.status <> 'paid'::public.bill_status
       OR b.is_personal IS TRUE
       OR pri.amount_cents <= 0
     );

  IF v_bad_bills IS NOT NULL THEN
    RAISE EXCEPTION 'payment run % has invalid bill item(s): %',
      p_payment_run_id,
      v_bad_bills
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT string_agg(DISTINCT pri.bill_id::text, ', ' ORDER BY pri.bill_id::text)
    INTO v_reconciled_bills
    FROM public.payment_run_items pri
    JOIN public.bank_transactions bt
      ON bt.matched_bill_id = pri.bill_id
     AND bt.organization_id = v_run.organization_id
    JOIN public.journal_entries je
      ON je.organization_id = v_run.organization_id
     AND je.source_type = 'bank_reconciliation'
     AND je.source_id = bt.id
     AND je.status = 'posted'
   WHERE pri.payment_run_id = p_payment_run_id;

  IF v_reconciled_bills IS NOT NULL THEN
    RAISE EXCEPTION
      'payment run % bill(s) already have bank-reconciliation settlement journal(s): %',
      p_payment_run_id,
      v_reconciled_bills
      USING ERRCODE = 'check_violation';
  END IF;

  WITH bill_postings AS (
    SELECT
      pri.bill_id,
      pri.amount_cents,
      COALESCE(SUM(jl.credit_cents) FILTER (WHERE coa.code = '2000'), 0)::bigint AS ap_credit_cents,
      COALESCE(SUM(jl.credit_cents) FILTER (WHERE coa.code = '1000'), 0)::bigint AS bank_credit_cents
    FROM public.payment_run_items pri
    LEFT JOIN public.journal_entries je
      ON je.organization_id = v_run.organization_id
     AND je.source_type = 'bill'
     AND je.source_id = pri.bill_id
     AND je.status = 'posted'
    LEFT JOIN public.journal_lines jl
      ON jl.journal_entry_id = je.id
    LEFT JOIN public.chart_of_accounts coa
      ON coa.id = jl.account_id
     AND coa.code IN ('2000', '1000')
    WHERE pri.payment_run_id = p_payment_run_id
    GROUP BY pri.bill_id, pri.amount_cents
  )
  SELECT
    string_agg(bill_id::text, ', ' ORDER BY bill_id::text) FILTER (
      WHERE bank_credit_cents > 0
    ),
    string_agg(bill_id::text, ', ' ORDER BY bill_id::text) FILTER (
      WHERE ap_credit_cents <= 0
    ),
    string_agg(bill_id::text, ', ' ORDER BY bill_id::text) FILTER (
      WHERE ap_credit_cents <> amount_cents
    )
    INTO v_direct_bank_bills, v_unposted_ap_bills, v_mismatched_ap_bills
  FROM bill_postings;

  IF v_direct_bank_bills IS NOT NULL THEN
    RAISE EXCEPTION
      'payment run % includes bill(s) already posted directly to bank: %',
      p_payment_run_id,
      v_direct_bank_bills
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_unposted_ap_bills IS NOT NULL THEN
    RAISE EXCEPTION
      'payment run % includes bill(s) with no posted AP journal to settle: %',
      p_payment_run_id,
      v_unposted_ap_bills
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_mismatched_ap_bills IS NOT NULL THEN
    RAISE EXCEPTION
      'payment run % includes bill(s) whose posted AP liability does not match item amount: %',
      p_payment_run_id,
      v_mismatched_ap_bills
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT coa.id
    INTO v_ap_account_id
    FROM public.chart_of_accounts coa
   WHERE coa.organization_id = v_run.organization_id
     AND coa.code = '2000'
     AND coa.account_type = 'liability'::public.account_type
     AND coa.is_active = true
   LIMIT 1;

  IF v_ap_account_id IS NULL THEN
    RAISE EXCEPTION 'payment run % cannot post: active liability account 2000 is missing',
      p_payment_run_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT coa.id
    INTO v_bank_account_id
    FROM public.chart_of_accounts coa
   WHERE coa.organization_id = v_run.organization_id
     AND coa.code = '1000'
     AND coa.account_type = 'asset'::public.account_type
     AND coa.is_active = true
   LIMIT 1;

  IF v_bank_account_id IS NULL THEN
    RAISE EXCEPTION 'payment run % cannot post: active asset account 1000 is missing',
      p_payment_run_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT *
    INTO v_entry
    FROM public.create_and_post_journal(
      v_run.organization_id,
      v_run.pay_date,
      'payment_run',
      v_run.id,
      'settlement:v1',
      jsonb_build_array(
        jsonb_build_object(
          'account_id', v_ap_account_id,
          'debit_cents', v_run.total_cents,
          'credit_cents', 0,
          'description', 'Payment run AP settlement'
        ),
        jsonb_build_object(
          'account_id', v_bank_account_id,
          'debit_cents', 0,
          'credit_cents', v_run.total_cents,
          'description', 'Payment run bank settlement'
        )
      ),
      'Payment run settlement',
      jsonb_build_object(
        'source_table', 'payment_runs',
        'payment_run_id', v_run.id,
        'pay_date', v_run.pay_date,
        'bill_count', v_run.bill_count,
        'total_cents', v_run.total_cents
      )
    );

  RETURN v_entry;
END;
$$;

COMMENT ON FUNCTION public.post_payment_run_journal(uuid) IS
  'Posts a paid AP payment run through create_and_post_journal using idempotency '
  'key settlement:v1. Validates payment_run_items match the header, bills are '
  'paid/non-personal/in-run, bill journals credited AP 2000 for the item amounts, '
  'and no item bill has already been settled by a bank-reconciliation journal. '
  'Posts Dr AP 2000 / Cr bank 1000 for the run total.';

REVOKE ALL ON FUNCTION public.post_payment_run_journal(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_payment_run_journal(uuid)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Payroll pay-run posting.
--
-- Dr Wages & salaries (6000)         gross wages
-- Dr Superannuation expense (6010)   employer SG, when non-zero
-- Cr PAYG withholding payable (2200) PAYG-W, when non-zero
-- Cr Superannuation payable (2300)   employer SG liability, when non-zero
-- Cr Business bank account (1000)    net pay, when non-zero
--
-- Idempotency key: payroll:v1
-- Source event:    pay_run:<pay_run_id>:payroll:v1
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_payroll_pay_run_journal(p_pay_run_id uuid)
RETURNS public.journal_entries
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_run                   public.pay_runs%ROWTYPE;
  v_entry                 public.journal_entries;
  v_slip_count            integer;
  v_slip_gross_cents      bigint;
  v_slip_tax_cents        bigint;
  v_slip_super_cents      bigint;
  v_slip_net_cents        bigint;
  v_cross_org_slips       text;
  v_wages_account_id      uuid;
  v_super_expense_id      uuid;
  v_payg_payable_id       uuid;
  v_super_payable_id      uuid;
  v_bank_account_id       uuid;
  v_lines                 jsonb;
BEGIN
  IF p_pay_run_id IS NULL THEN
    RAISE EXCEPTION 'pay_run_id is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  SELECT *
    INTO v_run
    FROM public.pay_runs
   WHERE id = p_pay_run_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'pay run % not found or not accessible', p_pay_run_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_run.status <> 'paid'::public.pay_run_status THEN
    RAISE EXCEPTION 'pay run % must be paid before GL payroll posting', p_pay_run_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_run.total_gross_cents <= 0 THEN
    RAISE EXCEPTION 'pay run % gross wages must be positive', p_pay_run_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT string_agg(ps.id::text, ', ' ORDER BY ps.id::text)
    INTO v_cross_org_slips
    FROM public.pay_slips ps
   WHERE ps.pay_run_id = p_pay_run_id
     AND ps.organization_id <> v_run.organization_id;

  IF v_cross_org_slips IS NOT NULL THEN
    RAISE EXCEPTION 'pay run % has cross-org pay slip(s): %',
      p_pay_run_id,
      v_cross_org_slips
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT
    COUNT(*)::integer,
    COALESCE(SUM(ps.gross_total_cents), 0)::bigint,
    COALESCE(SUM(ps.payg_tax_cents), 0)::bigint,
    COALESCE(SUM(ps.super_guarantee_cents), 0)::bigint,
    COALESCE(SUM(ps.net_pay_cents), 0)::bigint
    INTO v_slip_count, v_slip_gross_cents, v_slip_tax_cents, v_slip_super_cents, v_slip_net_cents
  FROM public.pay_slips ps
  WHERE ps.pay_run_id = p_pay_run_id
    AND ps.organization_id = v_run.organization_id;

  IF v_slip_count = 0 THEN
    RAISE EXCEPTION 'pay run % has no pay slips to post', p_pay_run_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_slip_gross_cents <> v_run.total_gross_cents
     OR v_slip_tax_cents <> v_run.total_tax_cents
     OR v_slip_super_cents <> v_run.total_super_cents
     OR v_slip_net_cents <> v_run.total_net_cents THEN
    RAISE EXCEPTION 'pay run % pay slip totals do not match header totals', p_pay_run_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_run.total_tax_cents < 0
     OR v_run.total_super_cents < 0
     OR v_run.total_net_cents < 0 THEN
    RAISE EXCEPTION 'pay run % contains negative payroll totals', p_pay_run_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_run.total_gross_cents <> v_run.total_tax_cents + v_run.total_net_cents THEN
    RAISE EXCEPTION 'pay run % gross does not equal PAYG plus net pay', p_pay_run_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT coa.id
    INTO v_wages_account_id
    FROM public.chart_of_accounts coa
   WHERE coa.organization_id = v_run.organization_id
     AND coa.code = '6000'
     AND coa.account_type = 'expense'::public.account_type
     AND coa.is_active = true
   LIMIT 1;

  IF v_wages_account_id IS NULL THEN
    RAISE EXCEPTION 'pay run % cannot post: active expense account 6000 is missing',
      p_pay_run_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT coa.id
    INTO v_bank_account_id
    FROM public.chart_of_accounts coa
   WHERE coa.organization_id = v_run.organization_id
     AND coa.code = '1000'
     AND coa.account_type = 'asset'::public.account_type
     AND coa.is_active = true
   LIMIT 1;

  IF v_bank_account_id IS NULL THEN
    RAISE EXCEPTION 'pay run % cannot post: active asset account 1000 is missing',
      p_pay_run_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF v_run.total_super_cents > 0 THEN
    SELECT coa.id
      INTO v_super_expense_id
      FROM public.chart_of_accounts coa
     WHERE coa.organization_id = v_run.organization_id
       AND coa.code = '6010'
       AND coa.account_type = 'expense'::public.account_type
       AND coa.is_active = true
     LIMIT 1;

    IF v_super_expense_id IS NULL THEN
      RAISE EXCEPTION 'pay run % cannot post: active expense account 6010 is missing',
        p_pay_run_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    SELECT coa.id
      INTO v_super_payable_id
      FROM public.chart_of_accounts coa
     WHERE coa.organization_id = v_run.organization_id
       AND coa.code = '2300'
       AND coa.account_type = 'liability'::public.account_type
       AND coa.is_active = true
     LIMIT 1;

    IF v_super_payable_id IS NULL THEN
      RAISE EXCEPTION 'pay run % cannot post: active liability account 2300 is missing',
        p_pay_run_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  IF v_run.total_tax_cents > 0 THEN
    SELECT coa.id
      INTO v_payg_payable_id
      FROM public.chart_of_accounts coa
     WHERE coa.organization_id = v_run.organization_id
       AND coa.code = '2200'
       AND coa.account_type = 'liability'::public.account_type
       AND coa.is_active = true
     LIMIT 1;

    IF v_payg_payable_id IS NULL THEN
      RAISE EXCEPTION 'pay run % cannot post: active liability account 2200 is missing',
        p_pay_run_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  v_lines := jsonb_build_array(
    jsonb_build_object(
      'account_id', v_wages_account_id,
      'debit_cents', v_run.total_gross_cents,
      'credit_cents', 0,
      'description', 'Payroll gross wages'
    )
  );

  IF v_run.total_super_cents > 0 THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_super_expense_id,
        'debit_cents', v_run.total_super_cents,
        'credit_cents', 0,
        'description', 'Payroll superannuation expense'
      ),
      jsonb_build_object(
        'account_id', v_super_payable_id,
        'debit_cents', 0,
        'credit_cents', v_run.total_super_cents,
        'description', 'Payroll superannuation payable'
      )
    );
  END IF;

  IF v_run.total_tax_cents > 0 THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_payg_payable_id,
        'debit_cents', 0,
        'credit_cents', v_run.total_tax_cents,
        'description', 'Payroll PAYG withholding payable'
      )
    );
  END IF;

  IF v_run.total_net_cents > 0 THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_bank_account_id,
        'debit_cents', 0,
        'credit_cents', v_run.total_net_cents,
        'description', 'Payroll net pay'
      )
    );
  END IF;

  SELECT *
    INTO v_entry
    FROM public.create_and_post_journal(
      v_run.organization_id,
      v_run.pay_date,
      'pay_run',
      v_run.id,
      'payroll:v1',
      v_lines,
      'Payroll pay run',
      jsonb_build_object(
        'source_table', 'pay_runs',
        'pay_run_id', v_run.id,
        'period_start', v_run.period_start,
        'period_end', v_run.period_end,
        'pay_date', v_run.pay_date,
        'pay_slip_count', v_slip_count,
        'total_gross_cents', v_run.total_gross_cents,
        'total_tax_cents', v_run.total_tax_cents,
        'total_super_cents', v_run.total_super_cents,
        'total_net_cents', v_run.total_net_cents
      )
    );

  RETURN v_entry;
END;
$$;

COMMENT ON FUNCTION public.post_payroll_pay_run_journal(uuid) IS
  'Posts a paid payroll pay_run through create_and_post_journal using idempotency '
  'key payroll:v1. Validates pay_slip sums match the pay_run header and gross = '
  'PAYG withholding + net pay, then posts Dr wages 6000, Dr super expense 6010, '
  'Cr PAYG payable 2200, Cr super payable 2300, and Cr bank 1000.';

REVOKE ALL ON FUNCTION public.post_payroll_pay_run_journal(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_payroll_pay_run_journal(uuid)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
