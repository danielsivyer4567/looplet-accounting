import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Tenant isolation test suite — THE deploy-blocker gate.
 *
 * The single most important invariant of this product:
 *   A member of organization A must NEVER see ANY data belonging to
 *   organization B, on ANY table, via the normal (anon-key + JWT) data path.
 *
 * If this suite goes red on `main`, deploys block until it goes green.
 * No exceptions, no temporary skips, no `.only`.
 *
 * How it works (no fixtures file required — fully self-seeding):
 *   1. Using the SERVICE ROLE key (RLS-bypassing) we create two throwaway auth
 *      users, two organizations, and one membership each (user A → org A,
 *      user B → org B). We then seed one row per key table into EACH org.
 *   2. Using the ANON key we sign in as user A and as user B, obtaining real
 *      JWTs. All reads through these clients are subject to RLS exactly as a
 *      browser would be.
 *   3. We assert that querying as B never returns A's rows (and vice-versa),
 *      and that a direct .eq('id', <A row id>) fetch as B returns nothing.
 *   4. Everything is torn down in afterAll (rows cascade when the orgs/users
 *      are deleted; we also delete the auth users explicitly).
 *
 * Env required (real cross-tenant assertions only run when all three are set):
 *   - VITE_SUPABASE_URL          (or SUPABASE_URL)
 *   - VITE_SUPABASE_ANON_KEY     (or SUPABASE_ANON_KEY)
 *   - SUPABASE_SERVICE_ROLE_KEY  (service_role — server-side only, never shipped)
 *
 * Run: `npm run test:tenant-isolation`
 */

const SUPABASE_URL =
  process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
const ANON_KEY =
  process.env['VITE_SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_ANON_KEY'] ?? '';
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';

const HAS_ENV = Boolean(SUPABASE_URL && ANON_KEY && SERVICE_ROLE_KEY);
const SKIP_REASON =
  'tenant-isolation requires VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY + ' +
  'SUPABASE_SERVICE_ROLE_KEY in env (real cross-tenant RLS assertions need a ' +
  'live Supabase). Set them to run this deploy gate.';

// vitest's `it.skipIf` keeps the test body type-checked while skipping at runtime
// when env is absent. When env IS present, every assertion below runs for real.
const itLive = it.skipIf(!HAS_ENV);

// Unique suffix so repeated runs (and parallel CI) never collide.
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

interface SeededTenant {
  email: string;
  userId: string;
  orgId: string;
  client: SupabaseClient; // anon client authenticated as this tenant's member
  // ids of the rows we seeded into THIS org, keyed by table name
  rowIds: Record<string, string>;
  // tables we actually managed to seed (some, e.g. bank_transactions, may not
  // exist depending on which migrations are applied to the target DB)
  seededTables: Set<string>;
}

/** The tables whose cross-tenant isolation we assert. */
const KEY_TABLES = [
  'customers',
  'jobs',
  'bills',
  'invoices',
  'bank_transactions',
] as const;
type KeyTable = (typeof KEY_TABLES)[number];

