// Organisation access for edge functions that write with the service role.
//
// A service-role client bypasses RLS, so the function itself must prove the caller may act for the organisation
// named in the request. Two callers are allowed:
//   - a trusted backend caller whose bearer is exactly SUPABASE_SERVICE_ROLE_KEY, and
//   - a signed-in user with an ACCEPTED membership in that organisation at or above a minimum role.
// The ranking matches public.require_role(uuid, org_role) in migration 0210: pending invites grant nothing.
import { isExactServiceRoleBearer } from './serviceRole.ts';

export type OrgRole = 'viewer' | 'employee' | 'accountant' | 'admin' | 'owner';

const RANK: Record<OrgRole, number> = { viewer: 0, employee: 1, accountant: 2, admin: 3, owner: 4 };

export interface MembershipRow {
  role_enum: string | null;
  accepted_at: string | null;
}

export interface OrgAccessDeps {
  serviceKey: string;
  /** The user id for a valid user access token, or null when the token is not a signed-in user. */
  userIdFromJwt(jwt: string): Promise<string | null>;
  membership(userId: string, organizationId: string): Promise<MembershipRow | null>;
}

export type OrgCaller = { kind: 'service' } | { kind: 'member'; userId: string; role: OrgRole };

export type OrgAccess =
  | { ok: true; caller: OrgCaller }
  | { ok: false; status: 401 | 403; error: string };

function isOrgRole(value: string | null | undefined): value is OrgRole {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RANK, value);
}

export async function authorizeOrgCaller(
  authorization: string | null,
  organizationId: string,
  deps: OrgAccessDeps,
  minRole: OrgRole,
): Promise<OrgAccess> {
  if (deps.serviceKey && isExactServiceRoleBearer(authorization, deps.serviceKey)) {
    return { ok: true, caller: { kind: 'service' } };
  }
  const jwt = (authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return { ok: false, status: 401, error: 'Unauthorized' };
  const userId = await deps.userIdFromJwt(jwt);
  if (!userId) return { ok: false, status: 401, error: 'Unauthorized' };

  const membership = await deps.membership(userId, organizationId);
  if (!membership || !membership.accepted_at || !isOrgRole(membership.role_enum)) {
    return { ok: false, status: 403, error: 'Not a member of this organisation' };
  }
  if (RANK[membership.role_enum] < RANK[minRole]) {
    return { ok: false, status: 403, error: `This action needs the ${minRole} role or higher` };
  }
  return { ok: true, caller: { kind: 'member', userId, role: membership.role_enum } };
}

// The two calls authorizeOrgCaller needs from a service-role supabase-js client, typed loosely so this module (and its
// tests) do not import supabase-js and the checker does not expand its deep query-builder generics.
interface MembershipQuery {
  select(columns: string): MembershipQuery;
  eq(column: string, value: string): MembershipQuery;
  maybeSingle(): PromiseLike<{ data: MembershipRow | null; error: { message: string } | null }>;
}

interface AdminClientLike {
  auth: { getUser(jwt: string): Promise<{ data: { user: { id: string } | null }; error: unknown }> };
  from(table: string): unknown;
}

export function supabaseOrgAccessDeps(admin: AdminClientLike, serviceKey: string): OrgAccessDeps {
  return {
    serviceKey,
    async userIdFromJwt(jwt) {
      const { data, error } = await admin.auth.getUser(jwt);
      return error ? null : data.user?.id ?? null;
    },
    async membership(userId, organizationId) {
      const { data, error } = await (admin.from('organization_memberships') as MembershipQuery)
        .select('role_enum, accepted_at')
        .eq('user_id', userId)
        .eq('organization_id', organizationId)
        .maybeSingle();
      if (error) throw new Error(`membership lookup failed: ${error.message}`);
      return data;
    },
  };
}
