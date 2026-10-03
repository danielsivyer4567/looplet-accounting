import { assert, assertEquals, assertMatch } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { authorizeOrgMember } from '../_shared/orgRole.ts';
import { mapAccountType, type FeedAccount } from '../_shared/redbark/client.ts';
import { listFeedAccounts } from '../bank-feed-accounts/accounts.ts';
import { LINKED_ELSEWHERE, linkFeedAccount, type LinkDeps, type LinkedAccountRow, type NewConnectionRow } from './link.ts';

const ORG = '0a000000-0000-4000-8000-000000000001';
const OTHER_ORG = '0b000000-0000-4000-8000-000000000001';
const ADMIN = '10000000-0000-4000-8000-000000000001';
const TODAY = '2026-10-03';
const FEED: FeedAccount[] = [
  { externalAccountId: 'acct-main', connectionId: 'rb-conn-1', name: 'Business Transaction', institution: 'Commonwealth Bank', accountNumber: 'xxxx 2894', currency: 'AUD', accountType: 'transaction' },
  { externalAccountId: 'acct-card', connectionId: 'rb-conn-1', name: 'Business Card', institution: 'Commonwealth Bank', accountNumber: '5521', currency: 'AUD', accountType: 'credit card' },
  { externalAccountId: 'acct-usd', connectionId: 'rb-conn-1', name: 'USD Account', institution: 'Commonwealth Bank', accountNumber: '7777', currency: 'USD', accountType: 'transaction' },
  { externalAccountId: 'acct-other', connectionId: 'rb-conn-2', name: 'Someone else', institution: 'NAB', accountNumber: '1111', currency: 'AUD', accountType: 'savings' },
];

/** bank_connections and bank_accounts in memory, with the global unique key on (provider, external_item_id). */
function memoryDb(seed: { connections?: { id: string; organization_id: string; external_item_id: string; status: string }[] } = {}) {
  const connections = [...(seed.connections ?? [])];
  const accounts: (Omit<LinkedAccountRow, 'feed_covered_through'> & { id: string; feed_covered_through: string | null })[] = [];
  const created: NewConnectionRow[] = [];
  const reactivated: string[] = [];
  let raceWinner: string | null = null;
  const deps: LinkDeps = {
    feedAccounts: () => Promise.resolve(FEED),
    findConnection: (ext) => Promise.resolve(connections.find((c) => c.external_item_id === ext) ?? null),
    createConnection(row) {
      if (raceWinner) {
        connections.push({ id: 'conn-raced', organization_id: raceWinner, external_item_id: row.external_item_id, status: 'active' });
        return Promise.resolve('conflict');
      }
      if (connections.some((c) => c.external_item_id === row.external_item_id)) return Promise.resolve('conflict');
      created.push(row);
      const id = `conn-${connections.length + 1}`;
      connections.push({ id, organization_id: row.organization_id, external_item_id: row.external_item_id, status: row.status });
      return Promise.resolve({ id });
    },
    reactivateConnection(id) {
      reactivated.push(id);
      const c = connections.find((x) => x.id === id);
      if (c) c.status = 'active';
      return Promise.resolve();
    },
    upsertAccount(row) {
      const existing = accounts.find((a) => a.organization_id === row.organization_id && a.bank_connection_id === row.bank_connection_id && a.external_id === row.external_id);
      if (existing) {
        Object.assign(existing, row);
        return Promise.resolve({ id: existing.id });
      }
      const id = `ba-${accounts.length + 1}`;
      accounts.push({ ...row, id });
      return Promise.resolve({ id });
    },
  };
  return { deps, connections, accounts, created, reactivated, raceWith: (org: string) => (raceWinner = org) };
}

const input = (overrides: Record<string, unknown> = {}) => ({
  organizationId: ORG,
  connectionId: 'rb-conn-1',
  accountId: 'acct-main',
  syncFrom: '2026-07-01',
  userId: ADMIN,
  today: TODAY,
  ...overrides,
});

Deno.test('linking an AUD account creates the organisation\'s Redbark connection and the bank account with its import-from date', async () => {
  const db = memoryDb();
  const result = await linkFeedAccount(input(), db.deps);
  assertEquals(result, { ok: true, bank_connection_id: 'conn-1', bank_account_id: 'ba-1', sync_from: '2026-07-01' });
  assertEquals(db.created, [{
    organization_id: ORG, provider: 'redbark', external_item_id: 'rb-conn-1', institution_name: 'Commonwealth Bank', status: 'active',
    encrypted_access_token: '', metadata: { source: 'redbark' }, created_by: ADMIN,
  }]);
  assertEquals(db.accounts, [{
    id: 'ba-1', organization_id: ORG, bank_connection_id: 'conn-1', external_id: 'acct-main', name: 'Business Transaction',
    account_number_last4: '2894', account_type: 'checking', currency_code: 'AUD', is_active: true, feed_sync_from: '2026-07-01', feed_covered_through: null,
  }]);

  // A second account on the same connection reuses it; linking again with an earlier date restarts the import from it.
  const card = await linkFeedAccount(input({ accountId: 'acct-card', syncFrom: '2026-08-15' }), db.deps);
  assertEquals(card.ok && [card.bank_connection_id, db.accounts[1].account_type], ['conn-1', 'credit_card']);
  db.accounts[0].feed_covered_through = '2026-10-02';
  await linkFeedAccount(input({ syncFrom: '2026-01-01' }), db.deps);
  assertEquals([db.accounts.length, db.accounts[0].feed_sync_from, db.accounts[0].feed_covered_through], [2, '2026-01-01', null]);
  assertEquals(db.created.length, 1);
});

