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

// The full trust record for the detail view.
export interface TrustDetailRow extends TrustRow {
  trustee_abn: string | null;
  tfn: string | null;
}

// The governing deed (SC-5.A.02, table `trust_deed`). One active row per trust.
export interface TrustDeedRow {
  id: string;
  deed_date: string | null;
  vesting_date: string | null;
  streaming_allowed: boolean;
  parsed_terms: Record<string, unknown>;
  storage_key: string | null;
}

// A beneficiary (SC-5.A.01, table `trust_beneficiaries`).
export interface BeneficiaryRow {
  id: string;
  name: string;
  beneficiary_type: string;
  relationship: string | null;
  abn: string | null;
  date_of_birth: string | null;
}

export const BENEFICIARY_TYPES = [
  'individual',
  'company',
  'trust',
  'smsf',
  'charity',
  'partnership',
  'other',
] as const;

/**
 * Loads one trust + its active deed + its beneficiaries for the detail view. org-scoped
 * (RLS does the rest). Returns the rows + loading/error + a refresh to re-pull after edits.
 */
export function useTrust(id: string | undefined) {
  const { currentOrg } = useOrg();
  const [trust, setTrust] = useState<TrustDetailRow | null>(null);
  const [deed, setDeed] = useState<TrustDeedRow | null>(null);
  const [beneficiaries, setBeneficiaries] = useState<BeneficiaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg || !id) {
      setTrust(null);
      setDeed(null);
      setBeneficiaries([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    const [trustRes, deedRes, benRes] = await Promise.all([
      supabase
        .from('trusts')
        .select('id, name, trust_type, abn, tfn, trustee_name, trustee_abn, is_corporate_trustee, settled_date, created_at')
        .eq('id', id)
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .maybeSingle(),
      supabase
        .from('trust_deed')
        .select('id, deed_date, vesting_date, streaming_allowed, parsed_terms, storage_key')
        .eq('trust_id', id)
        .is('deleted_at', null)
        .maybeSingle(),
      supabase
        .from('trust_beneficiaries')
        .select('id, name, beneficiary_type, relationship, abn, date_of_birth')
        .eq('trust_id', id)
        .is('deleted_at', null)
        .order('name', { ascending: true }),
    ]);

    if (trustRes.error) {
      setError(trustRes.error.message);
      setLoading(false);
      return;
    }
    setTrust((trustRes.data as TrustDetailRow | null) ?? null);
    setDeed((deedRes.data as TrustDeedRow | null) ?? null);
    setBeneficiaries((benRes.data ?? []) as BeneficiaryRow[]);
    setLoading(false);
  }, [currentOrg, id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { trust, deed, beneficiaries, loading, error, refresh };
}
