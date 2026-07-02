-- ============================================================================
-- 0218_bank_reconciliation_gl_posting.sql  (P2-01b)
--
-- Source posting for bank transactions and reconciliation settlements.
--
-- The bank feed is not blindly auto-posted by trigger: matched AR/AP rows have
-- dedicated settlement postings, payroll/payment-run/GST flows have their own
-- source slices, and raw service-role cron writes still need org-scoped tokens
-- before they can use the canonical GL RPC. These functions are the explicit,
-- idempotent surfaces for human or org-scoped backend callers.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Standalone bank transaction posting.
--
-- Scope: business, unmatched, categorised bank OUTFLOWS that are not owned by a
-- more specific source ledger. The journal is deliberately gross-only because a
-- bank transaction row has no reliable GST split.
--
-- Dr mapped expense/asset account
-- Cr Business bank account (1000)
--
-- Idempotency key: bank-txn:v1
-- Source event:    bank_transaction:<bank_transaction_id>:bank-txn:v1
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_bank_transaction_journal(p_bank_transaction_id uuid)
RETURNS public.journal_entries
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_tx                    public.bank_transactions%ROWTYPE;
  v_entry                 public.journal_entries;
  v_category              public.intake_categories%ROWTYPE;
  v_bank_account_id       uuid;
  v_counter_account_id    uuid;
  v_counter_account_code  text;
  v_counter_account_type  public.account_type := 'expense'::public.account_type;
  v_amount_abs_cents      bigint;
BEGIN
  IF p_bank_transaction_id IS NULL THEN
    RAISE EXCEPTION 'bank_transaction_id is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  SELECT *
    INTO v_tx
    FROM public.bank_transactions
   WHERE id = p_bank_transaction_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank transaction % not found or not accessible', p_bank_transaction_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_tx.is_personal IS TRUE THEN
    RAISE EXCEPTION 'bank transaction % is personal and cannot post to business GL',
      p_bank_transaction_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_tx.matched_bill_id IS NOT NULL OR v_tx.matched_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION
      'bank transaction % is reconciled; use post_reconciled_bank_transaction_journal instead',
      p_bank_transaction_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_tx.amount_cents = 0 THEN
    RAISE EXCEPTION 'bank transaction % amount must be non-zero', p_bank_transaction_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_tx.amount_cents > 0 THEN
    RAISE EXCEPTION
      'unmatched bank inflow % must be reconciled to an invoice/payment source before GL posting',
      p_bank_transaction_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NULLIF(btrim(COALESCE(v_tx.auto_category_code, '')), '') IS NULL THEN
    RAISE EXCEPTION 'bank transaction % has no auto_category_code', p_bank_transaction_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT *
    INTO v_category
    FROM public.intake_categories
   WHERE code = v_tx.auto_category_code;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank transaction % references unknown intake category %',
      p_bank_transaction_id,
      v_tx.auto_category_code
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_category.is_business IS NOT TRUE THEN
    RAISE EXCEPTION 'bank transaction % category % is not business-postable',
      p_bank_transaction_id,
      v_tx.auto_category_code
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_tx.auto_category_code IN (
    'uncategorized',
    'personal_expense',
    'customer_payment',
    'refunds',
    'ato_bas_super',
    'employee_wages'
  ) THEN
    RAISE EXCEPTION
      'bank transaction % category % belongs to a dedicated source posting flow',
      p_bank_transaction_id,
      v_tx.auto_category_code
      USING ERRCODE = 'check_violation';
  END IF;

  v_counter_account_code := CASE v_tx.auto_category_code
    WHEN 'materials' THEN '5000'
    WHEN 'subcontractor' THEN '5100'
    WHEN 'plant_equipment' THEN '1500'
    WHEN 'motor_vehicle' THEN '6100'
    WHEN 'fuel' THEN '6100'
    WHEN 'insurance' THEN '6200'
    WHEN 'telephone_internet' THEN '6300'
    WHEN 'subscriptions_saas' THEN '6400'
    WHEN 'professional_fees' THEN '6500'
    WHEN 'bank_fees' THEN '6600'
    ELSE '6900'
  END;

  IF v_tx.auto_category_code = 'plant_equipment' THEN
    v_counter_account_type := 'asset'::public.account_type;
  END IF;

  SELECT coa.id
    INTO v_bank_account_id
    FROM public.chart_of_accounts coa
   WHERE coa.organization_id = v_tx.organization_id
     AND coa.code = '1000'
     AND coa.account_type = 'asset'::public.account_type
     AND coa.is_active = true
   LIMIT 1;

  IF v_bank_account_id IS NULL THEN
    RAISE EXCEPTION 'bank transaction % cannot post: active asset account 1000 is missing',
      p_bank_transaction_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT coa.id
    INTO v_counter_account_id
    FROM public.chart_of_accounts coa
   WHERE coa.organization_id = v_tx.organization_id
     AND coa.code = v_counter_account_code
     AND coa.account_type = v_counter_account_type
     AND coa.is_active = true
   LIMIT 1;

  IF v_counter_account_id IS NULL THEN
    RAISE EXCEPTION
      'bank transaction % cannot post: active % account % is missing',
      p_bank_transaction_id,
      v_counter_account_type,
      v_counter_account_code
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  v_amount_abs_cents := abs(v_tx.amount_cents);

  SELECT *
    INTO v_entry
    FROM public.create_and_post_journal(
      v_tx.organization_id,
      v_tx.posted_at::date,
      'bank_transaction',
      v_tx.id,
      'bank-txn:v1',
      jsonb_build_array(
        jsonb_build_object(
          'account_id', v_counter_account_id,
          'debit_cents', v_amount_abs_cents,
          'credit_cents', 0,
          'description', 'Bank spend ' || v_tx.auto_category_code
        ),
        jsonb_build_object(
          'account_id', v_bank_account_id,
          'debit_cents', 0,
          'credit_cents', v_amount_abs_cents,
          'description', 'Bank transaction ' || v_tx.description
        )
      ),
      'Bank transaction ' || v_tx.description,
      jsonb_build_object(
        'source_table', 'bank_transactions',
        'bank_account_id', v_tx.bank_account_id,
        'external_id', v_tx.external_id,
        'description', v_tx.description,
        'auto_category_code', v_tx.auto_category_code,
        'amount_cents', v_tx.amount_cents,
        'posted_gross_only', true
      )
    );

  RETURN v_entry;
