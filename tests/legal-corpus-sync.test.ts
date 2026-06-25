import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { chunkLegalText } from '../supabase/functions/_shared/legal/chunk.ts';

/**
 * legal-corpus-sync integration test (SC-LC.E.03).
 *
 * Exercises the deployed `legal-corpus-sync` edge fn against a live Supabase, on a
 * throwaway source (unique name = doc_ref) we seed and tear down:
 *   - first sync of a 2-section text → both sections INSERTED (in force), each a
 *     'new' change event.
 *   - re-sync of a text where ONE section changed, at a LATER effective_from → that
 *     section is VERSIONED (prior closed + new version) with one 'amended' event,
 *     while the byte-identical section is a no-op. The old version is preserved.
 *
 * Env (mirrors tests/coding-classifier.test.ts): VITE_SUPABASE_URL +
 * VITE_SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY. Also requires 0108–0111
 * applied + the fn deployed with OPENAI_API_KEY. If `legal_sources`/`legal_corpus`
 * is absent the suite warns and skips; if the deployed fn cannot embed (no
 * OPENAI_API_KEY) it warns and skips the rest. The deeper "right sections" check is
 * the human spot-check; the version+event SQL path is also proven by rolled-back
 * live SQL (see ledger SC-LC.E.03).
 */

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
const ANON_KEY = process.env['VITE_SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_ANON_KEY'] ?? '';
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';

const HAS_ENV = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_ROLE_KEY);
const IS_CI = Boolean(process.env['CI']);
const SKIP_REASON =
  'legal-corpus-sync integration test requires VITE_SUPABASE_URL + ' +
  'VITE_SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY in env.';

if (IS_CI && !HAS_ENV) {
  throw new Error(`[legal-corpus-sync] FATAL: CI run missing env, cannot assert. ${SKIP_REASON}`);
}

const itLive = it.skipIf(!HAS_ENV);
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const DOC_REF = `ZZ-TEST-SYNC ${RUN}`; // legal_sources.name == corpus doc_ref (the E.03 convention)
const FN_URL = `${SUPABASE_URL}/functions/v1/legal-corpus-sync`;

const TEXT_V1 = [
  'Division 40—Capital allowances',
  '',
  '40-25  Deducting amounts for depreciating assets',
  '   (1)  You can deduct the decline in value of a depreciating asset you held.',
  '',
  '40-30  What a depreciating asset is',
  '   (1)  A depreciating asset is an asset that has a limited effective life.',
].join('\n');

const TEXT_V2 = [
  'Division 40—Capital allowances',
  '',
  '40-25  Deducting amounts for depreciating assets',
  '   (1)  You can deduct the decline in value of a depreciating asset you held, worked out under this Division.',
  '',
  '40-30  What a depreciating asset is',
  '   (1)  A depreciating asset is an asset that has a limited effective life.',
].join('\n');

const EXPECTED = chunkLegalText(TEXT_V1, { doc_ref: DOC_REF }).map((c) => c.section_ref);

async function sync(text: string, effectiveFrom: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      apikey: ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ source_name: DOC_REF, text, effective_from: effectiveFrom }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

function stats(body: Record<string, unknown>): Record<string, number> {
  return (body['stats'] ?? {}) as Record<string, number>;
}

describe('legal-corpus-sync (re-ingest → version-bump + change events)', () => {
  let admin: SupabaseClient;
  let featureAvailable = false;
  let canEmbed = true;

  beforeAll(async () => {
    if (!HAS_ENV) {
      console.warn(`[legal-corpus-sync] SKIPPED: ${SKIP_REASON}`);
      return;
    }
    admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const probe = await admin.from('legal_sources').select('id').limit(1);
    const probe2 = await admin.from('legal_corpus').select('id').limit(1);
    if (probe.error || probe2.error) {
      console.warn(
        `[legal-corpus-sync] SKIPPED: legal_sources/legal_corpus not available. Apply 0108–0111 + deploy the fn.`,
      );
      return;
    }
    featureAvailable = true;
    const ins = await admin
      .from('legal_sources')
      .insert({ name: DOC_REF, kind: 'act', canonical_url: 'https://example.test/sync', check_method: 'frl_api' });
    if (ins.error) throw new Error(`seed source failed: ${ins.error.message}`);
  }, 60_000);

  afterAll(async () => {
    if (!HAS_ENV || !admin || !featureAvailable) return;
    await admin.from('legal_change_events').delete().eq('doc_ref', DOC_REF);
    await admin.from('legal_corpus').delete().eq('doc_ref', DOC_REF);
    await admin.from('legal_sources').delete().eq('name', DOC_REF);
  }, 60_000);

  itLive('first sync inserts every section in force', async () => {
    if (!featureAvailable) return;
    const r = await sync(TEXT_V1, '2020-07-01');
    if (r.status !== 200 && /openai|embedding/i.test(String(r.body['error']))) {
      canEmbed = false;
      console.warn(`[legal-corpus-sync] SKIPPED rest: deployed fn cannot embed (${r.body['error']}).`);
      return;
    }
    expect(r.status, `sync failed: ${JSON.stringify(r.body)}`).toBe(200);
    expect(stats(r.body)['inserted']).toBe(EXPECTED.length);

    const rows = await admin
      .from('legal_corpus')
      .select('section_ref, effective_to')
      .eq('doc_ref', DOC_REF)
      .is('deleted_at', null);
    expect(rows.error).toBeNull();
    expect(rows.data ?? []).toHaveLength(EXPECTED.length);
    expect((rows.data ?? []).every((x) => x.effective_to === null)).toBe(true);
  });

  itLive('re-sync with one changed section versions it + emits an amended event; old preserved', async () => {
    if (!featureAvailable || !canEmbed) return;
    const r = await sync(TEXT_V2, '2024-07-01');
    expect(r.status, `re-sync failed: ${JSON.stringify(r.body)}`).toBe(200);
    expect(stats(r.body)['versioned'], 'only the changed section is versioned').toBe(1);
    expect(stats(r.body)['unchanged'], 'the byte-identical section is a no-op').toBe(1);

    // s 40-25 now has two versions: the 2020 one closed to 2024-07-01, the 2024 one open.
    const s4025 = await admin
      .from('legal_corpus')
      .select('effective_from, effective_to')
      .eq('doc_ref', DOC_REF)
      .eq('section_ref', 's 40-25')
      .is('deleted_at', null);
    expect(s4025.error).toBeNull();
    expect(s4025.data ?? [], 's 40-25 has both versions').toHaveLength(2);
    const old = (s4025.data ?? []).find((x) => x.effective_from === '2020-07-01');
    const fresh = (s4025.data ?? []).find((x) => x.effective_from === '2024-07-01');
    expect(old?.effective_to, 'prior version closed at the new commencement').toBe('2024-07-01');
    expect(fresh?.effective_to, 'new version currently in force').toBeNull();

    // an 'amended' change event for s 40-25 was recorded.
    const ev = await admin
      .from('legal_change_events')
      .select('change_kind')
      .eq('doc_ref', DOC_REF)
      .eq('section_ref', 's 40-25')
      .eq('change_kind', 'amended');
    expect(ev.error).toBeNull();
    expect((ev.data ?? []).length, 'one amended event for the changed section').toBeGreaterThanOrEqual(1);
  });
});
