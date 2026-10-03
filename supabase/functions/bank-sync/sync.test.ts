import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { normaliseTransactions, RedbarkError, type FeedAccount, type FeedBalance, type FeedTransaction, type RedbarkClient } from '../_shared/redbark/client.ts';
import { syncRedbarkConnection, type BankTransactionRow, type FeedConnection, type LinkedAccount, type SyncStore } from './sync.ts';

const ORG = '0a000000-0000-4000-8000-000000000001';
const CONNECTION: FeedConnection = { id: 'bank-conn-1', organization_id: ORG, external_item_id: 'rb-conn-1' };
const ACCOUNT = 'ee84a02a-6138-4d54-8421-c6b935b50d5f';
const SAVER = 'acct-saver';
const FEED_ACCOUNTS: FeedAccount[] = [
  { externalAccountId: ACCOUNT, connectionId: 'rb-conn-1', name: 'Business Transaction', institution: 'Commonwealth Bank', accountNumber: '2894', currency: 'AUD', accountType: 'transaction' },
  { externalAccountId: SAVER, connectionId: 'rb-conn-1', name: 'Business Saver', institution: 'Commonwealth Bank', accountNumber: '2069', currency: 'AUD', accountType: 'savings' },
];

/** Redbark rows in the v1 REST shape; the fake provider serves whatever is dated inside the requested window. */
function provider(rowsByAccount: Record<string, Record<string, unknown>[]>, options: { truncateOverDays?: number } = {}) {
  const requests: string[] = [];
  const client: RedbarkClient = {
    accounts: () => Promise.resolve(FEED_ACCOUNTS),
    balance: () => Promise.resolve({ currentCents: 154_500, availableCents: 150_000, observedAt: '2026-07-31T23:00:00Z' }),
    transactions(accountId, connectionId, from, offset, to) {
      requests.push(`${accountId === ACCOUNT ? 'main' : 'saver'} ${from}..${to}`);
      assertEquals(connectionId, 'rb-conn-1');
      const days = Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000);
      if (options.truncateOverDays !== undefined && days > options.truncateOverDays) {
        return Promise.reject(new RedbarkError('truncated', { truncated: true }));
      }
      const inWindow = (rowsByAccount[accountId] ?? []).filter((r) => String(r.date) >= from && String(r.date) <= (to ?? '9999'));
      return Promise.resolve({ ...normaliseTransactions(offset === 0 ? inWindow : [], accountId), hasMore: false });
    },
  };
  return { client, requests };
}

/** An in-memory store with the database's unique key on (bank_account_id, external_id). */
function memoryStore(accounts: LinkedAccount[]) {
  const transactions: (BankTransactionRow & { id: string })[] = [];
  const balances = new Map<string, FeedBalance>();
  const raw = new Map<string, string>();
  let failInsert = false;
  const store: SyncStore = {
    linkedAccounts: () => Promise.resolve(accounts.map((a) => ({ ...a }))),
    storeRawTransactions(_org, rows: FeedTransaction[]) {
      for (const row of rows) if (!raw.has(row.id)) raw.set(row.id, `raw-${row.id}`);
      return Promise.resolve(new Map(rows.map((row) => [row.id, raw.get(row.id) ?? ''])));
    },
    insertNewTransactions(rows) {
      if (failInsert) return Promise.reject(new Error('database unavailable'));
      const inserted: { id: string; external_id: string }[] = [];
      for (const row of rows) {
        if (transactions.some((t) => t.bank_account_id === row.bank_account_id && t.external_id === row.external_id)) continue;
        const id = `txn-${transactions.length + 1}`;
        transactions.push({ ...row, id });
        inserted.push({ id, external_id: row.external_id });
      }
      return Promise.resolve(inserted);
    },
    saveBalance(bankAccountId, balance) {
      balances.set(bankAccountId, balance);
      return Promise.resolve();
    },
    advanceCheckpoint(bankAccountId, coveredThrough) {
      const account = accounts.find((a) => a.id === bankAccountId);
      if (account && (!account.feed_covered_through || account.feed_covered_through < coveredThrough)) account.feed_covered_through = coveredThrough;
      return Promise.resolve();
    },
  };
  return { store, transactions, balances, accounts, setFailInsert: (value: boolean) => (failInsert = value) };
}

const posted = (id: string, date: string, amount: string, extra: Record<string, unknown> = {}) =>
  ({ id, accountId: ACCOUNT, amount, status: 'posted', description: `Row ${id}`, date, ...extra });

