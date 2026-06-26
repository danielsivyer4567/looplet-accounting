import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * coding-classifier CROSS-TENANT authorization regression test.
 *
 * Guards the IDOR closed in the coding-classifier auth fix: the function loads the
 * target bill through a CALLER-SCOPED client so RLS on `bills` decides visibility.
 * A logged-in member of org A must NOT be able to code / post against a bill in
 * org B just by knowing its bill_id.
 *
 * Mirrors tests/tenant-isolation.test.ts's self-seeding pattern: with the service
 * role we create two throwaway users + orgs + memberships and seed one bill into
 * each; with the anon key we sign in as each user to get real RLS-subject JWTs and
 * invoke the deployed function as that user.
 *
 *   - SECURITY: user A invoking coding-classifier on org B's bill_id is rejected
 *     (no 2xx success) and writes NO coding_suggestions row + NO journal for B's
 *     bill — the cross-tenant write never happens.
 *   - POSITIVE CONTROL: user A invoking on org A's OWN bill succeeds and writes a
 *     suggestion — proving the empty cross-tenant result is RLS, not a dead function.
 *
 * Env required (mirrors tenant-isolation): VITE_SUPABASE_URL (or SUPABASE_URL),
 * VITE_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY), SUPABASE_SERVICE_ROLE_KEY. Also
 * requires migrations 0090-0092 applied AND the edge function deployed (with the
 * auth fix); if coding_suggestions is absent the suite warns and skips.
 *
 * Run: `npm run test:integration` (or target this file directly).
 */

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
const ANON_KEY = process.env['VITE_SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_ANON_KEY'] ?? '';
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';

const HAS_ENV = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_ROLE_KEY);
const IS_CI = Boolean(process.env['CI']);
const SKIP_REASON =
  'coding-classifier cross-tenant test requires VITE_SUPABASE_URL + ' +
  'VITE_SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY in env (it signs in real ' +
  'users and invokes the deployed edge function against a live Supabase).';

// HARD GATE in CI: a missing secret must fail RED, not silently skip — this guards a
// cross-tenant write hole, so a silent skip would let a P0 regression ship.
if (IS_CI && !HAS_ENV) {
  throw new Error(
    `[coding-classifier-tenant] FATAL: cross-tenant regression running in CI but its ` +
      `required env is missing, so it cannot assert isolation. ${SKIP_REASON}`,
  );
}

const itLive = it.skipIf(!HAS_ENV);
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

interface Tenant {
  email: string;
  userId: string;
  orgId: string;
  billId: string;
  client: SupabaseClient; // anon client authenticated as this tenant's member
}

