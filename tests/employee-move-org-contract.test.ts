import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const migration = readFileSync(
  join(root, 'supabase/migrations/20260702135000_move_employee_to_org.sql'),
  'utf8',
);
const component = readFileSync(join(root, 'src/components/EmployeeMoveToOrgButton.tsx'), 'utf8');
const employeeDetail = readFileSync(join(root, 'src/pages/EmployeeDetail.tsx'), 'utf8');

describe('employee multi-org move contract', () => {
  it('moves current employee work/setup rows and clears org-scoped job links', () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.move_employee_to_org/i);
    expect(migration).toMatch(/SECURITY DEFINER/i);
    expect(migration).toMatch(/SET search_path = public/i);
    expect(migration).toMatch(/target organization is not accessible/i);
    expect(migration).toMatch(/source organization is not accessible/i);
    expect(migration).toMatch(/FROM public\.pay_slips[\s\S]*WHERE employee_id = p_employee_id/i);
    expect(migration).toMatch(/FROM public\.super_batch_lines[\s\S]*WHERE employee_id = p_employee_id/i);
    expect(migration).toMatch(/cannot move employee with payroll history/i);
    expect(migration).toMatch(/UPDATE public\.timesheet_entries[\s\S]*organization_id = p_target_org_id[\s\S]*job_id = NULL/i);
    expect(migration).toMatch(/UPDATE public\.wage_entries[\s\S]*organization_id = p_target_org_id[\s\S]*job_id = NULL/i);
    expect(migration).toMatch(/UPDATE public\.leave_balances[\s\S]*organization_id = p_target_org_id/i);
    expect(migration).toMatch(/UPDATE public\.pay_schedules[\s\S]*organization_id = p_target_org_id/i);
    expect(migration).toMatch(/UPDATE public\.employees[\s\S]*organization_id = p_target_org_id/i);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.move_employee_to_org\(uuid, uuid\) TO authenticated/i);
  });

  it('wires employee detail to the employee-safe move RPC', () => {
    expect(component).toMatch(/supabase\.rpc\('move_employee_to_org'/);
    expect(component).toMatch(/p_employee_id: employeeId/);
    expect(component).toMatch(/p_target_org_id: targetOrgId/);
    expect(component).toMatch(/payroll history cannot be moved/i);
    expect(employeeDetail).toContain('EmployeeMoveToOrgButton');
    expect(employeeDetail).toMatch(/employeeId=\{employee\.id\}/);
    expect(employeeDetail).toMatch(/currentOrgId=\{employee\.organization_id\}/);
  });
});
