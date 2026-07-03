-- ============================================================================
-- 0221_source_posting_completion.sql  (P2-01e)
--
-- Remaining source-posting surfaces over the canonical create_and_post_journal()
-- RPC: depreciation periods, opening balances, manual journals, reversals, and
-- AR/AP credit-note postings.
--
-- This migration adds explicit RPCs, not triggers. Product workflows still own
-- review/approval, document capture, and UI state. These functions are the
-- deterministic GL posting surfaces those workflows can call with org-scoped
-- human or backend tokens.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Depreciation schedule period posting.
--
-- Shared canonical version of the legacy depreciation-run / close_period posting
-- loop:
--   Dr 6700 Depreciation expense
--   Cr 1900 Accumulated depreciation
--
-- Idempotency key: period:<month-end>:depreciation:v1
-- Source event:    depreciation_schedule:<schedule_id>:period:<month-end>:depreciation:v1
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_depreciation_schedule_journal(
  p_schedule_id uuid,
  p_period date
)
RETURNS public.journal_entries
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_schedule          public.depreciation_schedules%ROWTYPE;
  v_asset             public.fixed_assets%ROWTYPE;
  v_entry             public.journal_entries;
  v_period_end        date;
  v_amount_cents      bigint;
  v_expense_account   uuid;
  v_accum_account     uuid;
BEGIN
  IF p_schedule_id IS NULL THEN
    RAISE EXCEPTION 'schedule_id is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_period IS NULL THEN
    RAISE EXCEPTION 'period is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  v_period_end := (date_trunc('month', p_period)::date + INTERVAL '1 month' - INTERVAL '1 day')::date;

  SELECT *
    INTO v_schedule
    FROM public.depreciation_schedules
   WHERE id = p_schedule_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'depreciation schedule % not found or not accessible', p_schedule_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_schedule.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'depreciation schedule % is deleted', p_schedule_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT *
    INTO v_asset
    FROM public.fixed_assets
   WHERE id = v_schedule.fixed_asset_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'depreciation schedule % references missing fixed asset %',
      p_schedule_id,
      v_schedule.fixed_asset_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_asset.organization_id <> v_schedule.organization_id THEN
    RAISE EXCEPTION 'depreciation schedule % fixed asset organization mismatch',
      p_schedule_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF v_asset.deleted_at IS NOT NULL OR v_asset.status <> 'active'::public.fixed_asset_status THEN
    RAISE EXCEPTION 'depreciation schedule % fixed asset is not active', p_schedule_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Legacy idempotency guard: depreciation-run and close_period already posted
  -- source_type/source_id/entry_date rows before 0215 added source_event_key.
  SELECT *
    INTO v_entry
    FROM public.journal_entries je
   WHERE je.organization_id = v_schedule.organization_id
     AND je.source_type = 'depreciation_schedule'
     AND je.source_id = v_schedule.id
     AND je.entry_date = v_period_end
     AND je.status IN ('posted', 'void')
   ORDER BY je.created_at
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    RETURN v_entry;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.journal_entries je
     WHERE je.organization_id = v_schedule.organization_id
       AND je.source_type = 'depreciation_schedule'
       AND je.source_id = v_schedule.id
       AND je.entry_date = v_period_end
       AND je.status = 'draft'
  ) THEN
    RAISE EXCEPTION 'draft depreciation journal already exists for schedule % and period %',
      p_schedule_id,
      v_period_end
      USING ERRCODE = 'check_violation';
  END IF;

  v_amount_cents := public.compute_depreciation(v_schedule.id, v_period_end);

  IF v_amount_cents IS NULL OR v_amount_cents <= 0 THEN
    RAISE EXCEPTION 'depreciation schedule % has no depreciation to post for %',
      p_schedule_id,
      v_period_end
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT (array_agg(coa.id) FILTER (WHERE coa.code = '6700'))[1],
         (array_agg(coa.id) FILTER (WHERE coa.code = '1900'))[1]
    INTO v_expense_account, v_accum_account
    FROM public.chart_of_accounts coa
   WHERE coa.organization_id = v_schedule.organization_id
     AND coa.is_active = true
     AND (
       (coa.code = '6700' AND coa.account_type = 'expense'::public.account_type)
       OR (coa.code = '1900' AND coa.account_type = 'asset'::public.account_type)
     );

  IF v_expense_account IS NULL THEN
    RAISE EXCEPTION 'depreciation schedule % cannot post: active expense account 6700 is missing',
      p_schedule_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF v_accum_account IS NULL THEN
    RAISE EXCEPTION 'depreciation schedule % cannot post: active asset account 1900 is missing',
      p_schedule_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT *
    INTO v_entry
    FROM public.create_and_post_journal(
      v_schedule.organization_id,
      v_period_end,
      'depreciation_schedule',
      v_schedule.id,
      'period:' || v_period_end::text || ':depreciation:v1',
      jsonb_build_array(
        jsonb_build_object(
          'account_id', v_expense_account,
          'debit_cents', v_amount_cents,
          'credit_cents', 0,
          'description', 'Depreciation ' || v_period_end::text || ' - ' || v_asset.name
        ),
        jsonb_build_object(
          'account_id', v_accum_account,
          'debit_cents', 0,
          'credit_cents', v_amount_cents,
          'description', 'Accumulated depreciation ' || v_asset.name
        )
      ),
      'Depreciation ' || v_period_end::text || ' - ' || v_asset.name,
      jsonb_build_object(
        'source_table', 'depreciation_schedules',
        'schedule_id', v_schedule.id,
        'fixed_asset_id', v_asset.id,
        'asset_name', v_asset.name,
        'period_end', v_period_end,
        'amount_cents', v_amount_cents,
        'method', v_schedule.method,
        'opening_cost_base_cents', v_schedule.opening_cost_base_cents,
        'effective_life_years', v_schedule.effective_life_years
      )
    );

  RETURN v_entry;
