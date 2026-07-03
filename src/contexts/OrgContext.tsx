import { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { OrgContext } from './org-context';
import type { Organization, OrgRole } from './org-context';

export type { Organization } from './org-context';

/** Shape of an org embedded in the membership query (business_profile is an array embed). */
interface EmbeddedOrg {
  id: string;
  name: string;
  abn: string | null;
  organization_type: Organization['organization_type'];
  business_profile: { entity_type: string | null } | { entity_type: string | null }[] | null;
}

interface MembershipRow {
  role_enum: OrgRole | null;
  accepted_at: string | null;
  organizations: EmbeddedOrg | EmbeddedOrg[] | null;
}

const LS_CURRENT_ORG = 'looplet:current-org-id';

export function OrgProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [currentOrg, setCurrentOrgState] = useState<Organization | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!user) {
      setOrganizations([]);
      setCurrentOrgState(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    // Memberships → orgs (RLS does the org-id filtering automatically). We carry
    // the caller's role_enum/accepted_at and the org's entity_type so the client
    // picker and role-aware landing can reason about accountant access.
    //
    // PENDING-INVITE GATE (P0-01): a pending membership (accepted_at IS NULL) is
    // created the moment a user is invited; it must NOT surface the org until the
    // invite is accepted. get_accessible_org_ids() (migration 0203) already drops
    // pending orgs at the RLS layer, but this row read is keyed on user_id and
    // still returns the caller's own pending membership rows. We exclude them
    // here (server-side .not filter) so a pending org is never listed/selectable.
    const { data, error } = await supabase
      .from('organization_memberships')
      .select(
        'role_enum, accepted_at, organizations(id, name, abn, organization_type, business_profile(entity_type))',
      )
      .eq('user_id', user.id)
      .not('accepted_at', 'is', null);
    if (error) {
      console.error('Failed to load organizations', error);
      setOrganizations([]);
      setLoading(false);
      return;
    }
    const orgs: Organization[] = ((data as MembershipRow[] | null) ?? [])
      .map((row): Organization | null => {
        // Defense in depth: never surface a pending (un-accepted) membership,
        // even if the server filter above is bypassed. accepted_at IS NULL =
        // invite not yet accepted → the org is not yet accessible.
        if (!row.accepted_at) return null;
        const o = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
        if (!o) return null;
        const profile = Array.isArray(o.business_profile)
          ? o.business_profile[0]
          : o.business_profile;
        return {
          id: o.id,
          name: o.name,
          organization_type: o.organization_type,
          abn: o.abn,
          role_enum: row.role_enum,
          accepted_at: row.accepted_at,
          entity_type: profile?.entity_type ?? null,
        };
      })
      .filter((o): o is Organization => o !== null);
    setOrganizations(orgs);
    // Restore preferred org from localStorage if still a member, else first
    const preferred = localStorage.getItem(LS_CURRENT_ORG);
    const match = orgs.find((o) => o.id === preferred) ?? orgs[0] ?? null;
    setCurrentOrgState(match);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setCurrentOrg = (org: Organization) => {
    setCurrentOrgState(org);
    localStorage.setItem(LS_CURRENT_ORG, org.id);
  };

  const createOrganization = async (name: string) => {
    if (!user) return { error: new Error('Not signed in') };
    // Org + owner-membership are created atomically by a SECURITY DEFINER RPC
    // (migration 0085). A brand-new user has no membership yet, so the prior
    // two client inserts hit the admin-gated memberships_insert RLS and the
    // membership was rejected — leaving an orphaned org and a locked-out user.
    // The RPC bypasses that bootstrap deadlock and sets role + role_enum.
    const { data: orgRow, error: rpcErr } = await supabase
      .rpc('create_organization_with_owner', { p_name: name })
      .select('id, name, organization_type')
      .single();
    if (rpcErr || !orgRow) return { error: rpcErr ?? new Error('No row returned') };

    await refresh();
    setCurrentOrg(orgRow as Organization);
    return { error: null };
  };

  // An "accountant client" is any org where the caller's only relationship is the
  // accountant role. isAccountantOnly gates the non-billable / role-aware landing.
  const accountantClientOrgs = useMemo(
    () => organizations.filter((o) => o.role_enum === 'accountant'),
    [organizations],
  );
  const isAccountantOnly = useMemo(
    () => organizations.length > 0 && organizations.every((o) => o.role_enum === 'accountant'),
    [organizations],
  );

  return (
    <OrgContext.Provider
      value={{
        organizations,
        currentOrg,
        loading,
        setCurrentOrg,
        createOrganization,
        refresh,
        accountantClientOrgs,
        isAccountantOnly,
      }}
    >
      {children}
    </OrgContext.Provider>
  );
}
