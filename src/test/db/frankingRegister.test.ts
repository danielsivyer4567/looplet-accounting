import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/0225_franking_register.sql'),
  'utf8',
);

describe('0225 franking register migration', () => {
  it('creates audited franking register and dividend statement tables', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.franking_account_entries/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.company_dividend_statements/);
    expect(sql).toMatch(/franking_account_entry_one_sided/);
    expect(sql).toMatch(/company_dividend_statement_positive/);
    expect(sql).toMatch(/public\.audit_log_trigger_v2\(\)/);
  });

  it('keeps franking tables tenant-scoped under RLS', () => {
    expect(sql).toMatch(/ALTER TABLE public\.franking_account_entries ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(
      /ALTER TABLE public\.company_dividend_statements ENABLE ROW LEVEL SECURITY/,
    );
    expect(sql).toMatch(/organization_id IN \(SELECT public\.get_accessible_org_ids\(\)\)/);
    expect(sql).toMatch(/REVOKE ALL ON public\.franking_account_entries FROM PUBLIC, anon/);
  });

  it('builds the franking register and reconciliation payload', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.build_franking_register\(/);
    expect(sql).toMatch(/SECURITY INVOKER/);
    expect(sql).toMatch(/SET search_path = public/);
    expect(sql).toMatch(/p_org NOT IN \(SELECT public\.get_accessible_org_ids\(\)\)/);
    expect(sql).toMatch(/statement_vs_register_variance_cents/);
    expect(sql).toMatch(/statement_vs_gl_variance_cents/);
    expect(sql).toMatch(/benchmark_franking_percentage_bps/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.build_franking_register/);
  });

  it('drafts per-member dividend statements from the share register', () => {
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.draft_dividend_statements_from_share_register\(/,
    );
    expect(sql).toMatch(/FROM public\.share_register/);
    expect(sql).toMatch(/FLOOR\(p_total_cash_dividend_cents::numeric/);
    expect(sql).toMatch(/franking_credit_cents/);
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.draft_dividend_statements_from_share_register/,
    );
  });

  it('marks lodgement as draft-only', () => {
    expect(sql).toMatch(/'schema_version', 'build_franking_register:v1'/);
    expect(sql).toMatch(/'input_hash', v_input_hash/);
    expect(sql).toMatch(/'enabled', false/);
    expect(sql).toMatch(/FATR lodgement is outside this in-repo finish-line slice/);
  });
});
