import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { OrgContext } from './org-context';
import type { Organization } from './org-context';

export type { Organization } from './org-context';

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
    // Memberships → orgs (RLS does the filtering automatically)
    const { data, error } = await supabase
      .from('organization_memberships')
      .select('organization_id, organizations(id, name, organization_type)')
      .eq('user_id', user.id);
    if (error) {
      console.error('Failed to load organizations', error);
      setOrganizations([]);
      setLoading(false);
      return;
    }
    const orgs: Organization[] = (data ?? [])
      .map((row: { organizations: Organization | Organization[] | null }) => {
        const o = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
        return o ?? null;
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
    // Insert org + membership in two calls (atomic via Supabase pg fn would be cleaner;
    // edge fn `create-organization` is the Phase 1.5 hardening target).
    const { data: orgRow, error: orgErr } = await supabase
      .from('organizations')
      .insert({ name, organization_type: 'standard', created_by: user.id })
      .select('id, name, organization_type')
      .single();
    if (orgErr || !orgRow) return { error: orgErr ?? new Error('No row returned') };

    const { error: memErr } = await supabase.from('organization_memberships').insert({
      user_id: user.id,
      organization_id: orgRow.id,
      role: 'owner',
      is_default: true,
    });
    if (memErr) return { error: memErr };

    await refresh();
    setCurrentOrg(orgRow as Organization);
    return { error: null };
  };

  return (
    <OrgContext.Provider
      value={{ organizations, currentOrg, loading, setCurrentOrg, createOrganization, refresh }}
    >
      {children}
    </OrgContext.Provider>
  );
}
