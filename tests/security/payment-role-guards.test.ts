import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Wiring checks for the money-moving, pay-data and TFN edge functions. The role ranking itself (accepted members only,
// admin or owner) is tested in Deno: supabase/functions/_shared/orgRole.test.ts.
const source = (fn: string) => readFileSync(`supabase/functions/${fn}/index.ts`, 'utf8');

function at(src: string, needle: string): number {
  const index = src.indexOf(needle);
  expect(index, `expected to find ${JSON.stringify(needle)}`).toBeGreaterThanOrEqual(0);
  return index;
}

// For each function: what the role check must come before. payment-runs-mark-paid first reads the run to learn
// which organisation it belongs to, so only its later reads and writes are listed.
const FUNCTIONS: Record<string, string[]> = {
  'payment-runs-create': [".from('bills')", ".from('payment_runs')", '.insert('],
  'payment-runs-aba-export': [".from('payment_runs')", ".from('payment_run_items')", ".rpc('is_action_approved'", '.update('],
  'payment-runs-mark-paid': [".from('payment_run_items')", '.update('],
  'super-batch-send': ['.from("super_batches")', '.rpc("is_action_approved"', '.rpc("build_superstream_payload"', '.update('],
  'payroll-termination': ['calculateTermination(input)'],
  // Same class: these already meant admin or owner, but a pending invite passed because accepted_at was not checked.
  'payroll-create-pay-run': [".from('employees')", ".from('pay_runs')", ".rpc('calc_payg_tax'"],
  'payroll-export-stp': [".from('organizations')", 'decryptToken('],
  'employee-tfn-save': [".from('employees')", 'encryptToken('],
};

describe('payment, payroll, super, termination and TFN functions require an accepted admin or owner', () => {
  for (const [fn, laterOps] of Object.entries(FUNCTIONS)) {
    it(`${fn} checks the caller's role before it touches payment or pay data`, () => {
      const src = source(fn);
      expect(src).toMatch(/import \{ authorizeOrgMember, supabaseOrgAccessDeps \} from ['"]\.\.\/_shared\/orgRole\.ts['"];/);
      const guard = at(src, 'authorizeOrgMember(user.id, ');
      expect(src.slice(guard, guard + 140)).toMatch(/^authorizeOrgMember\(user\.id, [\w.]+, supabaseOrgAccessDeps\(admin, serviceKey\), ['"]admin['"]\);/);
      expect(src.indexOf('if (!access.ok) return json(', guard)).toBeGreaterThan(guard);
      const handler = at(src, 'Deno.serve(');
      for (const op of laterOps) {
        const first = src.indexOf(op, handler);
        expect(first, `${fn}: ${op} should exist in the handler`).toBeGreaterThan(handler);
        expect(guard, `${fn}: role check must come before ${op}`).toBeLessThan(first);
      }
      // The old checks read organization_memberships directly with no accepted_at filter.
      expect(src).not.toMatch(/from\(['"]organization_memberships['"]\)/);
    });
  }
});

describe('payment-run bill writes stay inside the authorised organisation', () => {
  // Each statement that writes bills, from `.from('bills')` to the end of the chain.
  const billWrites = (src: string) =>
    [...src.matchAll(/\.from\('bills'\)\s*\.update\([\s\S]*?;/g)].map((m) => m[0]);

  it('payment-runs-create links only the loaded bills of this organisation, never raw request ids', () => {
    const src = source('payment-runs-create');
    const writes = billWrites(src);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain(".in('id', linkedBillIds)");
    expect(writes[0]).toContain(".eq('organization_id', organization_id)");
    expect(src).toContain('const linkedBillIds = items.map((item) => item.bill_id);');
    expect(writes[0]).not.toContain('bill_ids');
  });

  it('payment-runs-mark-paid reads items and marks bills paid only within the run organisation', () => {
    const src = source('payment-runs-mark-paid');
    const writes = billWrites(src);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain(".eq('organization_id', organization_id)");
    const itemsLoad = src.slice(src.indexOf(".from('payment_run_items')"), src.indexOf("if (itemsErr)"));
    expect(itemsLoad).toContain(".eq('organization_id', organization_id)");
  });
});

describe('team-invite', () => {
  it('requires an accepted admin or owner before inviting, so a pending admin invite cannot invite others', () => {
    const src = source('team-invite');
    const guard = at(src, "authorizeOrgMember(user.id, organization_id, supabaseOrgAccessDeps(adminClient, serviceKey), 'admin')");
    expect(guard).toBeLessThan(at(src, '.insert('));
    expect(src).toContain('ROLE_RANK[access.caller.role as OrgRole]');
    expect(src).not.toMatch(/userClient\s*\.from\('organization_memberships'\)/);
  });
});
