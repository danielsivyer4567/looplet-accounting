import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * coding-classifier integration test (SC-1.C.02).
 *
 * Exercises the deployed `coding-classifier` edge function against a live
 * Supabase, on a throwaway org we seed and tear down:
 *   - a LOW-confidence bill (sender_domain match, ~0.88) → exactly ONE
 *     `coding_suggestions` row, status 'needs_review', confidence in [0,1) below
 *     the 0.9 auto-post threshold, a proposed account+tax code, NO journal, and
 *     it appears in `coding_review_queue`.
 *   - a HIGH-confidence bill (sender_address match, ~0.98) → the auto-post branch
 *     RUNS, but because this throwaway org's chart_of_accounts is NOT seeded the
 *     proposed account cannot resolve, so the classifier FAILS CLOSED to
 *     'needs_review' with an `auto_post_skipped` reason and writes NO journal.
 *   - idempotency: invoking twice still leaves exactly one live suggestion.
 *
 * The SUCCESSFUL balanced auto-post (≥0.9 → 'auto_posted' + posted journal) is
 * proven separately by a live ROLLED-BACK SQL transaction (see ledger
 * SC-1.C.02), because GL immutability (migration 0075) makes a committed posted
 * journal permanently undeletable — a vitest test that posted for real could
 * never clean up after itself.
 *
 * Env required (mirrors tests/tenant-isolation.test.ts):
 *   - VITE_SUPABASE_URL          (or SUPABASE_URL)
 *   - VITE_SUPABASE_ANON_KEY     (or SUPABASE_ANON_KEY)
 *   - SUPABASE_SERVICE_ROLE_KEY
 * It also requires migrations 0090-0092 applied AND the edge function deployed;
 * if `coding_suggestions` is absent the suite warns and skips (out-of-branch
 * schema, same defensive pattern tenant-isolation uses for bank_transactions).
 *
 * Run: `npm run test:integration` (or target this file directly).
 */

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
const ANON_KEY = process.env['VITE_SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_ANON_KEY'] ?? '';
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';

const HAS_ENV = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_ROLE_KEY);
const IS_CI = Boolean(process.env['CI']);
const SKIP_REASON =
  'coding-classifier integration test requires VITE_SUPABASE_URL + ' +
  'VITE_SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY in env (it invokes the ' +
  'deployed edge function against a live Supabase).';

// HARD GATE in CI: a missing secret must fail RED, not silently skip (same policy
// as the tenant-isolation deploy gate).
if (IS_CI && !HAS_ENV) {
  throw new Error(
    `[coding-classifier] FATAL: integration test running in CI but its required ` +
      `env is missing, so it cannot assert behaviour. ${SKIP_REASON}`,
  );
}

const itLive = it.skipIf(!HAS_ENV);
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const AUTO_POST_THRESHOLD = 0.9;

interface SeededBill {
  id: string;
}

