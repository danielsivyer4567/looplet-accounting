import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';

/**
 * super-batch-send integration test (SC-3.G.01).
 *
 * Exercises the DEPLOYED `super-batch-send` edge fn against a live Supabase:
 * the full Tier-2 gate — refuse without approval, then succeed after approval,
 * then idempotent re-send. Flow:
 *   1. POST send (as the user) for a DRAFT batch → 403 + approval_id (the fn
 *      recorded a pending Tier-2 approval bound to the batch payload).
 *   2. Approve that row (service role flips status → 'approved').
 *   3. POST send again → 200 { sent: true }, batch → 'sent'.
 *   4. POST send again → 200 { already_sent: true } (no double-send).
 *
 * Skip-safe (NOT a CI hard-gate): needs the deployed fn + 0124/approvals live +
 * a user JWT + a draft TEST_SUPER_BATCH_ID, none of which exist in CI — so it
 * skips cleanly until provided. Env: VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY +
 * SUPABASE_SERVICE_ROLE_KEY + TEST_USER_JWT + TEST_ORG_ID + TEST_SUPER_BATCH_ID.
 */

const URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
const ANON = process.env['VITE_SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_ANON_KEY'] ?? '';
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
const USER_JWT = process.env['TEST_USER_JWT'] ?? '';
const ORG_ID = process.env['TEST_ORG_ID'] ?? '';
const BATCH_ID = process.env['TEST_SUPER_BATCH_ID'] ?? '';

const HAS_ENV = Boolean(URL && ANON && SERVICE && USER_JWT && ORG_ID && BATCH_ID);

if (!HAS_ENV) {
  console.warn(
    '[super-batch-send] SKIPPED: needs VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY + ' +
      'SUPABASE_SERVICE_ROLE_KEY + TEST_USER_JWT + TEST_ORG_ID + TEST_SUPER_BATCH_ID ' +
      '(deployed fn + 0124/approvals live + a draft batch).',
  );
}

async function send(): Promise<Response> {
  return fetch(`${URL}/functions/v1/super-batch-send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${USER_JWT}`, apikey: ANON },
    body: JSON.stringify({ organization_id: ORG_ID, super_batch_id: BATCH_ID }),
  });
}

describe.skipIf(!HAS_ENV)('super-batch-send (integration, deploy-gated)', () => {
  it('refuses without approval, succeeds after approval, then is idempotent', async () => {
    const admin = createClient(URL, SERVICE);

    // 1. refuse — the fn records a pending Tier-2 approval and 403s
    const refused = await send();
    expect(refused.status).toBe(403);
    const refusedBody = (await refused.json()) as { approval_id?: string };
    expect(refusedBody.approval_id).toBeTruthy();

    // 2. approve it (service role)
    const { error: approveErr } = await admin
      .from('approvals')
      .update({ status: 'approved', resolved_at: new Date().toISOString() })
      .eq('id', refusedBody.approval_id);
    expect(approveErr).toBeNull();

    // 3. now it sends
    const sent = await send();
    expect(sent.status).toBe(200);
    const sentBody = (await sent.json()) as { ok: boolean; sent?: boolean; status?: string };
    expect(sentBody.ok).toBe(true);
    expect(sentBody.sent).toBe(true);
    expect(sentBody.status).toBe('sent');

    // 4. re-send is idempotent (no double-send)
    const again = await send();
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as { ok: boolean; already_sent?: boolean };
    expect(againBody.ok).toBe(true);
    expect(againBody.already_sent).toBe(true);
  });
});
