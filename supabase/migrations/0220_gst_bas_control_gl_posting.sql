-- ============================================================================
-- 0220_gst_bas_control_gl_posting.sql  (P2-01d)
--
-- Source posting for GST/BAS control settlement and GST/BAS adjustments.
--
-- These functions are explicit RPC surfaces over create_and_post_journal(). They
-- deliberately do not add triggers: BAS lodgement/payment timing remains a
-- review workflow, and service-role automation must call through an org-scoped
-- token before it can satisfy the canonical GL org gate.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. BAS bank settlement posting.
--
-- Uses generate_bas_worksheet(org, FY, quarter) as the source-of-truth labels:
--
-- Payable BAS:
--   Dr GST payable / collected (2100 or system gst_collected)      1A
--   Dr PAYG withholding payable (2200)                             W2 / label 4
--   Cr GST receivable / input credits (1200 or system gst_paid)    1B
--   Cr Business bank account (1000)                                label 9
--
-- Refund BAS:
--   Dr GST payable / collected (2100 or system gst_collected)      1A
--   Dr PAYG withholding payable (2200)                             W2 / label 4
--   Dr Business bank account (1000)                                refund
--   Cr GST receivable / input credits (1200 or system gst_paid)    1B
--
-- The linked bank transaction must be the exact opposite sign of worksheet
-- summary label 9. This is the dedicated path for bank rows that
-- post_bank_transaction_journal rejects as ato_bas_super.
--
-- Idempotency key: bas-settlement:v1
-- Source event:    bas_bank_transaction:<bank_transaction_id>:bas-settlement:v1
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_bas_bank_transaction_journal(
  p_bank_transaction_id uuid,
  p_fy_start_year integer,
  p_quarter integer
)
RETURNS public.journal_entries
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_tx                         public.bank_transactions%ROWTYPE;
  v_entry                      public.journal_entries;
  v_worksheet                  jsonb;
  v_label_1a_cents             bigint;
  v_label_1b_cents             bigint;
  v_payg_w_cents               bigint;
  v_net_cents                  bigint;
  v_quarter_start              date;
  v_quarter_end                date;
  v_due_date                   date;
  v_gst_collected_account_id   uuid;
  v_gst_paid_account_id        uuid;
  v_payg_account_id            uuid;
  v_bank_account_id            uuid;
  v_lines                      jsonb := '[]'::jsonb;
