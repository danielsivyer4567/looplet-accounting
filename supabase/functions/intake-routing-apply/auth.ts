// Who may run the intake rules engine for an organisation. Routing fills supplier, job and category fields on bills
// and bank transactions and can auto-post a coded bill, so a user caller needs bookkeeping rights (accountant or
// higher) in the organisation named in the request. Backend callers (bills-extract, bank-csv-import, bank-sync,
// automation-worker) send the exact service-role key.
import { authorizeOrgCaller, type OrgAccess, type OrgAccessDeps } from '../_shared/orgRole.ts';

export const INTAKE_ROUTING_MIN_ROLE = 'accountant' as const;

export function authorizeIntakeRouting(
  authorization: string | null,
  organizationId: string,
  deps: OrgAccessDeps,
): Promise<OrgAccess> {
  return authorizeOrgCaller(authorization, organizationId, deps, INTAKE_ROUTING_MIN_ROLE);
}