describe('coding-classifier (auto-coding + review queue)', () => {
  let admin: SupabaseClient;
  let featureAvailable = false;
  let orgId = '';
  const billHi: SeededBill = { id: '' };
  const billLo: SeededBill = { id: '' };

  async function seedBill(sender: string, totalIncGst: number, gst: number): Promise<string> {
    const res = await admin
      .from('bills')
      .insert({
        organization_id: orgId,
        source: 'manual',
        storage_key: `cc/${RUN}/${sender}.pdf`,
        original_filename: `${sender}.pdf`,
        mime_type: 'application/pdf',
        total_inc_gst_cents: totalIncGst,
        gst_cents: gst,
        subtotal_ex_gst_cents: totalIncGst - gst,
        intake_metadata: { email_sender: sender },
      })
      .select('id')
      .single();
    if (res.error || !res.data) throw new Error(`seed bill failed: ${res.error?.message}`);
    return res.data.id as string;
  }

  async function invoke(billId: string) {
    return admin.functions.invoke('coding-classifier', { body: { bill_id: billId } });
  }

  async function liveSuggestions(billId: string): Promise<Record<string, unknown>[]> {
    const res = await admin.from('coding_suggestions').select('*').eq('bill_id', billId).is('deleted_at', null);
    expect(res.error, `select coding_suggestions: ${res.error?.message}`).toBeNull();
    return (res.data ?? []) as Record<string, unknown>[];
  }

  async function journalsForBill(billId: string): Promise<unknown[]> {
    const res = await admin
      .from('journal_entries')
      .select('id')
      .eq('source_type', 'bill')
      .eq('source_id', billId);
    expect(res.error, `select journal_entries: ${res.error?.message}`).toBeNull();
    return res.data ?? [];
  }

  beforeAll(async () => {
    if (!HAS_ENV) {
      console.warn(`[coding-classifier] SKIPPED: ${SKIP_REASON}`);
      return;
    }
    admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Defensive feature probe: this branch's migrations (0090-0092) may not be
    // applied to the target DB yet (migration-history drift). Skip rather than
    // hard-fail on missing out-of-branch schema.
    const probe = await admin.from('coding_suggestions').select('id').limit(1);
    if (probe.error) {
      console.warn(
        `[coding-classifier] SKIPPED: coding_suggestions not available ` +
          `(${probe.error.message}). Apply migrations 0090-0092 and deploy the ` +
          `edge function, then this suite runs for real.`,
      );
      return;
    }
    featureAvailable = true;

    const org = await admin.from('organizations').insert({ name: `CC ${RUN}` }).select('id').single();
    if (org.error || !org.data) throw new Error(`org insert failed: ${org.error?.message}`);
    orgId = org.data.id as string;

    const rules = await admin.from('intake_rules').insert([
      {
        organization_id: orgId,
        matcher_type: 'sender_address',
        matcher_value: `ap-hi-${RUN}@hicorp.test`,
        matcher_priority: 100,
        xero_account_code_override: '6400',
        xero_tax_type_override: 'GST',
        is_active: true,
      },
      {
        organization_id: orgId,
        matcher_type: 'sender_domain',
        matcher_value: `locorp-${RUN}.test`,
        matcher_priority: 100,
        xero_account_code_override: '6400',
        xero_tax_type_override: 'GST',
        is_active: true,
      },
    ]);
    if (rules.error) throw new Error(`intake_rules insert failed: ${rules.error.message}`);

    billHi.id = await seedBill(`ap-hi-${RUN}@hicorp.test`, 11000, 1000);
    billLo.id = await seedBill(`ap@locorp-${RUN}.test`, 5500, 500);
  }, 60_000);

  afterAll(async () => {
    if (!HAS_ENV || !admin || !featureAvailable) return;
    for (const id of [billHi.id, billLo.id]) {
      if (!id) continue;
      await admin.from('coding_suggestions').delete().eq('bill_id', id);
      await admin.from('bills').delete().eq('id', id);
    }
    if (orgId) {
      await admin.from('intake_rules').delete().eq('organization_id', orgId);
      await admin.from('organizations').delete().eq('id', orgId);
    }
  }, 60_000);

  itLive('low-confidence bill → one needs_review suggestion, no journal, in queue', async () => {
    if (!featureAvailable) return;
    const res = await invoke(billLo.id);
    expect(res.error, `invoke error: ${JSON.stringify(res.error)}`).toBeFalsy();

    const rows = await liveSuggestions(billLo.id);
    expect(rows, 'exactly one live suggestion').toHaveLength(1);
    const s = rows[0] ?? {};
    expect(s['status']).toBe('needs_review');
    const confidence = Number(s['confidence']);
    expect(confidence).toBeGreaterThanOrEqual(0);
    expect(confidence).toBeLessThan(AUTO_POST_THRESHOLD);
    expect(s['account_code']).toBe('6400');
    expect(s['tax_code']).toBe('GST');

    expect(await journalsForBill(billLo.id), 'no journal for a sub-threshold bill').toHaveLength(0);

    const queue = await admin.from('coding_review_queue').select('id').eq('bill_id', billLo.id);
    expect(queue.error, `coding_review_queue: ${queue.error?.message}`).toBeNull();
    expect(queue.data ?? [], 'low-confidence row appears in the review queue').toHaveLength(1);
  });

  itLive('high-confidence bill without seeded COA → fails closed to needs_review, no journal', async () => {
    if (!featureAvailable) return;
    const res = await invoke(billHi.id);
    expect(res.error, `invoke error: ${JSON.stringify(res.error)}`).toBeFalsy();

    const rows = await liveSuggestions(billHi.id);
    expect(rows).toHaveLength(1);
    const s = rows[0] ?? {};
    const confidence = Number(s['confidence']);
    expect(confidence).toBeGreaterThanOrEqual(AUTO_POST_THRESHOLD);
    // Auto-post branch ran but the proposed account does not resolve in this
    // un-seeded org's chart_of_accounts, so it must fail closed — never an
    // auto_posted row without a real journal.
    expect(s['status']).toBe('needs_review');
    const rationale = (s['rationale'] ?? {}) as Record<string, unknown>;
    expect(rationale['auto_post_skipped'], 'records why the post was skipped').toBeTruthy();
    expect(await journalsForBill(billHi.id), 'no journal when the post is skipped').toHaveLength(0);
  });

  itLive('idempotent: invoking twice keeps exactly one live suggestion', async () => {
    if (!featureAvailable) return;
    await invoke(billLo.id);
    await invoke(billLo.id);
    expect(await liveSuggestions(billLo.id)).toHaveLength(1);
  });
});
