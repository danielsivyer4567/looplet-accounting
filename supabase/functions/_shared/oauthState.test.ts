import { assertEquals, assertRejects, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { createOAuthState, OAUTH_STATE_TTL_SECONDS, oauthStateSecret, verifyOAuthState } from './oauthState.ts';

const SECRET = 'state-secret-for-tests';
const ORG = '00000000-0000-4000-8000-0000000000aa';
const claims = { provider: 'xero' as const, organizationId: ORG, userId: 'user-1' };
const T0 = Date.UTC(2026, 9, 3, 1, 0, 0);

const reason = (r: { ok: boolean; reason?: string }) => (r.ok ? 'ok' : r.reason);

Deno.test('a state verifies for the same provider, organisation and user within the time limit', async () => {
  const state = await createOAuthState(claims, SECRET, T0);
  assertEquals(await verifyOAuthState(state, claims, SECRET, T0), { ok: true });
  assertEquals(await verifyOAuthState(state, claims, SECRET, T0 + (OAUTH_STATE_TTL_SECONDS - 1) * 1000), { ok: true });
});

Deno.test('a state issued to another user, organisation or provider is refused', async () => {
  const state = await createOAuthState(claims, SECRET, T0);
  assertEquals(reason(await verifyOAuthState(state, { ...claims, userId: 'attacker' }, SECRET, T0)), 'state issued to another user');
  assertEquals(reason(await verifyOAuthState(state, { ...claims, organizationId: 'other-org' }, SECRET, T0)), 'state issued for another organisation');
  assertEquals(reason(await verifyOAuthState(state, { ...claims, provider: 'gmail' }, SECRET, T0)), 'state issued for another provider');
});

Deno.test('an expired state is refused', async () => {
  const state = await createOAuthState(claims, SECRET, T0);
  assertEquals(reason(await verifyOAuthState(state, claims, SECRET, T0 + (OAUTH_STATE_TTL_SECONDS + 1) * 1000)), 'state expired');
});

Deno.test('a missing, malformed, re-signed or tampered state is refused', async () => {
  const state = await createOAuthState(claims, SECRET, T0);
  const [body, signature] = state.split('.');
  // The old Gmail format (org id + random suffix) and the old Xero format (org.nonce.signature) are not accepted.
  for (const bad of [undefined, null, '', `${ORG}.${crypto.randomUUID()}`, `${ORG}.nonce.${signature}`, body, `${body}.`, `.${signature}`]) {
    assertEquals((await verifyOAuthState(bad, claims, SECRET, T0)).ok, false, String(bad));
  }
  assertEquals(reason(await verifyOAuthState(state, claims, 'another-secret', T0)), 'state signature invalid');

  // Rewriting the payload to another user breaks the signature.
  const forged = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (body.length % 4)) % 4)));
  forged.u = 'attacker';
  const forgedBody = btoa(JSON.stringify(forged)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  assertEquals(reason(await verifyOAuthState(`${forgedBody}.${signature}`, { ...claims, userId: 'attacker' }, SECRET, T0)), 'state signature invalid');
});

Deno.test('every state is unique', async () => {
  const a = await createOAuthState(claims, SECRET, T0);
  const b = await createOAuthState(claims, SECRET, T0);
  assertEquals(a === b, false);
});

Deno.test('states need a user and organisation, and signing fails closed without a secret', async () => {
  await assertRejects(() => createOAuthState({ ...claims, userId: '' }, SECRET, T0), Error, 'needs an organisation and a user');
  await assertRejects(() => createOAuthState(claims, '', T0), Error, 'secret is empty');
  const env = (values: Record<string, string>) => ({ get: (name: string) => values[name] });
  assertEquals(oauthStateSecret('xero', env({ XERO_OAUTH_STATE_SECRET: 'a', XERO_CLIENT_SECRET: 'b' })), 'a');
  assertEquals(oauthStateSecret('xero', env({ XERO_CLIENT_SECRET: 'b' })), 'b');
  assertEquals(oauthStateSecret('gmail', env({ GMAIL_CLIENT_SECRET: 'g' })), 'g');
  assertThrows(() => oauthStateSecret('gmail', env({ XERO_CLIENT_SECRET: 'b' })), Error, 'not configured');
});

// Wiring: the four edge functions issue and check bound states, and the old weak checks are gone.
const read = (fn: string) => Deno.readTextFile(new URL(`../${fn}/index.ts`, import.meta.url));

Deno.test('the start functions require an accepted admin and issue a state bound to that user', async () => {
  for (const [fn, provider] of [['xero-oauth-start', 'xero'], ['gmail-oauth-start', 'gmail']] as const) {
    const src = await read(fn);
    const guard = src.indexOf("authorizeOrgCaller(");
    const issue = src.indexOf(`createOAuthState({ provider: '${provider}', organizationId: body.organization_id, userId: access.caller.userId }`);
    assertEquals(guard > 0 && issue > guard, true, fn);
    assertEquals(/'admin',?\s*\)/.test(src.slice(guard, issue)), true, `${fn} needs admin`);
    assertEquals(src.includes('crypto.randomUUID()'), false, `${fn} still builds an unsigned state`);
  }
});

Deno.test('the callbacks require a signed-in admin and a mandatory state bound to them', async () => {
  for (const [fn, provider] of [['xero-oauth-callback', 'xero'], ['gmail-oauth-callback', 'gmail']] as const) {
    const src = await read(fn);
    const guard = src.indexOf('authorizeOrgCaller(');
    const check = src.indexOf(`verifyOAuthState(body.state, { provider: '${provider}', organizationId: body.organization_id, userId: access.caller.userId }`);
    const exchange = src.indexOf('grant_type');
    assertEquals(guard > 0 && check > guard && exchange > check, true, fn);
    assertEquals(src.includes("access.caller.kind !== 'member'"), true, `${fn} must refuse non-user callers`);
    assertEquals(/if \(body\.state &&/.test(src), false, `${fn} treats state as optional`);
    assertEquals(src.includes('startsWith(`${body.organization_id}.`)'), false, `${fn} still uses the prefix check`);
  }
});
