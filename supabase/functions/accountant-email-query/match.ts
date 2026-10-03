// Matching an inbound email sender to the organisations they act for as an accountant.
//
// The previous lookup filtered organization_memberships on the legacy `role` column for 'accountant', a value that
// enum (owner/admin/manager/member) does not have, so no sender ever matched. It also read 50 memberships across every
// organisation, only the first page of users, and ignored pending invites. Now: the sender's user id is found across
// every page of users, and only that user's ACCEPTED memberships with role_enum 'accountant' count.

export interface AuthUserLike {
  id: string;
  email?: string | null;
}

export interface UserPage {
  users: AuthUserLike[];
}

/** Lists one page of users (auth.admin.listUsers). Pages start at 1. */
export type ListUsersPage = (page: number, perPage: number) => Promise<UserPage>;

export const USERS_PER_PAGE = 1000;
const MAX_PAGES = 100;

export interface MatchedUser {
  id: string;
  /** The address registered on the account, which is where replies go (never the raw From header). */
  email: string;
}

export async function findUserByEmail(listPage: ListUsersPage, email: string): Promise<MatchedUser | null> {
  const wanted = email.trim().toLowerCase();
  if (!wanted) return null;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { users } = await listPage(page, USERS_PER_PAGE);
    const match = users.find((u) => (u.email ?? '').trim().toLowerCase() === wanted);
    if (match) return { id: match.id, email: (match.email ?? '').trim() };
    if (users.length < USERS_PER_PAGE) return null;
  }
  throw new Error(`more than ${MAX_PAGES * USERS_PER_PAGE} users; sender lookup needs an indexed query`);
}

export async function findUserIdByEmail(listPage: ListUsersPage, email: string): Promise<string | null> {
  return (await findUserByEmail(listPage, email))?.id ?? null;
}

export interface MembershipWithOrg {
  organization_id: string;
  role_enum: string | null;
  accepted_at: string | null;
  organizations?: { name?: string | null } | null;
}

/** The organisations this user acts for as an accepted accountant. */
export function acceptedAccountantMemberships<T extends MembershipWithOrg>(rows: T[] | null | undefined): T[] {
  return (rows ?? []).filter((m) => m.role_enum === 'accountant' && !!m.accepted_at);
}

/** The membership whose organisation name contains the hint, else the first. */
export function pickTargetMembership<T extends MembershipWithOrg>(memberships: T[], organizationHint?: string | null): T | null {
  const hint = (organizationHint ?? '').trim().toLowerCase();
  if (hint) {
    const named = memberships.find((m) => String(m.organizations?.name ?? '').toLowerCase().includes(hint));
    if (named) return named;
  }
  return memberships[0] ?? null;
}