BEGIN
  IF p_bank_transaction_id IS NULL THEN
    RAISE EXCEPTION 'bank_transaction_id is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_fy_start_year IS NULL OR p_quarter IS NULL OR p_quarter NOT BETWEEN 1 AND 4 THEN
    RAISE EXCEPTION 'valid BAS FY start year and quarter are required'
      USING ERRCODE = 'invalid_parameter_value';
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
    RAISE EXCEPTION 'bank transaction % is personal and cannot post BAS settlement',
      p_bank_transaction_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_tx.matched_bill_id IS NOT NULL OR v_tx.matched_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'bank transaction % is already reconciled to another source',
      p_bank_transaction_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_tx.amount_cents = 0 THEN
    RAISE EXCEPTION 'bank transaction % amount must be non-zero for BAS settlement',
      p_bank_transaction_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF COALESCE(v_tx.auto_category_code, '') <> 'ato_bas_super' THEN
    RAISE EXCEPTION
      'bank transaction % category % is not the dedicated ATO/BAS category',
      p_bank_transaction_id,
      v_tx.auto_category_code
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT public.generate_bas_worksheet(v_tx.organization_id, p_fy_start_year, p_quarter)
    INTO v_worksheet;

  IF v_worksheet IS NULL OR jsonb_typeof(v_worksheet) <> 'object' THEN
    RAISE EXCEPTION 'BAS worksheet did not return an object for org %, FY %, quarter %',
      v_tx.organization_id,
      p_fy_start_year,
      p_quarter
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_label_1a_cents := COALESCE((v_worksheet #>> ARRAY['gst', '1A'])::bigint, 0);
  v_label_1b_cents := COALESCE((v_worksheet #>> ARRAY['gst', '1B'])::bigint, 0);
  v_payg_w_cents := COALESCE((v_worksheet #>> ARRAY['payg_withholding', '4'])::bigint, 0);
  v_net_cents := COALESCE(
    (v_worksheet #>> ARRAY['summary', '9_net_amount_cents'])::bigint,
    v_label_1a_cents - v_label_1b_cents + v_payg_w_cents
  );

  IF v_label_1a_cents < 0 OR v_label_1b_cents < 0 OR v_payg_w_cents < 0 THEN
    RAISE EXCEPTION 'BAS worksheet contains negative GST/PAYG labels for org %, FY %, quarter %',
      v_tx.organization_id,
      p_fy_start_year,
      p_quarter
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_net_cents = 0 THEN
    RAISE EXCEPTION 'BAS worksheet net amount is zero; no bank settlement journal is required'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_tx.amount_cents <> -v_net_cents THEN
    RAISE EXCEPTION
      'bank transaction % amount % does not equal BAS worksheet settlement amount %',
      p_bank_transaction_id,
      v_tx.amount_cents,
      -v_net_cents
      USING ERRCODE = 'check_violation';
  END IF;

  v_quarter_start := COALESCE(
    NULLIF(v_worksheet ->> 'quarter_start', '')::date,
    CASE p_quarter
      WHEN 1 THEN make_date(p_fy_start_year, 7, 1)
      WHEN 2 THEN make_date(p_fy_start_year, 10, 1)
      WHEN 3 THEN make_date(p_fy_start_year + 1, 1, 1)
      ELSE make_date(p_fy_start_year + 1, 4, 1)
    END
  );
  v_quarter_end := COALESCE(
    NULLIF(v_worksheet ->> 'quarter_end', '')::date,
    CASE p_quarter
      WHEN 1 THEN make_date(p_fy_start_year, 9, 30)
      WHEN 2 THEN make_date(p_fy_start_year, 12, 31)
      WHEN 3 THEN make_date(p_fy_start_year + 1, 3, 31)
      ELSE make_date(p_fy_start_year + 1, 6, 30)
    END
  );
  v_due_date := COALESCE(
    NULLIF(v_worksheet ->> 'due_date', '')::date,
    CASE p_quarter
      WHEN 1 THEN make_date(p_fy_start_year, 10, 28)
      WHEN 2 THEN make_date(p_fy_start_year + 1, 2, 28)
      WHEN 3 THEN make_date(p_fy_start_year + 1, 4, 28)
      ELSE make_date(p_fy_start_year + 1, 7, 28)
    END
  );

  IF v_label_1a_cents > 0 THEN
    SELECT coa.id
      INTO v_gst_collected_account_id
      FROM public.system_accounts sa
      JOIN public.chart_of_accounts coa
        ON coa.id = sa.account_id
       AND coa.organization_id = sa.organization_id
       AND coa.account_type = 'liability'::public.account_type
       AND coa.is_active = true
     WHERE sa.organization_id = v_tx.organization_id
       AND sa.role = 'gst_collected'
       AND sa.deleted_at IS NULL
     LIMIT 1;

    IF v_gst_collected_account_id IS NULL THEN
      SELECT coa.id
        INTO v_gst_collected_account_id
        FROM public.chart_of_accounts coa
       WHERE coa.organization_id = v_tx.organization_id
         AND coa.code = '2100'
         AND coa.account_type = 'liability'::public.account_type
         AND coa.is_active = true
       LIMIT 1;
    END IF;

    IF v_gst_collected_account_id IS NULL THEN
      RAISE EXCEPTION
        'BAS settlement % cannot post: gst_collected system account or active liability account 2100 is missing',
        p_bank_transaction_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_gst_collected_account_id,
        'debit_cents', v_label_1a_cents,
        'credit_cents', 0,
        'description', 'BAS GST on sales 1A'
      )
    );
  END IF;

  IF v_payg_w_cents > 0 THEN
    SELECT coa.id
      INTO v_payg_account_id
      FROM public.chart_of_accounts coa
     WHERE coa.organization_id = v_tx.organization_id
       AND coa.code = '2200'
       AND coa.account_type = 'liability'::public.account_type
       AND coa.is_active = true
     LIMIT 1;

    IF v_payg_account_id IS NULL THEN
      RAISE EXCEPTION 'BAS settlement % cannot post: active liability account 2200 is missing',
        p_bank_transaction_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_payg_account_id,
        'debit_cents', v_payg_w_cents,
        'credit_cents', 0,
        'description', 'BAS PAYG withholding label 4'
      )
    );
  END IF;

  IF v_label_1b_cents > 0 THEN
    SELECT coa.id
      INTO v_gst_paid_account_id
      FROM public.system_accounts sa
      JOIN public.chart_of_accounts coa
        ON coa.id = sa.account_id
       AND coa.organization_id = sa.organization_id
       AND coa.account_type = 'asset'::public.account_type
       AND coa.is_active = true
     WHERE sa.organization_id = v_tx.organization_id
       AND sa.role = 'gst_paid'
       AND sa.deleted_at IS NULL
     LIMIT 1;

    IF v_gst_paid_account_id IS NULL THEN
      SELECT coa.id
        INTO v_gst_paid_account_id
        FROM public.chart_of_accounts coa
       WHERE coa.organization_id = v_tx.organization_id
         AND coa.code = '1200'
         AND coa.account_type = 'asset'::public.account_type
         AND coa.is_active = true
       LIMIT 1;
    END IF;

    IF v_gst_paid_account_id IS NULL THEN
      RAISE EXCEPTION
        'BAS settlement % cannot post: gst_paid system account or active asset account 1200 is missing',
        p_bank_transaction_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_gst_paid_account_id,
        'debit_cents', 0,
        'credit_cents', v_label_1b_cents,
        'description', 'BAS GST on purchases 1B'
      )
    );
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
    RAISE EXCEPTION 'BAS settlement % cannot post: active asset account 1000 is missing',
      p_bank_transaction_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF v_net_cents > 0 THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_bank_account_id,
        'debit_cents', 0,
        'credit_cents', v_net_cents,
        'description', 'BAS payment to ATO'
      )
    );
  ELSE
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_bank_account_id,
        'debit_cents', abs(v_net_cents),
        'credit_cents', 0,
        'description', 'BAS refund from ATO'
      )
    );
  END IF;

  SELECT *
    INTO v_entry
    FROM public.create_and_post_journal(
      v_tx.organization_id,
      v_tx.posted_at::date,
      'bas_bank_transaction',
      v_tx.id,
      'bas-settlement:v1',
      v_lines,
      'BAS settlement FY ' || p_fy_start_year || ' Q' || p_quarter,
      jsonb_build_object(
        'source_table', 'bank_transactions',
        'bank_transaction_id', v_tx.id,
        'bank_account_id', v_tx.bank_account_id,
        'external_id', v_tx.external_id,
        'auto_category_code', v_tx.auto_category_code,
        'fy_start_year', p_fy_start_year,
        'quarter', p_quarter,
        'quarter_start', v_quarter_start,
        'quarter_end', v_quarter_end,
        'due_date', v_due_date,
        'label_1a_gst_on_sales_cents', v_label_1a_cents,
        'label_1b_gst_on_purchases_cents', v_label_1b_cents,
        'label_4_payg_withheld_cents', v_payg_w_cents,
        'label_9_net_amount_cents', v_net_cents,
        'bank_amount_cents', v_tx.amount_cents,
        'bas_worksheet', v_worksheet
      )
    );

  RETURN v_entry;
