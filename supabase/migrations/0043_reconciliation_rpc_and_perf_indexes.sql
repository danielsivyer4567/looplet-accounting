-- 0043: Reconciliation atomicity RPCs + perf indexes from sql-pro review.
--
-- Problem: matchToBill / matchToInvoice / undoMatch were two sequential
-- supabase calls in the React Reconciliation page. A connection drop between
-- the bank_transactions UPDATE and the bills UPDATE left half-applied state.
-- Fix: wrap both in a SECURITY DEFINER RPC that runs in a single tx.

CREATE OR REPLACE FUNCTION public.reconcile_match_bill(
  p_bank_transaction_id uuid,
  p_bill_id uuid,
  p_match_confidence numeric DEFAULT 1.0
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org_txn uuid;
  v_org_bill uuid;
BEGIN
  SELECT organization_id INTO v_org_txn FROM bank_transactions WHERE id = p_bank_transaction_id;
  SELECT organization_id INTO v_org_bill FROM bills WHERE id = p_bill_id;

  IF v_org_txn IS NULL OR v_org_bill IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'transaction or bill not found');
  END IF;
  IF v_org_txn != v_org_bill THEN
    RETURN jsonb_build_object('ok', false, 'error', 'org mismatch');
  END IF;
  IF v_org_txn NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  UPDATE bank_transactions
    SET matched_bill_id = p_bill_id,
        manually_matched = true,
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
  p_match_confidence numeric DEFAULT 1.0
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org_txn uuid;
  v_org_inv uuid;
BEGIN
  SELECT organization_id INTO v_org_txn FROM bank_transactions WHERE id = p_bank_transaction_id;
  SELECT organization_id INTO v_org_inv FROM invoices WHERE id = p_invoice_id;

  IF v_org_txn IS NULL OR v_org_inv IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'transaction or invoice not found');
  END IF;
  IF v_org_txn != v_org_inv THEN
    RETURN jsonb_build_object('ok', false, 'error', 'org mismatch');
  END IF;
  IF v_org_txn NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_amount_cents <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'amount must be positive');
  END IF;

  UPDATE bank_transactions
    SET matched_invoice_id = p_invoice_id,
        manually_matched = true,
        match_confidence = p_match_confidence
    WHERE id = p_bank_transaction_id;

  INSERT INTO invoice_payments (
    organization_id, invoice_id, bank_transaction_id, amount_cents, method, notes
  ) VALUES (
    v_org_txn, p_invoice_id, p_bank_transaction_id, p_amount_cents, 'bank',
    'Auto-matched from bank reconciliation'
  );

  RETURN jsonb_build_object('ok', true);
END $$;

CREATE OR REPLACE FUNCTION public.reconcile_undo_match(p_bank_transaction_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org uuid;
  v_bill uuid;
  v_invoice uuid;
BEGIN
  SELECT organization_id, matched_bill_id, matched_invoice_id
    INTO v_org, v_bill, v_invoice
    FROM bank_transactions WHERE id = p_bank_transaction_id;

  IF v_org IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'transaction not found');
  END IF;
  IF v_org NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;

  UPDATE bank_transactions
    SET matched_bill_id = NULL,
        matched_invoice_id = NULL,
        manually_matched = false,
        match_confidence = NULL
    WHERE id = p_bank_transaction_id;

  IF v_bill IS NOT NULL THEN
    UPDATE bills SET paid_at = NULL, status = 'attached' WHERE id = v_bill;
  END IF;
  IF v_invoice IS NOT NULL THEN
    DELETE FROM invoice_payments WHERE bank_transaction_id = p_bank_transaction_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'bill_id', v_bill, 'invoice_id', v_invoice);
END $$;

GRANT EXECUTE ON FUNCTION public.reconcile_match_bill TO authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_match_invoice TO authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_undo_match TO authenticated;

-- Perf indexes from sql-pro review
CREATE INDEX IF NOT EXISTS bank_txns_unmatched_debit_idx
  ON public.bank_transactions (organization_id, posted_at DESC, amount_cents)
  WHERE matched_bill_id IS NULL AND matched_invoice_id IS NULL;

CREATE INDEX IF NOT EXISTS invoices_unsettled_idx
  ON public.invoices (organization_id, due_date)
  WHERE deleted_at IS NULL AND status NOT IN ('paid', 'void') AND balance_due_cents > 0;

CREATE INDEX IF NOT EXISTS bills_unpaid_idx
  ON public.bills (organization_id, invoice_date)
  WHERE deleted_at IS NULL AND status NOT IN ('paid', 'void') AND total_inc_gst_cents IS NOT NULL;

CREATE INDEX IF NOT EXISTS bills_business_dated_idx
  ON public.bills (organization_id, invoice_date)
  WHERE deleted_at IS NULL AND is_personal = false AND invoice_date IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS system_defaults_key_idx ON public.system_defaults (key);
