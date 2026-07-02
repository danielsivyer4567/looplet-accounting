/**
 * Static assertions over migration 0210_require_role_accepted.sql (P1-14).
 *
 * The finish-line worktree has no DB, so these are text-level guarantees that
 * the migration redefines BOTH require_role() signatures to require an ACCEPTED
 * membership (accepted_at IS NOT NULL) before granting the invited role —
 * mirroring the get_accessible_org_ids() gate P0-01 added in 0203. A pending
 * (un-accepted) member must therefore fail require_role even for their invited
 * role; every accepted role keeps its existing privilege.
 *
 * The live behavioural proof (pending member fails require_role; accepted member
 * passes) is deploy-gated — see live_proof.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/0210_require_role_accepted.sql',
);
const sql = readFileSync(migrationPath, 'utf8');
// Normalise whitespace so multi-line / re-indented statements still match.
const flat = sql.replace(/\s+/g, ' ');

describe('0210 require_role() accepted_at gate', () => {
  it('is wrapped in a single transaction', () => {
    expect(sql).toMatch(/\bBEGIN;/);
    expect(sql).toMatch(/\bCOMMIT;\s*$/);
  });

  it('redefines BOTH require_role() signatures', () => {
    expect(flat).toMatch(/CREATE OR REPLACE FUNCTION public\.require_role\(min_role org_role\)/);
    expect(flat).toMatch(
      /CREATE OR REPLACE FUNCTION public\.require_role\(p_org_id uuid, min_role org_role\)/,
    );
    // Exactly two function definitions — no third/renamed overload.
    const defs = [...flat.matchAll(/CREATE OR REPLACE FUNCTION public\.require_role\(/g)];
    expect(defs.length).toBe(2);
  });

  it('adds the accepted_at IS NOT NULL gate to BOTH functions', () => {
    const gates = [...flat.matchAll(/m\.accepted_at\s+IS NOT NULL/g)];
    expect(gates.length).toBe(2);
  });

  it('preserves the hardening contract of 0039 on both signatures', () => {
    // Each marker must appear in BOTH function bodies (prose in the header may
    // mention them too, so assert >= 2 rather than an exact count).
    expect([...flat.matchAll(/LANGUAGE sql/g)].length).toBeGreaterThanOrEqual(2);
    expect([...flat.matchAll(/\bSTABLE\b/g)].length).toBeGreaterThanOrEqual(2);
    expect([...flat.matchAll(/SECURITY DEFINER/g)].length).toBeGreaterThanOrEqual(2);
    expect([...flat.matchAll(/SET search_path = public/g)].length).toBeGreaterThanOrEqual(2);
    // Same boolean return contract as 0039 so RLS callers are unaffected — this
    // appears only as a typed declaration, never in prose, so the count is exact.
    expect([...flat.matchAll(/RETURNS boolean/g)].length).toBe(2);
  });

  it('preserves the role-ranking ladder unchanged (no privilege regression)', () => {
    // The 0039 ladder must survive verbatim in both functions: owner>admin>
    // accountant>employee>viewer(0). Two CASE blocks per function (member side
    // + min_role side) → 4 occurrences of the ranked WHEN sequence.
    const ladders = [
      ...flat.matchAll(
        /WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'accountant' THEN 2 WHEN 'employee' THEN 1 ELSE 0/g,
      ),
    ];
    expect(ladders.length).toBe(4);
    // role_enum still gated as NOT NULL alongside the new accepted_at check.
    expect([...flat.matchAll(/m\.role_enum\s+IS NOT NULL/g)].length).toBe(2);
  });

  it('keeps the org-scoped overload bound to the org argument', () => {
    expect(flat).toMatch(/m\.organization_id\s*=\s*p_org_id/);
  });

  it('re-asserts pinned search_path + EXECUTE grants idempotently and guarded', () => {
    // Guarded with to_regprocedure so a partial DB never aborts the migration.
    expect(flat).toMatch(/to_regprocedure\(sig\) IS NOT NULL/);
    expect(flat).toMatch(/ALTER FUNCTION %s SET search_path = public;/);
    // Caller role (RLS) needs EXECUTE — matches the 0039 grant set exactly.
    expect(flat).toMatch(/GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role;/);
    // Both signatures are named in the harden loop.
    expect(flat).toMatch(/public\.require_role\(org_role\)/);
    expect(flat).toMatch(/public\.require_role\(uuid, org_role\)/);
  });

  it('does not weaken the grants (no REVOKE FROM authenticated on require_role)', () => {
    // require_role is used inside RLS USING/WITH CHECK clauses; revoking it from
    // authenticated would break every role-gated policy. Assert no such revoke.
    expect(flat).not.toMatch(/REVOKE EXECUTE ON FUNCTION %s FROM[^;]*authenticated/);
  });
});
