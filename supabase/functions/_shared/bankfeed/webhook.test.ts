import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { feedOrganizationIds, isFeedOrganization } from './access.ts';
import { deliveredAccountIds, parseRedbarkEvent, readBoundedBody, verifyRedbarkSignature } from './webhook.ts';

const SECRET = 'whsec_test_only_not_a_real_secret';
const ACCOUNT = 'a1b2c3d4-e5f6-7890-a1b2-c3d4e5f67890';
const NOW = 1_790_000_000_000;
const TS = String(Math.floor(NOW / 1000));

async function sign(secret: string, timestamp: string, body: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`)));
  return 'sha256=' + Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.test('a signature over "<timestamp>.<body>" inside the five-minute window verifies, with or without the prefix', async () => {
  const body = '{"type":"transactions.synced"}';
  const signature = await sign(SECRET, TS, body);
  assertEquals(await verifyRedbarkSignature({ signature, timestamp: TS, rawBody: body, secret: SECRET, nowMs: NOW }), { ok: true });
  assertEquals(await verifyRedbarkSignature({ signature: signature.slice(7).toUpperCase(), timestamp: TS, rawBody: body, secret: SECRET, nowMs: NOW + 299_000 }), { ok: true });
  assertEquals(await verifyRedbarkSignature({ signature, timestamp: TS, rawBody: body, secret: SECRET, nowMs: NOW - 299_000 }), { ok: true });
});

Deno.test('verification fails closed: unset secret, wrong secret, tampered body, skew either way, missing or malformed parts', async () => {
  const body = '{"type":"transactions.synced"}';
  const signature = await sign(SECRET, TS, body);
  const check = (overrides: Record<string, unknown>) =>
    verifyRedbarkSignature({ signature, timestamp: TS, rawBody: body, secret: SECRET, nowMs: NOW, ...overrides });
  assertEquals(await check({ secret: '' }), { ok: false, reason: 'secret not configured' });
  assertEquals(await check({ secret: undefined }), { ok: false, reason: 'secret not configured' });
  assertEquals((await check({ signature: await sign('other-secret', TS, body) })).ok, false);
  assertEquals(await check({ rawBody: body + ' ' }), { ok: false, reason: 'signature does not match' });
  assertEquals(await check({ nowMs: NOW + 301_000 }), { ok: false, reason: 'timestamp outside the replay window' });
  assertEquals(await check({ nowMs: NOW - 301_000 }), { ok: false, reason: 'timestamp outside the replay window' });
  assertEquals(await check({ timestamp: TS + '000' }), { ok: false, reason: 'timestamp outside the replay window' });
  assertEquals(await check({ timestamp: '1.7e9' }), { ok: false, reason: 'timestamp outside the replay window' });
  assertEquals(await check({ signature: null }), { ok: false, reason: 'signature headers missing' });
  assertEquals(await check({ timestamp: null }), { ok: false, reason: 'signature headers missing' });
  assertEquals(await check({ signature: 'sha256=zz' }), { ok: false, reason: 'signature is not a sha256 hex digest' });
  assertEquals(await check({ signature: signature + '00' }), { ok: false, reason: 'signature is not a sha256 hex digest' });
  // A signature made with a different timestamp does not verify under the one sent.
  assertEquals((await check({ signature: await sign(SECRET, String(Number(TS) - 1), body) })).ok, false);
});

Deno.test('account ids come from new and updated rows and an accountIds list, once each, ignoring junk', () => {
  assertEquals(
    deliveredAccountIds({ data: { new: [{ account_id: ACCOUNT }, { accountId: ' ' }, 7], updated: [{ accountId: ACCOUNT }, { account_public_id: 'acct_p2' }] }, accountIds: ['p3', 4, ACCOUNT] }),
    [ACCOUNT, 'acct_p2', 'p3'],
  );
  assertEquals(deliveredAccountIds(null), []);
  assertEquals(deliveredAccountIds('text'), []);
});

Deno.test('events are parsed from the signed body; only transactions.synced names accounts to wake', () => {
  const synced = parseRedbarkEvent(JSON.stringify({ id: 'evt-1', object: 'event', type: 'transactions.synced', api_version: '2026-03-15', data: { new: [{ account_id: ACCOUNT, amount: -4550 }], updated: [] } }));
  assertEquals([synced.id, synced.type, synced.accountIds], ['evt-1', 'transactions.synced', [ACCOUNT]]);
  const other = parseRedbarkEvent(JSON.stringify({ id: 'evt-2', type: 'connection.expired', data: { new: [{ account_id: ACCOUNT }] } }));
  assertEquals([other.type, other.accountIds], ['connection.expired', []]);
  assertEquals(parseRedbarkEvent('not json'), { id: null, type: null, payload: { unparsed_body: 'not json' }, accountIds: [] });
  assertEquals(parseRedbarkEvent('[1,2]').payload, { unparsed_body: '[1,2]' });
});

Deno.test('the body is bounded before it is verified', async () => {
  assertEquals(await readBoundedBody(new Request('https://x.invalid', { method: 'POST', body: 'abc' }), 3), 'abc');
  await assertRejects(() => readBoundedBody(new Request('https://x.invalid', { method: 'POST', body: 'abcd' }), 3), RangeError);
  await assertRejects(
    () => readBoundedBody(new Request('https://x.invalid', { method: 'POST', body: 'a', headers: { 'Content-Length': '9999' } }), 3),
    RangeError,
  );
});

Deno.test('the feed is limited to the organisations configured for it; unset means none', () => {
  const allowed = feedOrganizationIds(' 0A000000-0000-4000-8000-000000000001 , not-a-uuid,,0b000000-0000-4000-8000-000000000001');
  assertEquals([...allowed], ['0a000000-0000-4000-8000-000000000001', '0b000000-0000-4000-8000-000000000001']);
  assertEquals(isFeedOrganization(allowed, '0a000000-0000-4000-8000-000000000001'), true);
  assertEquals(isFeedOrganization(allowed, '0c000000-0000-4000-8000-000000000001'), false);
  assertEquals(feedOrganizationIds(undefined).size, 0);
  assertEquals(feedOrganizationIds('').size, 0);
});
