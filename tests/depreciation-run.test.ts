import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * depreciation-run integration test (SC-1.G.02).
 *
 * Exercises the deployed `depreciation-run` edge function against a live Supabase,
 * on a throwaway org we seed and tear down. The throwaway org has NO seeded chart
 * of accounts, so the 6700/1900 depreciation accounts cannot resolve and every
 * schedule with a positive amount must FAIL CLOSED — an error is recorded and NO
 * journal is written. This is exactly the cleanable surface:
 *   - an ACTIVE schedule whose month amount > 0 → recorded in stats.errors
 *     (accounts missing), NOT posted, no journal_entries row.
 *   - a fully-depreciated schedule (amount 0) → counted in stats.skipped_zero,
 *     no error, no journal.
 *   - idempotency: invoking twice still leaves zero journals.
 *
 * The SUCCESSFUL balanced post (Dr 6700 / Cr 1900 = compute_depreciation amount,
 * posted via post_journal_entry) is proven separately by a live ROLLED-BACK SQL
 * transaction (see ledger SC-1.G.02), because GL immutability (migration 0075)
 * makes a committed posted journal permanently undeletable — a vitest test that
 * posted for real could never clean up after itself (same as coding-classifier).
 *
 * Env required (mirrors tests/coding-classifier.test.ts):
 *   - VITE_SUPABASE_URL          (or SUPABASE_URL)
 *   - VITE_SUPABASE_ANON_KEY     (or SUPABASE_ANON_KEY)
 *   - SUPABASE_SERVICE_ROLE_KEY
 * It also requires migrations 0093 + 0095 applied AND the edge function deployed;
 * if `depreciation_schedules` is absent the suite warns and skips (out-of-branch
 * schema, same defensive pattern coding-classifier uses for coding_suggestions).
 *
 * Run: `npm run test:integration` (or target this file directly).
 */

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
const ANON_KEY = process.env['VITE_SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_ANON_KEY'] ?? '';
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';

const HAS_ENV = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_ROLE_KEY);
const IS_CI = Boolean(process.env['CI']);
const SKIP_REASON =
  'depreciation-run integration test requires VITE_SUPABASE_URL + ' +
  'VITE_SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY in env (it invokes the ' +
  'deployed edge function against a live Supabase).';

// HARD GATE in CI: a missing secret must fail RED, not silently skip (same policy
// as the coding-classifier / tenant-isolation deploy gates).
if (IS_CI && !HAS_ENV) {
  throw new Error(
    `[depreciation-run] FATAL: integration test running in CI but its required ` +
      `env is missing, so it cannot assert behaviour. ${SKIP_REASON}`,
  );
}

const itLive = it.skipIf(!HAS_ENV);
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
// A fixed mid-month date so the run is deterministic regardless of when it executes.
const PERIOD = '2026-03-15';

