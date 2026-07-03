import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Tier-2 approval hash-binding — RPC-level coverage (H1 hardening, lane/h-approval).
 *
 * Every existing Tier-2 test (super-batch-send, payment-runs-aba-export,
 * payroll-finalise-pay-run) exercises a specific money-mover/lodgement edge fn end
 * to end, but none of them isolate the actual guarantee `request_approval`/
 * `is_action_approved` (0104/0106) are supposed to provide: that the approval is
 * bound to the EXACT payload content via its sha256 hash, so approve-then-mutate
 * cannot slip through, and that the approvals ledger cannot be written directly by
 * a client (only through the DEFINER RPCs). This suite calls those two RPCs
 * directly against a throwaway resource, with no edge fn involved.
 *
 * Env (mirrors tests/payroll-finalise-pay-run.test.ts): VITE_SUPABASE_URL (or
 * SUPABASE_URL), VITE_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY),
 * SUPABASE_SERVICE_ROLE_KEY. Requires migrations 0090-0107 applied; if `approvals`
 * or `request_approval` are absent the suite warns and skips.
 */

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
const ANON_KEY = process.env['VITE_SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_ANON_KEY'] ?? '';
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';

const HAS_ENV = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_ROLE_KEY);
const IS_CI = Boolean(process.env['CI']);
const SKIP_REASON =
  'tier2-approval-hash integration test requires VITE_SUPABASE_URL + ' +
  'VITE_SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY in env (it calls ' +
  'request_approval/is_action_approved directly against a live Supabase).';

if (IS_CI && !HAS_ENV) {
  throw new Error(`[tier2-approval-hash] FATAL: running in CI but required env is missing. ${SKIP_REASON}`);
}

const itLive = it.skipIf(!HAS_ENV);
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const RESOURCE_TYPE = 'test_tier2_hash_probe';

