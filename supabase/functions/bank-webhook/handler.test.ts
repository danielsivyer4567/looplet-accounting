import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { handleBankWebhook, type LinkedConnection, type RawEventRow, type WebhookDeps } from './handler.ts';

const SECRET = 'whsec_test_only_not_a_real_secret';
const ORG = '0a000000-0000-4000-8000-000000000001';
const OTHER_ORG = '0b000000-0000-4000-8000-000000000001';
const NOW = 1_790_000_000_000;
const ACCOUNT_1 = 'a1000000-0000-4000-8000-000000000001';
const ACCOUNT_2 = 'a1000000-0000-4000-8000-000000000002';
const ACCOUNT_3 = 'a1000000-0000-4000-8000-000000000003';
const ACCOUNT_ELSEWHERE = 'a1000000-0000-4000-8000-0000000000ee';

// Two accounts on one connection, one on another, and one linked by an organisation not allowed to use the feed.
const LINKS: Record<string, LinkedConnection> = {
  [ACCOUNT_1]: { id: 'conn-1', organization_id: ORG },
  [ACCOUNT_2]: { id: 'conn-1', organization_id: ORG },
  [ACCOUNT_3]: { id: 'conn-2', organization_id: ORG },
  [ACCOUNT_ELSEWHERE]: { id: 'conn-x', organization_id: OTHER_ORG },
};

const event = (type = 'transactions.synced', accounts = [ACCOUNT_1, ACCOUNT_2, ACCOUNT_3, 'unlinked']) =>
  JSON.stringify({
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    object: 'event',
    type,
    api_version: '2026-03-15',
    data: { new: accounts.map((account_id, i) => ({ id: `t${i}`, object: 'transaction', amount: -4550, currency: 'aud', status: 'posted', account_id })), updated: [] },
  });

