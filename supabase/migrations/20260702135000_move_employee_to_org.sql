-- Move an employee between organisations without stranding current work rows.
--
-- Payroll history is intentionally not moved. Once pay slips or super batch
-- lines exist, the employee is part of lodged/payroll history and should be
-- archived/recreated or handled by a deliberate payroll migration instead.

CREATE OR REPLACE FUNCTION public.move_employee_to_org(
  p_employee_id uuid,
  p_target_org_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.move_employee_to_org(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.move_employee_to_org(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.move_employee_to_org(uuid, uuid) IS
  'Moves an employee and current work/setup rows across accessible orgs; blocks once payroll history exists.';