END;
$$;

COMMENT ON FUNCTION public.post_depreciation_schedule_journal(uuid, date) IS
  'Posts one active depreciation schedule for the month containing p_period through '
  'create_and_post_journal. Uses compute_depreciation(), Dr 6700 / Cr 1900, a '
  'stable period:<month-end>:depreciation:v1 idempotency key, and a legacy guard '
  'that returns already-posted/void source_type/source_id/entry_date journals from '
  'depreciation-run or close_period to prevent double posting.';

REVOKE ALL ON FUNCTION public.post_depreciation_schedule_journal(uuid, date)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_depreciation_schedule_journal(uuid, date)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Opening balance and manual journal wrappers.
--
-- These are intentionally thin typed surfaces over create_and_post_journal. The
-- canonical RPC validates balanced, non-empty, same-org active account lines.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_opening_balance_journal(
  p_organization_id uuid,
  p_opening_date date,
  p_opening_key text,
  p_lines jsonb,
  p_memo text DEFAULT NULL,
  p_source_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS public.journal_entries
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_entry public.journal_entries;
  v_key   text := lower(btrim(COALESCE(p_opening_key, '')));
  v_meta  jsonb := COALESCE(p_source_metadata, '{}'::jsonb);
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_opening_date IS NULL THEN
    RAISE EXCEPTION 'opening_date is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF v_key = '' THEN
    RAISE EXCEPTION 'opening_key is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF jsonb_typeof(v_meta) <> 'object' THEN
    RAISE EXCEPTION 'source_metadata must be a JSON object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT *
    INTO v_entry
    FROM public.create_and_post_journal(
      p_organization_id,
      p_opening_date,
      'opening_balance',
      NULL,
      'opening:' || v_key || ':v1',
      p_lines,
      COALESCE(NULLIF(btrim(p_memo), ''), 'Opening balance ' || v_key),
      v_meta || jsonb_build_object(
        'source_table', null,
        'opening_key', v_key
      )
    );

  RETURN v_entry;
END;
$$;

COMMENT ON FUNCTION public.post_opening_balance_journal(uuid, date, text, jsonb, text, jsonb) IS
  'Typed opening-balance posting wrapper over create_and_post_journal using '
  'idempotency key opening:<key>:v1. The canonical RPC validates line shape, '
  'balance, active same-org accounts, period locks, and org access.';

REVOKE ALL ON FUNCTION public.post_opening_balance_journal(uuid, date, text, jsonb, text, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_opening_balance_journal(uuid, date, text, jsonb, text, jsonb)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.post_manual_journal(
  p_organization_id uuid,
  p_entry_date date,
  p_manual_key text,
  p_lines jsonb,
  p_memo text,
  p_reason text DEFAULT NULL,
  p_source_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS public.journal_entries
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_entry public.journal_entries;
  v_key   text := lower(btrim(COALESCE(p_manual_key, '')));
  v_meta  jsonb := COALESCE(p_source_metadata, '{}'::jsonb);
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_entry_date IS NULL THEN
    RAISE EXCEPTION 'entry_date is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF v_key = '' THEN
    RAISE EXCEPTION 'manual_key is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF NULLIF(btrim(COALESCE(p_memo, '')), '') IS NULL THEN
    RAISE EXCEPTION 'memo is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF jsonb_typeof(v_meta) <> 'object' THEN
    RAISE EXCEPTION 'source_metadata must be a JSON object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT *
    INTO v_entry
    FROM public.create_and_post_journal(
      p_organization_id,
      p_entry_date,
      'manual_journal',
      NULL,
      'manual:' || v_key || ':v1',
      p_lines,
      btrim(p_memo),
      v_meta || jsonb_build_object(
        'source_table', null,
        'manual_key', v_key,
        'reason', NULLIF(btrim(COALESCE(p_reason, '')), '')
      )
    );

  RETURN v_entry;
END;
$$;

COMMENT ON FUNCTION public.post_manual_journal(uuid, date, text, jsonb, text, text, jsonb) IS
  'Typed manual-journal posting wrapper over create_and_post_journal using '
  'idempotency key manual:<key>:v1. Requires a memo and delegates balanced-line, '
  'same-org active-account, period-lock, and org-access checks to the canonical RPC.';

REVOKE ALL ON FUNCTION public.post_manual_journal(uuid, date, text, jsonb, text, text, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_manual_journal(uuid, date, text, jsonb, text, text, jsonb)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Reversal posting.
--
-- Reverses a posted journal by swapping every debit/credit line into a new
-- immutable journal. It returns an existing reversal for the original entry
-- rather than allowing a second reversal under another key.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reverse_journal_entry(
  p_journal_entry_id uuid,
  p_reversal_date date DEFAULT CURRENT_DATE,
  p_reversal_key text DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS public.journal_entries
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_original public.journal_entries;
  v_existing public.journal_entries;
  v_entry    public.journal_entries;
  v_key      text;
  v_lines    jsonb;
BEGIN
  IF p_journal_entry_id IS NULL THEN
    RAISE EXCEPTION 'journal_entry_id is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_reversal_date IS NULL THEN
    RAISE EXCEPTION 'reversal_date is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  SELECT *
    INTO v_original
    FROM public.journal_entries
   WHERE id = p_journal_entry_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'journal entry % not found or not accessible', p_journal_entry_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_original.status <> 'posted'::public.journal_entry_status THEN
    RAISE EXCEPTION 'journal entry % must be posted before it can be reversed',
      p_journal_entry_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT *
    INTO v_existing
    FROM public.journal_entries je
   WHERE je.organization_id = v_original.organization_id
     AND je.source_type = 'journal_reversal'
     AND je.source_id = v_original.id
     AND je.status IN ('posted', 'void')
   ORDER BY je.created_at
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    RETURN v_existing;
  END IF;

  v_key := lower(btrim(COALESCE(p_reversal_key, v_original.id::text)));

  IF v_key = '' THEN
    RAISE EXCEPTION 'reversal_key is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'account_id', jl.account_id,
        'debit_cents', jl.credit_cents,
        'credit_cents', jl.debit_cents,
        'description', 'Reversal: ' || COALESCE(NULLIF(btrim(jl.description), ''), v_original.memo, v_original.id::text)
      )
      ORDER BY jl.id
    ),
    '[]'::jsonb
  )
    INTO v_lines
    FROM public.journal_lines jl
   WHERE jl.journal_entry_id = v_original.id;

  IF jsonb_array_length(v_lines) = 0 THEN
    RAISE EXCEPTION 'journal entry % has no lines to reverse', p_journal_entry_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT *
    INTO v_entry
    FROM public.create_and_post_journal(
      v_original.organization_id,
      p_reversal_date,
      'journal_reversal',
      v_original.id,
      'reversal:' || v_key || ':v1',
      v_lines,
      'Reversal of ' || COALESCE(v_original.memo, v_original.id::text),
      jsonb_build_object(
        'source_table', 'journal_entries',
        'original_journal_entry_id', v_original.id,
        'original_source_type', v_original.source_type,
        'original_source_id', v_original.source_id,
        'original_source_event_key', v_original.source_event_key,
        'reversal_key', v_key,
        'reason', NULLIF(btrim(COALESCE(p_reason, '')), '')
      )
    );

  RETURN v_entry;
END;
$$;

COMMENT ON FUNCTION public.reverse_journal_entry(uuid, date, text, text) IS
  'Posts a reversing journal for an existing posted journal by swapping every '
  'debit/credit line through create_and_post_journal. Uses source_type '
  'journal_reversal, source_id = original journal id, idempotency key '
  'reversal:<key>:v1, and returns any existing posted/void reversal for the '
  'original entry to prevent duplicate reversals.';

REVOKE ALL ON FUNCTION public.reverse_journal_entry(uuid, date, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_journal_entry(uuid, date, text, text)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. AR/AP credit-note posting surfaces.
--
-- P2-CN still owns document tables, UI, Xero sync, and source workflow. These
-- RPCs provide the canonical GL postings those later source rows can call.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_customer_credit_note_journal(
  p_organization_id uuid,
  p_credit_note_key text,
  p_credit_note_date date,
  p_subtotal_ex_gst_cents bigint,
  p_gst_cents bigint,
  p_invoice_id uuid DEFAULT NULL,
  p_revenue_account_code text DEFAULT '4000',
  p_reason text DEFAULT NULL
)
RETURNS public.journal_entries
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_invoice             public.invoices%ROWTYPE;
  v_entry               public.journal_entries;
  v_key                 text := lower(btrim(COALESCE(p_credit_note_key, '')));
  v_revenue_code        text := COALESCE(NULLIF(btrim(p_revenue_account_code), ''), '4000');
  v_total_cents         bigint;
  v_revenue_account_id  uuid;
  v_gst_account_id      uuid;
  v_ar_account_id       uuid;
  v_lines               jsonb := '[]'::jsonb;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF v_key = '' THEN
    RAISE EXCEPTION 'credit_note_key is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_credit_note_date IS NULL THEN
    RAISE EXCEPTION 'credit_note_date is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_subtotal_ex_gst_cents IS NULL OR p_gst_cents IS NULL
     OR p_subtotal_ex_gst_cents < 0 OR p_gst_cents < 0 THEN
    RAISE EXCEPTION 'credit note subtotal and GST must be non-negative'
      USING ERRCODE = 'check_violation';
  END IF;

  v_total_cents := p_subtotal_ex_gst_cents + p_gst_cents;

  IF v_total_cents <= 0 THEN
    RAISE EXCEPTION 'credit note total must be positive'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_invoice_id IS NOT NULL THEN
    SELECT *
      INTO v_invoice
      FROM public.invoices
     WHERE id = p_invoice_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'source invoice % not found or not accessible', p_invoice_id
        USING ERRCODE = 'no_data_found';
    END IF;

    IF v_invoice.organization_id <> p_organization_id THEN
      RAISE EXCEPTION 'credit note % invoice organization mismatch', v_key
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF v_invoice.deleted_at IS NOT NULL
       OR v_invoice.status IN ('draft'::public.invoice_status, 'void'::public.invoice_status) THEN
      RAISE EXCEPTION 'credit note % cannot post against draft, void, or deleted invoice',
        v_key
        USING ERRCODE = 'check_violation';
    END IF;

    PERFORM public.post_invoice_journal(v_invoice.id);
  END IF;

  SELECT coa.id
    INTO v_revenue_account_id
    FROM public.chart_of_accounts coa
   WHERE coa.organization_id = p_organization_id
     AND coa.code = v_revenue_code
     AND coa.account_type = 'income'::public.account_type
     AND coa.is_active = true
   LIMIT 1;

  IF v_revenue_account_id IS NULL THEN
    RAISE EXCEPTION 'customer credit note % cannot post: active income account % is missing',
      v_key,
      v_revenue_code
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT coa.id
    INTO v_ar_account_id
    FROM public.chart_of_accounts coa
   WHERE coa.organization_id = p_organization_id
     AND coa.code = '1100'
     AND coa.account_type = 'asset'::public.account_type
     AND coa.is_active = true
   LIMIT 1;

  IF v_ar_account_id IS NULL THEN
    RAISE EXCEPTION 'customer credit note % cannot post: active asset account 1100 is missing',
      v_key
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF p_subtotal_ex_gst_cents > 0 THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_revenue_account_id,
        'debit_cents', p_subtotal_ex_gst_cents,
        'credit_cents', 0,
        'description', 'Customer credit note revenue reversal'
      )
    );
  END IF;

  IF p_gst_cents > 0 THEN
    SELECT coa.id
      INTO v_gst_account_id
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

    IF v_gst_account_id IS NULL THEN
      SELECT coa.id
        INTO v_gst_account_id
        FROM public.chart_of_accounts coa
       WHERE coa.organization_id = p_organization_id
         AND coa.code = '2100'
         AND coa.account_type = 'liability'::public.account_type
         AND coa.is_active = true
       LIMIT 1;
    END IF;

    IF v_gst_account_id IS NULL THEN
      RAISE EXCEPTION
        'customer credit note % cannot post: gst_collected system account or active liability account 2100 is missing',
        v_key
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_gst_account_id,
        'debit_cents', p_gst_cents,
        'credit_cents', 0,
        'description', 'Customer credit note GST reversal'
      )
    );
  END IF;

  v_lines := v_lines || jsonb_build_array(
    jsonb_build_object(
      'account_id', v_ar_account_id,
      'debit_cents', 0,
      'credit_cents', v_total_cents,
      'description', 'Customer credit note accounts receivable'
    )
  );

  SELECT *
    INTO v_entry
    FROM public.create_and_post_journal(
      p_organization_id,
      p_credit_note_date,
      'customer_credit_note',
      p_invoice_id,
      'credit-note:' || v_key || ':v1',
      v_lines,
      'Customer credit note ' || v_key,
      jsonb_build_object(
        'source_table', 'customer_credit_notes',
        'credit_note_key', v_key,
        'invoice_id', p_invoice_id,
        'revenue_account_code', v_revenue_code,
        'subtotal_ex_gst_cents', p_subtotal_ex_gst_cents,
        'gst_cents', p_gst_cents,
        'total_inc_gst_cents', v_total_cents,
        'reason', NULLIF(btrim(COALESCE(p_reason, '')), '')
      )
    );

  RETURN v_entry;
