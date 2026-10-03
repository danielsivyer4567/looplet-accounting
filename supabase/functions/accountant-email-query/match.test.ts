import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  acceptedAccountantMemberships,
  findUserByEmail,
  findUserIdByEmail,
  type ListUsersPage,
  pickTargetMembership,
  USERS_PER_PAGE,
} from './match.ts';

// A fake user directory of `total` users split into pages, recording which pages were read.
function directory(total: number, special: Record<number, string> = {}) {
  const pagesRead: number[] = [];
  const listPage: ListUsersPage = (page, perPage) => {
    pagesRead.push(page);
    const start = (page - 1) * perPage;
    const users = [];
    for (let i = start; i < Math.min(total, start + perPage); i++) {
      users.push({ id: `user-${i}`, email: special[i] ?? `person${i}@example.test` });
    }
    return Promise.resolve({ users });
  };
  return { listPage, pagesRead };
}

Deno.test('finds the sender on a later page, ignoring case and surrounding spaces', async () => {
  const dir = directory(USERS_PER_PAGE * 2 + 10, { [USERS_PER_PAGE * 2 + 3]: 'Accountant@Firm.example' });
  assertEquals(await findUserIdByEmail(dir.listPage, '  accountant@firm.EXAMPLE '), `user-${USERS_PER_PAGE * 2 + 3}`);
  assertEquals(dir.pagesRead, [1, 2, 3]);
});

Deno.test('returns null for an unknown sender after the last (short) page, and for an empty address', async () => {
  const dir = directory(25);
  assertEquals(await findUserIdByEmail(dir.listPage, 'nobody@example.test'), null);
  assertEquals(dir.pagesRead, [1]);
  assertEquals(await findUserIdByEmail(dir.listPage, '   '), null);
});

Deno.test('the registered address is returned for replies, trimmed, even when the sender wrote it differently', async () => {
  const dir = directory(5, { 3: '  Accountant@Firm.example ' });
  assertEquals(await findUserByEmail(dir.listPage, 'accountant@firm.example'), { id: 'user-3', email: 'Accountant@Firm.example' });
});

Deno.test('a failing user listing is an error, not "unknown sender"', async () => {
  const failing: ListUsersPage = () => Promise.reject(new Error('listUsers: upstream 500'));
  await assertRejects(() => findUserIdByEmail(failing, 'a@example.test'), Error, 'upstream 500');
});

Deno.test('only accepted accountant memberships count', () => {
  const rows = [
    { organization_id: 'o1', role_enum: 'accountant', accepted_at: '2026-01-01T00:00:00Z', organizations: { name: 'Fencing Co' } },
    { organization_id: 'o2', role_enum: 'accountant', accepted_at: null, organizations: { name: 'Pending Co' } },
    { organization_id: 'o3', role_enum: 'viewer', accepted_at: '2026-01-01T00:00:00Z', organizations: { name: 'Viewer Co' } },
    { organization_id: 'o4', role_enum: null, accepted_at: '2026-01-01T00:00:00Z', organizations: null },
  ];
  assertEquals(acceptedAccountantMemberships(rows).map((m) => m.organization_id), ['o1']);
  assertEquals(acceptedAccountantMemberships(null), []);
});

Deno.test('the organisation hint picks by name, else the first membership', () => {
  const rows = [
    { organization_id: 'o1', role_enum: 'accountant', accepted_at: 'x', organizations: { name: 'Fencing Co' } },
    { organization_id: 'o2', role_enum: 'accountant', accepted_at: 'x', organizations: { name: 'Gold Coast Plumbing' } },
  ];
  assertEquals(pickTargetMembership(rows, 'plumbing')?.organization_id, 'o2');
  assertEquals(pickTargetMembership(rows, 'unknown')?.organization_id, 'o1');
  assertEquals(pickTargetMembership(rows, null)?.organization_id, 'o1');
  assertEquals(pickTargetMembership([], 'x'), null);
});

Deno.test('the handler queries the sender\'s own accepted accountant memberships by role_enum', async () => {
  const src = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  assertEquals(src.includes(".eq('role', 'accountant')"), false, 'legacy role filter still present');
  assertEquals(/\.limit\(50\)/.test(src), false, 'cross-organisation 50-row read still present');
  assertEquals(/listUsers\(\)/.test(src), false, 'single-page user listing still present');
  const query = src.slice(src.indexOf(".from('organization_memberships')"), src.indexOf('if (membershipErr)'));
  for (const part of [".eq('user_id', matchedId)", ".eq('role_enum', 'accountant')", ".not('accepted_at', 'is', null)"]) {
    assertEquals(query.includes(part), true, part);
  }
  assertEquals(src.includes('findUserByEmail('), true);
  // Replies never go to the raw From header, and an unknown sender gets no reply at all.
  assertEquals(/sendReply\(resendKey, email\.from/.test(src), false, 'a reply still goes to the raw From header');
  assertEquals(src.includes("status: 'unknown_sender'"), true);
  assertEquals(src.slice(0, src.indexOf("status: 'unknown_sender'")).includes('sender not recognised'), false, 'unknown senders still get a reply');
  assertEquals(src.includes('pickTargetMembership(memberships, intent.organization_hint)'), true);
});
