import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * legal-horizon-scan integration test (SC-LC.F.02).
 *
 * Exercises the deployed `legal-horizon-scan` edge fn against a live Supabase using
 * its OPERATOR/TEST injection path (`body.items`) — which SKIPS Sonar so the upsert /
 * dedupe / idempotency behaviour is deterministic and needs no PERPLEXITY_API_KEY:
 *   - first scan of two distinct items → both INSERTED as open horizon rows.
 *   - a re-scan of the SAME items → both UPDATED in place (last_seen_at refreshed,
 *     first_seen_at + row id preserved), zero inserted — idempotent, no duplicates.
 *   - the same item posted twice in one batch → deduped to ONE inserted row.
 *
 * Env (mirrors tests/legal-corpus-sync.test.ts): VITE_SUPABASE_URL +
 * VITE_SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY. Requires 0113 applied + the fn
 * deployed. If `legal_horizon` is absent the suite warns and skips. The "are these
 * real, correctly-staged measures" check is the human spot-check (uses the live Sonar
 * path); the upsert/dedupe path is also proven by rolled-back live SQL (ledger F.02).
 */

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
const ANON_KEY = process.env['VITE_SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_ANON_KEY'] ?? '';
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';

const HAS_ENV = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_ROLE_KEY);
const IS_CI = Boolean(process.env['CI']);
const SKIP_REASON =
  'legal-horizon-scan integration test requires VITE_SUPABASE_URL + ' +
  'VITE_SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY in env.';

if (IS_CI && !HAS_ENV) {
  throw new Error(`[legal-horizon-scan] FATAL: CI run missing env, cannot assert. ${SKIP_REASON}`);
}

const itLive = it.skipIf(!HAS_ENV);
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const TOPIC = `ZZ-TEST-HORIZON ${RUN}`; // unique marker — all this run's rows share it (cleanup key)
const FN_URL = `${SUPABASE_URL}/functions/v1/legal-horizon-scan`;

const TITLE_A = `Test measure A ${RUN}`;
const TITLE_B = `Test measure B ${RUN}`;
const TITLE_DUP = `Test measure DUP ${RUN}`;

const ITEMS = [
  {
    title: TITLE_A,
    summary: 'A pending change for testing.',
    topic: TOPIC,
    stage: 'before_parliament',
    confidence: 0.8,
    proposed_effective_from: '2026-07-01',
    source_url: 'https://example.test/a',
    source_excerpt: 'excerpt A',
  },
  {
    title: TITLE_B,
    summary: 'Another pending change for testing.',
    topic: TOPIC,
    stage: 'exposure_draft',
    confidence: 0.6,
    proposed_effective_from: null,
    source_url: 'https://example.test/b',
    source_excerpt: 'excerpt B',
  },
];

interface HorizonRow {
  id: string;
  title: string;
  first_seen_at: string;
  last_seen_at: string;
  status: string;
}

async function scan(items: unknown[]): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      apikey: ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ items }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

function stats(body: Record<string, unknown>): Record<string, number> {
  return (body['stats'] ?? {}) as Record<string, number>;
}

describe('legal-horizon-scan (classify → idempotent upsert into legal_horizon)', () => {
  let admin: SupabaseClient;
  let featureAvailable = false;

  async function rowsByTopic(): Promise<HorizonRow[]> {
    const r = await admin
      .from('legal_horizon')
      .select('id, title, first_seen_at, last_seen_at, status')
      .eq('topic', TOPIC)
      .is('deleted_at', null);
    expect(r.error).toBeNull();
    return (r.data ?? []) as HorizonRow[];
  }

  beforeAll(async () => {
    if (!HAS_ENV) {
      console.warn(`[legal-horizon-scan] SKIPPED: ${SKIP_REASON}`);
      return;
    }
    admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const probe = await admin.from('legal_horizon').select('id').limit(1);
    if (probe.error) {
      console.warn(`[legal-horizon-scan] SKIPPED: legal_horizon not available. Apply 0113 + deploy the fn.`);
      return;
    }
    featureAvailable = true;
  }, 60_000);

  afterAll(async () => {
    if (!HAS_ENV || !admin || !featureAvailable) return;
    await admin.from('legal_horizon').delete().eq('topic', TOPIC);
  }, 60_000);

  itLive('first scan inserts each item as an open horizon row', async () => {
    if (!featureAvailable) return;
    const r = await scan(ITEMS);
    expect(r.status, `scan failed: ${JSON.stringify(r.body)}`).toBe(200);
    expect(stats(r.body)['inserted']).toBe(2);
    expect(stats(r.body)['updated']).toBe(0);

    const rows = await rowsByTopic();
    const a = rows.filter((x) => x.title === TITLE_A);
    const b = rows.filter((x) => x.title === TITLE_B);
    expect(a, 'one open row for A').toHaveLength(1);
    expect(b, 'one open row for B').toHaveLength(1);
    expect(a[0]?.status).toBe('open');
  });

  itLive('re-scan of the same items updates in place — no duplicates, last_seen_at refreshed', async () => {
    if (!featureAvailable) return;
    const before = await rowsByTopic();
    const beforeA = before.find((x) => x.title === TITLE_A);
    expect(beforeA, 'A exists from the first scan').toBeDefined();

    const r = await scan(ITEMS);
    expect(r.status, `re-scan failed: ${JSON.stringify(r.body)}`).toBe(200);
    expect(stats(r.body)['updated'], 'both existing items updated').toBe(2);
    expect(stats(r.body)['inserted'], 'nothing re-inserted').toBe(0);

    const after = await rowsByTopic();
    expect(after.filter((x) => x.title === TITLE_A), 'still one open row for A').toHaveLength(1);
    expect(after.filter((x) => x.title === TITLE_B), 'still one open row for B').toHaveLength(1);

    const afterA = after.find((x) => x.title === TITLE_A);
    expect(afterA?.id, 'same row (updated in place, not re-created)').toBe(beforeA?.id);
    expect(afterA?.first_seen_at, 'first_seen_at preserved').toBe(beforeA?.first_seen_at);
    expect(
      new Date(afterA?.last_seen_at ?? 0).getTime(),
      'last_seen_at refreshed',
    ).toBeGreaterThanOrEqual(new Date(beforeA?.last_seen_at ?? 0).getTime());
  });

  itLive('the same item twice in one batch is deduped to one inserted row', async () => {
    if (!featureAvailable) return;
    const dup = { ...ITEMS[0], title: TITLE_DUP };
    const r = await scan([dup, dup]);
    expect(r.status, `dup scan failed: ${JSON.stringify(r.body)}`).toBe(200);
    expect(stats(r.body)['inserted'], 'in-batch fingerprint dedupe → one insert').toBe(1);

    const rows = await rowsByTopic();
    expect(rows.filter((x) => x.title === TITLE_DUP), 'one open row for the dup title').toHaveLength(1);
  });
});