END;
$$;

COMMENT ON FUNCTION public.post_customer_credit_note_journal(uuid, text, date, bigint, bigint, uuid, text, text) IS
  'Posts an AR/customer credit-note journal through create_and_post_journal using '
  'idempotency key credit-note:<key>:v1. Optionally validates and posts the source '
  'invoice first, then debits income and GST payable and credits AR 1100. The '
  'credit-note document table/UI remains owned by the P2-CN product slice.';

REVOKE ALL ON FUNCTION public.post_customer_credit_note_journal(
  uuid,
  text,
  date,
  bigint,
  bigint,
  uuid,
  text,
  text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_customer_credit_note_journal(
  uuid,
  text,
  date,
  bigint,
  bigint,
  uuid,
  text,
  text
) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.post_supplier_credit_note_journal(
  p_organization_id uuid,
  p_credit_note_key text,
  p_credit_note_date date,
  p_subtotal_ex_gst_cents bigint,
  p_gst_cents bigint,
  p_counter_account_code text,
  p_counter_account_type public.account_type,
  p_bill_id uuid DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS public.journal_entries
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_bill                public.bills%ROWTYPE;
  v_entry               public.journal_entries;
  v_key                 text := lower(btrim(COALESCE(p_credit_note_key, '')));
  v_counter_code        text := btrim(COALESCE(p_counter_account_code, ''));
  v_total_cents         bigint;
  v_counter_account_id  uuid;
  v_gst_account_id      uuid;
  v_ap_account_id       uuid;
  v_lines               jsonb := '[]'::jsonb;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF v_key = '' THEN
    RAISE EXCEPTION 'credit_note_key is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_credit_note_date IS NULL THEN
    RAISE EXCEPTION 'credit_note_date is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_subtotal_ex_gst_cents IS NULL OR p_gst_cents IS NULL
     OR p_subtotal_ex_gst_cents < 0 OR p_gst_cents < 0 THEN
    RAISE EXCEPTION 'supplier credit note subtotal and GST must be non-negative'
      USING ERRCODE = 'check_violation';
  END IF;

  v_total_cents := p_subtotal_ex_gst_cents + p_gst_cents;

  IF v_total_cents <= 0 THEN
    RAISE EXCEPTION 'supplier credit note total must be positive'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_counter_code = '' OR p_counter_account_type IS NULL THEN
    RAISE EXCEPTION 'counter account code and type are required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_bill_id IS NOT NULL THEN
    SELECT *
      INTO v_bill
      FROM public.bills
     WHERE id = p_bill_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'source bill % not found or not accessible', p_bill_id
        USING ERRCODE = 'no_data_found';
    END IF;

    IF v_bill.organization_id <> p_organization_id THEN
      RAISE EXCEPTION 'supplier credit note % bill organization mismatch', v_key
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF v_bill.deleted_at IS NOT NULL OR v_bill.status = 'void'::public.bill_status THEN
      RAISE EXCEPTION 'supplier credit note % cannot post against void or deleted bill',
        v_key
        USING ERRCODE = 'check_violation';
    END IF;
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
    RAISE EXCEPTION 'supplier credit note % cannot post: active % account % is missing',
      v_key,
      p_counter_account_type,
      v_counter_code
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT coa.id
    INTO v_ap_account_id
    FROM public.chart_of_accounts coa
   WHERE coa.organization_id = p_organization_id
     AND coa.code = '2000'
     AND coa.account_type = 'liability'::public.account_type
     AND coa.is_active = true
   LIMIT 1;

  IF v_ap_account_id IS NULL THEN
    RAISE EXCEPTION 'supplier credit note % cannot post: active liability account 2000 is missing',
      v_key
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  v_lines := v_lines || jsonb_build_array(
    jsonb_build_object(
      'account_id', v_ap_account_id,
      'debit_cents', v_total_cents,
      'credit_cents', 0,
      'description', 'Supplier credit note accounts payable'
    )
  );

  IF p_subtotal_ex_gst_cents > 0 THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_counter_account_id,
        'debit_cents', 0,
        'credit_cents', p_subtotal_ex_gst_cents,
        'description', 'Supplier credit note purchase reversal'
      )
    );
  END IF;

  IF p_gst_cents > 0 THEN
    SELECT coa.id
      INTO v_gst_account_id
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

    IF v_gst_account_id IS NULL THEN
      SELECT coa.id
        INTO v_gst_account_id
        FROM public.chart_of_accounts coa
       WHERE coa.organization_id = p_organization_id
         AND coa.code = '1200'
         AND coa.account_type = 'asset'::public.account_type
         AND coa.is_active = true
       LIMIT 1;
    END IF;

    IF v_gst_account_id IS NULL THEN
      RAISE EXCEPTION
        'supplier credit note % cannot post: gst_paid system account or active asset account 1200 is missing',
        v_key
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_gst_account_id,
        'debit_cents', 0,
        'credit_cents', p_gst_cents,
        'description', 'Supplier credit note GST credit reversal'
      )
    );
  END IF;

  SELECT *
    INTO v_entry
    FROM public.create_and_post_journal(
      p_organization_id,
      p_credit_note_date,
      'supplier_credit_note',
      p_bill_id,
      'credit-note:' || v_key || ':v1',
      v_lines,
      'Supplier credit note ' || v_key,
      jsonb_build_object(
        'source_table', 'supplier_credit_notes',
        'credit_note_key', v_key,
        'bill_id', p_bill_id,
        'counter_account_code', v_counter_code,
        'counter_account_type', p_counter_account_type,
        'subtotal_ex_gst_cents', p_subtotal_ex_gst_cents,
        'gst_cents', p_gst_cents,
        'total_inc_gst_cents', v_total_cents,
        'reason', NULLIF(btrim(COALESCE(p_reason, '')), '')
      )
    );

  RETURN v_entry;
END;
$$;

COMMENT ON FUNCTION public.post_supplier_credit_note_journal(uuid, text, date, bigint, bigint, text, public.account_type, uuid, text) IS
  'Posts an AP/supplier credit-note journal through create_and_post_journal using '
  'idempotency key credit-note:<key>:v1. Optionally validates the source bill, '
  'then debits AP 2000 and credits an explicit purchase/counter account plus GST '
  'input-credit control. The credit-note document table/UI remains owned by the '
  'P2-CN product slice.';

REVOKE ALL ON FUNCTION public.post_supplier_credit_note_journal(
  uuid,
  text,
  date,
  bigint,
  bigint,
  text,
  public.account_type,
  uuid,
  text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_supplier_credit_note_journal(
  uuid,
  text,
  date,
  bigint,
  bigint,
  text,
  public.account_type,
  uuid,
  text
) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