describe('Tier-2 approval hash-binding (request_approval / is_action_approved RPCs)', () => {
  let admin: SupabaseClient;
  let owner: SupabaseClient;
  let featureAvailable = false;
  let orgId = '';
  let userId = '';
  const email = `t2h-owner-${RUN}@looplet.test`;
  const password = `Pw-${RUN}-aZ9!`;

  beforeAll(async () => {
    if (!HAS_ENV) {
      console.warn(`[tier2-approval-hash] SKIPPED: ${SKIP_REASON}`);
      return;
    }
    admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const probe = await admin.from('approvals').select('id').limit(1);
    if (probe.error) {
      console.warn(
        `[tier2-approval-hash] SKIPPED: approvals not available (${probe.error.message}). ` +
          'Apply migrations 0090-0107, then this suite runs for real.',
      );
      return;
    }
    featureAvailable = true;

    const org = await admin.from('organizations').insert({ name: `T2H ${RUN}` }).select('id').single();
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
  }, 60_000);

  afterAll(async () => {
    if (!HAS_ENV || !admin || !featureAvailable) return;
    await admin.from('approvals').delete().eq('organization_id', orgId).eq('resource_type', RESOURCE_TYPE);
    if (orgId) {
      await admin.from('organization_memberships').delete().eq('organization_id', orgId);
      await admin.from('organizations').delete().eq('id', orgId);
    }
    if (userId) await admin.auth.admin.deleteUser(userId);
  }, 60_000);

  itLive(
    'binds the approval to the exact payload: idempotent on identical content, a NEW pending row on any change, and never approved-by-association',
    async () => {
      if (!featureAvailable) return;
      const resourceId = crypto.randomUUID();
      const payloadA = { amount_cents: 150_00, reference: 'A' };
      const payloadB = { amount_cents: 150_00, reference: 'B' }; // one field differs -> different hash

      const first = await owner.rpc('request_approval', {
        p_org: orgId,
        p_resource_type: RESOURCE_TYPE,
        p_resource_id: resourceId,
        p_risk_tier: 'tier2_approve',
        p_payload: payloadA,
      });
      expect(first.error, `request_approval(A) error: ${first.error?.message}`).toBeNull();
      const idA = first.data as string;
      expect(idA).toBeTruthy();

      // Same resource, SAME payload -> returns the SAME row (idempotent), not a duplicate.
      const repeat = await owner.rpc('request_approval', {
        p_org: orgId,
        p_resource_type: RESOURCE_TYPE,
        p_resource_id: resourceId,
        p_risk_tier: 'tier2_approve',
        p_payload: payloadA,
      });
      expect(repeat.error).toBeNull();
      expect(repeat.data, 'identical payload reuses the existing pending row').toBe(idA);

      // Same resource, DIFFERENT payload -> a genuinely new pending row, not a mutation of A's.
      const second = await owner.rpc('request_approval', {
        p_org: orgId,
        p_resource_type: RESOURCE_TYPE,
        p_resource_id: resourceId,
        p_risk_tier: 'tier2_approve',
        p_payload: payloadB,
      });
      expect(second.error).toBeNull();
      const idB = second.data as string;
      expect(idB, 'a changed payload must not reuse the prior approval row').not.toBe(idA);

      // Neither is approved yet.
      const notApprovedA = await owner.rpc('is_action_approved', {
        p_org: orgId,
        p_resource_type: RESOURCE_TYPE,
        p_resource_id: resourceId,
        p_payload: payloadA,
      });
      expect(notApprovedA.data).toBe(false);

      // Approve ONLY row A (service role, simulating a human clicking approve).
      const approve = await admin
        .from('approvals')
        .update({ status: 'approved', resolved_at: new Date().toISOString() })
        .eq('id', idA);
      expect(approve.error).toBeNull();

      // A's exact payload now reads approved...
      const approvedA = await owner.rpc('is_action_approved', {
        p_org: orgId,
        p_resource_type: RESOURCE_TYPE,
        p_resource_id: resourceId,
        p_payload: payloadA,
      });
      expect(approvedA.error).toBeNull();
      expect(approvedA.data, 'exact-hash match on the approved payload').toBe(true);

      // ...but B (same resource, different content, still pending) is NOT approved by
      // association — this is the core guarantee: approve-then-mutate-payload can't pass.
      const stillNotApprovedB = await owner.rpc('is_action_approved', {
        p_org: orgId,
        p_resource_type: RESOURCE_TYPE,
        p_resource_id: resourceId,
        p_payload: payloadB,
      });
      expect(stillNotApprovedB.error).toBeNull();
      expect(stillNotApprovedB.data, 'a different payload on the same resource is never approved by association').toBe(false);
    },
    30_000,
  );

  itLive(
    'the approvals ledger cannot be written directly by an authenticated client (SELECT-only RLS)',
    async () => {
      if (!featureAvailable) return;
      const resourceId = crypto.randomUUID();

      // A client cannot forge an already-approved row by inserting directly.
      const forged = await owner.from('approvals').insert({
        organization_id: orgId,
        risk_tier: 'tier2_approve',
        status: 'approved',
        resource_type: RESOURCE_TYPE,
        resource_id: resourceId,
        payload_hash: 'a'.repeat(64),
      });
      expect(forged.error, 'direct INSERT into approvals must be rejected by RLS').not.toBeNull();

      // Nor can it self-approve a row it legitimately requested via the RPC.
      const created = await owner.rpc('request_approval', {
        p_org: orgId,
        p_resource_type: RESOURCE_TYPE,
        p_resource_id: resourceId,
        p_risk_tier: 'tier2_approve',
        p_payload: { reference: 'self-approve-attempt' },
      });
      expect(created.error).toBeNull();
      const approvalId = created.data as string;

      await owner
        .from('approvals')
        .update({ status: 'approved', resolved_at: new Date().toISOString() })
        .eq('id', approvalId);

      const check = await admin.from('approvals').select('status').eq('id', approvalId).single();
      expect(check.error).toBeNull();
      expect(check.data?.status, 'a direct client UPDATE must not flip status to approved').toBe('pending');
    },
    30_000,
  );
});
