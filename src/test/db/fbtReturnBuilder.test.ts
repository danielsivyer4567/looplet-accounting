import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/0223_fbt_return_builder.sql'),
  'utf8',
);

describe('0223 FBT return builder migration', () => {
  it('creates explicit FBT rate and benefit input sources', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.fbt_rates/);
    expect(sql).toMatch(/fbt_rate_bps integer NOT NULL/);
    expect(sql).toMatch(/type_1_gross_up_rate_bps integer NOT NULL/);
    expect(sql).toMatch(/type_2_gross_up_rate_bps integer NOT NULL/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.fbt_benefit_inputs/);
    expect(sql).toMatch(/benefit_kind IN/);
    expect(sql).toMatch(/gross_up_type IN \('type_1', 'type_2'\)/);
    expect(sql).toMatch(/fbt_benefit_inputs_org_year_idx/);
  });

  it('keeps FBT inputs RLS-scoped and audited', () => {
    expect(sql).toMatch(/ALTER TABLE public\.fbt_benefit_inputs ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/organization_id IN \(SELECT public\.get_accessible_org_ids\(\)\)/);
    expect(sql).toMatch(/public\.audit_log_trigger_v2\(\)/);
    expect(sql).toMatch(/REVOKE ALL ON public\.fbt_benefit_inputs FROM PUBLIC, anon/);
  });

  it('builds the draft return from source rows without lodgement', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.build_fbt_return\(/);
    expect(sql).toMatch(/SECURITY INVOKER/);
    expect(sql).toMatch(/SET search_path = public/);
    expect(sql).toMatch(
      /ROUND\(\(v_type_1_taxable \* v_rates\.type_1_gross_up_rate_bps\)::numeric \/ 10000\)/,
    );
    expect(sql).toMatch(
      /ROUND\(\(v_type_2_taxable \* v_rates\.type_2_gross_up_rate_bps\)::numeric \/ 10000\)/,
    );
    expect(sql).toMatch(/'fbt_payable_cents', v_fbt_payable/);
    expect(sql).toMatch(/'enabled', false/);
  });

  it('exposes a stable approval payload that binds to the input hash and totals', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.fbt_return_approval_payload\(/);
    expect(sql).toMatch(/'kind', 'fbt_return_approve'/);
    expect(sql).toMatch(/'resource_id', p_org::text \|\| ':' \|\| p_fbt_year_end_year::text/);
    expect(sql).toMatch(/'input_hash', body #>> '\{evidence,input_hash\}'/);
    expect(sql).toMatch(/'fbt_payable_cents'/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.fbt_return_approval_payload/);
  });
});
