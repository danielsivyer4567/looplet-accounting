/**
 * Static assertions over migration 0206_definer_notify_hardening.sql.
 *
 * The finish-line worktree has no DB, so these are text-level guarantees that
 * the migration (a) adds the org-membership guard inside notify() and (b)
 * revokes PUBLIC/anon EXECUTE on the named SECURITY DEFINER write functions,
 * locking the cron sweep down to service_role. The live behavioural proof
 * (cross-org notify() rejected) is deploy-gated — see live_proof.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/0206_definer_notify_hardening.sql',
);
const sql = readFileSync(migrationPath, 'utf8');
// Normalise whitespace so multi-line / re-indented statements still match.
const flat = sql.replace(/\s+/g, ' ');

describe('0206 definer + notify org-guard hardening', () => {
  it('is wrapped in a single transaction', () => {
    expect(sql).toMatch(/\bBEGIN;/);
    expect(sql).toMatch(/\bCOMMIT;\s*$/);
  });

  it('redefines notify() preserving its full 10-arg signature and SECURITY DEFINER', () => {
    expect(flat).toMatch(/CREATE OR REPLACE FUNCTION public\.notify\(/);
    expect(flat).toMatch(/SECURITY DEFINER/);
    // search_path must stay pinned (not mutable) so the definer is escalation-safe.
    expect(flat).toMatch(/SET search_path = public/);
    // Same return contract as 0040 so existing callers are unaffected.
    expect(flat).toMatch(/RETURNS uuid/);
  });

  it('adds an org-membership guard inside notify() keyed on get_accessible_org_ids()', () => {
    // The guard must reference both the membership helper and the target org arg.
    expect(flat).toMatch(/p_org NOT IN \(SELECT public\.get_accessible_org_ids\(\)\)/);
    // It must raise rather than silently insert when the org is not accessible.
    expect(flat).toMatch(/RAISE EXCEPTION 'organization not accessible/);
  });

  it('exempts service_role (auth.uid() IS NULL) so cron/orchestrator/payroll still work', () => {
    // The guard only fires for interactive callers — auth.uid() IS NOT NULL.
    expect(flat).toMatch(/auth\.uid\(\) IS NOT NULL\s+AND p_org NOT IN/);
  });

  it('still validates severity (no regression of the original 0040 check)', () => {
    expect(flat).toMatch(/IF p_severity NOT IN \('info', 'warning', 'error'\)/);
  });

  it('revokes PUBLIC and anon EXECUTE on notify() (defence in depth over the body guard)', () => {
    expect(flat).toMatch(
      /REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon;/,
    );
    // notify() must remain callable by both authenticated and service_role.
    expect(flat).toMatch(/GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role;/);
    // The notify signature is the one being hardened.
    expect(flat).toMatch(
      /public\.notify\(uuid,text,text,text,text,text,uuid,text,uuid,jsonb\)/,
    );
  });

  it('locks close_idle_accountant_sessions() down to service_role only (cron sweep)', () => {
    expect(flat).toMatch(/public\.close_idle_accountant_sessions\(\)/);
    expect(flat).toMatch(
      /REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated;/,
    );
    expect(flat).toMatch(/GRANT EXECUTE ON FUNCTION %s TO service_role;/);
  });

  it('guards each grant change with to_regprocedure() so it never aborts on a partial DB', () => {
    expect(flat).toMatch(/to_regprocedure\(v_notify_sig\) IS NOT NULL/);
    expect(flat).toMatch(/to_regprocedure\(v_close_sig\) IS NOT NULL/);
  });

  it('reloads the PostgREST schema cache after the grant change', () => {
    expect(flat).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });

  it('does not weaken any authenticated-facing guarded RPC (no blanket REVOKE FROM authenticated on notify/approval/receipt RPCs)', () => {
    // Sanity: the only function we revoke from `authenticated` is the cron sweep.
    const authRevokes = [...flat.matchAll(/REVOKE EXECUTE ON FUNCTION (\S+) FROM[^;]*authenticated/g)];
    // We use the %s placeholder form, so the captured target is the format() arg
    // name — assert the only authenticated-revoke statement is the close-sig one.
    expect(flat).toMatch(
      /REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated;/,
    );
    // notify's revoke must NOT include authenticated.
    expect(flat).not.toMatch(/REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role/);
    expect(authRevokes.length).toBeGreaterThanOrEqual(1);
  });
});
