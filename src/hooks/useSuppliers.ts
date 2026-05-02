import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';

export interface SupplierRow {
  id: string;
  name: string;
  abn: string | null;
  email: string | null;
  contact_phone: string | null;
  default_account_code: string | null;
  current_balance_owing_cents: number | null;
  created_at: string;
}

export interface SupplierSpend {
  supplier_id: string;
  total_spend_cents: number;
}

export function useSuppliers() {
  const { currentOrg } = useOrg();
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [spendMap, setSpendMap] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!currentOrg) {
      setSuppliers([]);
      setSpendMap(new Map());
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    const [suppliersRes, billsRes] = await Promise.all([
      supabase
        .from('suppliers')
        .select(
          'id, name, abn, email, contact_phone, default_account_code, current_balance_owing_cents, created_at',
        )
        .eq('organization_id', currentOrg.id)
        .order('name', { ascending: true }),
      // Aggregate spend from bills grouped by supplier_id
      supabase
        .from('bills')
        .select('supplier_id, total_inc_gst_cents')
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .not('supplier_id', 'is', null),
    ]);

    if (suppliersRes.error) {
      setError(suppliersRes.error.message);
      setSuppliers([]);
      setLoading(false);
      return;
    }

    setSuppliers((suppliersRes.data ?? []) as SupplierRow[]);

    // Build spend map client-side from raw bill rows
    const map = new Map<string, number>();
    for (const bill of billsRes.data ?? []) {
      const sid = (bill as { supplier_id: string | null }).supplier_id;
      if (!sid) continue;
      const amount = (bill as { total_inc_gst_cents: number | null }).total_inc_gst_cents ?? 0;
      map.set(sid, (map.get(sid) ?? 0) + amount);
    }
    setSpendMap(map);
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  return { suppliers, spendMap, loading, error, refresh: fetch };
}