END;
$$;

COMMENT ON FUNCTION public.post_bank_transaction_journal(uuid) IS
  'Posts a standalone, unmatched, business bank outflow through '
  'create_and_post_journal using idempotency key bank-txn:v1. Rejects personal, '
  'matched, uncategorized, inflow, payroll/GST/customer-payment/refund categories '
  'and posts gross only because bank transaction rows do not carry a reliable GST '
  'split. Matched rows use post_reconciled_bank_transaction_journal().';

REVOKE ALL ON FUNCTION public.post_bank_transaction_journal(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_bank_transaction_journal(uuid)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Reconciled bank transaction dispatcher.
--
-- AR match: delegate to post_invoice_payment_journal(invoice_payments.id), which
-- posts Dr Bank / Cr AR after ensuring the invoice issue journal exists.
--
-- AP match: if the bill's existing bill journal credited AP 2000, post the
-- settlement Dr AP / Cr Bank. If the bill journal already credited bank 1000
-- directly, fail closed instead of double-crediting bank.
--
-- Unmatched rows: delegate to post_bank_transaction_journal().
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_reconciled_bank_transaction_journal(
  p_bank_transaction_id uuid
)
RETURNS public.journal_entries
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_tx                       public.bank_transactions%ROWTYPE;
  v_bill                     public.bills%ROWTYPE;
  v_entry                    public.journal_entries;
  v_invoice_payment_id       uuid;
  v_bank_account_id          uuid;
  v_ap_account_id            uuid;
  v_bill_ap_credit_cents     bigint;
  v_bill_bank_credit_cents   bigint;
  v_amount_abs_cents         bigint;
BEGIN
  IF p_bank_transaction_id IS NULL THEN
    RAISE EXCEPTION 'bank_transaction_id is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  SELECT *
    INTO v_tx
    FROM public.bank_transactions
   WHERE id = p_bank_transaction_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank transaction % not found or not accessible', p_bank_transaction_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_tx.matched_invoice_id IS NOT NULL THEN
    SELECT ip.id
      INTO v_invoice_payment_id
      FROM public.invoice_payments ip
     WHERE ip.bank_transaction_id = p_bank_transaction_id
       AND ip.invoice_id = v_tx.matched_invoice_id
       AND ip.organization_id = v_tx.organization_id
     ORDER BY ip.created_at DESC
     LIMIT 1;

    IF v_invoice_payment_id IS NULL THEN
      RAISE EXCEPTION 'bank transaction % is invoice-matched but has no invoice_payments row',
        p_bank_transaction_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    SELECT *
      INTO v_entry
      FROM public.post_invoice_payment_journal(v_invoice_payment_id);

    RETURN v_entry;
  END IF;

  IF v_tx.matched_bill_id IS NULL THEN
    SELECT *
      INTO v_entry
      FROM public.post_bank_transaction_journal(p_bank_transaction_id);

    RETURN v_entry;
  END IF;

  IF v_tx.is_personal IS TRUE THEN
    RAISE EXCEPTION 'bank transaction % is personal and cannot settle AP',
      p_bank_transaction_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_tx.amount_cents >= 0 THEN
    RAISE EXCEPTION 'bank transaction % must be an outflow to settle AP',
      p_bank_transaction_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT *
    INTO v_bill
    FROM public.bills
   WHERE id = v_tx.matched_bill_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank transaction % references missing bill %',
      p_bank_transaction_id,
      v_tx.matched_bill_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_bill.organization_id <> v_tx.organization_id THEN
    RAISE EXCEPTION 'bank transaction % bill organization mismatch',
      p_bank_transaction_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF v_bill.deleted_at IS NOT NULL OR v_bill.status = 'void'::public.bill_status THEN
    RAISE EXCEPTION 'bank transaction % cannot settle a void or deleted bill',
      p_bank_transaction_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT coa.id
    INTO v_bank_account_id
    FROM public.chart_of_accounts coa
   WHERE coa.organization_id = v_tx.organization_id
     AND coa.code = '1000'
     AND coa.account_type = 'asset'::public.account_type
     AND coa.is_active = true
   LIMIT 1;

  IF v_bank_account_id IS NULL THEN
    RAISE EXCEPTION 'bank transaction % cannot settle AP: active asset account 1000 is missing',
      p_bank_transaction_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT coa.id
    INTO v_ap_account_id
    FROM public.chart_of_accounts coa
   WHERE coa.organization_id = v_tx.organization_id
     AND coa.code = '2000'
     AND coa.account_type = 'liability'::public.account_type
     AND coa.is_active = true
   LIMIT 1;

  IF v_ap_account_id IS NULL THEN
    RAISE EXCEPTION 'bank transaction % cannot settle AP: active liability account 2000 is missing',
      p_bank_transaction_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT
    COALESCE(SUM(jl.credit_cents) FILTER (WHERE coa.code = '2000'), 0)::bigint,
    COALESCE(SUM(jl.credit_cents) FILTER (WHERE coa.code = '1000'), 0)::bigint
    INTO v_bill_ap_credit_cents, v_bill_bank_credit_cents
  FROM public.journal_entries je
  JOIN public.journal_lines jl
    ON jl.journal_entry_id = je.id
  JOIN public.chart_of_accounts coa
    ON coa.id = jl.account_id
  WHERE je.organization_id = v_tx.organization_id
    AND je.source_type = 'bill'
    AND je.source_id = v_bill.id
    AND je.status = 'posted'
    AND coa.code IN ('2000', '1000');

  IF v_bill_ap_credit_cents <= 0 AND v_bill_bank_credit_cents > 0 THEN
    RAISE EXCEPTION
      'bill % was posted directly to bank; AP settlement for bank transaction % would double-post bank',
      v_bill.id,
      p_bank_transaction_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_bill_ap_credit_cents <= 0 THEN
    RAISE EXCEPTION 'bill % has no posted AP journal to settle', v_bill.id
      USING ERRCODE = 'check_violation';
  END IF;

  v_amount_abs_cents := abs(v_tx.amount_cents);

  IF v_amount_abs_cents <> v_bill_ap_credit_cents THEN
    RAISE EXCEPTION
      'bank transaction % amount % does not equal posted AP liability % for bill %',
      p_bank_transaction_id,
      v_amount_abs_cents,
      v_bill_ap_credit_cents,
      v_bill.id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT *
    INTO v_entry
    FROM public.create_and_post_journal(
      v_tx.organization_id,
      v_tx.posted_at::date,
      'bank_reconciliation',
      v_tx.id,
      'bill-settlement:v1',
      jsonb_build_array(
        jsonb_build_object(
          'account_id', v_ap_account_id,
          'debit_cents', v_bill_ap_credit_cents,
          'credit_cents', 0,
          'description', 'AP settlement bill ' || COALESCE(v_bill.invoice_number, v_bill.id::text)
        ),
        jsonb_build_object(
          'account_id', v_bank_account_id,
          'debit_cents', 0,
          'credit_cents', v_bill_ap_credit_cents,
          'description', 'Bank settlement ' || v_tx.description
        )
      ),
      'Bank reconciliation bill settlement',
      jsonb_build_object(
        'source_table', 'bank_transactions',
        'bank_transaction_id', v_tx.id,
        'matched_bill_id', v_bill.id,
        'bank_account_id', v_tx.bank_account_id,
        'external_id', v_tx.external_id,
        'amount_cents', v_tx.amount_cents
      )
    );

  RETURN v_entry;
END;
$$;

COMMENT ON FUNCTION public.post_reconciled_bank_transaction_journal(uuid) IS
  'Posts the GL effect of a reconciled bank transaction through the canonical '
  'source posting RPCs. Invoice matches delegate to post_invoice_payment_journal; '
  'bill matches post AP settlement only when the bill journal credited AP 2000; '
  'unmatched rows delegate to post_bank_transaction_journal. Rejects personal, '
  'wrong-direction, missing-source, missing-COA, direct-bank bill journals, and '
  'amounts that do not tie to the posted AP liability.';

REVOKE ALL ON FUNCTION public.post_reconciled_bank_transaction_journal(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_reconciled_bank_transaction_journal(uuid)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
