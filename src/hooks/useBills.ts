import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

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
  // EPIC D: intake classification. document_kind / is_probable_bill are not in
  // the generated types yet, so they're optional and queried defensively.
  document_kind?: string | null;
  is_probable_bill?: boolean | null;
  storage_key?: string | null;
  mime_type?: string | null;
  original_filename?: string | null;
  attached_job?: { id: string; job_number: string } | null;
}

export function useBills(
  statusFilter?: BillListRow['status'],
  pageSize = 100,
  // When false (default), classified non-invoices (is_probable_bill = false)
  // are hidden from the active bills list. The "Show non-invoices" toggle on
  // the bills page flips this to true.
  includeNonBills = false,
) {
  const { currentOrg } = useOrg();
  const [bills, setBills] = useState<BillListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const offsetRef = useRef(0);

  const fetch = useCallback(async (reset = true) => {
    if (!currentOrg) {
      setBills([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const from = reset ? 0 : offsetRef.current;
    const to = from + pageSize - 1;

    let q = supabase
      .from('bills')
      .select(
        'id, status, source, supplier_name_raw, invoice_number, invoice_date, total_inc_gst_cents, job_reference_raw, ocr_provider, xero_status, created_at, document_kind, is_probable_bill, storage_key, mime_type, original_filename, attached_job:jobs!job_id(id, job_number)',
      )
      .eq('organization_id', currentOrg.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .range(from, to);

    if (statusFilter) q = q.eq('status', statusFilter);
    // Default view hides classified non-invoices. is_probable_bill defaults to
    // true at the DB level, so rows ingested before classification still show.
    if (!includeNonBills) q = q.neq('is_probable_bill', false);

    const { data, error: queryErr } = await q;
    if (queryErr) {
      setError(queryErr.message);
      if (reset) setBills([]);
    } else {
      const fetched = (data ?? []) as unknown as BillListRow[];
      if (reset) {
        setBills(fetched);
      } else {
        setBills((prev) => [...prev, ...fetched]);
      }
      offsetRef.current = from + fetched.length;
      setHasMore(fetched.length === pageSize);
    }
    setLoading(false);
  }, [currentOrg, statusFilter, pageSize, includeNonBills]);

  useEffect(() => {
    offsetRef.current = 0;
    void fetch(true);
  }, [fetch]);

  const loadMore = useCallback(async () => {
    await fetch(false);
  }, [fetch]);

  return { bills, loading, error, refresh: () => { offsetRef.current = 0; return fetch(true); }, hasMore, loadMore };
}
