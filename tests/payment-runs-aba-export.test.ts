import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * payment-runs-aba-export Tier-2 approval gate (SC-2.C.01).
 *
 * Asserts the refusal-then-success contract in ONE test against the deployed
 * edge function on a throwaway org we seed and tear down:
 *   1. POST with NO matching approval  -> 403 { ok:false, approval_id } AND the
 *      payment_run is NOT flipped to 'exported'. The fn records a pending Tier-2
 *      approval (bound to the exact item-set payload) so an admin can approve it.
 *   2. The owner approve()s that approval.
 *   3. The SAME POST -> 200 { ok:true } AND the payment_run flips to 'exported'.
 *
 * Uses raw fetch (not functions.invoke) so we can assert the 403/200 status codes
 * directly. The owner's JWT drives both the edge fn (which getUser()s it) and the
 * approve() RPC (which require_role-gates auth.uid()).
 *
 * Env required (mirrors tests/coding-classifier.test.ts):
 *   - VITE_SUPABASE_URL          (or SUPABASE_URL)
 *   - VITE_SUPABASE_ANON_KEY     (or SUPABASE_ANON_KEY)
 *   - SUPABASE_SERVICE_ROLE_KEY
 * It also requires migrations 0090-0106 applied AND the edge function deployed; if
 * the `approvals` table is absent the suite warns and skips (out-of-branch schema,
 * the same defensive pattern coding-classifier/tenant-isolation use).
 */

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
const ANON_KEY = process.env['VITE_SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_ANON_KEY'] ?? '';
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';

const HAS_ENV = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_ROLE_KEY);
const IS_CI = Boolean(process.env['CI']);
const SKIP_REASON =
  'payment-runs-aba-export integration test requires VITE_SUPABASE_URL + ' +
  'VITE_SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY in env (it invokes the ' +
  'deployed edge function against a live Supabase).';

// HARD GATE in CI: a missing secret must fail RED, not silently skip.
if (IS_CI && !HAS_ENV) {
  throw new Error(
    `[payment-runs-aba-export] FATAL: integration test running in CI but its required ` +
      `env is missing, so it cannot assert behaviour. ${SKIP_REASON}`,
  );
}

const itLive = it.skipIf(!HAS_ENV);
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const FN_URL = `${SUPABASE_URL}/functions/v1/payment-runs-aba-export`;

async function callExport(token: string, organization_id: string, payment_run_id: string) {
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ organization_id, payment_run_id }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

