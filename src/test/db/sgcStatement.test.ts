import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const sql = readFileSync(join(root, 'supabase/migrations/0226_sgc_statement_builder.sql'), 'utf8');
const payrollCreatePayRun = readFileSync(
  join(root, 'supabase/functions/payroll-create-pay-run/index.ts'),
  'utf8',
);
const payrollSuperRate = readFileSync(
  join(root, 'supabase/functions/payroll-create-pay-run/super.ts'),
  'utf8',
);

describe('0226 SGC statement migration', () => {
  it('moves payroll super defaults to 12% and keeps the OTE helper explicit', () => {
    expect(sql).toMatch(/'au_super_pct', '12'::jsonb/);
    expect(sql).toMatch(/ALTER COLUMN super_rate_pct SET DEFAULT 12\.00/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.au_sg_rate_pct/);
    expect(sql).toMatch(/WHEN p_pay_date >= DATE '2025-07-01' THEN 12\.00/);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.calc_super_ote/);
    expect(sql).toMatch(/p_ote_cents bigint/);
    expect(sql).toMatch(/public\.calc_super\(p_ote_cents, p_rate_pct, p_org_id\)/);
  });

  it('creates a tenant-scoped SGC statement builder', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.build_sgc_statement\(/);
    expect(sql).toMatch(/SECURITY INVOKER/);
    expect(sql).toMatch(/SET search_path = public/);
    expect(sql).toMatch(/p_org NOT IN \(SELECT public\.get_accessible_org_ids\(\)\)/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.build_sgc_statement/);
  });

  it('uses OTE, excludes overtime, and returns draft-only SGC components', () => {
    expect(sql).toMatch(
      /COALESCE\(ps\.gross_ordinary_cents, 0\) \+ COALESCE\(ps\.gross_leave_cents, 0\)/,
    );
    expect(sql).toMatch(/gross_overtime_cents/);
    expect(sql).toMatch(/ordinary_time_earnings_cents/);
    expect(sql).toMatch(/required_super_cents/);
    expect(sql).toMatch(/calculation_shortfall_cents/);
    expect(sql).toMatch(/admin_fee_cents_per_employee', 2000/);
    expect(sql).toMatch(/nominal_interest_cents', null/);
    expect(sql).toMatch(/'enabled', false/);
  });

  it('updates payroll creation to calculate SG from OTE at the statutory/default 12% rate', () => {
    // The statutory table lives in super.ts (tested in super.test.ts) and is applied as a floor.
    expect(payrollCreatePayRun).toMatch(
      /import \{ effectiveSuperRate, statutorySuperRatePct \} from '\.\/super\.ts'/,
    );
    expect(payrollSuperRate).toMatch(/\{ from: '2025-07-01', pct: 12 \}/);
    // OTE = ordinary + leave, excluding overtime; computed by grossPay() in calc.ts (tested in calc.test.ts).
    expect(payrollCreatePayRun).toMatch(
      /const ordinaryTimeEarnings = gross\.ordinaryTimeEarningsCents/,
    );
    expect(payrollCreatePayRun).toMatch(/admin\.rpc\('calc_super_ote'/);
    expect(payrollCreatePayRun).toMatch(/p_ote_cents: ordinaryTimeEarnings/);
    expect(payrollCreatePayRun).toMatch(/super_basis: 'ordinary_time_earnings'/);
    expect(payrollCreatePayRun).toMatch(/ordinary_time_earnings_cents: ordinaryTimeEarnings/);
  });
});
