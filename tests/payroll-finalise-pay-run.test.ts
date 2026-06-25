import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * payroll-finalise-pay-run Tier-2 approval gate surfacing (SC-2.D.02).
 *
 * The RPC (SC-2.D.01) raises 'approval required ...' when a pay run has no live
 * Tier-2 approval; this edge fn must map that to HTTP 403 (not 400) AND record a
 * pending approval so an admin can approve it. Asserts refusal-then-success on a
 * throwaway org (no pay_slips needed — the gate works on an empty slip set):
 *   1. POST finalise with NO approval -> 403, body.error matches /approval required/,
 *      body.approval_id set, run NOT 'paid'.
 *   2. The owner approve()s it.
 *   3. The SAME POST -> 200 { ok:true }, run flips to 'paid'.
 *
 * Env (mirrors tests/coding-classifier.test.ts): VITE_SUPABASE_URL (or SUPABASE_URL),
 * VITE_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY), SUPABASE_SERVICE_ROLE_KEY. Requires
 * migrations 0090-0107 applied AND the edge fn deployed; if `approvals` is absent the
 * suite warns and skips (out-of-branch schema, the house defensive pattern).
 */

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
const ANON_KEY = process.env['VITE_SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_ANON_KEY'] ?? '';
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';

const HAS_ENV = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_ROLE_KEY);
const IS_CI = Boolean(process.env['CI']);
const SKIP_REASON =
  'payroll-finalise-pay-run integration test requires VITE_SUPABASE_URL + ' +
  'VITE_SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY in env (it invokes the ' +
  'deployed edge function against a live Supabase).';

if (IS_CI && !HAS_ENV) {
  throw new Error(
    `[payroll-finalise-pay-run] FATAL: integration test running in CI but its required ` +
      `env is missing, so it cannot assert behaviour. ${SKIP_REASON}`,
  );
}

const itLive = it.skipIf(!HAS_ENV);
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const FN_URL = `${SUPABASE_URL}/functions/v1/payroll-finalise-pay-run`;

async function callFinalise(token: string, run_id: string) {
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ run_id }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

describe('payroll-finalise-pay-run (Tier-2 approval gate → 403)', () => {
  let admin: SupabaseClient;
  let owner: SupabaseClient;
  let featureAvailable = false;
  let orgId = '';
  let userId = '';
  let runId = '';
  let token = '';
  const email = `pf-owner-${RUN}@looplet.test`;
  const password = `Pw-${RUN}-aZ9!`;

  beforeAll(async () => {
    if (!HAS_ENV) {
      console.warn(`[payroll-finalise-pay-run] SKIPPED: ${SKIP_REASON}`);
      return;
    }
    admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const probe = await admin.from('approvals').select('id').limit(1);
    if (probe.error) {
      console.warn(
        `[payroll-finalise-pay-run] SKIPPED: approvals not available ` +
          `(${probe.error.message}). Apply migrations 0090-0107 and deploy the ` +
          `edge function, then this suite runs for real.`,
      );
      return;
    }
    featureAvailable = true;

    const org = await admin.from('organizations').insert({ name: `PF ${RUN}` }).select('id').single();
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
    token = session.data.session.access_token;

    // A draft pay run with no slips — the gate works on an empty slip set.
    const run = await admin
      .from('pay_runs')
      .insert({ organization_id: orgId, period_start: '2026-06-01', period_end: '2026-06-14', pay_date: '2026-06-20' })
      .select('id')
      .single();
    if (run.error || !run.data) throw new Error(`pay_run insert failed: ${run.error?.message}`);
    runId = run.data.id as string;
  }, 60_000);

  afterAll(async () => {
    if (!HAS_ENV || !admin || !featureAvailable) return;
    if (runId) {
      await admin.from('approvals').delete().eq('resource_id', runId);
      await admin.from('pay_runs').delete().eq('id', runId);
    }
    if (orgId) {
      await admin.from('organization_memberships').delete().eq('organization_id', orgId);
      await admin.from('organizations').delete().eq('id', orgId);
    }
    if (userId) await admin.auth.admin.deleteUser(userId);
  }, 60_000);

  itLive('approval-required finalise returns 403 (not 400), then 200 after approve()', async () => {
    if (!featureAvailable) return;

    // 1. No approval -> 403 (not 400), actionable message, pending approval recorded, not paid.
    const first = await callFinalise(token, runId);
    expect(first.status, `first POST body: ${JSON.stringify(first.body)}`).toBe(403);
    expect(String(first.body['error'])).toMatch(/approval required/i);
    const approvalId = first.body['approval_id'] as string | null;
    expect(approvalId, 'fn records a pending approval to approve').toBeTruthy();

    const afterRefuse = await admin.from('pay_runs').select('status').eq('id', runId).single();
    expect(afterRefuse.data?.status, 'run not paid while unapproved').not.toBe('paid');

    // 2. Owner approves.
    const approved = await owner.rpc('approve', { p_approval_id: approvalId });
    expect(approved.error, `approve() error: ${approved.error?.message}`).toBeNull();

    // 3. Same POST now finalises.
    const second = await callFinalise(token, runId);
    expect(second.status, `second POST body: ${JSON.stringify(second.body)}`).toBe(200);
    expect(second.body['ok']).toBe(true);

    const afterPay = await admin.from('pay_runs').select('status').eq('id', runId).single();
    expect(afterPay.data?.status, 'run paid after approval').toBe('paid');
  }, 60_000);
});