describe('coding-classifier (cross-tenant authorization)', () => {
  let admin: SupabaseClient;
  let featureAvailable = false;
  let tenantA: Tenant;
  let tenantB: Tenant;

  // Create a user + org + owner membership + one bill, and sign in as the user.
  // No supplier_name_raw → the bills autolink trigger (0028) creates no supplier,
  // so teardown is just bill + membership + org + user.
  async function provision(tag: string): Promise<Tenant> {
    const email = `cc-iso-${tag}-${RUN}@example.test`;
    const password = `Cc!${RUN}!${tag}`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error(`createUser(${tag}): ${created.error?.message}`);
    const userId = created.data.user.id;

    const org = await admin.from('organizations').insert({ name: `CC ISO ${tag} ${RUN}` }).select('id').single();
    if (org.error || !org.data) throw new Error(`org insert(${tag}): ${org.error?.message}`);
    const orgId = org.data.id as string;

    const mem = await admin
      .from('organization_memberships')
      .insert({ user_id: userId, organization_id: orgId, role: 'owner', is_default: true });
    if (mem.error) throw new Error(`membership insert(${tag}): ${mem.error.message}`);

    const bill = await admin
      .from('bills')
      .insert({
        organization_id: orgId,
        source: 'manual',
        storage_key: `cc-iso/${RUN}/${tag}.pdf`,
        original_filename: `${tag}.pdf`,
        mime_type: 'application/pdf',
        total_inc_gst_cents: 11000,
        gst_cents: 1000,
        subtotal_ex_gst_cents: 10000,
      })
      .select('id')
      .single();
    if (bill.error || !bill.data) throw new Error(`bill insert(${tag}): ${bill.error?.message}`);

    const client = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error || !signIn.data.session) throw new Error(`signIn(${tag}): ${signIn.error?.message}`);

    return { email, userId, orgId, billId: bill.data.id as string, client };
  }

  async function suggestionsFor(billId: string): Promise<unknown[]> {
    const res = await admin.from('coding_suggestions').select('id').eq('bill_id', billId);
    expect(res.error, `select coding_suggestions: ${res.error?.message}`).toBeNull();
    return res.data ?? [];
  }

  async function journalsFor(billId: string): Promise<unknown[]> {
    const res = await admin.from('journal_entries').select('id').eq('source_type', 'bill').eq('source_id', billId);
    expect(res.error, `select journal_entries: ${res.error?.message}`).toBeNull();
    return res.data ?? [];
  }

  beforeAll(async () => {
    if (!HAS_ENV) {
      console.warn(`[coding-classifier-tenant] SKIPPED: ${SKIP_REASON}`);
      return;
    }
    admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const probe = await admin.from('coding_suggestions').select('id').limit(1);
    if (probe.error) {
      console.warn(
        `[coding-classifier-tenant] SKIPPED: coding_suggestions not available ` +
          `(${probe.error.message}). Apply migrations 0090-0092 and deploy the edge function.`,
      );
      return;
    }
    featureAvailable = true;
    tenantA = await provision('A');
    tenantB = await provision('B');
  }, 60_000);

  afterAll(async () => {
    if (!HAS_ENV || !admin || !featureAvailable) return;
    const failures: string[] = [];
    for (const t of [tenantA, tenantB]) {
      if (!t) continue;
      await admin.from('coding_suggestions').delete().eq('bill_id', t.billId);
      await admin.from('journal_entries').delete().eq('source_type', 'bill').eq('source_id', t.billId);
      await admin.from('bills').delete().eq('id', t.billId);
      await admin.from('organization_memberships').delete().eq('organization_id', t.orgId);
      const orgDel = await admin.from('organizations').delete().eq('id', t.orgId);
      if (orgDel.error) failures.push(`org ${t.orgId}: ${orgDel.error.message}`);
      const userDel = await admin.auth.admin.deleteUser(t.userId);
      if (userDel.error) failures.push(`user ${t.userId}: ${userDel.error.message}`);
    }
    if (failures.length) throw new Error(`[coding-classifier-tenant] teardown failed:\n  ${failures.join('\n  ')}`);
  }, 60_000);

  itLive('member of org A CANNOT code org B\'s bill (no cross-tenant write)', async () => {
    if (!featureAvailable) return;
    // Invoke AS user A (their JWT) against org B's bill_id.
    const res = await tenantA.client.functions.invoke('coding-classifier', { body: { bill_id: tenantB.billId } });
    // Never a 2xx success: a 404 surfaces as res.error (data null → okFlag undefined),
    // and any body must not be ok:true. (If user A's JWT somehow weren't reaching the
    // fn at all, this assertion would still pass — but then the positive-control test
    // below would FAIL its expected write, so a "testing nothing" false-pass cannot
    // slip through unnoticed.)
    const okFlag = (res.data as { ok?: boolean } | null)?.ok;
    expect(okFlag, 'cross-tenant invoke must not succeed').not.toBe(true);

    // The load-bearing assertion: NOTHING was written for org B's bill.
    expect(await suggestionsFor(tenantB.billId), 'no coding suggestion written for org B').toHaveLength(0);
    expect(await journalsFor(tenantB.billId), 'no journal posted for org B').toHaveLength(0);
  });

  itLive('member of org A CAN code their OWN bill (positive control)', async () => {
    if (!featureAvailable) return;
    const res = await tenantA.client.functions.invoke('coding-classifier', { body: { bill_id: tenantA.billId } });
    expect(res.error, `own-org invoke error: ${JSON.stringify(res.error)}`).toBeFalsy();
    expect((res.data as { ok?: boolean } | null)?.ok, 'own-org invoke succeeds').toBe(true);
    // Proves the gate allows legitimate same-org access (so the empty B result above
    // is RLS doing its job, not a dead function).
    expect(await suggestionsFor(tenantA.billId), 'a suggestion is written for the own-org bill').toHaveLength(1);
  });
});
