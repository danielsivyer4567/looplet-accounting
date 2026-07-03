import { useCallback, useMemo } from 'react';
import { useOrg } from '@/hooks/useOrg';

/**
 * Cross-tenant notification scope, shared by the notification bell and the
 * notifications page.
 *
 * Accountants see notifications across every client org at once: RLS already
 * scopes the rows to accessible orgs, so callers simply drop the single-org
 * filter when `crossOrg` is true. Non-accountants keep current-org-only.
 */
export function useNotificationOrgScope() {
  const { currentOrg, organizations, accountantClientOrgs, setCurrentOrg } = useOrg();

  const crossOrg = accountantClientOrgs.length > 0;
  const orgNameById = useMemo(
    () => new Map(organizations.map((o) => [o.id, o.name])),
    [organizations],
  );

  // Switch into the notification's org before following its link so the target
  // page loads that org's data. No-op when already current or not an accountant.
  const enterOrg = useCallback(
    (organizationId: string) => {
      if (!crossOrg || organizationId === currentOrg?.id) return;
      const target = organizations.find((o) => o.id === organizationId);
      if (target) setCurrentOrg(target);
    },
    [crossOrg, currentOrg, organizations, setCurrentOrg],
  );

  return { crossOrg, orgNameById, enterOrg };
}