async function signedRequest(body: string, options: { secret?: string; timestamp?: number; method?: string } = {}) {
  const timestamp = String(Math.floor((options.timestamp ?? NOW) / 1000));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(options.secret ?? SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`)));
  const signature = 'sha256=' + Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
  return new Request('https://project.supabase.co/functions/v1/bank-webhook', {
    method: options.method ?? 'POST',
    body: options.method === 'GET' ? undefined : body,
    headers: { 'X-Redbark-Signature': signature, 'X-Redbark-Timestamp': timestamp, 'X-Redbark-Delivery-Id': 'unsigned-header-not-trusted' },
  });
}

function fakeDeps(overrides: Partial<WebhookDeps> = {}) {
  const log: string[] = [];
  const stored: RawEventRow[] = [];
  const failures: string[] = [];
  const pending: Promise<unknown>[] = [];
  const deps: WebhookDeps = {
    secret: SECRET,
    allowedOrganizationIds: new Set([ORG]),
    now: () => NOW,
    findLinkedConnections(accountIds) {
      log.push(`find ${accountIds.length}`);
      return Promise.resolve(accountIds.flatMap((id) => (LINKS[id] ? [LINKS[id]] : [])));
    },
    storeEvent(row) {
      log.push('store');
      const duplicate = stored.some((s) => s.provider_event_id === row.provider_event_id && s.payload_hash === row.payload_hash);
      stored.push(row);
      return Promise.resolve(duplicate ? 'duplicate' : 'stored');
    },
    dispatchSync(connection) {
      log.push(`sync ${connection.id}`);
      return Promise.resolve();
    },
    recordDispatchFailure(connection, message) {
      failures.push(`${connection.id}: ${message}`);
      return Promise.resolve();
    },
    background(work) {
      pending.push(work);
    },
    ...overrides,
  };
  return { deps, log, stored, failures, settle: () => Promise.all(pending) };
}

Deno.test('an unset secret refuses every delivery before reading it', async () => {
  for (const secret of [undefined, null, '']) {
    const { deps, log, stored } = fakeDeps({ secret });
    const response = await handleBankWebhook(await signedRequest(event()), deps);
    assertEquals(response.status, 503);
    assertEquals([log, stored], [[], []]);
  }
});

Deno.test('unsigned, wrongly signed, replayed or oversized deliveries are refused and nothing is stored', async () => {
  const cases: [Request, number][] = [
    [new Request('https://x.invalid', { method: 'POST', body: event() }), 401],
    [await signedRequest(event(), { secret: 'not-the-secret' }), 401],
    [await signedRequest(event(), { timestamp: NOW - 301_000 }), 401],
    [await signedRequest(event(), { timestamp: NOW + 301_000 }), 401],
    [await signedRequest('x'.repeat(4 * 1024 * 1024 + 1)), 413],
    [await signedRequest(event(), { method: 'GET' }), 405],
  ];
  for (const [request, status] of cases) {
    const { deps, log, stored } = fakeDeps();
    const response = await handleBankWebhook(request, deps);
    assertEquals(response.status, status);
    assertEquals([log, stored.length], [[], 0]);
  }
  // A body changed after signing is refused too.
  const signed = await signedRequest(event());
  const tampered = new Request(signed.url, { method: 'POST', body: event('transactions.synced', [ACCOUNT_ELSEWHERE]), headers: signed.headers });
  const { deps, stored } = fakeDeps();
  assertEquals((await handleBankWebhook(tampered, deps)).status, 401);
  assertEquals(stored.length, 0);
});

Deno.test('a verified event is stored first, then one sync is dispatched per linked connection', async () => {
  const { deps, log, stored, failures, settle } = fakeDeps();
  const response = await handleBankWebhook(await signedRequest(event()), deps);
  await settle();
  assertEquals(response.status, 202);
  assertEquals(await response.json(), { ok: true, action: 'sync_dispatched', connections: 2, duplicate: false });
  assertEquals(log, ['find 4', 'store', 'sync conn-1', 'sync conn-2']);
  assertEquals(stored.length, 1);
  assertEquals(stored[0].provider, 'redbark');
  assertEquals(stored[0].organization_id, ORG);
  // The event id comes from the signed body, not the unsigned delivery header.
  assertEquals(stored[0].provider_event_id, 'event:a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  assert(/^[0-9a-f]{64}$/.test(stored[0].payload_hash));
  assertEquals((stored[0].raw_payload as { type: string }).type, 'transactions.synced');
  assertEquals(failures, []);
});

Deno.test('connections of organisations not allowed to use the feed are never woken', async () => {
  const { deps, log, stored, settle } = fakeDeps();
  const response = await handleBankWebhook(await signedRequest(event('transactions.synced', [ACCOUNT_ELSEWHERE, ACCOUNT_3])), deps);
  await settle();
  assertEquals(response.status, 202);
  assertEquals(log, ['find 2', 'store', 'sync conn-2']);
  assertEquals(stored[0].organization_id, ORG);

  const none = fakeDeps({ allowedOrganizationIds: new Set() });
  const refused = await handleBankWebhook(await signedRequest(event()), none.deps);
  await none.settle();
  assertEquals(await refused.json(), { ok: true, action: 'no_linked_accounts', duplicate: false });
  assertEquals(none.log, ['find 4', 'store']);
  assertEquals(none.stored[0].organization_id, null);
});

Deno.test('a repeated delivery is recognised but still dispatches, because an earlier attempt may not have synced', async () => {
  const { deps, log, settle } = fakeDeps();
  await handleBankWebhook(await signedRequest(event()), deps);
  const again = await handleBankWebhook(await signedRequest(event()), deps);
  await settle();
  assertEquals(again.status, 202);
  assertEquals((await again.json()).duplicate, true);
  assertEquals(log.filter((l) => l.startsWith('sync')), ['sync conn-1', 'sync conn-2', 'sync conn-1', 'sync conn-2']);
});

Deno.test('if the event cannot be stored the delivery is not acknowledged and nothing is dispatched', async () => {
  const { deps, log } = fakeDeps({
    storeEvent: () => Promise.reject(new Error('database unavailable')),
  });
  const response = await handleBankWebhook(await signedRequest(event()), deps);
  assertEquals(response.status, 500);
  assertEquals(log, ['find 4']);
});

Deno.test('other event types and unreadable bodies are stored and acknowledged without a sync', async () => {
  const other = fakeDeps();
  const response = await handleBankWebhook(await signedRequest(event('connection.expired')), other.deps);
  assertEquals([response.status, (await response.json()).action], [200, 'ignored']);
  assertEquals(other.log, ['store']);

  const garbled = fakeDeps();
  const unreadable = await handleBankWebhook(await signedRequest('not json'), garbled.deps);
  assertEquals(unreadable.status, 200);
  assertEquals(garbled.stored[0].raw_payload, { unparsed_body: 'not json' });
  assert(garbled.stored[0].provider_event_id.startsWith('body:'));
});

Deno.test('a failed sync is recorded on its connection and does not fail the delivery or the other syncs', async () => {
  const { deps, log, failures, settle } = fakeDeps({
    dispatchSync(connection) {
      return connection.id === 'conn-1' ? Promise.reject(new Error('bank-sync dispatch failed: HTTP 502')) : Promise.resolve();
    },
  });
  const response = await handleBankWebhook(await signedRequest(event()), deps);
  await settle();
  assertEquals(response.status, 202);
  assertEquals(log, ['find 4', 'store']);
  assertEquals(failures, ['conn-1: bank-sync dispatch failed: HTTP 502']);
});
