import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

// One trust the org administers (SC-5.A.01, table `trusts`). Typed against the
// distribution-engine-relevant columns the list surfaces.
export interface TrustRow {
  id: string;
  name: string;
  trust_type: string;
  abn: string | null;
  trustee_name: string | null;
  is_corporate_trustee: boolean;
  settled_date: string | null;
  created_at: string;
}

/**
 * Lists the org's trusts + whether the org is itself a trust entity (the visibility gate
 * for the Trusts workspace lives on business_profile.entity_type, not organizations).
 * Mirrors useSuppliers: org-scoped, RLS does the rest; loading/error/refresh.
 */
export function useTrusts() {
  const { currentOrg } = useOrg();
  const [trusts, setTrusts] = useState<TrustRow[]>([]);
  const [isTrustEntity, setIsTrustEntity] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!currentOrg) {
      setTrusts([]);
      setIsTrustEntity(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    const [trustsRes, profileRes] = await Promise.all([
      supabase
        .from('trusts')
        .select('id, name, trust_type, abn, trustee_name, is_corporate_trustee, settled_date, created_at')
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .order('name', { ascending: true }),
      supabase
        .from('business_profile')
        .select('entity_type')
        .eq('organization_id', currentOrg.id)
        .maybeSingle(),
    ]);

    if (trustsRes.error) {
      setError(trustsRes.error.message);
      setTrusts([]);
      setLoading(false);
      return;
    }

    setTrusts((trustsRes.data ?? []) as TrustRow[]);
    setIsTrustEntity(
      (profileRes.data as { entity_type?: string } | null)?.entity_type === 'trust',
    );
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  return { trusts, isTrustEntity, loading, error, refresh: fetch };
}