describe('depreciation-run (monthly depreciation posting)', () => {
  let admin: SupabaseClient;
  let featureAvailable = false;
  let orgId = '';
  let schedActiveId = ''; // positive amount in PERIOD's month → fails closed (no COA)
  let schedZeroId = ''; // fully depreciated before PERIOD → amount 0 → skipped

  async function seedAssetWithSchedule(
    name: string,
    startDate: string,
    openingCents: number,
    lifeYears: number,
  ): Promise<string> {
    const asset = await admin
      .from('fixed_assets')
      .insert({
        organization_id: orgId,
        name,
        acquisition_date: startDate,
        cost_base_cents: openingCents,
        depreciation_method: 'prime_cost',
        effective_life_years: lifeYears,
        status: 'active',
      })
      .select('id')
      .single();
    if (asset.error || !asset.data) throw new Error(`seed asset failed: ${asset.error?.message}`);
    const assetId = asset.data.id as string;

    const sched = await admin
      .from('depreciation_schedules')
      .insert({
        organization_id: orgId,
        fixed_asset_id: assetId,
        method: 'prime_cost',
        start_date: startDate,
        opening_cost_base_cents: openingCents,
        effective_life_years: lifeYears,
      })
      .select('id')
      .single();
    if (sched.error || !sched.data) throw new Error(`seed schedule failed: ${sched.error?.message}`);
    return sched.data.id as string;
  }

  async function invoke() {
    return admin.functions.invoke('depreciation-run', {
      body: { organization_id: orgId, period: PERIOD },
    });
  }

  async function journalsForSchedule(scheduleId: string): Promise<unknown[]> {
    const res = await admin
      .from('journal_entries')
      .select('id')
      .eq('source_type', 'depreciation_schedule')
      .eq('source_id', scheduleId);
    expect(res.error, `select journal_entries: ${res.error?.message}`).toBeNull();
    return res.data ?? [];
  }

  beforeAll(async () => {
    if (!HAS_ENV) {
      console.warn(`[depreciation-run] SKIPPED: ${SKIP_REASON}`);
      return;
    }
    admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Defensive feature probe: this branch's migrations (0093/0095) may not be
    // applied to the target DB yet (migration-history drift). Skip rather than
    // hard-fail on missing out-of-branch schema.
    const probe = await admin.from('depreciation_schedules').select('id').limit(1);
    if (probe.error) {
      console.warn(
        `[depreciation-run] SKIPPED: depreciation_schedules not available ` +
          `(${probe.error.message}). Apply migrations 0093 + 0095 and deploy the ` +
          `edge function, then this suite runs for real.`,
      );
      return;
    }

    // The edge fn also needs the compute_depreciation RPC (migration 0095). If only
    // the table (0093) is applied, skip rather than fail RED — keeps the
    // skip-until-deployed contract whole. A DEPLOYED fn RAISEs 'schedule not found'
    // for this sentinel id, so skip ONLY on the function-missing error, not any error.
    const rpcProbe = await admin.rpc('compute_depreciation', {
      p_schedule_id: '00000000-0000-0000-0000-000000000000',
      p_period: PERIOD,
    });
    const rpcMissing =
      rpcProbe.error?.code === 'PGRST202' || /could not find the function/i.test(rpcProbe.error?.message ?? '');
    if (rpcMissing) {
      console.warn(
        `[depreciation-run] SKIPPED: compute_depreciation RPC not available ` +
          `(${rpcProbe.error?.message}). Apply migration 0095 and deploy the edge ` +
          `function, then this suite runs for real.`,
      );
      return;
    }
    featureAvailable = true;

    const org = await admin.from('organizations').insert({ name: `DR ${RUN}` }).select('id').single();
    if (org.error || !org.data) throw new Error(`org insert failed: ${org.error?.message}`);
    orgId = org.data.id as string;

    // Active: started Jan 2026, $12,000 over 5y → ~$200/mo → positive in Mar 2026.
    schedActiveId = await seedAssetWithSchedule(`active-${RUN}`, '2026-01-01', 1_200_000, 5);
    // Zero: started 2000, 5y life → fully depreciated decades before Mar 2026.
    schedZeroId = await seedAssetWithSchedule(`zero-${RUN}`, '2000-01-01', 100_000, 5);
  }, 60_000);

  afterAll(async () => {
    if (!HAS_ENV || !admin || !featureAvailable) return;
    // No journals are posted (fail-closed), but defensively clear any draft remnants.
    for (const id of [schedActiveId, schedZeroId]) {
      if (!id) continue;
      await admin.from('journal_entries').delete().eq('source_type', 'depreciation_schedule').eq('source_id', id);
    }
    if (orgId) {
      // depreciation_schedules cascade-delete with their fixed_assets.
      await admin.from('fixed_assets').delete().eq('organization_id', orgId);
      await admin.from('organizations').delete().eq('id', orgId);
    }
  }, 60_000);

  itLive('positive-amount schedule with no seeded COA → fails closed, no journal', async () => {
    if (!featureAvailable) return;
    const res = await invoke();
    expect(res.error, `invoke error: ${JSON.stringify(res.error)}`).toBeFalsy();
    const data = (res.data ?? {}) as {
      ok?: boolean;
      period?: string;
      stats?: {
        scanned: number;
        posted: number;
        skipped_zero: number;
        skipped_existing: number;
        errors: { schedule_id: string; error: string }[];
      };
    };
    expect(data.ok, `response not ok: ${JSON.stringify(data)}`).toBe(true);
    expect(data.period).toBe('2026-03-31'); // month-end of PERIOD's month
    const stats = data.stats;
    expect(stats, 'stats present in response').toBeTruthy();
    if (!stats) return;
    expect(stats.scanned).toBe(2);
    expect(stats.posted).toBe(0);
    expect(stats.skipped_zero).toBeGreaterThanOrEqual(1); // the fully-depreciated one
    // The active schedule could not resolve 6700/1900 → recorded as an error.
    expect(stats.errors.some((e) => e.schedule_id === schedActiveId)).toBe(true);

    expect(await journalsForSchedule(schedActiveId), 'no journal when post fails closed').toHaveLength(0);
    expect(await journalsForSchedule(schedZeroId), 'no journal for a zero-amount schedule').toHaveLength(0);
  });

  itLive('idempotent: invoking twice still posts no journal', async () => {
    if (!featureAvailable) return;
    await invoke();
    await invoke();
    expect(await journalsForSchedule(schedActiveId)).toHaveLength(0);
    expect(await journalsForSchedule(schedZeroId)).toHaveLength(0);
  });
});
