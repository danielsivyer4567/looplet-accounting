import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { supabaseOrgAccessDeps, type MembershipRow, type OrgAccessDeps } from '../_shared/orgRole.ts';
import { authorizeAllocationBatch, minRoleForMode } from './auth.ts';

const ORG = '00000000-0000-4000-8000-0000000000aa';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000bb';
const at = '2026-01-01T00:00:00Z';

// Token "user-<id>" is user <id>; anything else is not a signed-in user. There is no service key in this function.
function deps(rows: Record<string, MembershipRow>): OrgAccessDeps {
  return {
    serviceKey: '',
    userIdFromJwt: (jwt) => Promise.resolve(jwt.startsWith('user-') ? jwt.slice(5) : null),
    membership: (userId, orgId) => Promise.resolve(rows[`${userId}@${orgId}`] ?? null),
  };
}
const status = (r: { ok: boolean; status?: number }) => (r.ok ? 'allowed' : r.status);

Deno.test('stats is read-only and open to any accepted member; the write modes need accountant or higher', async () => {
  assertEquals(minRoleForMode('stats'), 'viewer');
  for (const mode of ['auto_accept', 'rematch', 'full'] as const) assertEquals(minRoleForMode(mode), 'accountant');

  const expected: Record<string, Record<string, 'allowed' | 403>> = {
    viewer: { stats: 'allowed', auto_accept: 403, rematch: 403, full: 403 },
    employee: { stats: 'allowed', auto_accept: 403, rematch: 403, full: 403 },
    accountant: { stats: 'allowed', auto_accept: 'allowed', rematch: 'allowed', full: 'allowed' },
    admin: { stats: 'allowed', auto_accept: 'allowed', rematch: 'allowed', full: 'allowed' },
    owner: { stats: 'allowed', auto_accept: 'allowed', rematch: 'allowed', full: 'allowed' },
  };
  for (const [role, byMode] of Object.entries(expected)) {
    for (const [mode, want] of Object.entries(byMode)) {
      const result = await authorizeAllocationBatch('Bearer user-u1', ORG, mode as never, deps({ [`u1@${ORG}`]: { role_enum: role, accepted_at: at } }));
      assertEquals(status(result), want, `${role} ${mode}`);
    }
  }
});

Deno.test('pending invites, other organisations and non-members are refused even for stats', async () => {
  const rows = {
    [`pending@${ORG}`]: { role_enum: 'owner', accepted_at: null },
    [`elsewhere@${OTHER_ORG}`]: { role_enum: 'owner', accepted_at: at },
  };
  for (const user of ['pending', 'elsewhere', 'stranger']) {
    assertEquals(status(await authorizeAllocationBatch(`Bearer user-${user}`, ORG, 'stats', deps(rows))), 403, user);
  }
});

Deno.test('no token, the anon key or an empty bearer is refused with 401, and an empty service key never matches', async () => {
  for (const header of [null, '', 'Bearer ', 'Bearer sb_publishable_anon']) {
    assertEquals(status(await authorizeAllocationBatch(header, ORG, 'stats', deps({}))), 401, String(header));
  }
});

Deno.test("the membership lookup reads the caller's own row, not any member of the organisation", async () => {
  const calls: string[] = [];
  const query = {
    select(columns: string) { calls.push(`select ${columns}`); return query; },
    eq(column: string, value: string) { calls.push(`eq ${column}=${value}`); return query; },
    maybeSingle: () => Promise.resolve({ data: { role_enum: 'accountant', accepted_at: at }, error: null }),
  };
  const client = {
    auth: { getUser: (jwt: string) => Promise.resolve(jwt === 'user-token' ? { data: { user: { id: 'u5' } }, error: null } : { data: { user: null }, error: { message: 'bad' } }) },
    from(table: string) { calls.push(`from ${table}`); return query; },
  };
  const result = await authorizeAllocationBatch('Bearer user-token', ORG, 'full', supabaseOrgAccessDeps(client, ''));
  assertEquals(result, { ok: true, caller: { kind: 'member', userId: 'u5', role: 'accountant' } });
  assertEquals(calls, ['from organization_memberships', 'select role_enum, accepted_at', 'eq user_id=u5', `eq organization_id=${ORG}`]);
});

Deno.test('the edge function checks the caller for the requested mode before any query or RPC', async () => {
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  const guard = src.indexOf('authorizeAllocationBatch(authHeader, org_id, mode, supabaseOrgAccessDeps(client, \'\'))');
  assertEquals(guard > 0, true, 'guard call missing');
  const handlerEnd = src.indexOf('\nasync function fetchStats');
  for (const call of ['fetchStats(client', 'runAutoAccept(client', 'runRematch(client']) {
    const first = src.indexOf(call);
    assertEquals(first > guard && first < handlerEnd, true, `${call} must come after the guard`);
  }
  assertEquals(/\.from\('organization_memberships'\)/.test(src), false, 'old any-member lookup is still present');
});
