import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

export interface BillingAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;
}

export interface CustomerRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  billing_address: BillingAddress | null;
  abn: string | null;
  created_at: string;
}

export function useCustomers() {
  const { currentOrg } = useOrg();
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!currentOrg) {
      setCustomers([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    const { data, error: queryErr } = await supabase
      .from('customers')
      .select('id, name, email, phone, billing_address, abn, created_at')
      .eq('organization_id', currentOrg.id)
      .order('name', { ascending: true });

    if (queryErr) {
      setError(queryErr.message);
      setCustomers([]);
    } else {
      setCustomers((data ?? []) as unknown as CustomerRow[]);
    }
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  return { customers, loading, error, refresh: fetch };
}
