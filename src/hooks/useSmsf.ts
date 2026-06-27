import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

// One SMSF the org administers (SC-5.H, table `smsf_funds`). Typed against the columns the
// workspace list surfaces.
export interface SmsfFundRow {
  id: string;
  name: string;
  abn: string | null;
  trustee_structure: string;
  establishment_date: string | null;
  created_at: string;
}

// One fund member (SC-5.H, table `smsf_members`). The recorded balance is the sum of the
// tax-free + taxable components on the row (the roll-forward closing balance is SC-5.I.01,
// surfaced in the financials panel — SC-5.N.02).
export interface SmsfMemberRow {
  id: string;
  fund_id: string;
  name: string;
  role: string;
  date_of_birth: string | null;
  tax_free_component_cents: number;
  taxable_component_cents: number;
}

/**
 * Lists the org's SMSF funds + their members + whether the org is itself an SMSF entity (the
 * visibility gate for the SMSF workspace lives on business_profile.entity_type, not
 * organizations). Mirrors useTrusts: org-scoped, RLS does the rest; loading/error/refresh.
 */
export function useSmsf() {
  const { currentOrg } = useOrg();
  const [funds, setFunds] = useState<SmsfFundRow[]>([]);
  const [members, setMembers] = useState<SmsfMemberRow[]>([]);
  const [isSmsfEntity, setIsSmsfEntity] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!currentOrg) {
      setFunds([]);
      setMembers([]);
      setIsSmsfEntity(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    const [fundsRes, membersRes, profileRes] = await Promise.all([
      supabase
        .from('smsf_funds')
        .select('id, name, abn, trustee_structure, establishment_date, created_at')
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .order('name', { ascending: true }),
      supabase
        .from('smsf_members')
        .select('id, fund_id, name, role, date_of_birth, tax_free_component_cents, taxable_component_cents')
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .order('name', { ascending: true }),
      supabase
        .from('business_profile')
        .select('entity_type')
        .eq('organization_id', currentOrg.id)
        .maybeSingle(),
    ]);

    if (fundsRes.error) {
      setError(fundsRes.error.message);
      setFunds([]);
      setMembers([]);
      setLoading(false);
      return;
    }

    setFunds((fundsRes.data ?? []) as SmsfFundRow[]);
    setMembers((membersRes.data ?? []) as SmsfMemberRow[]);
    setIsSmsfEntity(
      (profileRes.data as { entity_type?: string } | null)?.entity_type === 'smsf',
    );
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  return { funds, members, isSmsfEntity, loading, error, refresh: fetch };
}
