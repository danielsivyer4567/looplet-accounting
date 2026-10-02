import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { boundedInt, requireServiceRole, requireSignedInCaller } from './authGuards.ts';

const SERVICE_KEY = 'sb_secret_service-key';
const forgedServiceJwt = `h.${btoa(JSON.stringify({ role: 'service_role' })).replace(/=+$/, '')}.s`;

// Token "user-<id>" belongs to user <id>; anything else (the anon key, a forged JWT) is not a signed-in user.
const deps = {
  serviceKey: SERVICE_KEY,
  userIdFromJwt: (jwt: string) => Promise.resolve(jwt.startsWith('user-') ? jwt.slice(5) : null),
};

Deno.test('requireServiceRole accepts only the exact service-role key', () => {
  assertEquals(requireServiceRole(`Bearer ${SERVICE_KEY}`, SERVICE_KEY), { ok: true, caller: { kind: 'service' } });
  for (const header of [null, '', 'Bearer user-u1', 'Bearer sb_publishable_anon', `Bearer ${forgedServiceJwt}`, `Bearer ${SERVICE_KEY}x`]) {
    const result = requireServiceRole(header, SERVICE_KEY);
    assertEquals(result.ok ? 'allowed' : result.status, 401, JSON.stringify(header));
  }
});

Deno.test('requireServiceRole never matches when the service key is not configured', () => {
  const result = requireServiceRole('Bearer ', '');
  assertEquals(result.ok ? 'allowed' : result.status, 401);
});

Deno.test('requireSignedInCaller accepts a signed-in user or the service role', async () => {
  assertEquals(await requireSignedInCaller('Bearer user-u7', deps), { ok: true, caller: { kind: 'user', userId: 'u7' } });
  assertEquals(await requireSignedInCaller(`Bearer ${SERVICE_KEY}`, deps), { ok: true, caller: { kind: 'service' } });
});

Deno.test('requireSignedInCaller refuses no header, the anon key and forged tokens with 401', async () => {
  for (const header of [null, '', 'Bearer ', 'Bearer sb_publishable_anon', `Bearer ${forgedServiceJwt}`]) {
    const result = await requireSignedInCaller(header, deps);
    assertEquals(result.ok ? 'allowed' : result.status, 401, JSON.stringify(header));
  }
});

Deno.test('boundedInt clamps caller-supplied counts and ignores junk', () => {
  assertEquals(boundedInt(undefined, 15, 1, 25), 15);
  assertEquals(boundedInt('500', 15, 1, 25), 15);
  assertEquals(boundedInt(2.5, 15, 1, 25), 15);
  assertEquals(boundedInt(Number.NaN, 15, 1, 25), 15);
  assertEquals(boundedInt(10_000, 15, 1, 25), 25);
  assertEquals(boundedInt(0, 15, 1, 25), 1);
  assertEquals(boundedInt(-3, 4, 1, 10), 1);
  assertEquals(boundedInt(7, 4, 1, 10), 7);
});
