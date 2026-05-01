import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';

export interface QueueBill {
  id: string;
  organization_id: string;
  supplier_name_raw: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  total_inc_gst_cents: number | null;
  job_reference_raw: string | null;
  ocr_confidence: number | null;
  ocr_provider: string | null;
  suggested_job_id: string | null;
  suggested_match_score: number | null;
  storage_key: string;
  mime_type: string;
  created_at: string;
  // Joined
  suggested_job?: { id: string; job_number: string; name: string } | null;
}

export function useAllocationQueue() {
  const { currentOrg } = useOrg();
  const [bills, setBills] = useState<QueueBill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!currentOrg) {
      setBills([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { data, error: queryErr } = await supabase
      .from('bills')
      .select(
        'id, organization_id, supplier_name_raw, invoice_number, invoice_date, total_inc_gst_cents, job_reference_raw, ocr_confidence, ocr_provider, suggested_job_id, suggested_match_score, storage_key, mime_type, created_at, suggested_job:jobs!suggested_job_id(id, job_number, name)',
      )
      .eq('organization_id', currentOrg.id)
      .eq('status', 'verified')
      .is('job_id', null)
      .is('deleted_at', null)
      .order('suggested_match_score', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });

    if (queryErr) {
      setError(queryErr.message);
      setBills([]);
    } else {
      setBills((data ?? []) as unknown as QueueBill[]);
    }
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  return { bills, loading, error, refresh: fetch };
}