Deno.test('the first sync imports posted rows from the import-from date in exact cents, skips pending rows and stores the checkpoint', async () => {
  const { client, requests } = provider({
    [ACCOUNT]: [
      posted('t0', '2026-06-30', '-1.00'),
      posted('t1', '2026-07-03', '-200.00', { direction: 'debit', reference: 'INV-7' }),
      posted('t2', '2026-07-04', '2908.40'),
      { ...posted('t3', '2026-07-05', '-15.00'), status: 'pending' },
    ],
  });
  const db = memoryStore([{ id: 'ba-main', external_id: ACCOUNT, feed_sync_from: '2026-07-01', feed_covered_through: null }]);
  const result = await syncRedbarkConnection(client, db.store, CONNECTION, FEED_ACCOUNTS, { today: '2026-07-10' });

  assertEquals(requests, ['main 2026-07-01..2026-07-10']);
  assertEquals(db.transactions.map((t) => [t.external_id, t.posted_at, t.amount_cents, t.reference, t.raw_event_id, t.organization_id]), [
    ['t1', '2026-07-03', -20000, 'INV-7', 'raw-t1', ORG],
    ['t2', '2026-07-04', 290840, null, 'raw-t2', ORG],
  ]);
  assertEquals([result.transactions_synced, result.transactions_existing, result.pending_skipped], [2, 0, 1]);
  assertEquals(result.inserted_txn_ids, ['txn-1', 'txn-2']);
  assertEquals(db.accounts[0].feed_covered_through, '2026-07-10');
  assertEquals(result.accounts[0].caught_up, true);
  assertEquals(db.balances.get('ba-main')?.currentCents, 154_500);
  assertEquals(result.errors, []);
});

Deno.test('syncing again is idempotent on (bank account, Redbark id): only new rows are inserted and existing rows are not rewritten', async () => {
  const rows = { [ACCOUNT]: [posted('t1', '2026-07-03', '-200.00'), posted('t2', '2026-07-08', '50.00')] };
  const db = memoryStore([{ id: 'ba-main', external_id: ACCOUNT, feed_sync_from: '2026-07-01', feed_covered_through: null }]);
  await syncRedbarkConnection(provider(rows).client, db.store, CONNECTION, FEED_ACCOUNTS, { today: '2026-07-10' });
  db.transactions[0].description = 'Matched and coded by the bookkeeper';

  // A late-posted row inside the overlap and a new day both arrive; an amended amount on t1 is not applied silently.
  rows[ACCOUNT] = [posted('t1', '2026-07-03', '-999.00'), posted('t2', '2026-07-08', '50.00'), posted('t4', '2026-07-09', '7.00'), posted('t5', '2026-07-12', '3.00')];
  const second = provider(rows);
  const result = await syncRedbarkConnection(second.client, db.store, CONNECTION, FEED_ACCOUNTS, { today: '2026-07-12' });
  assertEquals(second.requests, ['main 2026-07-03..2026-07-12']);
  assertEquals([result.transactions_synced, result.transactions_existing], [2, 2]);
  assertEquals(result.inserted_txn_ids, ['txn-3', 'txn-4']);
  assertEquals(db.transactions.map((t) => [t.external_id, t.amount_cents]), [['t1', -20000], ['t2', 5000], ['t4', 700], ['t5', 300]]);
  assertEquals(db.transactions[0].description, 'Matched and coded by the bookkeeper');

  // Losing the checkpoint (or a duplicate webhook) re-reads everything and still inserts nothing twice.
  db.accounts[0].feed_covered_through = null;
  const replay = await syncRedbarkConnection(provider(rows).client, db.store, CONNECTION, FEED_ACCOUNTS, { today: '2026-07-12' });
  assertEquals([replay.transactions_synced, replay.transactions_existing, db.transactions.length], [0, 4, 4]);
});

Deno.test('the same Redbark transaction id on two linked accounts is two transactions', async () => {
  const rows = { [ACCOUNT]: [posted('same-id', '2026-07-03', '-5.00')], [SAVER]: [{ ...posted('same-id', '2026-07-03', '5.00'), accountId: SAVER }] };
  const db = memoryStore([
    { id: 'ba-main', external_id: ACCOUNT, feed_sync_from: '2026-07-01', feed_covered_through: null },
    { id: 'ba-saver', external_id: SAVER, feed_sync_from: '2026-07-01', feed_covered_through: null },
  ]);
  const result = await syncRedbarkConnection(provider(rows).client, db.store, CONNECTION, FEED_ACCOUNTS, { today: '2026-07-10' });
  assertEquals(result.transactions_synced, 2);
  assertEquals(db.transactions.map((t) => [t.bank_account_id, t.external_id, t.amount_cents]), [['ba-main', 'same-id', -500], ['ba-saver', 'same-id', 500]]);
});

