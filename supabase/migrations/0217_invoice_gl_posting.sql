-- ============================================================================
-- 0217_invoice_gl_posting.sql  (P2-01a)
--
-- Source posting for customer invoices and invoice payments.
--
-- This intentionally does not install table triggers yet. Several service-role
-- cron/sync paths still create invoice_payments without an org-scoped JWT claim;
-- automatic triggers would make those paths fail the canonical GL org gate. The
-- source-specific RPCs below are the deterministic posting surface for human and
-- org-scoped backend callers, and later reconciliation slices can wire cron
-- callers to them through org-scoped tokens.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Customer invoice issue posting.
--
-- Dr Accounts receivable (1100)       total invoice inc GST
-- Cr Revenue (line account_code/4000) subtotal ex GST
-- Cr GST payable (system gst_collected or 2100) GST collected, when non-zero
--
-- Idempotency key: issue:v1
-- Source event:    invoice:<invoice_id>:issue:v1
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_invoice_journal(p_invoice_id uuid)
RETURNS public.journal_entries
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_invoice              public.invoices%ROWTYPE;
  v_entry                public.journal_entries;
  v_ar_account_id        uuid;
  v_gst_account_id       uuid;
  v_bad_revenue_codes    text;
  v_line_count           integer;
  v_line_subtotal_cents  bigint;
  v_line_gst_cents       bigint;
  v_line_total_cents     bigint;
  v_revenue_lines        jsonb;
  v_lines                jsonb;
BEGIN
  IF p_invoice_id IS NULL THEN
    RAISE EXCEPTION 'invoice_id is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  SELECT *
    INTO v_invoice
    FROM public.invoices
   WHERE id = p_invoice_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice % not found or not accessible', p_invoice_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_invoice.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'cannot post deleted invoice %', p_invoice_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_invoice.status IN ('draft'::public.invoice_status, 'void'::public.invoice_status) THEN
    RAISE EXCEPTION 'cannot post invoice % with status %', p_invoice_id, v_invoice.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_invoice.total_inc_gst_cents <= 0 THEN
    RAISE EXCEPTION 'invoice % total must be positive before GL posting', p_invoice_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE line_total_inc_gst_cents > 0)::integer,
    COALESCE(SUM(line_total_ex_gst_cents), 0)::bigint,
    COALESCE(SUM(line_gst_cents), 0)::bigint,
    COALESCE(SUM(line_total_inc_gst_cents), 0)::bigint
    INTO v_line_count, v_line_subtotal_cents, v_line_gst_cents, v_line_total_cents
  FROM public.invoice_line_items
  WHERE invoice_id = p_invoice_id;

  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'invoice % has no positive line items to post', p_invoice_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.invoice_line_items ili
     WHERE ili.invoice_id = p_invoice_id
       AND (
         ili.organization_id <> v_invoice.organization_id
         OR ili.line_total_ex_gst_cents < 0
         OR ili.line_gst_cents < 0
         OR ili.line_total_inc_gst_cents <= 0
       )
  ) THEN
    RAISE EXCEPTION 'invoice % has invalid or cross-org line items', p_invoice_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF v_line_subtotal_cents <> v_invoice.subtotal_ex_gst_cents
     OR v_line_gst_cents <> v_invoice.gst_cents
     OR v_line_total_cents <> v_invoice.total_inc_gst_cents THEN
    RAISE EXCEPTION
      'invoice % line totals do not match header totals',
      p_invoice_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT coa.id
    INTO v_ar_account_id
    FROM public.chart_of_accounts coa
   WHERE coa.organization_id = v_invoice.organization_id
     AND coa.code = '1100'
     AND coa.account_type = 'asset'::public.account_type
     AND coa.is_active = true
   LIMIT 1;

  IF v_ar_account_id IS NULL THEN
    RAISE EXCEPTION 'invoice % cannot post: active asset account 1100 is missing', p_invoice_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  WITH revenue_codes AS (
    SELECT COALESCE(NULLIF(btrim(ili.account_code), ''), '4000') AS code
      FROM public.invoice_line_items ili
     WHERE ili.invoice_id = p_invoice_id
       AND ili.line_total_ex_gst_cents > 0
     GROUP BY 1
  )
  SELECT string_agg(rc.code, ', ' ORDER BY rc.code)
    INTO v_bad_revenue_codes
    FROM revenue_codes rc
    LEFT JOIN public.chart_of_accounts coa
      ON coa.organization_id = v_invoice.organization_id
     AND coa.code = rc.code
     AND coa.account_type = 'income'::public.account_type
     AND coa.is_active = true
   WHERE coa.id IS NULL;

  IF v_bad_revenue_codes IS NOT NULL THEN
    RAISE EXCEPTION
      'invoice % cannot post: missing, inactive, or non-income revenue account code(s): %',
      p_invoice_id,
      v_bad_revenue_codes
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  WITH revenue AS (
    SELECT
      COALESCE(NULLIF(btrim(ili.account_code), ''), '4000') AS code,
      SUM(ili.line_total_ex_gst_cents)::bigint AS amount_cents
    FROM public.invoice_line_items ili
    WHERE ili.invoice_id = p_invoice_id
      AND ili.line_total_ex_gst_cents > 0
    GROUP BY 1
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'account_id', coa.id,
        'debit_cents', 0,
        'credit_cents', r.amount_cents,
        'description', 'Invoice revenue ' || r.code
      )
      ORDER BY coa.code
    ),
    '[]'::jsonb
  )
    INTO v_revenue_lines
    FROM revenue r
    JOIN public.chart_of_accounts coa
      ON coa.organization_id = v_invoice.organization_id
     AND coa.code = r.code
     AND coa.account_type = 'income'::public.account_type
     AND coa.is_active = true;

  IF v_invoice.gst_cents > 0 THEN
    SELECT coa.id
      INTO v_gst_account_id
      FROM public.system_accounts sa
      JOIN public.chart_of_accounts coa
        ON coa.id = sa.account_id
       AND coa.organization_id = sa.organization_id
       AND coa.account_type = 'liability'::public.account_type
       AND coa.is_active = true
     WHERE sa.organization_id = v_invoice.organization_id
       AND sa.role = 'gst_collected'
       AND sa.deleted_at IS NULL
     LIMIT 1;

    IF v_gst_account_id IS NULL THEN
      SELECT coa.id
        INTO v_gst_account_id
        FROM public.chart_of_accounts coa
       WHERE coa.organization_id = v_invoice.organization_id
         AND coa.code = '2100'
         AND coa.account_type = 'liability'::public.account_type
         AND coa.is_active = true
       LIMIT 1;
    END IF;

    IF v_gst_account_id IS NULL THEN
      RAISE EXCEPTION
        'invoice % cannot post: gst_collected system account or active liability account 2100 is missing',
        p_invoice_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  v_lines :=
    jsonb_build_array(
      jsonb_build_object(
        'account_id', v_ar_account_id,
        'debit_cents', v_invoice.total_inc_gst_cents,
        'credit_cents', 0,
        'description', 'Accounts receivable ' || v_invoice.invoice_number
      )
    )
    || v_revenue_lines;

  IF v_invoice.gst_cents > 0 THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_gst_account_id,
        'debit_cents', 0,
        'credit_cents', v_invoice.gst_cents,
        'description', 'GST collected ' || v_invoice.invoice_number
      )
    );
  END IF;

  SELECT *
    INTO v_entry
    FROM public.create_and_post_journal(
      v_invoice.organization_id,
      v_invoice.issue_date,
      'invoice',
      v_invoice.id,
      'issue:v1',
      v_lines,
      'Invoice ' || v_invoice.invoice_number,
      jsonb_build_object(
        'source_table', 'invoices',
        'invoice_number', v_invoice.invoice_number,
        'customer_id', v_invoice.customer_id,
        'job_id', v_invoice.job_id,
        'status_at_posting', v_invoice.status,
        'subtotal_ex_gst_cents', v_invoice.subtotal_ex_gst_cents,
        'gst_cents', v_invoice.gst_cents,
        'total_inc_gst_cents', v_invoice.total_inc_gst_cents
      )
    );

  RETURN v_entry;
