import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const migration = readFileSync(
  join(root, 'supabase/migrations/20260702133000_timesheet_entries_job_pnl.sql'),
  'utf8',
);
const employeeDetail = readFileSync(join(root, 'src/pages/EmployeeDetail.tsx'), 'utf8');

describe('employee timesheet to job P&L contract', () => {
  it('feeds current timesheet_entries into v_job_costs wages for v_job_pnl', () => {
    expect(migration).toMatch(/create or replace view public\.v_job_costs/i);
    expect(migration).toMatch(/timesheet_wage_costs\s+as\s*\(/i);
    expect(migration).toMatch(/from public\.timesheet_entries te/i);
    expect(migration).toMatch(/te\.deleted_at is null/i);
    expect(migration).toMatch(/te\.job_id is not null/i);
    expect(migration).toMatch(/'wages'::text as category/i);
    expect(migration).toMatch(/sum\(te\.total_cost_cents\)::bigint as total_cents/i);
    expect(migration).toMatch(/union all select \* from timesheet_wage_costs/i);
  });

  it('keeps Employee detail log-time writes aligned with the P&L source table', () => {
    expect(employeeDetail).toMatch(/from\('timesheet_entries'\)\.insert\(\{/);
    expect(employeeDetail).toMatch(/organization_id:\s*currentOrg\.id/);
    expect(employeeDetail).toMatch(/employee_id:\s*employee\.id/);
    expect(employeeDetail).toMatch(/job_id:\s*jobId \|\| null/);
    expect(employeeDetail).toMatch(/loaded_hourly_rate_cents:\s*loadedRate/);
    expect(employeeDetail).toMatch(/entry_type:\s*entryType/);
  });
});
