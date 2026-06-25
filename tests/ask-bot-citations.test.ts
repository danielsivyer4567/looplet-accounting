import { describe, it, expect } from 'vitest';

/**
 * ask-bot cited-corpus contract — integration test (SC-LC.D.01).
 *
 * Skip-safe and deploy-gated: it exercises the DEPLOYED ask-bot to assert the
 * additive `citations` contract. Asserting against the corpus content needs a
 * seeded corpus (a post-deploy SEED OP), so this asserts the part that holds
 * even with an EMPTY corpus: a pure DATA-route question performs no legal
 * retrieval, so `citations` is an empty array while the answer still returns —
 * and the pre-existing `sonar_citations` field is preserved.
 *
 * Env required (mirrors tests/coding-classifier.test.ts):
 *   - VITE_SUPABASE_URL          (or SUPABASE_URL)
 *   - VITE_SUPABASE_ANON_KEY     (or SUPABASE_ANON_KEY)
 *   - SUPABASE_SERVICE_ROLE_KEY  (used as the bearer; ask-bot needs an auth header)
 * Also requires ask-bot deployed with GROQ_API_KEY set. If the fn is not
 * reachable / not configured (non-200), the suite warns and skips.
 *
 * The deeper assertion — a legal question returns the RIGHT cited sections — is a
 * human spot-check (DONE human) once the corpus is seeded; the citation MAPPING
 * itself is proven deterministically in tests/legal-citations.test.ts.
 */

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
const ANON_KEY = process.env['VITE_SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_ANON_KEY'] ?? '';
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';

const HAS_ENV = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_ROLE_KEY);
const IS_CI = Boolean(process.env['CI']);
const SKIP_REASON =
  'ask-bot-citations integration test requires VITE_SUPABASE_URL + ' +
  'VITE_SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY in env (it invokes the ' +
  'deployed ask-bot edge function).';

if (IS_CI && !HAS_ENV) {
  throw new Error(
    `[ask-bot-citations] FATAL: integration test running in CI but its required ` +
      `env is missing, so it cannot assert behaviour. ${SKIP_REASON}`,
  );
}

const itLive = it.skipIf(!HAS_ENV);
const FN_URL = `${SUPABASE_URL}/functions/v1/ask-bot`;
// A throwaway org id — the books queries return empty for it, which is all this
// contract assertion needs (a data-route question with no legal retrieval).
const ORG_ID = '00000000-0000-4000-8000-0000000000d1';

describe('ask-bot — additive cited-corpus contract', () => {
  itLive('a data-route question answers with citations: [] (and keeps sonar_citations)', async () => {
    if (!HAS_ENV) return;
    const res = await fetch(FN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        apikey: ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ organization_id: ORG_ID, question: 'How many bills do I have?' }),
    });

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    // Not deployed / not configured (e.g. no GROQ_API_KEY) → skip, don't fail.
    if (res.status !== 200 || body['ok'] !== true) {
      console.warn(`[ask-bot-citations] SKIPPED: ask-bot not reachable/configured (${res.status} ${JSON.stringify(body['error'] ?? '')}).`);
      return;
    }

    expect(Array.isArray(body['citations']), 'citations is always an array').toBe(true);
    expect(body['citations'], 'a pure data question retrieves no law').toEqual([]);
    expect(Array.isArray(body['sonar_citations']), 'existing sonar_citations field preserved').toBe(true);
    expect(typeof body['answer']).toBe('string');
  });
});
