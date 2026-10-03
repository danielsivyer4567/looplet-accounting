-- SEC-10: SECURITY DEFINER functions that users can call and that write money tables now check the caller's role.
--
-- These functions bypass RLS, so the restrictive write policies from 20261003120000 do not reach them. Each one only
-- checked membership (organization_id IN get_accessible_org_ids()), so a viewer could post journals, reconcile bank
-- transactions, bulk-accept job allocations on bills or move employees between organisations. Each gate now also
-- needs public.can_write_org (20261003120000: accepted role, agency admin, or the org's own machine token):
--   post_journal_entry, reconcile_match_bill, reconcile_match_invoice, reconcile_undo_match,
--   bulk_accept_job_suggestions, rematch_unallocated_bills          accountant or higher
--   move_employee_to_org                                            admin or higher in BOTH organisations
-- The reconcile functions' service-role path is unchanged, but their gate is now NOT coalesce(v_is_service, false):
-- auth.role() is NULL for a token without a role claim, and the old `NOT v_is_service AND ...` then skipped the check.
--
-- Bodies are the current definitions (pg_get_functiondef after every earlier migration) with only those gate lines
-- changed. CREATE OR REPLACE keeps each function's owner, grants and comment.

-- post_journal_entry
CREATE OR REPLACE FUNCTION public.post_journal_entry(p_entry_id uuid)
 RETURNS journal_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_entry   public.journal_entries;
  v_debits  bigint;
  v_credits bigint;
  v_lines   int;
BEGIN
  -- Lock the header so two concurrent posts can't race.
  SELECT * INTO v_entry
    FROM public.journal_entries
   WHERE id = p_entry_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'journal entry % not found', p_entry_id;
  END IF;

  -- SECURITY DEFINER bypasses RLS — re-assert org access explicitly so a user
  -- cannot post an entry belonging to an org they cannot access.
  IF v_entry.organization_id NOT IN (SELECT public.get_accessible_org_ids()) OR NOT public.can_write_org(v_entry.organization_id, 'accountant'::public.org_role) THEN
    RAISE EXCEPTION 'not authorized to post journal entry %', p_entry_id;
  END IF;

  IF v_entry.status = 'posted' THEN
    RAISE EXCEPTION 'journal entry % is already posted', p_entry_id;
  END IF;

  IF v_entry.status = 'void' THEN
    RAISE EXCEPTION 'journal entry % is void and cannot be posted', p_entry_id;
  END IF;

  SELECT COALESCE(SUM(debit_cents), 0),
         COALESCE(SUM(credit_cents), 0),
         COUNT(*)
    INTO v_debits, v_credits, v_lines
    FROM public.journal_lines
   WHERE journal_entry_id = p_entry_id;

  IF v_lines = 0 THEN
    RAISE EXCEPTION 'journal entry % has no lines', p_entry_id;
  END IF;

  IF v_debits <> v_credits THEN
    RAISE EXCEPTION
      'journal entry % is unbalanced: debits=% credits=%',
      p_entry_id, v_debits, v_credits;
  END IF;

  -- Every referenced account must belong to the SAME org as the entry and be
  -- active. The same-org tie is also enforced at write time by a trigger (0075)
  -- but is re-asserted here so posting fails loudly rather than silently leaking
  -- a foreign-org account into v_trial_balance, and so inactive accounts cannot
  -- receive new postings.
  IF EXISTS (
    SELECT 1
      FROM public.journal_lines jl
      JOIN public.chart_of_accounts coa ON coa.id = jl.account_id
     WHERE jl.journal_entry_id = p_entry_id
       AND coa.organization_id <> v_entry.organization_id
  ) THEN
    RAISE EXCEPTION
      'journal entry % references an account belonging to a different organization',
      p_entry_id;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.journal_lines jl
      JOIN public.chart_of_accounts coa ON coa.id = jl.account_id
     WHERE jl.journal_entry_id = p_entry_id
       AND coa.is_active = false
  ) THEN
    RAISE EXCEPTION
      'journal entry % references an inactive account', p_entry_id;
  END IF;

  UPDATE public.journal_entries
     SET status = 'posted',
         posted_at = now()
   WHERE id = p_entry_id
  RETURNING * INTO v_entry;

  RETURN v_entry;
END;
$function$;

