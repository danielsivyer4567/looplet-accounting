import { describe, it, expect } from 'vitest';

/**
 * payroll-termination integration test (SC-3.L.01) — smokes the DEPLOYED handler:
 * POST a genuine-redundancy fixture, assert the breakdown matches the calc using the
 * default FY constants. The substantive tax-math assertions live in the colocated
 * deno unit test (supabase/functions/payroll-termination/calc.test.ts); this just
 * confirms the HTTP wrapper (auth + validate + calc) returns the right shape.
 *
 * Skip-safe (NOT a CI hard-gate): needs the deployed fn + a user JWT + an org the
 * caller belongs to — absent in CI, so it skips cleanly. Env: VITE_SUPABASE_URL +
 * VITE_SUPABASE_ANON_KEY + TEST_USER_JWT + TEST_ORG_ID.
 */

const URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
const ANON = process.env['VITE_SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_ANON_KEY'] ?? '';
const USER_JWT = process.env['TEST_USER_JWT'] ?? '';
const ORG_ID = process.env['TEST_ORG_ID'] ?? '';
const HAS_ENV = Boolean(URL && ANON && USER_JWT && ORG_ID);

if (!HAS_ENV) {
  console.warn(
    '[payroll-termination] SKIPPED: needs VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY + ' +
      'TEST_USER_JWT + TEST_ORG_ID (deployed fn + a member JWT).',
  );
}

describe.skipIf(!HAS_ENV)('payroll-termination (integration, deploy-gated)', () => {
  it('computes a genuine-redundancy breakdown via the handler', async () => {
    const res = await fetch(`${URL}/functions/v1/payroll-termination`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${USER_JWT}`, apikey: ANON },
      body: JSON.stringify({
        organization_id: ORG_ID,
        input: {
          reason: 'genuine_redundancy',
          years_of_service: 10,
          at_or_above_preservation_age: false,
          unused_annual_leave_cents: 2_000_000,
          unused_long_service_leave_cents: 1_000_000,
          redundancy_or_severance_cents: 10_000_000,
          etp_other_cents: 0,
          other_taxable_income_cents: 9_000_000,
          leave_marginal_rate: 0.345,
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result?: Record<string, number | boolean> };
    expect(body.ok).toBe(true);
    expect(body.result?.is_excluded_etp).toBe(true);
    // Uses DEFAULT_TAX_CONSTANTS (FY2024-25): tax-free cap 7,516,400; concessional leave 0.32.
    expect(body.result?.redundancy_tax_free_cents).toBe(7_516_400);
    expect(body.result?.unused_leave_tax_cents).toBe(960_000);
    expect(body.result?.total_tax_cents).toBe(794_752 + 960_000);
  });
});
