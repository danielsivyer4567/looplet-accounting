import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

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

export function useSuppliers(pageSize = 100) {
  const { currentOrg } = useOrg();
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [spendMap, setSpendMap] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const offsetRef = useRef(0);

  const fetch = useCallback(async (reset = true) => {
    if (!currentOrg) {
      setSuppliers([]);
      setSpendMap(new Map());
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    const from = reset ? 0 : offsetRef.current;
    const to = from + pageSize - 1;

    const [suppliersRes, billsRes] = await Promise.all([
      supabase
        .from('suppliers')
        .select(
          'id, name, abn, email, contact_phone, default_account_code, current_balance_owing_cents, created_at',
        )
        .eq('organization_id', currentOrg.id)
        .order('name', { ascending: true })
        .range(from, to),
      // Fetch spend rows only on first page (reset); append pages don't re-aggregate
      reset
        ? supabase
            .from('bills')
            .select('supplier_id, total_inc_gst_cents')
            .eq('organization_id', currentOrg.id)
            .is('deleted_at', null)
            .not('supplier_id', 'is', null)
        : Promise.resolve({ data: null, error: null }),
    ]);

    if (suppliersRes.error) {
      setError(suppliersRes.error.message);
      if (reset) setSuppliers([]);
      setLoading(false);
      return;
    }

    const fetched = (suppliersRes.data ?? []) as SupplierRow[];
    if (reset) {
      setSuppliers(fetched);
    } else {
      setSuppliers((prev) => [...prev, ...fetched]);
    }
    offsetRef.current = from + fetched.length;
    setHasMore(fetched.length === pageSize);

    // Build spend map client-side from raw bill rows (only on first load / reset)
    if (reset && billsRes.data) {
      const map = new Map<string, number>();
      for (const bill of billsRes.data) {
        const sid = (bill as { supplier_id: string | null }).supplier_id;
        if (!sid) continue;
        const amount = (bill as { total_inc_gst_cents: number | null }).total_inc_gst_cents ?? 0;
        map.set(sid, (map.get(sid) ?? 0) + amount);
      }
      setSpendMap(map);
    }

    setLoading(false);
  }, [currentOrg, pageSize]);

  useEffect(() => {
    offsetRef.current = 0;
    void fetch(true);
  }, [fetch]);

  const loadMore = useCallback(async () => {
    await fetch(false);
  }, [fetch]);

  return {
    suppliers,
    spendMap,
    loading,
    error,
    refresh: () => { offsetRef.current = 0; return fetch(true); },
    hasMore,
    loadMore,
  };
}