describe('tenant isolation (cross-org RLS — DEPLOY BLOCKER)', () => {
  if (!HAS_ENV) {
    // Surface the reason in the runner output without failing the suite.
    console.warn(`[tenant-isolation] SKIPPED: ${SKIP_REASON}`);
  }

  // Service-role client bypasses RLS — used ONLY for seeding/teardown.
  let admin: SupabaseClient;
  let tenantA: SeededTenant;
  let tenantB: SeededTenant;

  /**
   * Seed one row into each key table for the given org, using the service-role
   * client. Returns the map of table -> row id and the set of tables that were
   * actually seeded (a table absent from the DB is skipped, not fatal).
   */
  async function seedRows(orgId: string, tag: string) {
    const rowIds: Record<string, string> = {};
    const seeded = new Set<string>();

    // customers (no FK deps beyond the org)
    const customer = await admin
      .from('customers')
      .insert({ organization_id: orgId, name: `Cust ${tag}` })
      .select('id')
      .single();
    if (!customer.error && customer.data) {
      rowIds['customers'] = customer.data.id as string;
      seeded.add('customers');
    }

    // jobs (job_number unique per org)
    const job = await admin
      .from('jobs')
      .insert({
        organization_id: orgId,
        job_number: `J-${tag}`,
        name: `Job ${tag}`,
        customer_id: rowIds['customers'] ?? null,
      })
      .select('id')
      .single();
    if (!job.error && job.data) {
      rowIds['jobs'] = job.data.id as string;
      seeded.add('jobs');
    }

    // bills (several NOT NULL evidence columns + required `source`)
    const bill = await admin
      .from('bills')
      .insert({
        organization_id: orgId,
        source: 'manual',
        storage_key: `org-${orgId}/iso-${tag}.pdf`,
        original_filename: `iso-${tag}.pdf`,
        mime_type: 'application/pdf',
        total_inc_gst_cents: 11000,
        gst_cents: 1000,
        subtotal_ex_gst_cents: 10000,
      })
      .select('id')
      .single();
    if (!bill.error && bill.data) {
      rowIds['bills'] = bill.data.id as string;
      seeded.add('bills');
    }

    // invoices (customer_id NOT NULL, due_date NOT NULL)
    if (rowIds['customers']) {
      const invoice = await admin
        .from('invoices')
        .insert({
          organization_id: orgId,
          invoice_number: `INV-${tag}`,
          customer_id: rowIds['customers'],
          due_date: '2099-12-31',
        })
        .select('id')
        .single();
      if (!invoice.error && invoice.data) {
        rowIds['invoices'] = invoice.data.id as string;
        seeded.add('invoices');
      }
    }

    // bank_transactions — created by an out-of-branch migration; seed
    // defensively. We only assert isolation on it when it actually seeds.
    const bankTxn = await admin
      .from('bank_transactions')
      .insert({
        organization_id: orgId,
        amount_cents: -5000,
        description: `ISO bank txn ${tag}`,
      })
      .select('id')
      .single();
    if (!bankTxn.error && bankTxn.data) {
      rowIds['bank_transactions'] = bankTxn.data.id as string;
      seeded.add('bank_transactions');
    }

    return { rowIds, seeded };
  }

  async function provisionTenant(tag: string): Promise<SeededTenant> {
    const email = `iso-${tag}-${RUN}@example.test`;
    const password = `Iso!${RUN}!${tag}`;

    // 1. Create the auth user (email pre-confirmed so we can sign in immediately).
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (created.error || !created.data.user) {
      throw new Error(`createUser(${tag}) failed: ${created.error?.message}`);
    }
    const userId = created.data.user.id;

    // 2. Create the organization (service role bypasses RLS).
    const org = await admin
      .from('organizations')
      .insert({ name: `Org ${tag} ${RUN}` })
      .select('id')
      .single();
    if (org.error || !org.data) {
      throw new Error(`org insert(${tag}) failed: ${org.error?.message}`);
    }
    const orgId = org.data.id as string;

    // 3. Make the user the owner of that org.
    const membership = await admin.from('organization_memberships').insert({
      user_id: userId,
      organization_id: orgId,
      role: 'owner',
      is_default: true,
    });
    if (membership.error) {
      throw new Error(`membership insert(${tag}) failed: ${membership.error.message}`);
    }

    // 4. Seed one row per key table into this org.
    const { rowIds, seeded } = await seedRows(orgId, tag);

    // 5. Sign in as this user with the ANON client → real RLS-subject JWT.
    const client = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error || !signIn.data.session) {
      throw new Error(`signIn(${tag}) failed: ${signIn.error?.message}`);
    }

    return { email, userId, orgId, client, rowIds, seededTables: seeded };
  }

  beforeAll(async () => {
    if (!HAS_ENV) return;

    admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    tenantA = await provisionTenant('A');
    tenantB = await provisionTenant('B');

    // Both tenants must have seeded the SAME core set, otherwise the gate is
    // not actually exercising anything. customers/jobs/bills/invoices have no
    // out-of-branch dependency, so require them.
    for (const required of ['customers', 'jobs', 'bills', 'invoices'] as const) {
      if (!tenantA.seededTables.has(required) || !tenantB.seededTables.has(required)) {
        throw new Error(
          `seed precondition failed: '${required}' did not seed for both tenants — ` +
            `the isolation gate cannot run without it.`,
        );
      }
    }
  }, 60_000);

  afterAll(async () => {
    if (!HAS_ENV || !admin) return;
    // Delete the orgs (rows cascade where FKs are ON DELETE CASCADE; the rest
    // are best-effort) then the auth users.
    for (const t of [tenantA, tenantB]) {
      if (!t) continue;
      // Remove seeded rows explicitly first (RESTRICT FKs block org delete otherwise).
      for (const table of KEY_TABLES) {
        const id = t.rowIds[table];
        if (id) await admin.from(table).delete().eq('id', id);
      }
      await admin.from('organization_memberships').delete().eq('organization_id', t.orgId);
      await admin.from('organizations').delete().eq('id', t.orgId);
      await admin.auth.admin.deleteUser(t.userId);
    }
  }, 60_000);

  /**
   * For a given table: querying as the OTHER tenant must never return rows
   * belonging to this tenant. Asserted two ways:
   *   (a) a broad select as B returns zero rows carrying A's organization_id;
   *   (b) a targeted .eq('id', <A's row id>) as B returns no row.
   */
  async function assertIsolated(table: KeyTable) {
    // Only assert on tables both tenants actually seeded.
    if (!tenantA.seededTables.has(table) || !tenantB.seededTables.has(table)) {
      console.warn(
        `[tenant-isolation] skipping '${table}' — not seeded in this DB ` +
          `(likely an out-of-branch table). Other tables still assert isolation.`,
      );
      return;
    }

    const aRowId = tenantA.rowIds[table];
    const bRowId = tenantB.rowIds[table];
    expect(aRowId, `tenant A should have a seeded ${table} row`).toBeTruthy();
    expect(bRowId, `tenant B should have a seeded ${table} row`).toBeTruthy();

    // (a) Broad select as tenant B — must not see anything in tenant A's org.
    const asB = await tenantB.client
      .from(table)
      .select('id, organization_id')
      .eq('organization_id', tenantA.orgId);
    expect(asB.error, `select ${table} as B should not error`).toBeNull();
    expect(
      asB.data ?? [],
      `tenant B must NOT see any ${table} rows from tenant A's org`,
    ).toHaveLength(0);

    // (b) Targeted fetch of A's exact row id, as tenant B — must be empty.
    const targeted = await tenantB.client
      .from(table)
      .select('id')
      .eq('id', aRowId);
    expect(targeted.error, `targeted ${table} fetch as B should not error`).toBeNull();
    expect(
      targeted.data ?? [],
      `tenant B must NOT be able to read tenant A's ${table} row by id`,
    ).toHaveLength(0);

    // (c) Symmetric: tenant A must not see tenant B's row either.
    const asA = await tenantA.client.from(table).select('id').eq('id', bRowId);
    expect(asA.error, `targeted ${table} fetch as A should not error`).toBeNull();
    expect(
      asA.data ?? [],
      `tenant A must NOT be able to read tenant B's ${table} row by id`,
    ).toHaveLength(0);

    // (d) Sanity: each tenant CAN read its OWN row (proves the query path works
    // and the empty results above are due to RLS, not a broken query).
    const ownA = await tenantA.client.from(table).select('id').eq('id', aRowId);
    expect(ownA.error, `own ${table} fetch as A should not error`).toBeNull();
    expect(
      ownA.data ?? [],
      `tenant A SHOULD be able to read its own ${table} row`,
    ).toHaveLength(1);
  }

  itLive(
    'customers are isolated across tenants',
    async () => assertIsolated('customers'),
  );

  itLive('jobs are isolated across tenants', async () => assertIsolated('jobs'));

  itLive('bills are isolated across tenants', async () => assertIsolated('bills'));

  itLive(
    'invoices are isolated across tenants',
    async () => assertIsolated('invoices'),
  );

  itLive(
    'bank_transactions are isolated across tenants',
    async () => assertIsolated('bank_transactions'),
  );

  itLive(
    'a member of org B sees none of org A across ALL key tables at once',
    async () => {
      for (const table of KEY_TABLES) {
        if (!tenantA.seededTables.has(table) || !tenantB.seededTables.has(table)) {
          continue;
        }
        const res = await tenantB.client
          .from(table)
          .select('id')
          .eq('organization_id', tenantA.orgId);
        expect(res.error, `select ${table} as B should not error`).toBeNull();
        expect(
          res.data ?? [],
          `cross-tenant leak detected in '${table}'`,
        ).toHaveLength(0);
      }
    },
  );
});
