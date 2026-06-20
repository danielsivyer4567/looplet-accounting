import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

export interface InvoiceListRow {
  id: string;
  invoice_number: string;
  status: string;
  issue_date: string;
  due_date: string;
  total_inc_gst_cents: number;
  amount_paid_cents: number;
  balance_due_cents: number;
  customer_id: string;
  job_id: string | null;
  customer: { id: string; name: string } | null;
  job: { id: string; job_number: string; name: string } | null;
}

export function useInvoices(
  filter?: { status?: string; customerId?: string; jobId?: string },
  pageSize = 100,
) {
  const { currentOrg } = useOrg();
  const [invoices, setInvoices] = useState<InvoiceListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const offsetRef = useRef(0);

  const fetch = useCallback(async (reset = true) => {
    if (!currentOrg) {
      setInvoices([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const from = reset ? 0 : offsetRef.current;
    const to = from + pageSize - 1;

    let query = supabase
      .from('invoices')
      .select(`
        id, invoice_number, status, issue_date, due_date,
        total_inc_gst_cents, amount_paid_cents, balance_due_cents,
        customer_id, job_id,
        customer:customers!invoices_customer_id_fkey(id, name),
        job:jobs!invoices_job_id_fkey(id, job_number, name)
      `)
      .eq('organization_id', currentOrg.id)
      .is('deleted_at', null)
      .order('issue_date', { ascending: false })
      .range(from, to);

    if (filter?.status) query = query.eq('status', filter.status);
    if (filter?.customerId) query = query.eq('customer_id', filter.customerId);
    if (filter?.jobId) query = query.eq('job_id', filter.jobId);

    const { data, error: err } = await query;
    if (err) {
      setError(err.message);
      if (reset) setInvoices([]);
    } else {
      const fetched = (data ?? []) as unknown as InvoiceListRow[];
      if (reset) {
        setInvoices(fetched);
      } else {
        setInvoices((prev) => [...prev, ...fetched]);
      }
      offsetRef.current = from + fetched.length;
      setHasMore(fetched.length === pageSize);
    }
    setLoading(false);
  }, [currentOrg, filter?.status, filter?.customerId, filter?.jobId, pageSize]);

  useEffect(() => {
    offsetRef.current = 0;
    void fetch(true);
  }, [fetch]);

  const loadMore = useCallback(async () => {
    await fetch(false);
  }, [fetch]);

  return {
    invoices,
    loading,
    error,
    refresh: () => { offsetRef.current = 0; return fetch(true); },
    hasMore,
    loadMore,
  };
}
