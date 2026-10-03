// Who may run the bill-to-job allocation batch. Reading the queue stats is open to any accepted member; rematching
// and auto-accepting change which job each bill is costed to, so they need bookkeeping rights (accountant or higher).
//
// This function runs everything as the caller (anon key + the caller's token, so RLS applies) and never holds the
// service-role key, so only signed-in members are accepted. The caller's own membership row is read: the previous
// check selected any membership row of the organisation, which errored once an organisation had two members and
// ignored both accepted_at and role.
import { authorizeOrgCaller, type OrgAccess, type OrgAccessDeps, type OrgRole } from '../_shared/orgRole.ts';

export type AllocationMode = 'stats' | 'auto_accept' | 'rematch' | 'full';

export function minRoleForMode(mode: AllocationMode): OrgRole {
  return mode === 'stats' ? 'viewer' : 'accountant';
}

export async function authorizeAllocationBatch(
  authorization: string | null,
  organizationId: string,
  mode: AllocationMode,
  deps: OrgAccessDeps,
): Promise<OrgAccess> {
  const access = await authorizeOrgCaller(authorization, organizationId, deps, minRoleForMode(mode));
  if (access.ok && access.caller.kind !== 'member') return { ok: false, status: 401, error: 'Unauthorized' };
  return access;
}