Deno.test('a Redbark connection linked by another organisation cannot be linked, even when two requests race', async () => {
  const taken = memoryDb({ connections: [{ id: 'conn-b', organization_id: OTHER_ORG, external_item_id: 'rb-conn-1', status: 'active' }] });
  assertEquals(await linkFeedAccount(input(), taken.deps), { ok: false, status: 409, error: LINKED_ELSEWHERE });
  assertEquals(taken.accounts, []);

  const raced = memoryDb();
  raced.raceWith(OTHER_ORG);
  assertEquals(await linkFeedAccount(input(), raced.deps), { ok: false, status: 409, error: LINKED_ELSEWHERE });
  assertEquals(raced.accounts, []);

  // Losing a race to a request from the same organisation just reuses its connection.
  const sameOrg = memoryDb();
  sameOrg.raceWith(ORG);
  const result = await linkFeedAccount(input(), sameOrg.deps);
  assertEquals(result.ok && result.bank_connection_id, 'conn-raced');
});

Deno.test('an unlinked (revoked) connection in the same organisation is reactivated when an account is linked again', async () => {
  const db = memoryDb({ connections: [{ id: 'conn-a', organization_id: ORG, external_item_id: 'rb-conn-1', status: 'revoked' }] });
  const result = await linkFeedAccount(input(), db.deps);
  assertEquals(result.ok && result.bank_connection_id, 'conn-a');
  assertEquals(db.reactivated, ['conn-a']);
});

Deno.test('bad dates, unknown or moved accounts and non-AUD accounts are refused and nothing is written', async () => {
  const cases: [Record<string, unknown>, number][] = [
    [{ syncFrom: '2026-10-04' }, 400],
    [{ syncFrom: '1999-12-31' }, 400],
    [{ syncFrom: '2026-02-30' }, 400],
    [{ syncFrom: '01/07/2026' }, 400],
    [{ syncFrom: 20260701 }, 400],
    [{ syncFrom: undefined }, 400],
    [{ accountId: '' }, 400],
    [{ connectionId: 42 }, 400],
    [{ accountId: 'acct-missing' }, 404],
    [{ accountId: 'acct-other' }, 404],
    [{ accountId: 'acct-usd' }, 422],
  ];
  for (const [overrides, status] of cases) {
    const db = memoryDb();
    const result = await linkFeedAccount(input(overrides), db.deps);
    assertEquals(result.ok ? 200 : result.status, status, JSON.stringify(overrides));
    assertEquals([db.created.length, db.accounts.length], [0, 0]);
  }
  assert((await linkFeedAccount(input({ syncFrom: TODAY }), memoryDb().deps)).ok, 'today is a valid import-from date');
});

Deno.test('the account list marks linked, available, elsewhere-linked and non-AUD accounts without revealing other organisations', async () => {
  const connections = [
    { id: 'conn-a', organization_id: ORG, external_item_id: 'rb-conn-1', status: 'active' },
    { id: 'conn-b', organization_id: OTHER_ORG, external_item_id: 'rb-conn-2', status: 'active' },
  ];
  const requested: string[][] = [];
  const views = await listFeedAccounts(ORG, {
    feedAccounts: () => Promise.resolve(FEED),
    connectionsFor: (ids) => Promise.resolve(connections.filter((c) => ids.includes(c.external_item_id))),
    accountsFor(org, ids) {
      requested.push([org, ...ids]);
      return Promise.resolve([{ id: 'ba-1', external_id: 'acct-main', bank_connection_id: 'conn-a', feed_sync_from: '2026-07-01', feed_covered_through: '2026-10-02', is_active: true }]);
    },
  });
  assertEquals(views.map((v) => [v.account_id, v.status, v.account_last4]), [
    ['acct-main', 'linked', '2894'],
    ['acct-card', 'available', '5521'],
    ['acct-usd', 'not_aud', '7777'],
    ['acct-other', 'linked_elsewhere', '1111'],
  ]);
  assertEquals(views[0].link, { bank_connection_id: 'conn-a', bank_account_id: 'ba-1', sync_from: '2026-07-01', covered_through: '2026-10-02' });
  assertEquals(views[3].link, null);
  // Only this organisation's own bank accounts are ever read.
  assertEquals(requested, [[ORG, 'conn-a']]);
});

Deno.test('account types map conservatively; unknown types are "other"', () => {
  assertEquals(['transaction', 'Savings', 'credit', 'home loan', 'term deposit', 'brokerage', null].map(mapAccountType),
    ['checking', 'savings', 'credit_card', 'loan', 'investment', 'other', 'other']);
});

Deno.test('listing and linking need an accepted admin or owner, and the functions are wired to that check', async () => {
  const at = '2026-01-01T00:00:00Z';
  for (const [role, accepted, allowed] of [['owner', at, true], ['admin', at, true], ['accountant', at, false], ['viewer', at, false], ['admin', null, false]] as const) {
    const result = await authorizeOrgMember('u1', ORG, { membership: () => Promise.resolve({ role_enum: role, accepted_at: accepted }) }, 'admin');
    assertEquals(result.ok, allowed, `${role} ${accepted ? 'accepted' : 'pending'}`);
  }
  for (const fn of ['bank-feed-link', 'bank-feed-accounts']) {
    const source = await Deno.readTextFile(new URL(`../${fn}/index.ts`, import.meta.url));
    assertMatch(source, /authorizeOrgCaller\([\s\S]*?'admin',\s*\)/, fn);
    assertMatch(source, /isFeedOrganization\(feedOrganizationIds\(Deno\.env\.get\('REDBARK_ORGANIZATION_IDS'\)\)/, fn);
  }
});