END;
$$;

COMMENT ON FUNCTION public.post_bas_bank_transaction_journal(uuid, integer, integer) IS
  'Posts a BAS bank settlement through create_and_post_journal using idempotency '
  'key bas-settlement:v1. Generates the BAS worksheet for the supplied AU FY '
  'quarter, requires the ato_bas_super bank transaction amount to be the exact '
  'opposite of label 9, clears 1A/1B/PAYG-W controls against bank 1000, and '
  'rejects personal, matched, wrong-category, missing-COA, zero-net, locked-period, '
  'and inaccessible-org states.';

REVOKE ALL ON FUNCTION public.post_bas_bank_transaction_journal(uuid, integer, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_bas_bank_transaction_journal(uuid, integer, integer)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Focused GST/BAS adjustment posting.
--
-- p_adjustment_type:
--   increase_gst_payable  -> Dr counter / Cr GST payable
--   decrease_gst_payable  -> Dr GST payable / Cr counter
--   increase_gst_credit   -> Dr GST receivable / Cr counter
--   decrease_gst_credit   -> Dr counter / Cr GST receivable
--
-- The caller supplies the counter account code and type so this stays a focused
-- tax adjustment RPC, not a hidden general manual-journal endpoint. The
-- adjustment_key is the durable idempotency source supplied by the BAS reviewer
-- or workflow.
--
-- Idempotency key: adjustment:<lower-key>:v1
-- Source event:    gst_bas_adjustment:no-source-id:adjustment:<key>:v1
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_gst_bas_adjustment_journal(
  p_organization_id uuid,
  p_adjustment_date date,
  p_adjustment_key text,
  p_adjustment_type text,
  p_amount_cents bigint,
  p_counter_account_code text,
  p_counter_account_type public.account_type,
  p_reason text DEFAULT NULL
)
RETURNS public.journal_entries
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_entry              public.journal_entries;
  v_adjustment_key     text := lower(btrim(COALESCE(p_adjustment_key, '')));
  v_adjustment_type    text := lower(btrim(COALESCE(p_adjustment_type, '')));
  v_counter_code       text := btrim(COALESCE(p_counter_account_code, ''));
  v_control_account_id uuid;
  v_counter_account_id uuid;
  v_lines              jsonb;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_adjustment_date IS NULL THEN
    RAISE EXCEPTION 'adjustment_date is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF v_adjustment_key = '' THEN
    RAISE EXCEPTION 'adjustment_key is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF v_adjustment_type NOT IN (
    'increase_gst_payable',
    'decrease_gst_payable',
    'increase_gst_credit',
    'decrease_gst_credit'
  ) THEN
    RAISE EXCEPTION 'invalid GST/BAS adjustment type %', p_adjustment_type
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'amount_cents must be positive'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_counter_code = '' OR p_counter_account_type IS NULL THEN
    RAISE EXCEPTION 'counter account code and type are required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  SELECT coa.id
    INTO v_counter_account_id
    FROM public.chart_of_accounts coa
   WHERE coa.organization_id = p_organization_id
     AND coa.code = v_counter_code
     AND coa.account_type = p_counter_account_type
     AND coa.is_active = true
   LIMIT 1;

  IF v_counter_account_id IS NULL THEN
    RAISE EXCEPTION 'GST/BAS adjustment % cannot post: active % account % is missing',
      v_adjustment_key,
      p_counter_account_type,
      v_counter_code
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF v_adjustment_type IN ('increase_gst_payable', 'decrease_gst_payable') THEN
    SELECT coa.id
      INTO v_control_account_id
      FROM public.system_accounts sa
      JOIN public.chart_of_accounts coa
        ON coa.id = sa.account_id
       AND coa.organization_id = sa.organization_id
       AND coa.account_type = 'liability'::public.account_type
       AND coa.is_active = true
     WHERE sa.organization_id = p_organization_id
       AND sa.role = 'gst_collected'
       AND sa.deleted_at IS NULL
     LIMIT 1;

    IF v_control_account_id IS NULL THEN
      SELECT coa.id
        INTO v_control_account_id
        FROM public.chart_of_accounts coa
       WHERE coa.organization_id = p_organization_id
         AND coa.code = '2100'
         AND coa.account_type = 'liability'::public.account_type
         AND coa.is_active = true
       LIMIT 1;
    END IF;

    IF v_control_account_id IS NULL THEN
      RAISE EXCEPTION
        'GST/BAS adjustment % cannot post: gst_collected system account or active liability account 2100 is missing',
        v_adjustment_key
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSE
    SELECT coa.id
      INTO v_control_account_id
      FROM public.system_accounts sa
      JOIN public.chart_of_accounts coa
        ON coa.id = sa.account_id
       AND coa.organization_id = sa.organization_id
       AND coa.account_type = 'asset'::public.account_type
       AND coa.is_active = true
     WHERE sa.organization_id = p_organization_id
       AND sa.role = 'gst_paid'
       AND sa.deleted_at IS NULL
     LIMIT 1;

    IF v_control_account_id IS NULL THEN
      SELECT coa.id
        INTO v_control_account_id
        FROM public.chart_of_accounts coa
       WHERE coa.organization_id = p_organization_id
         AND coa.code = '1200'
         AND coa.account_type = 'asset'::public.account_type
         AND coa.is_active = true
       LIMIT 1;
    END IF;

    IF v_control_account_id IS NULL THEN
      RAISE EXCEPTION
        'GST/BAS adjustment % cannot post: gst_paid system account or active asset account 1200 is missing',
        v_adjustment_key
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  IF v_control_account_id = v_counter_account_id THEN
    RAISE EXCEPTION 'GST/BAS adjustment % control and counter account are the same',
      v_adjustment_key
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_adjustment_type = 'increase_gst_payable' THEN
    v_lines := jsonb_build_array(
      jsonb_build_object(
        'account_id', v_counter_account_id,
        'debit_cents', p_amount_cents,
        'credit_cents', 0,
        'description', 'GST/BAS adjustment counter'
      ),
      jsonb_build_object(
        'account_id', v_control_account_id,
        'debit_cents', 0,
        'credit_cents', p_amount_cents,
        'description', 'GST payable adjustment'
      )
    );
  ELSIF v_adjustment_type = 'decrease_gst_payable' THEN
    v_lines := jsonb_build_array(
      jsonb_build_object(
        'account_id', v_control_account_id,
        'debit_cents', p_amount_cents,
        'credit_cents', 0,
        'description', 'GST payable adjustment'
      ),
      jsonb_build_object(
        'account_id', v_counter_account_id,
        'debit_cents', 0,
        'credit_cents', p_amount_cents,
        'description', 'GST/BAS adjustment counter'
      )
    );
  ELSIF v_adjustment_type = 'increase_gst_credit' THEN
    v_lines := jsonb_build_array(
      jsonb_build_object(
        'account_id', v_control_account_id,
        'debit_cents', p_amount_cents,
        'credit_cents', 0,
        'description', 'GST credit adjustment'
      ),
      jsonb_build_object(
        'account_id', v_counter_account_id,
        'debit_cents', 0,
        'credit_cents', p_amount_cents,
        'description', 'GST/BAS adjustment counter'
      )
    );
  ELSE
    v_lines := jsonb_build_array(
      jsonb_build_object(
        'account_id', v_counter_account_id,
        'debit_cents', p_amount_cents,
        'credit_cents', 0,
        'description', 'GST/BAS adjustment counter'
      ),
      jsonb_build_object(
        'account_id', v_control_account_id,
        'debit_cents', 0,
        'credit_cents', p_amount_cents,
        'description', 'GST credit adjustment'
      )
    );
  END IF;

  SELECT *
    INTO v_entry
    FROM public.create_and_post_journal(
      p_organization_id,
      p_adjustment_date,
      'gst_bas_adjustment',
      NULL,
      'adjustment:' || v_adjustment_key || ':v1',
      v_lines,
      'GST/BAS adjustment ' || v_adjustment_key,
      jsonb_build_object(
        'source_table', null,
        'adjustment_key', v_adjustment_key,
        'adjustment_type', v_adjustment_type,
        'amount_cents', p_amount_cents,
        'counter_account_code', v_counter_code,
        'counter_account_type', p_counter_account_type,
        'reason', NULLIF(btrim(COALESCE(p_reason, '')), '')
      )
    );

  RETURN v_entry;
END;
$$;

COMMENT ON FUNCTION public.post_gst_bas_adjustment_journal(uuid, date, text, text, bigint, text, public.account_type, text) IS
  'Posts a focused GST/BAS adjustment through create_and_post_journal using '
  'idempotency key adjustment:<key>:v1. Supports increase/decrease of GST payable '
  'and GST input-credit controls, requires an explicit active same-org counter '
  'account, rejects missing control accounts and same-account postings, and leaves '
  'general manual journals to the separate manual-journal/reversal slice.';

REVOKE ALL ON FUNCTION public.post_gst_bas_adjustment_journal(
  uuid,
  date,
  text,
  text,
  bigint,
  text,
  public.account_type,
  text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_gst_bas_adjustment_journal(
  uuid,
  date,
  text,
  text,
  bigint,
  text,
  public.account_type,
  text
) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
