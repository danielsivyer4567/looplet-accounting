import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { authorizeOrgCaller, authorizeOrgMember, type MembershipRow, type OrgRole } from './orgRole.ts';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000bb';
const at = '2026-01-01T00:00:00Z';

const lookups = (rows: Record<string, MembershipRow>) => ({
  membership: (userId: string, orgId: string) => Promise.resolve(rows[`${userId}@${orgId}`] ?? null),
});
const status = (r: { ok: boolean; status?: number }) => (r.ok ? 'allowed' : r.status);

Deno.test('admin-or-owner checks follow the require_role ranking for accepted members', async () => {
  const cases: Array<[string, 'allowed' | 403]> = [
    ['viewer', 403], ['employee', 403], ['accountant', 403], ['admin', 'allowed'], ['owner', 'allowed'],
  ];
  for (const [role, expected] of cases) {
    const result = await authorizeOrgMember('u1', ORG, lookups({ [`u1@${ORG}`]: { role_enum: role, accepted_at: at } }), 'admin');
    assertEquals(status(result), expected, role);
    if (result.ok) assertEquals(result.caller, { kind: 'member', userId: 'u1', role: role as OrgRole });
  }
});

Deno.test('pending invites, other organisations, missing or unknown roles are refused with 403', async () => {
  const rows: Record<string, MembershipRow> = {
    [`pending@${ORG}`]: { role_enum: 'owner', accepted_at: null },
    [`elsewhere@${OTHER_ORG}`]: { role_enum: 'owner', accepted_at: at },
    [`legacy@${ORG}`]: { role_enum: null, accepted_at: at },
    [`odd@${ORG}`]: { role_enum: 'superuser', accepted_at: at },
    [`proto@${ORG}`]: { role_enum: '__proto__', accepted_at: at },
  };
  for (const user of ['pending', 'elsewhere', 'legacy', 'odd', 'proto', 'stranger']) {
    assertEquals(status(await authorizeOrgMember(user, ORG, lookups(rows), 'viewer')), 403, user);
  }
});

Deno.test('every minimum role admits exactly the roles at or above it', async () => {
  const order: OrgRole[] = ['viewer', 'employee', 'accountant', 'admin', 'owner'];
  for (const [minIndex, minRole] of order.entries()) {
    for (const [roleIndex, role] of order.entries()) {
      const result = await authorizeOrgMember('u1', ORG, lookups({ [`u1@${ORG}`]: { role_enum: role, accepted_at: at } }), minRole);
      assertEquals(result.ok, roleIndex >= minIndex, `${role} vs min ${minRole}`);
    }
  }
});

Deno.test('a membership lookup failure is an error, never an allow', async () => {
  const failing = { membership: () => Promise.reject(new Error('membership lookup failed: timeout')) };
  await assertRejects(() => authorizeOrgMember('u1', ORG, failing, 'admin'), Error, 'membership lookup failed');
});

Deno.test('authorizeOrgCaller applies the same member check after resolving the user from the token', async () => {
  const deps = {
    serviceKey: 'sb_secret_service-key',
    userIdFromJwt: (jwt: string) => Promise.resolve(jwt === 'user-token' ? 'u1' : null),
    ...lookups({ [`u1@${ORG}`]: { role_enum: 'accountant', accepted_at: at } }),
  };
  assertEquals(status(await authorizeOrgCaller('Bearer user-token', ORG, deps, 'accountant')), 'allowed');
  assertEquals(status(await authorizeOrgCaller('Bearer user-token', ORG, deps, 'admin')), 403);
  assertEquals(status(await authorizeOrgCaller('Bearer anon-key', ORG, deps, 'viewer')), 401);
  assertEquals(status(await authorizeOrgCaller('Bearer sb_secret_service-key', ORG, deps, 'owner')), 'allowed');
});
