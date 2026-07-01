import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * close_period() books-health blocking gate — RPC-level coverage (H2 hardening,
 * lane/h-approval).
 *
 * v_books_health.blocking (0091) is read by three independent enforcement points:
 * the orchestrator's decide.ts (unit-tested), eofy-pack (owned by the EOFY draft
 * engine, out of this lane's scope), and close_period() (0100/SC-1.J.02) — which had
 * NO test coverage at all despite refusing month-end close on its own, structured
 * jsonb result (not the fragile error-string parsing eofy-pack does). This suite
 * drives a throwaway org's books-health score below/above the 80 threshold via
 * compute_books_health's coverage_pct component (an uncoded bill) and asserts
 * close_period() refuses, then succeeds once the books are clean.
 *
 * Env (mirrors tests/payroll-finalise-pay-run.test.ts): VITE_SUPABASE_URL (or
 * SUPABASE_URL), VITE_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY),
 * SUPABASE_SERVICE_ROLE_KEY. Requires migrations 0090-0100 applied; if
 * `close_period` is absent the suite warns and skips.
 */

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
const ANON_KEY = process.env['VITE_SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_ANON_KEY'] ?? '';
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';

const HAS_ENV = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_ROLE_KEY);
const IS_CI = Boolean(process.env['CI']);
const SKIP_REASON =
  'period-close-books-health integration test requires VITE_SUPABASE_URL + ' +
  'VITE_SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY in env (it calls close_period() ' +
  'directly against a live Supabase).';

if (IS_CI && !HAS_ENV) {
  throw new Error(`[period-close-books-health] FATAL: running in CI but required env is missing. ${SKIP_REASON}`);
}

const itLive = it.skipIf(!HAS_ENV);
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const PERIOD = '2026-01-15'; // any month with no existing period_locks for a fresh throwaway org

describe('close_period() books-health blocking gate (SC-1.J.02)', () => {
  let admin: SupabaseClient;
  let owner: SupabaseClient;
  let featureAvailable = false;
  let orgId = '';
  let userId = '';
  let billId = '';
  const email = `pcbh-owner-${RUN}@looplet.test`;
  const password = `Pw-${RUN}-aZ9!`;

  beforeAll(async () => {
    if (!HAS_ENV) {
      console.warn(`[period-close-books-health] SKIPPED: ${SKIP_REASON}`);
      return;
    }
    admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const probe = await admin.rpc('close_period', {
      p_org: '00000000-0000-0000-0000-000000000000',
      p_period: PERIOD,
    });
    // A well-formed "not found or not accessible" failure proves the RPC exists;
    // anything else (e.g. "function ... does not exist") means it isn't deployed yet.
    if (probe.error && /does not exist/i.test(probe.error.message)) {
      console.warn(
        `[period-close-books-health] SKIPPED: close_period not available ` +
          `(${probe.error.message}). Apply migrations 0090-0100, then this suite runs for real.`,
      );
      return;
    }
    featureAvailable = true;

    const org = await admin.from('organizations').insert({ name: `PCBH ${RUN}` }).select('id').single();
    if (org.error || !org.data) throw new Error(`org insert failed: ${org.error?.message}`);
    orgId = org.data.id as string;

    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error(`createUser failed: ${created.error?.message}`);
    userId = created.data.user.id;
    const mem = await admin.from('organization_memberships').insert({
      organization_id: orgId,
      user_id: userId,
      role: 'owner',
      role_enum: 'owner',
    });
    if (mem.error) throw new Error(`membership insert failed: ${mem.error.message}`);

    owner = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
    const session = await owner.auth.signInWithPassword({ email, password });
    if (session.error || !session.data.session) throw new Error(`signIn failed: ${session.error?.message}`);
  }, 60_000);

  afterAll(async () => {
    if (!HAS_ENV || !admin || !featureAvailable) return;
    // bills.organization_id is ON DELETE RESTRICT — must clear it before the org delete.
    if (billId) await admin.from('bills').delete().eq('id', billId);
    if (orgId) {
      await admin.from('period_locks').delete().eq('organization_id', orgId);
      await admin.from('organization_memberships').delete().eq('organization_id', orgId);
      await admin.from('organizations').delete().eq('id', orgId);
    }
    if (userId) await admin.auth.admin.deleteUser(userId);
  }, 60_000);

  itLive(
    'refuses with books_health_blocking while a bill is uncoded, then closes once coverage recovers',
    async () => {
      if (!featureAvailable) return;

      // Drive coverage_pct to 0 for this org: one live bill, uncoded (no
      // auto_category_code), no invoice_date so it doesn't also open a period.
      const bill = await admin
        .from('bills')
        .insert({
          organization_id: orgId,
          source: 'manual_upload',
          storage_key: `test/${RUN}.pdf`,
          original_filename: `${RUN}.pdf`,
          mime_type: 'application/pdf',
        })
        .select('id')
        .single();
      expect(bill.error, `bill insert failed: ${bill.error?.message}`).toBeNull();
      billId = bill.data!.id as string;

      const health = await admin.from('v_books_health').select('score, blocking').eq('organization_id', orgId).single();
      expect(health.error).toBeNull();
      expect(health.data?.blocking, `expected blocking books-health, got score ${health.data?.score}`).toBe(true);

      // 1. close_period refuses — structured jsonb, no lock written.
      const refused = await owner.rpc('close_period', { p_org: orgId, p_period: PERIOD });
      expect(refused.error, `close_period error: ${refused.error?.message}`).toBeNull();
      const refusedBody = refused.data as Record<string, unknown>;
      expect(refusedBody['ok']).toBe(false);
      expect(refusedBody['status']).toBe('refused');
      expect(refusedBody['reason']).toBe('books_health_blocking');

      const lockAfterRefuse = await admin
        .from('period_locks')
        .select('id')
        .eq('organization_id', orgId);
      expect(lockAfterRefuse.data ?? [], 'no lock written while blocking').toHaveLength(0);

      // 2. Resolve the coverage gap (soft-delete the uncoded bill) -> books-health clears.
      const resolved = await admin.from('bills').update({ deleted_at: new Date().toISOString() }).eq('id', billId);
      expect(resolved.error).toBeNull();

      const healthAfter = await admin
        .from('v_books_health')
        .select('score, blocking')
        .eq('organization_id', orgId)
        .single();
      expect(healthAfter.error).toBeNull();
      expect(healthAfter.data?.blocking, `expected clear books-health, got score ${healthAfter.data?.score}`).toBe(false);

      // 3. close_period now succeeds and writes the lock.
      const closed = await owner.rpc('close_period', { p_org: orgId, p_period: PERIOD });
      expect(closed.error, `close_period error: ${closed.error?.message}`).toBeNull();
      const closedBody = closed.data as Record<string, unknown>;
      expect(closedBody['ok'], `close_period body: ${JSON.stringify(closedBody)}`).toBe(true);
      expect(closedBody['status']).toBe('closed');

      const lockAfterClose = await admin.from('period_locks').select('id').eq('organization_id', orgId);
      expect(lockAfterClose.data ?? [], 'period locked once books-health clears').toHaveLength(1);
    },
    30_000,
  );
});