Deno.test('a long history is read in split windows over several runs, resuming from the checkpoint', async () => {
  const days = Array.from({ length: 60 }, (_, i) => new Date(Date.parse('2026-05-01T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10));
  const rows = { [ACCOUNT]: days.map((date, i) => posted(`d${i}`, date, '-1.00')) };
  const db = memoryStore([{ id: 'ba-main', external_id: ACCOUNT, feed_sync_from: '2026-05-01', feed_covered_through: null }]);

  const first = provider(rows, { truncateOverDays: 10 });
  const run1 = await syncRedbarkConnection(first.client, db.store, CONNECTION, FEED_ACCOUNTS, { today: '2026-06-29', maxWindows: 3 });
  // Window 1 halves 59 days down to 7. Windows 2 and 3 first try the seven-day overlap, drop it, then halve the rest.
  assertEquals(first.requests, [
    'main 2026-05-01..2026-06-29', 'main 2026-05-01..2026-05-30', 'main 2026-05-01..2026-05-15', 'main 2026-05-01..2026-05-08',
    'main 2026-05-01..2026-06-29', 'main 2026-05-09..2026-06-29', 'main 2026-05-09..2026-06-03', 'main 2026-05-09..2026-05-21', 'main 2026-05-09..2026-05-15',
    'main 2026-05-08..2026-06-29', 'main 2026-05-16..2026-06-29', 'main 2026-05-16..2026-06-07', 'main 2026-05-16..2026-05-27', 'main 2026-05-16..2026-05-21',
  ]);
  assertEquals([run1.accounts[0].covered_through, run1.accounts[0].caught_up, run1.transactions_synced], ['2026-05-21', false, 21]);

  let runs = 1;
  while (!db.accounts[0].feed_covered_through || db.accounts[0].feed_covered_through < '2026-06-29') {
    await syncRedbarkConnection(provider(rows, { truncateOverDays: 10 }).client, db.store, CONNECTION, FEED_ACCOUNTS, { today: '2026-06-29', maxWindows: 3 });
    runs++;
    assert(runs < 10, 'the backlog keeps moving forward');
  }
  assertEquals(db.transactions.length, 60);
  assertEquals(new Set(db.transactions.map((t) => t.external_id)).size, 60);
});

Deno.test('a failed insert leaves the checkpoint where it was, so the next run imports the same window', async () => {
  const rows = { [ACCOUNT]: [posted('t1', '2026-07-03', '-200.00')] };
  const db = memoryStore([{ id: 'ba-main', external_id: ACCOUNT, feed_sync_from: '2026-07-01', feed_covered_through: null }]);
  db.setFailInsert(true);
  const failed = await syncRedbarkConnection(provider(rows).client, db.store, CONNECTION, FEED_ACCOUNTS, { today: '2026-07-10' });
  assertEquals(failed.errors, ['database unavailable']);
  assertEquals(db.accounts[0].feed_covered_through, null);
  db.setFailInsert(false);
  const retried = await syncRedbarkConnection(provider(rows).client, db.store, CONNECTION, FEED_ACCOUNTS, { today: '2026-07-10' });
  assertEquals([retried.transactions_synced, db.accounts[0].feed_covered_through], [1, '2026-07-10']);
});

Deno.test('an account Redbark no longer lists on this connection, or one never given an import-from date, is reported while the others sync', async () => {
  const rows = { [ACCOUNT]: [posted('t1', '2026-07-03', '-200.00')] };
  const db = memoryStore([
    { id: 'ba-main', external_id: ACCOUNT, feed_sync_from: '2026-07-01', feed_covered_through: null },
    { id: 'ba-gone', external_id: 'acct-closed', feed_sync_from: '2026-07-01', feed_covered_through: null },
    { id: 'ba-moved', external_id: SAVER, feed_sync_from: '2026-07-01', feed_covered_through: null },
    { id: 'ba-undated', external_id: ACCOUNT, feed_sync_from: null, feed_covered_through: null },
  ]);
  const moved = FEED_ACCOUNTS.map((a) => (a.externalAccountId === SAVER ? { ...a, connectionId: 'rb-conn-other' } : a));
  const result = await syncRedbarkConnection(provider(rows).client, db.store, CONNECTION, moved, { today: '2026-07-10' });
  assertEquals(result.accounts_synced, 1);
  assertEquals(result.transactions_synced, 1);
  assertEquals(result.accounts.map((a) => [a.bank_account_id, Boolean(a.error)]), [['ba-main', false], ['ba-gone', true], ['ba-moved', true], ['ba-undated', true]]);
  assertEquals(result.errors.length, 3);
});
