import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * accruals-run integration test (SC-1.I.03).
 *
 * Exercises the deployed `accruals-run` edge function — the scheduled DRIVER that
 * detects recurring bill series (detect_recurring_bills, SC-1.I.01) and accrues the
 * most-recent bill of every multi-month series via accrue_recurring_bill
 * (SC-1.I.02) — against a live Supabase, on a throwaway org we seed and tear down:
 *
 *   - a QUARTERLY series (4 same-supplier bills ~91 days apart, constant amount) is
 *     DETECTED and selected for accrual, but because this throwaway org's
 *     chart_of_accounts is NOT seeded the expense / accrued accounts cannot resolve,
 *     so accrue_recurring_bill FAILS CLOSED for that bill (recorded in stats.errors)
 *     and writes NO journal. (If CONNECTOR_JWT_SECRET is unset the bill fails closed
 *     even earlier — same observable: an error, no journal.)
 *   - idempotency at the cleanable level: invoking twice still leaves NO accrual
 *     journals for the seeded bills.
 *
 * The SUCCESSFUL posting path (the reversing accrual/reversal pairs for the current
 * period, each balanced and netting to zero, idempotent per (bill, period)) is
 * proven separately by a live ROLLED-BACK SQL transaction (see ledger SC-1.I.02 and
 * SC-1.I.03), because GL immutability (migration 0075) makes a committed posted
 * journal permanently undeletable — a vitest test that posted for real could never
 * clean up after itself. This suite therefore asserts only the cleanable contracts:
 * the auth gate, the detect -> select -> accrue WIRING, and fail-closed.
 *
 * Env required (mirrors tests/coding-classifier.test.ts):
 *   - VITE_SUPABASE_URL          (or SUPABASE_URL)
 *   - VITE_SUPABASE_ANON_KEY     (or SUPABASE_ANON_KEY)
 *   - SUPABASE_SERVICE_ROLE_KEY
 * It also requires migrations 0090-0098 applied AND the edge function deployed; if
 * detect_recurring_bills is absent the suite warns and skips (out-of-branch schema,
 * the same defensive pattern coding-classifier uses for coding_suggestions).
 *
 * Run: `npm run test:integration` (or target this file directly).
 */

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
const ANON_KEY = process.env['VITE_SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_ANON_KEY'] ?? '';
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';

const HAS_ENV = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_ROLE_KEY);
const IS_CI = Boolean(process.env['CI']);
const SKIP_REASON =
  'accruals-run integration test requires VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY + ' +
  'SUPABASE_SERVICE_ROLE_KEY in env (it invokes the deployed edge function against a ' +
  'live Supabase).';

// HARD GATE in CI: a missing secret must fail RED, not silently skip (same policy
// as the coding-classifier / tenant-isolation deploy gates).
if (IS_CI && !HAS_ENV) {
  throw new Error(
    `[accruals-run] FATAL: integration test running in CI but its required env is ` +
      `missing, so it cannot assert behaviour. ${SKIP_REASON}`,
  );
}

const itLive = it.skipIf(!HAS_ENV);
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ACCRUAL_SOURCE_TYPES = ['bill_accrual', 'bill_accrual_reversal'];

// ISO date N days before today (UTC), for the quarterly bill series.
function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