describe('payment-runs-aba-export (Tier-2 approval gate)', () => {
  let admin: SupabaseClient;
  let owner: SupabaseClient; // authenticated as the seeded owner
  let featureAvailable = false;
  let orgId = '';
  let userId = '';
  let runId = '';
  let billId = '';
  let token = '';
  const email = `pr-owner-${RUN}@looplet.test`;
  const password = `Pw-${RUN}-aZ9!`;

  beforeAll(async () => {
    if (!HAS_ENV) {
      console.warn(`[payment-runs-aba-export] SKIPPED: ${SKIP_REASON}`);
      return;
    }
    admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Defensive feature probe: this branch's migrations (0090-0106) may not be
    // applied to the target DB yet (migration-history drift). Skip rather than
    // hard-fail on missing out-of-branch schema.
    const probe = await admin.from('approvals').select('id').limit(1);
    if (probe.error) {
      console.warn(
        `[payment-runs-aba-export] SKIPPED: approvals not available ` +
          `(${probe.error.message}). Apply migrations 0090-0106 and deploy the ` +
          `edge function, then this suite runs for real.`,
      );
      return;
    }
    featureAvailable = true;

    // Org + payer bank details (the fn refuses 422 without them).
    const org = await admin
      .from('organizations')
      .insert({
        name: `PR ${RUN}`,
        settings: { payer_bsb: '062-000', payer_account: '12345678', payer_name: `PR ${RUN}` },
      })
      .select('id')
      .single();
    if (org.error || !org.data) throw new Error(`org insert failed: ${org.error?.message}`);
    orgId = org.data.id as string;

    // Owner user + membership (role_enum='owner' so approve() passes require_role).
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (created.error || !created.data.user) throw new Error(`createUser failed: ${created.error?.message}`);
    userId = created.data.user.id;
    const mem = await admin.from('organization_memberships').insert({
      organization_id: orgId,
      user_id: userId,
      role: 'owner',
      role_enum: 'owner',
    });
    if (mem.error) throw new Error(`membership insert failed: ${mem.error.message}`);

    // Sign the owner in to get a JWT for the edge fn + approve() RPC.
    owner = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
    const session = await owner.auth.signInWithPassword({ email, password });
    if (session.error || !session.data.session) throw new Error(`signIn failed: ${session.error?.message}`);
    token = session.data.session.access_token;

    // A bill (payment_run_items.bill_id is NOT NULL).
    const bill = await admin
      .from('bills')
      .insert({
        organization_id: orgId,
        source: 'manual',
        storage_key: `pr/${RUN}/bill.pdf`,
        original_filename: 'bill.pdf',
        mime_type: 'application/pdf',
        total_inc_gst_cents: 11000,
        gst_cents: 1000,
        subtotal_ex_gst_cents: 10000,
      })
      .select('id')
      .single();
    if (bill.error || !bill.data) throw new Error(`bill insert failed: ${bill.error?.message}`);
    billId = bill.data.id as string;

    // Payment run (draft) + one item.
    const run = await admin
      .from('payment_runs')
      .insert({ organization_id: orgId, pay_date: '2026-06-30', total_cents: 11000, bill_count: 1 })
      .select('id')
      .single();
    if (run.error || !run.data) throw new Error(`payment_run insert failed: ${run.error?.message}`);
    runId = run.data.id as string;

    const item = await admin.from('payment_run_items').insert({
      payment_run_id: runId,
      organization_id: orgId,
      bill_id: billId,
      amount_cents: 11000,
      payee_bsb: '062-111',
      payee_account_number: '87654321',
      payee_account_name: 'ACME PTY LTD',
      reference: `INV-${RUN}`,
    });
    if (item.error) throw new Error(`payment_run_item insert failed: ${item.error.message}`);
  }, 60_000);

  afterAll(async () => {
    if (!HAS_ENV || !admin || !featureAvailable) return;
    if (runId) {
      await admin.from('approvals').delete().eq('resource_id', runId);
      await admin.from('payment_run_items').delete().eq('payment_run_id', runId);
      await admin.from('payment_runs').delete().eq('id', runId);
    }
    if (billId) await admin.from('bills').delete().eq('id', billId);
    if (orgId) {
      await admin.from('organization_memberships').delete().eq('organization_id', orgId);
      await admin.from('organizations').delete().eq('id', orgId);
    }
    if (userId) await admin.auth.admin.deleteUser(userId);
  }, 60_000);

  itLive('refuses without approval (403), then exports after approve() (200)', async () => {
    if (!featureAvailable) return;

    // 1. No approval yet -> 403, run stays un-exported, a pending approval is recorded.
    const first = await callExport(token, orgId, runId);
    expect(first.status, `first POST body: ${JSON.stringify(first.body)}`).toBe(403);
    expect(first.body['ok']).toBe(false);
    const approvalId = first.body['approval_id'] as string | null;
    expect(approvalId, 'fn records a pending approval to approve').toBeTruthy();

    const afterRefuse = await admin.from('payment_runs').select('status').eq('id', runId).single();
    expect(afterRefuse.data?.status, 'run not exported while unapproved').not.toBe('exported');

    // 2. Owner approves the pending Tier-2 approval.
    const approved = await owner.rpc('approve', { p_approval_id: approvalId });
    expect(approved.error, `approve() error: ${approved.error?.message}`).toBeNull();

    // 3. Same POST now succeeds and exports.
    const second = await callExport(token, orgId, runId);
    expect(second.status, `second POST body: ${JSON.stringify(second.body)}`).toBe(200);
    expect(second.body['ok']).toBe(true);

    const afterExport = await admin.from('payment_runs').select('status').eq('id', runId).single();
    expect(afterExport.data?.status, 'run exported after approval').toBe('exported');
  }, 60_000);
});