END;
$$;

COMMENT ON FUNCTION public.post_invoice_journal(uuid) IS
  'Posts a customer invoice through create_and_post_journal using stable '
  'idempotency key issue:v1. Debits AR 1100 for total inc GST, credits invoice '
  'line revenue accounts (account_code or 4000) for ex-GST revenue, and credits '
  'gst_collected/2100 for GST. Rejects draft/void/deleted invoices, missing COA, '
  'invalid line totals, locked periods, and inaccessible orgs via the canonical RPC.';

REVOKE ALL ON FUNCTION public.post_invoice_journal(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_invoice_journal(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Customer invoice payment / receipt posting.
--
-- Dr Business bank account (1000) or cash on hand (1010 for cash method)
-- Cr Accounts receivable (1100)
--
-- Idempotency key: receipt:v1
-- Source event:    invoice_payment:<invoice_payment_id>:receipt:v1
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_invoice_payment_journal(p_invoice_payment_id uuid)
RETURNS public.journal_entries
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_payment             public.invoice_payments%ROWTYPE;
  v_invoice             public.invoices%ROWTYPE;
  v_entry               public.journal_entries;
  v_cash_account_code   text := '1000';
  v_cash_account_id     uuid;
  v_ar_account_id       uuid;
  v_bank_org            uuid;
  v_bank_amount_cents   bigint;
BEGIN
  IF p_invoice_payment_id IS NULL THEN
    RAISE EXCEPTION 'invoice_payment_id is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  SELECT *
    INTO v_payment
    FROM public.invoice_payments
   WHERE id = p_invoice_payment_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice payment % not found or not accessible', p_invoice_payment_id
      USING ERRCODE = 'no_data_found';
  END IF;

  SELECT *
    INTO v_invoice
    FROM public.invoices
   WHERE id = v_payment.invoice_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'invoice payment % references missing invoice %',
      p_invoice_payment_id,
      v_payment.invoice_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_payment.organization_id <> v_invoice.organization_id THEN
    RAISE EXCEPTION 'invoice payment % organization mismatch', p_invoice_payment_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF v_invoice.deleted_at IS NOT NULL
     OR v_invoice.status = 'void'::public.invoice_status THEN
    RAISE EXCEPTION 'cannot post payment % against a void or deleted invoice',
      p_invoice_payment_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_payment.amount_cents <= 0 THEN
    RAISE EXCEPTION 'invoice payment % amount must be positive', p_invoice_payment_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_payment.bank_transaction_id IS NOT NULL THEN
    SELECT bt.organization_id, bt.amount_cents
      INTO v_bank_org, v_bank_amount_cents
      FROM public.bank_transactions bt
     WHERE bt.id = v_payment.bank_transaction_id;

    IF v_bank_org IS NULL THEN
      RAISE EXCEPTION 'invoice payment % references missing bank transaction %',
        p_invoice_payment_id,
        v_payment.bank_transaction_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF v_bank_org <> v_payment.organization_id THEN
      RAISE EXCEPTION 'invoice payment % bank transaction organization mismatch',
        p_invoice_payment_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF v_bank_amount_cents <= 0 THEN
      RAISE EXCEPTION 'invoice payment % bank transaction must be an inflow',
        p_invoice_payment_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Ensure the invoice issue journal exists before reducing AR. Replays are
  -- idempotent because post_invoice_journal uses the canonical source_event_key.
  PERFORM public.post_invoice_journal(v_invoice.id);

  IF lower(COALESCE(v_payment.method, '')) = 'cash' THEN
    v_cash_account_code := '1010';
  END IF;

  SELECT coa.id
    INTO v_cash_account_id
    FROM public.chart_of_accounts coa
   WHERE coa.organization_id = v_payment.organization_id
     AND coa.code = v_cash_account_code
     AND coa.account_type = 'asset'::public.account_type
     AND coa.is_active = true
   LIMIT 1;

  IF v_cash_account_id IS NULL THEN
    RAISE EXCEPTION
      'invoice payment % cannot post: active asset account % is missing',
      p_invoice_payment_id,
      v_cash_account_code
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT coa.id
    INTO v_ar_account_id
    FROM public.chart_of_accounts coa
   WHERE coa.organization_id = v_payment.organization_id
     AND coa.code = '1100'
     AND coa.account_type = 'asset'::public.account_type
     AND coa.is_active = true
   LIMIT 1;

  IF v_ar_account_id IS NULL THEN
    RAISE EXCEPTION 'invoice payment % cannot post: active asset account 1100 is missing',
      p_invoice_payment_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT *
    INTO v_entry
    FROM public.create_and_post_journal(
      v_payment.organization_id,
      v_payment.paid_at::date,
      'invoice_payment',
      v_payment.id,
      'receipt:v1',
      jsonb_build_array(
        jsonb_build_object(
          'account_id', v_cash_account_id,
          'debit_cents', v_payment.amount_cents,
          'credit_cents', 0,
          'description', 'Invoice receipt ' || v_invoice.invoice_number
        ),
        jsonb_build_object(
          'account_id', v_ar_account_id,
          'debit_cents', 0,
          'credit_cents', v_payment.amount_cents,
          'description', 'Accounts receivable receipt ' || v_invoice.invoice_number
        )
      ),
      'Invoice payment ' || v_invoice.invoice_number,
      jsonb_build_object(
        'source_table', 'invoice_payments',
        'invoice_id', v_invoice.id,
        'invoice_number', v_invoice.invoice_number,
        'payment_method', v_payment.method,
        'payment_reference', v_payment.reference,
        'bank_transaction_id', v_payment.bank_transaction_id,
        'amount_cents', v_payment.amount_cents
      )
    );

  RETURN v_entry;
END;
$$;

COMMENT ON FUNCTION public.post_invoice_payment_journal(uuid) IS
  'Posts a customer invoice payment through create_and_post_journal using stable '
  'idempotency key receipt:v1. Ensures the invoice issue journal exists first, '
  'then debits bank/cash (1000, or 1010 for cash payments) and credits AR 1100. '
  'Rejects missing COA, invalid/cross-org payment rows, non-inflow bank links, '
  'locked periods, and inaccessible orgs via the canonical RPC.';

REVOKE ALL ON FUNCTION public.post_invoice_payment_journal(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_invoice_payment_journal(uuid)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
