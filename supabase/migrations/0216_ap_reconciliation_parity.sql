-- ============================================================================
-- 0216_ap_reconciliation_parity.sql  (P1-10)
--
-- Bring AP/bill reconciliation up to the AR hardening standard from 0196.
--
-- Gaps closed:
--   * v_bank_match_candidates emitted paid/void/personal/non-bill rows.
--   * reconcile_match_bill did not reject already-matched transactions.
--   * reconcile_match_bill did not reject bank inflows, personal bank rows,
--     paid/void/deleted bills, personal bills, non-probable bills, null amounts,
--     or bad confidence values.
--   * reconcile_undo_match blindly reset a matched bill to attached, even if the
--     bill had since been voided/deleted.
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW public.v_bank_match_candidates
WITH (security_invoker = on) AS
SELECT
  bt.id                       AS bank_transaction_id,
  bt.organization_id,
  bt.posted_at::date          AS bt_date,
  bt.amount_cents             AS bt_amount_cents,
  bt.description              AS bt_description,
  b.id                        AS bill_id,
  b.invoice_date              AS bill_date,
  b.total_inc_gst_cents       AS bill_amount_cents,
  b.invoice_number            AS bill_invoice_number,
  s.id                        AS supplier_id,
  s.name                      AS supplier_name,
  abs(bt.amount_cents) - b.total_inc_gst_cents AS amount_diff_cents,
  abs(bt.posted_at::date - b.invoice_date)     AS days_diff,
  CASE
    WHEN abs(abs(bt.amount_cents) - b.total_inc_gst_cents) <= 50
     AND abs(bt.posted_at::date - b.invoice_date) <= 14
    THEN
      0.5
      + 0.5 * GREATEST(0::numeric, 1::numeric - abs(bt.posted_at::date - b.invoice_date)::numeric / 14.0)
      + CASE WHEN s.name IS NOT NULL
              AND lower(bt.description) LIKE '%' || lower(s.name) || '%'
             THEN 0.2 ELSE 0::numeric END
    ELSE 0::numeric
  END AS score
FROM public.bank_transactions bt
JOIN public.bills b
  ON b.organization_id = bt.organization_id
 AND b.deleted_at IS NULL
 AND b.status NOT IN ('paid'::public.bill_status, 'void'::public.bill_status)
 AND b.is_personal IS NOT TRUE
 AND b.is_probable_bill = true
 AND b.total_inc_gst_cents IS NOT NULL
 AND b.invoice_date IS NOT NULL
LEFT JOIN public.suppliers s ON s.id = b.supplier_id
WHERE bt.matched_bill_id IS NULL
  AND bt.matched_invoice_id IS NULL
  AND bt.amount_cents < 0
  AND bt.is_personal IS NOT TRUE
  AND abs(abs(bt.amount_cents) - b.total_inc_gst_cents) <= 50
  AND abs(bt.posted_at::date - b.invoice_date) <= 14;

COMMENT ON VIEW public.v_bank_match_candidates IS
  'AP bank-to-bill match candidates. Security invoker; emits only unmatched '
  'business outflows against outstanding probable business bills within $0.50 '
  'and 14 days.';

