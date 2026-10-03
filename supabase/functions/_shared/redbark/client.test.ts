import { assert, assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  createRedbarkClient,
  dollarsToCents,
  normaliseTransactions,
  REDBARK_API_VERSION,
  RedbarkError,
  type FeedPage,
  type RedbarkClient,
} from './client.ts';
import { addDays, feedToday, readNextWindow, readPostedWindow } from './history.ts';

const ACCOUNT = 'ee84a02a-6138-4d54-8421-c6b935b50d5f';
const KEY = 'rbk_test_only_not_a_real_key';

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function fakeFetch(handler: Handler) {
  const calls: URL[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push(url);
    const headers = init.headers as Record<string, string>;
    assertEquals(headers.Authorization, `Bearer ${KEY}`);
    assertEquals(headers['Redbark-Version'], REDBARK_API_VERSION);
    return await handler(url, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const page = (data: unknown[], offset: number, total: number, hasMore: boolean) =>
  Response.json({ data, pagination: { total, limit: 100, offset, hasMore } });

Deno.test('dollars become exact integer cents; anything that would need rounding or guessing is refused', () => {
  assertEquals(dollarsToCents('-200.00'), -20000);
  assertEquals(dollarsToCents('2908.4'), 290840);
  assertEquals(dollarsToCents('0.1'), 10);
  assertEquals(dollarsToCents('0.07'), 7);
  assertEquals(dollarsToCents('-0.00'), 0);
  assertEquals(dollarsToCents('90071992547409.91'), 9007199254740991);
  for (const bad of [1.5, '1.005', '1e3', '1.', '.5', '+5', '1,000.00', '', 'abc', null, undefined, '90071992547409.92']) {
    assertEquals(dollarsToCents(bad), null, String(bad));
  }
});

Deno.test('accounts are paged with the version header and limited to active banking connections', async () => {
  const accounts = [
    { id: ACCOUNT, connectionId: 'conn-1', name: 'Business Transaction', type: 'transaction', institutionName: 'Commonwealth Bank', accountNumber: '2894', currency: 'AUD' },
    { id: 'acct-2', connectionId: 'conn-2', name: 'Old card', type: 'credit', institutionName: 'NAB', currency: 'AUD' },
    { id: 'acct-3', connectionId: 'conn-3', name: 'Shares', type: 'brokerage', currency: 'AUD' },
    { id: 'acct-4', connectionId: 'conn-1', name: 'Business Saver', type: 'savings', accountNumber: '2069', currency: 'AUD' },
  ];
  const connections = [
    { id: 'conn-1', category: 'banking', institutionName: 'Commonwealth Bank', status: 'active' },
    { id: 'conn-2', category: 'banking', institutionName: 'NAB', status: 'revoked' },
    { id: 'conn-3', category: 'brokerage', status: 'active' },
  ];
  const { fetchImpl, calls } = fakeFetch((url) => {
    if (url.pathname === '/v1/accounts') {
      const offset = Number(url.searchParams.get('offset'));
      return offset === 0 ? page(accounts.slice(0, 2), 0, 4, true) : page(accounts.slice(2), 2, 4, false);
    }
    if (url.pathname === '/v1/connections') return Response.json({ data: connections });
    return new Response('{}', { status: 404 });
  });
  const result = await createRedbarkClient(KEY, fetchImpl).accounts();
  assertEquals(result.map((a) => [a.externalAccountId, a.institution, a.accountNumber]), [
    ['acct-4', 'Commonwealth Bank', '2069'],
    [ACCOUNT, 'Commonwealth Bank', '2894'],
  ]);
  assertEquals(calls.filter((u) => u.pathname === '/v1/accounts').map((u) => u.searchParams.get('offset')), ['0', '2']);
});

Deno.test('transactions are paged for one account and window; pending rows are counted and never imported', async () => {
  const rows = [
    { id: 't1', accountId: ACCOUNT, amount: '-200.00', status: 'posted', description: 'BUNNINGS 1234', date: '2026-07-03', direction: 'debit' },
    { id: 't2', accountId: ACCOUNT, amount: '2908.40', currency: 'AUD', status: 'posted', description: 'Deposit', reference: 'INV-7', date: '2026-07-04' },
    { id: 't3', accountId: ACCOUNT, amount: '-15.00', status: 'pending', description: 'Card pending', date: '2026-07-05' },
    { id: 't4', accountId: ACCOUNT, amount: '0.00', status: 'posted', description: 'Zero fee reversal', date: '2026-07-05' },
  ];
  const { fetchImpl, calls } = fakeFetch((url) => {
    const offset = Number(url.searchParams.get('offset'));
    return offset === 0 ? page(rows.slice(0, 2), 0, 4, true) : page(rows.slice(2), 2, 4, false);
  });
  const client = createRedbarkClient(KEY, fetchImpl);
  const window = await readPostedWindow(client, { externalAccountId: ACCOUNT, connectionId: 'conn-1' }, '2026-07-01', '2026-07-31');
  assertEquals(window.transactions.map((t) => [t.id, t.date, t.cents, t.reference]), [
    ['t1', '2026-07-03', -20000, null],
    ['t2', '2026-07-04', 290840, 'INV-7'],
  ]);
  assertEquals([window.pending, window.skipped], [1, 1]);
  const query = calls[0].searchParams;
  assertEquals(
    [query.get('connectionId'), query.get('accountId'), query.get('from'), query.get('to'), query.get('limit'), query.get('offset')],
    ['conn-1', ACCOUNT, '2026-07-01', '2026-07-31', '100', '0'],
  );
  assertEquals(calls[1].searchParams.get('offset'), '2');
});

Deno.test('one bad money row refuses the whole page instead of being dropped or rounded', () => {
  const ok = { id: 't1', accountId: ACCOUNT, amount: '-1.00', status: 'posted', date: '2026-07-03' };
  for (const bad of [
    { ...ok, amount: -1 },
    { ...ok, amount: '-1.001' },
    { ...ok, accountId: 'someone-else' },
    { ...ok, status: undefined },
    { ...ok, date: '2026-02-30' },
    { ...ok, currency: 'USD' },
    { ...ok, direction: 'credit' },
  ]) {
    let refused = false;
    try {
      normaliseTransactions([ok, bad], ACCOUNT);
    } catch (error) {
      refused = error instanceof RedbarkError;
    }
    assert(refused, JSON.stringify(bad));
  }
  let duplicate = false;
  try {
    normaliseTransactions([ok, { ...ok }], ACCOUNT);
  } catch {
    duplicate = true;
  }
  assert(duplicate, 'a repeated id refuses the page');
  // An instant falls back to its AEST date: 23:30 UTC on 3 July is 4 July in Brisbane.
  assertEquals(normaliseTransactions([{ id: 'i', accountId: ACCOUNT, amount: '5', status: 'posted', datetime: '2026-07-03T23:30:00Z' }], ACCOUNT).transactions[0].date, '2026-07-04');
});

Deno.test('inconsistent or stalled pagination is refused', async () => {
  const row = { id: 't1', accountId: ACCOUNT, amount: '1.00', status: 'posted', date: '2026-07-03' };
  for (const response of [
    () => Response.json({ data: [row], pagination: { total: 1, limit: 100, offset: 5, hasMore: false } }),
    () => Response.json({ data: [], pagination: { total: 9, limit: 100, offset: 0, hasMore: true } }),
    () => Response.json({ data: [row], pagination: { total: 3, limit: 100, offset: 0, hasMore: false } }),
    () => Response.json({ data: [row] }),
  ]) {
    const { fetchImpl } = fakeFetch(response);
    await assertRejects(() => createRedbarkClient(KEY, fetchImpl).transactions(ACCOUNT, 'conn-1', '2026-07-01', 0), RedbarkError);
  }
});

Deno.test('provider failures are plain messages that never repeat the key; Retry-After and size limits are honoured', async () => {
  const rejected = fakeFetch(() => new Response('{"error":"bad key ' + KEY + '"}', { status: 401 }));
  const error = await assertRejects(() => createRedbarkClient(KEY, rejected.fetchImpl).accounts(), RedbarkError);
  assert(!error.message.includes(KEY));

  const now = Date.parse('2026-07-31T23:00:00Z');
  const limited = fakeFetch(() => new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }));
  const slow = await assertRejects(() => createRedbarkClient(KEY, limited.fetchImpl, { now: () => now }).transactions(ACCOUNT, 'c', '2026-07-01', 0), RedbarkError);
  assertEquals(slow.retryAt, now + 120_000);

  const huge = fakeFetch(() => new Response('{}', { headers: { 'Content-Length': String(5 * 1024 * 1024) } }));
  await assertRejects(() => createRedbarkClient(KEY, huge.fetchImpl).transactions(ACCOUNT, 'c', '2026-07-01', 0), RedbarkError, '4 MiB');

  const down = (async () => {
    throw new TypeError('connection refused');
  }) as typeof fetch;
  await assertRejects(() => createRedbarkClient(KEY, down).accounts(), RedbarkError, 'Could not reach');
});

Deno.test('a fresh balance converts to cents; a stale or old observation is not used', async () => {
  const now = Date.parse('2026-07-31T23:05:00Z');
  const balance = (extra: Record<string, unknown>) =>
    fakeFetch((url) => Response.json({ data: [{ accountId: url.searchParams.get('accountIds'), currentBalance: '15.45', availableBalance: '10.00', currency: 'AUD', observedAt: '2026-07-31T23:00:00Z', ...extra }] }));
  assertEquals(await createRedbarkClient(KEY, balance({}).fetchImpl, { now: () => now }).balance(ACCOUNT), {
    currentCents: 1545,
    availableCents: 1000,
    observedAt: '2026-07-31T23:00:00Z',
  });
  assertEquals(await createRedbarkClient(KEY, balance({ freshness: 'stale' }).fetchImpl, { now: () => now }).balance(ACCOUNT), null);
  assertEquals(await createRedbarkClient(KEY, balance({ observedAt: '2026-07-31T10:00:00Z' }).fetchImpl, { now: () => now }).balance(ACCOUNT), null);
  await assertRejects(() => createRedbarkClient(KEY, balance({ currentBalance: 15.45 }).fetchImpl, { now: () => now }).balance(ACCOUNT), RedbarkError);
});

/** A provider that truncates any window longer than `maxDays` and returns one posted row per day otherwise. */
function windowedClient(maxDays: number) {
  const requested: string[] = [];
  const client: RedbarkClient = {
    accounts: () => Promise.resolve([]),
    balance: () => Promise.resolve(null),
    transactions(_account, _connection, from, _offset, to): Promise<FeedPage> {
      requested.push(`${from}..${to}`);
      const days = Math.round((Date.parse((to ?? from) + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000);
      if (days > maxDays) return Promise.reject(new RedbarkError('truncated', { truncated: true }));
      const transactions = Array.from({ length: days + 1 }, (_, i) => ({
        id: `t-${addDays(from, i)}`, accountId: ACCOUNT, date: addDays(from, i), description: 'Row', reference: null, category: null,
        cents: -100, status: 'posted' as const, raw: {},
      }));
      return Promise.resolve({ transactions, hasMore: false, skipped: 0 });
    },
  };
  return { client, requested };
}

Deno.test('a truncated first window is halved until it fits, and the checkpoint advances only through what was read', async () => {
  const { client, requested } = windowedClient(20);
  const link = { externalAccountId: ACCOUNT, connectionId: 'conn-1', syncFrom: '2026-01-01', coveredThrough: null };
  const first = await readNextWindow(client, link, '2026-03-01');
  assertEquals(requested, ['2026-01-01..2026-03-01', '2026-01-01..2026-01-30', '2026-01-01..2026-01-15']);
  assertEquals([first.from, first.to, first.coveredThrough, first.caughtUp, first.transactions.length], ['2026-01-01', '2026-01-15', '2026-01-15', false, 15]);

  // The next window resumes with a seven-day overlap; when that is too large, the overlap is dropped first.
  requested.length = 0;
  const second = await readNextWindow(client, { ...link, coveredThrough: first.coveredThrough }, '2026-01-30');
  assertEquals(requested, ['2026-01-08..2026-01-30', '2026-01-16..2026-01-30']);
  assertEquals([second.coveredThrough, second.caughtUp], ['2026-01-30', true]);
});

Deno.test('a single day too large to import is refused with its date; an import-from date never reads earlier', async () => {
  const { client, requested } = windowedClient(-1);
  await assertRejects(
    () => readNextWindow(client, { externalAccountId: ACCOUNT, connectionId: 'c', syncFrom: '2026-07-01', coveredThrough: null }, '2026-07-01'),
    RedbarkError,
    '2026-07-01',
  );
  const caughtUp = windowedClient(400);
  const result = await readNextWindow(caughtUp.client, { externalAccountId: ACCOUNT, connectionId: 'c', syncFrom: '2026-07-01', coveredThrough: '2026-07-03' }, '2026-07-10');
  assertEquals(caughtUp.requested, ['2026-07-01..2026-07-10']);
  assertEquals(result.coveredThrough, '2026-07-10');
  assertEquals(requested.length, 1);
});

Deno.test('a window past the row or page limits is too large and is split the same way', async () => {
  const link = { externalAccountId: ACCOUNT, connectionId: 'c', syncFrom: '2026-01-01', coveredThrough: null };
  const many = windowedClient(400);
  const byRows = await readNextWindow(many.client, link, '2026-01-31', { maxRows: 10 });
  assertEquals([byRows.to, byRows.transactions.length], ['2026-01-08', 8]);

  // One row per page: a 31-day window needs 31 pages.
  const paged: RedbarkClient = {
    ...many.client,
    transactions(_a, _c, from, offset, to): Promise<FeedPage> {
      const days = Math.round((Date.parse((to ?? from) + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86_400_000) + 1;
      const date = addDays(from, offset);
      return Promise.resolve({
        transactions: [{ id: `p-${date}`, accountId: ACCOUNT, date, description: 'Row', reference: null, category: null, cents: 100, status: 'posted', raw: {} }],
        hasMore: offset + 1 < days,
        skipped: 0,
      });
    },
  };
  const byPages = await readNextWindow(paged, link, '2026-01-31', { maxPages: 5 });
  assertEquals([byPages.to, byPages.transactions.length], ['2026-01-04', 4]);
  assertEquals(feedToday(Date.parse('2026-06-30T14:30:00Z')), '2026-07-01');
});
