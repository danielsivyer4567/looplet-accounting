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
