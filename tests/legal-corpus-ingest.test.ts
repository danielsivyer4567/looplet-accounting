import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { chunkLegalText } from '../supabase/functions/_shared/legal/chunk.ts';

/**
 * legal-corpus-ingest integration test (SC-LC.C.02).
 *
 * Exercises the deployed `legal-corpus-ingest` edge function against a live
 * Supabase, on a throwaway instrument (unique doc_ref) we ingest and tear down:
 *   - first ingest of a 2-section sample → both sections INSERTED, each with a
 *     non-null embedding + citation_url, all currently-in-force (effective_to NULL).
 *   - re-ingest of the identical text → idempotent: both sections UNCHANGED, no
 *     new rows (content_hash dedup).
 *   - ingest of a sample where ONE section's text changed, at a LATER
 *     effective_from → that section is VERSIONED (the prior version's
 *     effective_to is closed to the new date + a new live version inserted) while
 *     the unchanged section stays a no-op. The old version is preserved.
 *
 * Env required (mirrors tests/coding-classifier.test.ts):
 *   - VITE_SUPABASE_URL          (or SUPABASE_URL)
 *   - VITE_SUPABASE_ANON_KEY     (or SUPABASE_ANON_KEY)
 *   - SUPABASE_SERVICE_ROLE_KEY
 * It also requires migration 0108 applied AND the edge function deployed with
 * OPENAI_API_KEY set; if `legal_corpus` is absent the suite warns and skips
 * (out-of-branch schema — the same defensive pattern coding-classifier uses), and
 * if the deployed fn cannot embed (no OPENAI_API_KEY) it warns and skips the rest.
 *
 * Run: `npm run test:integration` (or target this file directly).
 */

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
const ANON_KEY = process.env['VITE_SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_ANON_KEY'] ?? '';
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';

const HAS_ENV = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_ROLE_KEY);
const IS_CI = Boolean(process.env['CI']);
const SKIP_REASON =
  'legal-corpus-ingest integration test requires VITE_SUPABASE_URL + ' +
  'VITE_SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY in env (it invokes the ' +
  'deployed edge function against a live Supabase).';

// HARD GATE in CI: a missing secret must fail RED, not silently skip.
if (IS_CI && !HAS_ENV) {
  throw new Error(
    `[legal-corpus-ingest] FATAL: integration test running in CI but its required ` +
      `env is missing, so it cannot assert behaviour. ${SKIP_REASON}`,
  );
}

const itLive = it.skipIf(!HAS_ENV);
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const DOC_REF = `ZZ-TEST-INGEST ${RUN}`;
const FN_URL = `${SUPABASE_URL}/functions/v1/legal-corpus-ingest`;

// Two hyphenated sections under a (dropped) division container. V2 changes ONLY
// 40-25's body; 40-30 is byte-identical so it must re-ingest as a no-op.
const SAMPLE_V1 = [
  'Division 40—Capital allowances',
  '',
  '40-25  Deducting amounts for depreciating assets',
  '   (1)  You can deduct the decline in value of a depreciating asset you held.',
  '',
  '40-30  What a depreciating asset is',
  '   (1)  A depreciating asset is an asset that has a limited effective life.',
].join('\n');

const SAMPLE_V2 = [
  'Division 40—Capital allowances',
  '',
  '40-25  Deducting amounts for depreciating assets',
  '   (1)  You can deduct the decline in value of a depreciating asset you held, worked out under this Division.',
  '',
  '40-30  What a depreciating asset is',
  '   (1)  A depreciating asset is an asset that has a limited effective life.',
].join('\n');

const EXPECTED = chunkLegalText(SAMPLE_V1, { doc_ref: DOC_REF }).map((c) => c.section_ref);

interface IngestResult {
  status: number;
  ok: boolean;
  body: Record<string, unknown>;
}

async function ingest(text: string, effectiveFrom: string): Promise<IngestResult> {
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      apikey: ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      doc_ref: DOC_REF,
      text,
      effective_from: effectiveFrom,
      citation_url: 'https://www.legislation.gov.au/C2004A05138',
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, ok: res.ok, body };
}

function stats(r: IngestResult): Record<string, number> {
  return (r.body['stats'] ?? {}) as Record<string, number>;
}

