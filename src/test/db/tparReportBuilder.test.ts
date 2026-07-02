import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/0224_tpar_report_builder.sql'),
  'utf8',
);

describe('0224 TPAR report builder migration', () => {
  it('creates a guarded TPAR builder RPC', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.build_tpar_report\(/);
    expect(sql).toMatch(/SECURITY INVOKER/);
    expect(sql).toMatch(/SET search_path = public/);
    expect(sql).toMatch(/p_org NOT IN \(SELECT public\.get_accessible_org_ids\(\)\)/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.build_tpar_report/);
  });

  it('uses completed financial-year dates and the TPAR due date', () => {
    expect(sql).toMatch(/v_period_start := make_date\(p_fy_start_year, 7, 1\)/);
    expect(sql).toMatch(/v_period_end := make_date\(p_fy_start_year \+ 1, 6, 30\)/);
    expect(sql).toMatch(/v_due_date := make_date\(p_fy_start_year \+ 1, 8, 28\)/);
  });

  it('aggregates paid AP from direct paid bills and paid payment runs', () => {
    expect(sql).toMatch(/direct_bill_payments AS/);
    expect(sql).toMatch(/b\.status = 'paid'::public\.bill_status/);
    expect(sql).toMatch(/payment_run_payments AS/);
    expect(sql).toMatch(/pr\.status = 'paid'::public\.payment_run_status/);
    expect(sql).toMatch(/payment_run_items/);
    expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1\s*FROM public\.payment_run_items/s);
  });

  it('limits reportable payments to subcontractor coding or supplier intake rules', () => {
    expect(sql).toMatch(/p\.auto_category_code = 'subcontractor'/);
    expect(sql).toMatch(/public\.intake_rules r/);
    expect(sql).toMatch(/r\.category_code = 'subcontractor'/);
    expect(sql).toMatch(/r\.is_active IS TRUE/);
  });

  it('returns export evidence, warnings, and draft-only lodgement metadata', () => {
    expect(sql).toMatch(/'schema_version', 'build_tpar_report:v1'/);
    expect(sql).toMatch(/'input_hash', v_input_hash/);
    expect(sql).toMatch(/'source_tables', jsonb_build_array/);
    expect(sql).toMatch(/'missing_abn_count', v_missing_abn_count/);
    expect(sql).toMatch(/'format', 'csv'/);
    expect(sql).toMatch(/'enabled', false/);
  });
});