describe('accruals-run (recurring-bill accrual driver)', () => {
  let admin: SupabaseClient;
  let featureAvailable = false;
  let orgId = '';
  const billIds: string[] = [];

  // 4 same-supplier bills ~91 days apart, constant amount -> a quarterly series.
  async function seedQuarterlySeries(): Promise<void> {
    const supplier = `Acme Insurance ${RUN}`;
    const dates = [isoDaysAgo(273), isoDaysAgo(182), isoDaysAgo(91), isoDaysAgo(0)];
    for (let i = 0; i < dates.length; i++) {
      const res = await admin
        .from('bills')
        .insert({
          organization_id: orgId,
          source: 'manual',
          storage_key: `ar/${RUN}/${i}.pdf`,
          original_filename: `${RUN}-${i}.pdf`,
          mime_type: 'application/pdf',
          supplier_name_raw: supplier,
          invoice_date: dates[i],
          total_inc_gst_cents: 330000,
          gst_cents: 30000,
          subtotal_ex_gst_cents: 300000,
        })
        .select('id')
        .single();
      if (res.error || !res.data) throw new Error(`seed bill ${i} failed: ${res.error?.message}`);
      billIds.push(res.data.id as string);
    }
  }

  async function invoke(scopeOrg: string) {
    return admin.functions.invoke('accruals-run', { body: { organization_id: scopeOrg } });
  }

  async function accrualJournals(): Promise<unknown[]> {
    const res = await admin
      .from('journal_entries')
      .select('id')
      .in('source_type', ACCRUAL_SOURCE_TYPES)
      .in('source_id', billIds);
    expect(res.error, `select journal_entries: ${res.error?.message}`).toBeNull();
    return res.data ?? [];
  }

  beforeAll(async () => {
    if (!HAS_ENV) {
      console.warn(`[accruals-run] SKIPPED: ${SKIP_REASON}`);
      return;
    }
    admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Defensive feature probe: this branch's migrations (0098) may not be applied to
    // the target DB yet (migration-history drift). A missing RPC surfaces as a
    // PostgREST "function not found" error — skip rather than hard-fail.
    const probe = await admin.rpc('detect_recurring_bills', {
      p_org: '00000000-0000-0000-0000-000000000000',
    });
    if (probe.error) {
      console.warn(
        `[accruals-run] SKIPPED: detect_recurring_bills not available ` +
          `(${probe.error.message}). Apply migrations 0090-0098 and deploy the edge ` +
          `function, then this suite runs for real.`,
      );
      return;
    }
    featureAvailable = true;

    const org = await admin.from('organizations').insert({ name: `AR ${RUN}` }).select('id').single();
    if (org.error || !org.data) throw new Error(`org insert failed: ${org.error?.message}`);
    orgId = org.data.id as string;

    await seedQuarterlySeries();
  }, 60_000);

  afterAll(async () => {
    if (!HAS_ENV || !admin || !featureAvailable) return;
    // Defensive: there should be NO accrual journals to clean (the throwaway org's
    // COA is unseeded so accrual fails closed), but delete any drafts just in case.
    await admin.from('journal_entries').delete().in('source_type', ACCRUAL_SOURCE_TYPES).in('source_id', billIds);
    for (const id of billIds) await admin.from('bills').delete().eq('id', id);
    // The bills-insert autolink trigger (0028) auto-creates a suppliers row for the
    // org from supplier_name_raw; it FKs organizations ON DELETE RESTRICT, so it must
    // go before the org delete (safe — bills.supplier_id is ON DELETE SET NULL and
    // the bills are already gone). Mirrors how coding-classifier deletes intake_rules
    // first. Assert the org delete succeeds so a future leak fails loudly, not silently.
    if (orgId) {
      await admin.from('suppliers').delete().eq('organization_id', orgId);
      const del = await admin.from('organizations').delete().eq('id', orgId);
      expect(del.error, `org cleanup failed: ${del.error?.message}`).toBeNull();
    }
  }, 60_000);

  itLive('rejects an unauthenticated request (auth gate)', async () => {
    if (!featureAvailable) return;
    // Raw fetch with no bearer and no ?secret= — the function's own gate must 401
    // (independent of the platform verify_jwt setting, which also 401s when on).
    const res = await fetch(`${SUPABASE_URL}/functions/v1/accruals-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  itLive('detects a quarterly series and accrues it; fails closed with no journal (unseeded COA)', async () => {
    if (!featureAvailable) return;
    const res = await invoke(orgId);
    expect(res.error, `invoke error: ${JSON.stringify(res.error)}`).toBeFalsy();

    const stats = (res.data as { ok: boolean; stats?: Record<string, unknown> })?.stats ?? {};
    // The driver detected at least the quarterly series we seeded...
    expect(Number(stats['series_detected'])).toBeGreaterThanOrEqual(1);
    // ...selected it for accrual (cadence > monthly) and attempted the RPC, which
    // failed closed because the throwaway org's COA is unseeded (or the secret is
    // unset) — either way an error is recorded and nothing posts.
    const errors = (stats['errors'] ?? []) as unknown[];
    expect(errors.length, 'a fail-closed error is recorded').toBeGreaterThanOrEqual(1);
    expect(Number(stats['posted_entries']), 'nothing posted into an unseeded org').toBe(0);

    expect(await accrualJournals(), 'no accrual journals when accrual fails closed').toHaveLength(0);
  });

  itLive('idempotent at the cleanable level: invoking twice posts no accrual journals', async () => {
    if (!featureAvailable) return;
    await invoke(orgId);
    await invoke(orgId);
    expect(await accrualJournals()).toHaveLength(0);
  });
});
