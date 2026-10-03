import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { authorizeIntakeRouting } from './auth.ts';
import { supabaseOrgAccessDeps } from '../_shared/orgRole.ts';
import type { MembershipRow, OrgAccessDeps, OrgCaller } from '../_shared/orgRole.ts';

const SERVICE_KEY = 'sb_secret_service-key';
const ORG = '00000000-0000-4000-8000-0000000000aa';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000bb';

// Fake auth and membership lookups: token "user-<id>" belongs to user <id>; anything else is not a signed-in user
// (for example the public anon key).
function deps(memberships: Record<string, MembershipRow>): OrgAccessDeps & { lookups: string[] } {
  const lookups: string[] = [];
  return {
    serviceKey: SERVICE_KEY,
    lookups,
    userIdFromJwt: (jwt) => Promise.resolve(jwt.startsWith('user-') ? jwt.slice(5) : null),
    membership: (userId, orgId) => {
      lookups.push(`${userId}@${orgId}`);
      return Promise.resolve(memberships[`${userId}@${orgId}`] ?? null);
    },
  };
}

const accepted = (role: string): MembershipRow => ({ role_enum: role, accepted_at: '2026-01-01T00:00:00Z' });

Deno.test('the exact service-role key is a trusted backend caller', async () => {
  const d = deps({});
  assertEquals(await authorizeIntakeRouting(`Bearer ${SERVICE_KEY}`, ORG, d), { ok: true, caller: { kind: 'service' } });
  assertEquals(d.lookups, []);
});

Deno.test('a missing header, the anon key or a forged service-role JWT is refused with 401', async () => {
  const forged = `h.${btoa(JSON.stringify({ role: 'service_role' })).replace(/=+$/, '')}.s`;
  for (const header of [null, '', 'Bearer ', 'Bearer sb_publishable_anon-key', `Bearer ${forged}`, `Bearer ${SERVICE_KEY}x`]) {
    const result = await authorizeIntakeRouting(header, ORG, deps({}));
    assertEquals(result.ok ? 'allowed' : result.status, 401, `header ${JSON.stringify(header)}`);
  }
});

Deno.test('a signed-in user with no membership in the target organisation is refused with 403', async () => {
  const d = deps({ [`u1@${OTHER_ORG}`]: accepted('owner') });
  const result = await authorizeIntakeRouting('Bearer user-u1', ORG, d);
  assertEquals(result.ok ? 'allowed' : result.status, 403);
  assertEquals(d.lookups, [`u1@${ORG}`]);
});

Deno.test('a pending invite is refused even for the owner role', async () => {
  const d = deps({ [`u1@${ORG}`]: { role_enum: 'owner', accepted_at: null } });
  const result = await authorizeIntakeRouting('Bearer user-u1', ORG, d);
  assertEquals(result.ok ? 'allowed' : result.status, 403);
});

Deno.test('viewers and employees are refused; accountants, admins and owners are allowed', async () => {
  for (const [role, expected] of [
    ['viewer', 403], ['employee', 403], ['accountant', 'allowed'], ['admin', 'allowed'], ['owner', 'allowed'],
    ['not-a-role', 403],
  ] as const) {
    const result = await authorizeIntakeRouting('Bearer user-u1', ORG, deps({ [`u1@${ORG}`]: accepted(role) }));
    assertEquals(result.ok ? 'allowed' : result.status, expected, role);
    if (result.ok) assertEquals(result.caller, { kind: 'member', userId: 'u1', role } as OrgCaller);
  }
});

Deno.test('a lookup failure propagates instead of allowing the call', async () => {
  const d: OrgAccessDeps = {
    serviceKey: SERVICE_KEY,
    userIdFromJwt: () => Promise.resolve('u1'),
    membership: () => Promise.reject(new Error('membership lookup failed: timeout')),
  };
  let threw = false;
  try {
    await authorizeIntakeRouting('Bearer user-u1', ORG, d);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test('an empty configured service key never matches an empty bearer', async () => {
  const d = { ...deps({}), serviceKey: '' };
  const result = await authorizeIntakeRouting('Bearer ', ORG, d);
  assertEquals(result.ok ? 'allowed' : result.status, 401);
});

Deno.test('the edge function authorises the caller before its first database read or write', async () => {
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  const guard = src.indexOf('authorizeIntakeRouting(');
  const handler = src.indexOf('Deno.serve(');
  const firstRead = src.indexOf(".from('", handler);
  const batch = src.indexOf('routeBatch(admin', handler);
  assertEquals(guard > handler, true, 'guard missing from the handler');
  assertEquals(firstRead === -1 || guard < firstRead, true, 'a read happens before the guard');
  assertEquals(guard < batch, true, 'routing starts before the guard');
});

Deno.test('the supabase-js adapter reads the caller membership row and treats a rejected token as signed out', async () => {
  const calls: string[] = [];
  const query = {
    select(columns: string) { calls.push(`select ${columns}`); return query; },
    eq(column: string, value: string) { calls.push(`eq ${column}=${value}`); return query; },
    maybeSingle: () => Promise.resolve({ data: accepted('admin'), error: null }),
  };
  const admin = {
    auth: {
      getUser: (jwt: string) => Promise.resolve(
        jwt === 'good' ? { data: { user: { id: 'u9' } }, error: null } : { data: { user: null }, error: { message: 'bad jwt' } },
      ),
    },
    from(table: string) { calls.push(`from ${table}`); return query; },
  };
  const live = supabaseOrgAccessDeps(admin, SERVICE_KEY);
  assertEquals(await live.userIdFromJwt('good'), 'u9');
  assertEquals(await live.userIdFromJwt('anon-key'), null);
  assertEquals(await live.membership('u9', ORG), accepted('admin'));
  assertEquals(calls, ['from organization_memberships', 'select role_enum, accepted_at', 'eq user_id=u9', `eq organization_id=${ORG}`]);
});