-- reconcile_match_bill
CREATE OR REPLACE FUNCTION public.reconcile_match_bill(p_bank_transaction_id uuid, p_bill_id uuid, p_match_confidence numeric DEFAULT 1.0, p_manually_matched boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  IF NOT coalesce(v_is_service, false) AND (v_org_txn NOT IN (SELECT public.get_accessible_org_ids()) OR NOT public.can_write_org(v_org_txn, 'accountant'::public.org_role)) THEN
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
$function$;

-- reconcile_match_invoice
CREATE OR REPLACE FUNCTION public.reconcile_match_invoice(p_bank_transaction_id uuid, p_invoice_id uuid, p_amount_cents bigint, p_match_confidence numeric DEFAULT 1.0, p_manually_matched boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  IF NOT coalesce(v_is_service, false) AND (v_org_txn NOT IN (SELECT public.get_accessible_org_ids()) OR NOT public.can_write_org(v_org_txn, 'accountant'::public.org_role)) THEN
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
$function$;

-- reconcile_undo_match
CREATE OR REPLACE FUNCTION public.reconcile_undo_match(p_bank_transaction_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  IF NOT coalesce(v_is_service, false) AND (v_org NOT IN (SELECT public.get_accessible_org_ids()) OR NOT public.can_write_org(v_org, 'accountant'::public.org_role)) THEN
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
$function$;

-- bulk_accept_job_suggestions
CREATE OR REPLACE FUNCTION public.bulk_accept_job_suggestions(p_org_id uuid, p_min_score numeric DEFAULT 0.85)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_attached integer := 0;
BEGIN
  -- Verify the caller is a member of the target org.
  IF p_org_id NOT IN (SELECT public.get_accessible_org_ids()) OR NOT public.can_write_org(p_org_id, 'accountant'::public.org_role) THEN
    RAISE EXCEPTION 'not a member of organization %', p_org_id
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.bills
  SET
    job_id               = suggested_job_id,
    suggested_job_id     = NULL,
    suggested_match_score = NULL,
    status               = 'attached',
    attached_at          = now(),
    attached_by          = auth.uid()
  WHERE organization_id      = p_org_id
    AND job_id              IS NULL
    AND suggested_job_id    IS NOT NULL
    AND suggested_match_score >= p_min_score
    AND deleted_at          IS NULL
    AND status IN ('received', 'verified');

  GET DIAGNOSTICS v_attached = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok',       true,
    'attached', v_attached
  );
END;
$function$;

-- rematch_unallocated_bills
CREATE OR REPLACE FUNCTION public.rematch_unallocated_bills(p_org_id uuid, p_limit integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_bill            record;
  v_matched_id      uuid;
  v_score           real;
  v_auto_attached   integer := 0;
  v_suggested       integer := 0;
  v_skipped         integer := 0;
BEGIN
  -- Verify the caller is a member of the target org.
  IF p_org_id NOT IN (SELECT public.get_accessible_org_ids()) OR NOT public.can_write_org(p_org_id, 'accountant'::public.org_role) THEN
    RAISE EXCEPTION 'not a member of organization %', p_org_id
      USING ERRCODE = 'P0001';
  END IF;

  FOR v_bill IN
    SELECT id, job_reference_raw
    FROM public.bills
    WHERE organization_id  = p_org_id
      AND job_id          IS NULL
      AND suggested_job_id IS NULL
      AND job_reference_raw IS NOT NULL
      AND deleted_at      IS NULL
      AND status IN ('received', 'verified')
    ORDER BY created_at DESC
    LIMIT p_limit
  LOOP
    -- Call the existing scorer; take only the top candidate (LIMIT 1 in the CTE).
    SELECT matched_job_id, score
      INTO v_matched_id, v_score
      FROM public.match_job_for_bill(p_org_id, v_bill.job_reference_raw)
     LIMIT 1;

    IF v_matched_id IS NULL OR v_score IS NULL THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    IF v_score >= 1.0 THEN
      UPDATE public.bills
         SET job_id      = v_matched_id,
             status      = 'attached',
             attached_at = now(),
             attached_by = auth.uid()
       WHERE id = v_bill.id;
      v_auto_attached := v_auto_attached + 1;

    ELSIF v_score >= 0.5 THEN
      UPDATE public.bills
         SET suggested_job_id     = v_matched_id,
             suggested_match_score = v_score
       WHERE id = v_bill.id;
      v_suggested := v_suggested + 1;

    ELSE
      v_skipped := v_skipped + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok',            true,
    'auto_attached', v_auto_attached,
    'suggested',     v_suggested,
    'skipped',       v_skipped
  );
END;
$function$;

-- move_employee_to_org
CREATE OR REPLACE FUNCTION public.move_employee_to_org(p_employee_id uuid, p_target_org_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_employee public.employees%ROWTYPE;
  v_source_org_id uuid;
  v_timesheets_moved integer := 0;
  v_wage_entries_moved integer := 0;
  v_leave_balances_moved integer := 0;
  v_pay_schedules_moved integer := 0;
  v_pay_slip_count integer := 0;
  v_super_line_count integer := 0;
BEGIN
  IF p_employee_id IS NULL OR p_target_org_id IS NULL THEN
    RAISE EXCEPTION 'employee_id and target organization are required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.get_accessible_org_ids() org_id
     WHERE org_id = p_target_org_id
  ) THEN
    RAISE EXCEPTION 'target organization is not accessible' USING ERRCODE = '42501';
  END IF;

  IF NOT public.can_write_org(p_target_org_id, 'admin'::public.org_role) THEN
    RAISE EXCEPTION 'moving an employee needs the admin role in the target organization' USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_employee
    FROM public.employees
   WHERE id = p_employee_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'employee not found' USING ERRCODE = 'P0002';
  END IF;

  v_source_org_id := v_employee.organization_id;

  IF NOT EXISTS (
    SELECT 1
      FROM public.get_accessible_org_ids() org_id
     WHERE org_id = v_source_org_id
  ) THEN
    RAISE EXCEPTION 'source organization is not accessible' USING ERRCODE = '42501';
  END IF;

  IF NOT public.can_write_org(v_source_org_id, 'admin'::public.org_role) THEN
    RAISE EXCEPTION 'moving an employee needs the admin role in the source organization' USING ERRCODE = '42501';
  END IF;

  IF p_target_org_id = v_source_org_id THEN
    RETURN jsonb_build_object(
      'ok', true,
      'employee_id', p_employee_id,
      'source_organization_id', v_source_org_id,
      'target_organization_id', p_target_org_id,
      'timesheets_moved', 0,
      'wage_entries_moved', 0,
      'leave_balances_moved', 0,
      'pay_schedules_moved', 0
    );
  END IF;

  SELECT count(*) INTO v_pay_slip_count
    FROM public.pay_slips
   WHERE employee_id = p_employee_id;

  SELECT count(*) INTO v_super_line_count
    FROM public.super_batch_lines
   WHERE employee_id = p_employee_id;

  IF v_pay_slip_count > 0 OR v_super_line_count > 0 THEN
    RAISE EXCEPTION
      'cannot move employee with payroll history; archive and recreate in the target organization';
  END IF;

  UPDATE public.timesheet_entries
     SET organization_id = p_target_org_id,
         job_id = NULL,
         updated_at = now()
   WHERE employee_id = p_employee_id
     AND organization_id = v_source_org_id;
  GET DIAGNOSTICS v_timesheets_moved = ROW_COUNT;

  UPDATE public.wage_entries
     SET organization_id = p_target_org_id,
         job_id = NULL,
         updated_at = now()
   WHERE employee_id = p_employee_id
     AND organization_id = v_source_org_id;
  GET DIAGNOSTICS v_wage_entries_moved = ROW_COUNT;

  UPDATE public.leave_balances
     SET organization_id = p_target_org_id,
         updated_at = now()
   WHERE employee_id = p_employee_id
     AND organization_id = v_source_org_id;
  GET DIAGNOSTICS v_leave_balances_moved = ROW_COUNT;

  UPDATE public.pay_schedules
     SET organization_id = p_target_org_id,
         updated_at = now()
   WHERE employee_id = p_employee_id
     AND organization_id = v_source_org_id;
  GET DIAGNOSTICS v_pay_schedules_moved = ROW_COUNT;

  UPDATE public.employees
     SET organization_id = p_target_org_id,
         updated_at = now()
   WHERE id = p_employee_id;

  RETURN jsonb_build_object(
    'ok', true,
    'employee_id', p_employee_id,
    'source_organization_id', v_source_org_id,
    'target_organization_id', p_target_org_id,
    'timesheets_moved', v_timesheets_moved,
    'wage_entries_moved', v_wage_entries_moved,
    'leave_balances_moved', v_leave_balances_moved,
    'pay_schedules_moved', v_pay_schedules_moved
  );
END;
$function$;
