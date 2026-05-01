import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';

export interface BillListRow {
  id: string;
  status: 'received' | 'verified' | 'attached' | 'paid' | 'void';
  source: string;
  supplier_name_raw: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  total_inc_gst_cents: number | null;
  job_reference_raw: string | null;
  ocr_provider: string | null;
  xero_status: string;
  created_at: string;
  attached_job?: { id: string; job_number: string } | null;
}

export function useBills(statusFilter?: BillListRow['status']) {
  const { currentOrg } = useOrg();
  const [bills, setBills] = useState<BillListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!currentOrg) {
      setBills([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    let q = supabase
      .from('bills')
      .select(
        'id, status, source, supplier_name_raw, invoice_number, invoice_date, total_inc_gst_cents, job_reference_raw, ocr_provider, xero_status, created_at, attached_job:jobs!job_id(id, job_number)',
      )
      .eq('organization_id', currentOrg.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(100);

    if (statusFilter) q = q.eq('status', statusFilter);

    const { data, error: queryErr } = await q;
    if (queryErr) {
      setError(queryErr.message);
      setBills([]);
    } else {
      setBills((data ?? []) as unknown as BillListRow[]);
    }
    setLoading(false);
  }, [currentOrg, statusFilter]);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  return { bills, loading, error, refresh: fetch };
}
