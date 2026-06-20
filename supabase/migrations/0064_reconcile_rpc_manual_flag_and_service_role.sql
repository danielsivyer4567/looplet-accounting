-- 0064: Let reconcile_match_bill / reconcile_match_invoice record auto-matches.
--
-- EPIC C2 (auto-reconciler). The auto-reconcile edge function calls these
-- existing atomic RPCs for unambiguous candidates, but needs two things the
-- 0043 versions don't provide:
--
--   1. A `p_manually_matched` flag so auto-applied matches are stamped
--      manually_matched = false (the 0043 RPCs hard-coded `true`, which is
--      correct for the human-driven Reconciliation page but wrong for the bot).
--      Defaulting to true keeps every existing caller (Reconciliation.tsx,
--      xero flows) behaving exactly as before — they pass no new argument.
--
--   2. A service-role / cron escape hatch on the org-access gate. The gate
--      checks `org IN (SELECT get_accessible_org_ids())`, which returns the
--      empty set when auth.uid() IS NULL (i.e. when the call arrives over a
--      service-role JWT from the cron worker). We additionally accept
--      auth.role() = 'service_role' so the trusted backend can apply matches
--      it has already org-scoped itself. User-JWT callers are unchanged: they
--      still must own the org.
--
-- IMPORTANT: appending a DEFAULTed parameter to a SECURITY DEFINER function does
-- NOT replace the 0043 function — it creates an OVERLOAD. The old 3-/4-arg
-- versions (hard-coded manually_matched = true, no service_role bypass) would
-- linger, and an all-defaults call would fail with "function is not unique".
-- We therefore DROP the exact 0043 signatures first, then CREATE the new ones.
-- reconcile_match_bill also gains an amount-tolerance guard (see below).

DROP FUNCTION IF EXISTS public.reconcile_match_bill(uuid, uuid, numeric);
DROP FUNCTION IF EXISTS public.reconcile_match_invoice(uuid, uuid, bigint, numeric);

CREATE OR REPLACE FUNCTION public.reconcile_match_bill(
  p_bank_transaction_id uuid,
  p_bill_id uuid,
  p_match_confidence numeric DEFAULT 1.0,
  p_manually_matched boolean DEFAULT true
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org_txn uuid;
  v_org_bill uuid;
  v_txn_amount_cents bigint;
  v_bill_amount_cents bigint;
  v_is_service boolean := (auth.role() = 'service_role');
  -- $0.50 tolerance — same window the candidate views use to emit a match.
  c_tolerance_cents constant bigint := 50;
BEGIN
  SELECT organization_id, amount_cents INTO v_org_txn, v_txn_amount_cents
    FROM bank_transactions WHERE id = p_bank_transaction_id;
  SELECT organization_id, total_inc_gst_cents INTO v_org_bill, v_bill_amount_cents
    FROM bills WHERE id = p_bill_id;

  IF v_org_txn IS NULL OR v_org_bill IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'transaction or bill not found');
  END IF;
  IF v_org_txn != v_org_bill THEN
    RETURN jsonb_build_object('ok', false, 'error', 'org mismatch');
  END IF;
  IF NOT v_is_service AND v_org_txn NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  -- Amount guard: never mark a bill paid unless the bank outflow matches the
  -- bill total within tolerance. Bank debits are stored negative, so compare on
  -- absolute value. (Applies to every caller, human and bot.)
  IF v_bill_amount_cents IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bill has no amount');
  END IF;
  IF abs(abs(v_txn_amount_cents) - v_bill_amount_cents) > c_tolerance_cents THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'amount mismatch',
      'txn_amount_cents', v_txn_amount_cents,
      'bill_amount_cents', v_bill_amount_cents
    );
  END IF;

  UPDATE bank_transactions
    SET matched_bill_id = p_bill_id,
        manually_matched = p_manually_matched,
        match_confidence = p_match_confidence
    WHERE id = p_bank_transaction_id;
  UPDATE bills
    SET paid_at = COALESCE(paid_at, now()),
        status = 'paid'
    WHERE id = p_bill_id;

  RETURN jsonb_build_object('ok', true);
END $$;

CREATE OR REPLACE FUNCTION public.reconcile_match_invoice(
  p_bank_transaction_id uuid,
  p_invoice_id uuid,
  p_amount_cents bigint,
  p_match_confidence numeric DEFAULT 1.0,
  p_manually_matched boolean DEFAULT true
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org_txn uuid;
  v_org_inv uuid;
  v_is_service boolean := (auth.role() = 'service_role');
BEGIN
  SELECT organization_id INTO v_org_txn FROM bank_transactions WHERE id = p_bank_transaction_id;
  SELECT organization_id INTO v_org_inv FROM invoices WHERE id = p_invoice_id;

  IF v_org_txn IS NULL OR v_org_inv IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'transaction or invoice not found');
  END IF;
  IF v_org_txn != v_org_inv THEN
    RETURN jsonb_build_object('ok', false, 'error', 'org mismatch');
  END IF;
  IF NOT v_is_service AND v_org_txn NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_amount_cents <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'amount must be positive');
  END IF;

  UPDATE bank_transactions
    SET matched_invoice_id = p_invoice_id,
        manually_matched = p_manually_matched,
        match_confidence = p_match_confidence
    WHERE id = p_bank_transaction_id;

  INSERT INTO invoice_payments (
    organization_id, invoice_id, bank_transaction_id, amount_cents, method, notes
  ) VALUES (
    v_org_txn, p_invoice_id, p_bank_transaction_id, p_amount_cents, 'bank',
    CASE WHEN p_manually_matched
         THEN 'Auto-matched from bank reconciliation'
         ELSE 'Auto-reconciled (autopilot)'
    END
  );

  RETURN jsonb_build_object('ok', true);
END $$;

-- service_role already bypasses GRANTs, but keep the authenticated grants so the
-- user-driven Reconciliation page continues to call the new signatures.
GRANT EXECUTE ON FUNCTION public.reconcile_match_bill(uuid, uuid, numeric, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_match_invoice(uuid, uuid, bigint, numeric, boolean) TO authenticated;
