import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

export type SignalKind =
  | 'investment_property'
  | 'business_saas'
  | 'recurring_utilities'
  | 'vehicle_fleet'
  | 'insurance'
  | 'bank_accounts'
  | 'regulatory_presence'
  | 'regular_subcontractors'
  | 'customer_base'
  | 'active_jobs';

export interface BusinessSignal {
  signal_kind: SignalKind;
  evidence: string;
  confidence: number;
  question: string;
  metadata: {
    entity_ids?: string[];
    sample_brands?: string[];
    count?: number;
    sample?: string[];
    brands?: string[];
  };
}

export function useBusinessSignals() {
  const { currentOrg } = useOrg();
  const [signals, setSignals] = useState<BusinessSignal[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    const { data } = await supabase.rpc('business_profile_signals', { p_org_id: currentOrg.id });
    setSignals((data as BusinessSignal[]) ?? []);
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => void refresh(), [refresh]);

  return { signals, loading, refresh };
}
