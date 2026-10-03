import { useOrg } from '@/hooks/useOrg';
import { canWrite, roleFor, type WriteArea } from '@/lib/roles';
import type { OrgRole } from '@/contexts/org-context';

/** The caller's role in the current organisation and what it may write (see lib/roles.ts). */
export function useOrgRole(): {
  role: OrgRole | null;
  canWrite: (area: WriteArea) => boolean;
} {
  const { currentOrg } = useOrg();
  const role = roleFor(currentOrg);
  return { role, canWrite: (area) => canWrite(role, area) };
}