CREATE OR REPLACE FUNCTION public.reconcile_match_bill(
  p_bank_transaction_id uuid,
  p_bill_id uuid,
  p_match_confidence numeric DEFAULT 1.0,
  p_manually_matched boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_txn uuid;
  v_org_bill uuid;
  v_txn_amount_cents bigint;
  v_matched_bill uuid;
  v_matched_invoice uuid;
  v_txn_is_personal boolean;
  v_bill_amount_cents bigint;
  v_bill_status public.bill_status;
  v_bill_paid_at timestamptz;
  v_bill_deleted_at timestamptz;
  v_bill_is_personal boolean;
  v_bill_is_probable boolean;
  v_is_service boolean := (auth.role() = 'service_role');
  c_tolerance_cents constant bigint := 50;
BEGIN
  SELECT organization_id, amount_cents, matched_bill_id, matched_invoice_id, is_personal
    INTO v_org_txn, v_txn_amount_cents, v_matched_bill, v_matched_invoice, v_txn_is_personal
  FROM public.bank_transactions
  WHERE id = p_bank_transaction_id
  FOR UPDATE;

  SELECT organization_id, total_inc_gst_cents, status, paid_at, deleted_at, is_personal, is_probable_bill
    INTO v_org_bill, v_bill_amount_cents, v_bill_status, v_bill_paid_at, v_bill_deleted_at,
         v_bill_is_personal, v_bill_is_probable
  FROM public.bills
  WHERE id = p_bill_id
  FOR UPDATE;

  IF v_org_txn IS NULL OR v_org_bill IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'transaction or bill not found');
  END IF;
  IF v_org_txn <> v_org_bill THEN
    RETURN jsonb_build_object('ok', false, 'error', 'org mismatch');
  END IF;
  IF NOT v_is_service AND v_org_txn NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF v_matched_bill IS NOT NULL OR v_matched_invoice IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'transaction already matched');
  END IF;
  IF v_txn_amount_cents >= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bank transaction must be an outflow');
  END IF;
  IF v_txn_is_personal IS TRUE THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bank transaction is personal');
  END IF;
  IF v_bill_deleted_at IS NOT NULL OR v_bill_status = 'void'::public.bill_status THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bill is void or deleted');
  END IF;
  IF v_bill_status = 'paid'::public.bill_status OR v_bill_paid_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bill is already paid');
  END IF;
  IF v_bill_is_personal IS TRUE THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bill is personal');
  END IF;
  IF v_bill_is_probable IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bill is not a probable bill');
  END IF;
  IF v_bill_amount_cents IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bill has no amount');
  END IF;
  IF p_match_confidence IS NULL OR p_match_confidence < 0 OR p_match_confidence > 1 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'match confidence out of range');
  END IF;
  IF abs(abs(v_txn_amount_cents) - v_bill_amount_cents) > c_tolerance_cents THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'amount mismatch',
      'txn_amount_cents', v_txn_amount_cents,
      'bill_amount_cents', v_bill_amount_cents
    );
  END IF;

  UPDATE public.bank_transactions
     SET matched_bill_id = p_bill_id,
         matched_invoice_id = NULL,
         manually_matched = p_manually_matched,
         match_confidence = p_match_confidence
   WHERE id = p_bank_transaction_id;

  UPDATE public.bills
     SET paid_at = COALESCE(paid_at, now()),
         status = 'paid'::public.bill_status,
         updated_at = now()
   WHERE id = p_bill_id;

  RETURN jsonb_build_object('ok', true);
END
$$;

COMMENT ON FUNCTION public.reconcile_match_bill(uuid, uuid, numeric, boolean) IS
  'Atomically reconciles a bank outflow to an outstanding business bill. Rejects '
  'cross-org rows, already-matched transactions, inflows/personal transactions, '
  'paid/void/deleted/personal/non-probable bills, null amounts, bad confidence, '
  'and amount mismatches outside the $0.50 candidate tolerance.';

REVOKE ALL ON FUNCTION public.reconcile_match_bill(uuid, uuid, numeric, boolean)
FROM public, anon;
GRANT EXECUTE ON FUNCTION public.reconcile_match_bill(uuid, uuid, numeric, boolean)
TO authenticated;

CREATE OR REPLACE FUNCTION public.reconcile_undo_match(p_bank_transaction_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org uuid;
  v_bill uuid;
  v_invoice uuid;
  v_is_service boolean := (auth.role() = 'service_role');
BEGIN
  SELECT organization_id, matched_bill_id, matched_invoice_id
    INTO v_org, v_bill, v_invoice
  FROM public.bank_transactions
  WHERE id = p_bank_transaction_id
  FOR UPDATE;

  IF v_org IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'transaction not found');
  END IF;
  IF NOT v_is_service AND v_org NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF v_bill IS NULL AND v_invoice IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'transaction is not matched');
  END IF;

  UPDATE public.bank_transactions
     SET matched_bill_id = NULL,
         matched_invoice_id = NULL,
         manually_matched = false,
         match_confidence = NULL
   WHERE id = p_bank_transaction_id;

  IF v_bill IS NOT NULL THEN
    UPDATE public.bills
       SET paid_at = NULL,
           status = CASE
             WHEN status = 'paid'::public.bill_status THEN 'attached'::public.bill_status
             ELSE status
           END,
           updated_at = now()
     WHERE id = v_bill
       AND deleted_at IS NULL
       AND status <> 'void'::public.bill_status;
  END IF;

  IF v_invoice IS NOT NULL THEN
    DELETE FROM public.invoice_payments
     WHERE bank_transaction_id = p_bank_transaction_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'bill_id', v_bill, 'invoice_id', v_invoice);
END
$$;

COMMENT ON FUNCTION public.reconcile_undo_match(uuid) IS
  'Clears a bank reconciliation match atomically. Bill undo only reopens live '
  'paid bills; void/deleted bills are not forced back to attached.';

REVOKE ALL ON FUNCTION public.reconcile_undo_match(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.reconcile_undo_match(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
