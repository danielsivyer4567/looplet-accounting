-- 0196: Harden invoice-side reconciliation and codify AR trigger/view drift.
--
-- Completion audit follow-up:
--   - The Reconciliation UI now does set matched_invoice_id, but the RPC could
--     still be called directly with an arbitrary positive payment amount.
--   - Production has the invoice total/payment triggers and AR candidate view
--     options that 0030/0035 did not fully preserve in source control.
--   - Broad client grants on AR tables included anon/TRIGGER/TRUNCATE access;
--     keep app CRUD for authenticated users and remove unnecessary privileges.

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Least-privilege AR table grants.
-- ----------------------------------------------------------------------------
REVOKE ALL ON TABLE
  public.invoices,
  public.invoice_line_items,
  public.invoice_payments,
  public.invoice_number_counters
FROM public, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.invoices,
  public.invoice_line_items,
  public.invoice_payments
TO authenticated;

GRANT ALL ON TABLE
  public.invoices,
  public.invoice_line_items,
  public.invoice_payments,
  public.invoice_number_counters
TO service_role;

-- Recreate source-controlled org-isolation policies as authenticated-only.
-- The older live dashboard-authored policies are left in place; these are the
-- fresh-rebuild safety net owned by migrations.
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'invoices', 'invoice_line_items', 'invoice_payments', 'invoice_number_counters'
  ])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_org_isolation_select ON public.%I;', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_org_isolation_insert ON public.%I;', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_org_isolation_update ON public.%I;', t, t);
    EXECUTE format('DROP POLICY IF EXISTS %I_org_isolation_delete ON public.%I;', t, t);

    EXECUTE format(
      'CREATE POLICY %I_org_isolation_select ON public.%I
         FOR SELECT TO authenticated
         USING (organization_id IN (SELECT public.get_accessible_org_ids()));', t, t);
    EXECUTE format(
      'CREATE POLICY %I_org_isolation_insert ON public.%I
         FOR INSERT TO authenticated
         WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));', t, t);
    EXECUTE format(
      'CREATE POLICY %I_org_isolation_update ON public.%I
         FOR UPDATE TO authenticated
         USING (organization_id IN (SELECT public.get_accessible_org_ids()))
         WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));', t, t);
    EXECUTE format(
      'CREATE POLICY %I_org_isolation_delete ON public.%I
         FOR DELETE TO authenticated
         USING (organization_id IN (SELECT public.get_accessible_org_ids()));', t, t);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 2. Codify invoice automation that existed live but was not fully represented
--    in source-control migrations.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.invoices_assign_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  next_n integer;
BEGIN
  IF NEW.invoice_number IS NOT NULL AND length(trim(NEW.invoice_number)) > 0 THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.invoice_number_counters (organization_id, next_number)
    VALUES (NEW.organization_id, 1)
  ON CONFLICT (organization_id) DO NOTHING;

  UPDATE public.invoice_number_counters
     SET next_number = next_number + 1
   WHERE organization_id = NEW.organization_id
   RETURNING next_number - 1 INTO next_n;

  NEW.invoice_number := 'INV-' || lpad(next_n::text, 4, '0');
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.invoices_recompute_totals()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inv_id uuid;
  sub bigint;
  gst bigint;
  total bigint;
BEGIN
  inv_id := COALESCE(NEW.invoice_id, OLD.invoice_id);

  SELECT
    COALESCE(SUM(line_total_ex_gst_cents), 0),
    COALESCE(SUM(line_gst_cents), 0),
    COALESCE(SUM(line_total_inc_gst_cents), 0)
  INTO sub, gst, total
  FROM public.invoice_line_items
  WHERE invoice_id = inv_id;

  UPDATE public.invoices
     SET subtotal_ex_gst_cents = sub,
         gst_cents = gst,
         total_inc_gst_cents = total,
         balance_due_cents = GREATEST(total - amount_paid_cents, 0),
         updated_at = now()
   WHERE id = inv_id;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.invoices_apply_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inv_id uuid;
  total_paid bigint;
  inv_total bigint;
BEGIN
  inv_id := COALESCE(NEW.invoice_id, OLD.invoice_id);

  SELECT COALESCE(SUM(amount_cents), 0)
    INTO total_paid
  FROM public.invoice_payments
  WHERE invoice_id = inv_id;

  SELECT total_inc_gst_cents
    INTO inv_total
  FROM public.invoices
  WHERE id = inv_id;

  UPDATE public.invoices
     SET amount_paid_cents = total_paid,
         balance_due_cents = GREATEST(inv_total - total_paid, 0),
         paid_at = CASE WHEN inv_total > 0 AND total_paid >= inv_total THEN now() ELSE NULL END,
         status = CASE
           WHEN inv_total > 0 AND total_paid >= inv_total THEN 'paid'::public.invoice_status
           WHEN total_paid > 0 THEN 'partially_paid'::public.invoice_status
           WHEN status IN ('partially_paid', 'paid') THEN 'sent'::public.invoice_status
           ELSE status
         END,
         updated_at = now()
   WHERE id = inv_id;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_invoices_assign_number ON public.invoices;
CREATE TRIGGER trg_invoices_assign_number
  BEFORE INSERT ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.invoices_assign_number();

DROP TRIGGER IF EXISTS trg_invoices_recompute_totals_ins ON public.invoice_line_items;
CREATE TRIGGER trg_invoices_recompute_totals_ins
  AFTER INSERT OR UPDATE OR DELETE ON public.invoice_line_items
  FOR EACH ROW EXECUTE FUNCTION public.invoices_recompute_totals();

DROP TRIGGER IF EXISTS trg_invoices_apply_payment ON public.invoice_payments;
CREATE TRIGGER trg_invoices_apply_payment
  AFTER INSERT OR UPDATE OR DELETE ON public.invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.invoices_apply_payment();

-- ----------------------------------------------------------------------------
-- 3. Payment validator shared by manual invoice payment recording and bank
--    reconciliation. It serializes on the invoice row, rejects cross-org links,
--    and prevents overpayments before the AFTER trigger recalculates totals.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.invoice_payments_validate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice_org uuid;
  v_invoice_total bigint;
  v_invoice_status public.invoice_status;
  v_invoice_deleted_at timestamptz;
  v_existing_paid bigint;
  v_remaining_cents bigint;
  v_bank_org uuid;
  v_bank_amount bigint;
BEGIN
  SELECT organization_id, total_inc_gst_cents, status, deleted_at
    INTO v_invoice_org, v_invoice_total, v_invoice_status, v_invoice_deleted_at
  FROM public.invoices
  WHERE id = NEW.invoice_id
  FOR UPDATE;

  IF v_invoice_org IS NULL THEN
    RAISE EXCEPTION 'invoice payment references missing invoice';
  END IF;
  IF NEW.organization_id <> v_invoice_org THEN
    RAISE EXCEPTION 'invoice payment organization mismatch';
  END IF;
  IF v_invoice_deleted_at IS NOT NULL OR v_invoice_status = 'void'::public.invoice_status THEN
    RAISE EXCEPTION 'cannot record payment against a void or deleted invoice';
  END IF;

  SELECT COALESCE(SUM(amount_cents), 0)
    INTO v_existing_paid
  FROM public.invoice_payments
  WHERE invoice_id = NEW.invoice_id
    AND (NEW.id IS NULL OR id <> NEW.id);

  v_remaining_cents := v_invoice_total - v_existing_paid;

  IF NEW.bank_transaction_id IS NOT NULL THEN
    SELECT organization_id, amount_cents
      INTO v_bank_org, v_bank_amount
    FROM public.bank_transactions
    WHERE id = NEW.bank_transaction_id;

    IF v_bank_org IS NULL THEN
      RAISE EXCEPTION 'invoice payment references missing bank transaction';
    END IF;
    IF v_bank_org <> NEW.organization_id THEN
      RAISE EXCEPTION 'invoice payment bank transaction organization mismatch';
    END IF;
    IF v_bank_amount <= 0 THEN
      RAISE EXCEPTION 'invoice payment bank transaction must be an inflow';
    END IF;
    IF NEW.amount_cents <> LEAST(v_bank_amount, v_remaining_cents) THEN
      RAISE EXCEPTION 'invoice payment amount must equal the bank settlement amount';
    END IF;
  END IF;

  IF v_existing_paid + NEW.amount_cents > v_invoice_total THEN
    RAISE EXCEPTION 'invoice payment exceeds invoice balance';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_invoice_payments_validate ON public.invoice_payments;
CREATE TRIGGER trg_invoice_payments_validate
  BEFORE INSERT OR UPDATE ON public.invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.invoice_payments_validate();

-- ----------------------------------------------------------------------------
-- 4. Recreate the AR bank match view with production's RLS-safe option and
--    due-date scoring, then harden the invoice reconciliation RPC contract.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_bank_invoice_match_candidates
WITH (security_invoker = on) AS
SELECT
  bt.id                       AS bank_transaction_id,
  bt.organization_id,
  bt.posted_at::date          AS bt_date,
  bt.amount_cents             AS bt_amount_cents,
  bt.description              AS bt_description,
  i.id                        AS invoice_id,
  i.invoice_number,
  i.issue_date                AS invoice_date,
  i.due_date,
  i.balance_due_cents         AS invoice_balance_due_cents,
  c.id                        AS customer_id,
  c.name                      AS customer_name,
  abs(bt.amount_cents - i.balance_due_cents) AS amount_diff_cents,
  abs(bt.posted_at::date - i.due_date)       AS days_diff,
  CASE
    WHEN abs(bt.amount_cents - i.balance_due_cents) <= 50
     AND abs(bt.posted_at::date - i.due_date) <= 60
    THEN
      0.5
      + 0.5 * GREATEST(0::numeric, 1::numeric - abs(bt.posted_at::date - i.due_date)::numeric / 60.0)
      + CASE WHEN c.name IS NOT NULL
              AND lower(bt.description) LIKE '%' || lower(c.name) || '%'
             THEN 0.2 ELSE 0::numeric END
      + CASE WHEN i.invoice_number IS NOT NULL
              AND lower(bt.description) LIKE '%' || lower(i.invoice_number) || '%'
             THEN 0.3 ELSE 0::numeric END
    ELSE 0::numeric
  END AS score
FROM public.bank_transactions bt
JOIN public.invoices i
  ON i.organization_id = bt.organization_id
 AND i.deleted_at IS NULL
 AND i.status NOT IN ('paid', 'void')
 AND i.balance_due_cents > 0
LEFT JOIN public.customers c ON c.id = i.customer_id
WHERE bt.matched_bill_id IS NULL
  AND bt.matched_invoice_id IS NULL
  AND bt.amount_cents > 0
  AND abs(bt.amount_cents - i.balance_due_cents) <= 50
  AND abs(bt.posted_at::date - i.due_date) <= 60;

CREATE OR REPLACE FUNCTION public.reconcile_match_invoice(
  p_bank_transaction_id uuid,
  p_invoice_id uuid,
  p_amount_cents bigint,
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
  v_org_inv uuid;
  v_txn_amount_cents bigint;
  v_matched_bill uuid;
  v_matched_invoice uuid;
  v_invoice_balance_due_cents bigint;
  v_invoice_status public.invoice_status;
  v_invoice_deleted_at timestamptz;
  v_expected_settlement_cents bigint;
  v_is_service boolean := (auth.role() = 'service_role');
BEGIN
  SELECT organization_id, amount_cents, matched_bill_id, matched_invoice_id
    INTO v_org_txn, v_txn_amount_cents, v_matched_bill, v_matched_invoice
  FROM public.bank_transactions
  WHERE id = p_bank_transaction_id;

  SELECT organization_id, balance_due_cents, status, deleted_at
    INTO v_org_inv, v_invoice_balance_due_cents, v_invoice_status, v_invoice_deleted_at
  FROM public.invoices
  WHERE id = p_invoice_id;

  IF v_org_txn IS NULL OR v_org_inv IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'transaction or invoice not found');
  END IF;
  IF v_org_txn <> v_org_inv THEN
    RETURN jsonb_build_object('ok', false, 'error', 'org mismatch');
  END IF;
  IF NOT v_is_service AND v_org_txn NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF v_matched_bill IS NOT NULL OR v_matched_invoice IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'transaction already matched');
  END IF;
  IF v_txn_amount_cents <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bank transaction must be an inflow');
  END IF;
  IF v_invoice_deleted_at IS NOT NULL OR v_invoice_status = 'void'::public.invoice_status THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invoice is void or deleted');
  END IF;
  IF v_invoice_status = 'paid'::public.invoice_status OR v_invoice_balance_due_cents <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invoice is already paid');
  END IF;

  v_expected_settlement_cents := LEAST(v_txn_amount_cents, v_invoice_balance_due_cents);
  IF p_amount_cents <> v_expected_settlement_cents THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'amount mismatch',
      'expected_amount_cents', v_expected_settlement_cents,
      'provided_amount_cents', p_amount_cents
    );
  END IF;

  UPDATE public.bank_transactions
     SET matched_invoice_id = p_invoice_id,
         manually_matched = p_manually_matched,
         match_confidence = p_match_confidence
   WHERE id = p_bank_transaction_id;

  INSERT INTO public.invoice_payments (
    organization_id, invoice_id, bank_transaction_id, amount_cents, method, notes
  ) VALUES (
    v_org_txn, p_invoice_id, p_bank_transaction_id, p_amount_cents, 'bank',
    CASE WHEN p_manually_matched
         THEN 'Matched from bank reconciliation'
         ELSE 'Auto-reconciled (autopilot)'
    END
  );

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_match_invoice(uuid, uuid, bigint, numeric, boolean)
FROM public, anon;
GRANT EXECUTE ON FUNCTION public.reconcile_match_invoice(uuid, uuid, bigint, numeric, boolean)
TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