describe('legal-corpus-ingest (chunk + embed + versioned upsert)', () => {
  let admin: SupabaseClient;
  let featureAvailable = false;
  let canEmbed = true;

  async function rowsForDoc(): Promise<Record<string, unknown>[]> {
    const res = await admin
      .from('legal_corpus')
      .select('section_ref, embedding, citation_url, content_hash, effective_from, effective_to')
      .eq('doc_ref', DOC_REF)
      .is('deleted_at', null);
    expect(res.error, `select legal_corpus: ${res.error?.message}`).toBeNull();
    return (res.data ?? []) as Record<string, unknown>[];
  }

  beforeAll(async () => {
    if (!HAS_ENV) {
      console.warn(`[legal-corpus-ingest] SKIPPED: ${SKIP_REASON}`);
      return;
    }
    admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Defensive feature probe: migration 0108 may not be applied yet (migration
    // drift). Skip rather than hard-fail on missing out-of-branch schema.
    const probe = await admin.from('legal_corpus').select('id').limit(1);
    if (probe.error) {
      console.warn(
        `[legal-corpus-ingest] SKIPPED: legal_corpus not available ` +
          `(${probe.error.message}). Apply migration 0108 and deploy the edge ` +
          `function (with OPENAI_API_KEY), then this suite runs for real.`,
      );
      return;
    }
    featureAvailable = true;
  }, 60_000);

  afterAll(async () => {
    if (!HAS_ENV || !admin || !featureAvailable) return;
    await admin.from('legal_corpus').delete().eq('doc_ref', DOC_REF);
  }, 60_000);

  itLive('first ingest inserts every section with a non-null embedding', async () => {
    if (!featureAvailable) return;
    const r = await ingest(SAMPLE_V1, '2020-07-01');

    // The deployed fn cannot embed without OPENAI_API_KEY — treat that as a skip
    // (the embedding pipeline isn't provisioned), not a behavioural failure.
    if (!r.ok && /openai|embedding/i.test(String(r.body['error']))) {
      canEmbed = false;
      console.warn(`[legal-corpus-ingest] SKIPPED rest: deployed fn cannot embed (${r.body['error']}).`);
      return;
    }

    expect(r.status, `ingest failed: ${JSON.stringify(r.body)}`).toBe(200);
    expect(r.body['ok']).toBe(true);
    expect(stats(r)['inserted']).toBe(EXPECTED.length);
    expect(stats(r)['chunks']).toBe(EXPECTED.length);

    const rows = await rowsForDoc();
    expect(rows).toHaveLength(EXPECTED.length);
    expect(rows.map((x) => x['section_ref']).sort()).toEqual([...EXPECTED].sort());
    for (const row of rows) {
      expect(row['embedding'], `embedding for ${row['section_ref']}`).not.toBeNull();
      expect(row['citation_url']).toBe('https://www.legislation.gov.au/C2004A05138');
      expect(row['effective_to'], 'newly ingested law is currently in force').toBeNull();
    }
  });

  itLive('re-ingesting identical text is idempotent (no new rows)', async () => {
    if (!featureAvailable || !canEmbed) return;
    const r = await ingest(SAMPLE_V1, '2020-07-01');
    expect(r.status, `re-ingest failed: ${JSON.stringify(r.body)}`).toBe(200);
    expect(stats(r)['unchanged']).toBe(EXPECTED.length);
    expect(stats(r)['inserted']).toBe(0);
    expect(stats(r)['versioned']).toBe(0);
    expect(await rowsForDoc()).toHaveLength(EXPECTED.length);
  });

  itLive('a changed section at a later date is versioned; the old version is preserved', async () => {
    if (!featureAvailable || !canEmbed) return;
    const r = await ingest(SAMPLE_V2, '2024-07-01');
    expect(r.status, `version ingest failed: ${JSON.stringify(r.body)}`).toBe(200);
    expect(stats(r)['versioned'], 'exactly the changed section is versioned').toBe(1);
    expect(stats(r)['unchanged'], 'the byte-identical section is a no-op').toBe(1);
    expect(stats(r)['inserted']).toBe(0);

    // 40-25 now has two versions: the 2020 one closed to 2024-07-01, the 2024 one open.
    const rows = await rowsForDoc();
    const s4025 = rows.filter((x) => x['section_ref'] === 's 40-25');
    expect(s4025, 's 40-25 has both versions').toHaveLength(2);
    const old = s4025.find((x) => x['effective_from'] === '2020-07-01');
    const fresh = s4025.find((x) => x['effective_from'] === '2024-07-01');
    expect(old?.['effective_to'], 'prior version is closed at the new commencement').toBe('2024-07-01');
    expect(fresh?.['effective_to'], 'new version is currently in force').toBeNull();

    // 40-30 was unchanged → still a single live version.
    const s4030 = rows.filter((x) => x['section_ref'] === 's 40-30');
    expect(s4030, 's 40-30 stays a single version').toHaveLength(1);
    expect(s4030[0]?.['effective_to']).toBeNull();
  });
});
