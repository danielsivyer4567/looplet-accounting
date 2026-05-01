import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';

export interface BillLineItem {
  id: string;
  line_number: number;
  description: string;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
  gst_cents: number;
  account_code: string | null;
  category: string | null;
}

export interface BillDetail {
  id: string;
  organization_id: string;
  job_id: string | null;
  status: 'received' | 'verified' | 'attached' | 'paid' | 'void';
  source: string;
  storage_key: string;
  original_filename: string;
  mime_type: string;
  supplier_name_raw: string | null;
  supplier_abn: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  total_inc_gst_cents: number | null;
  gst_cents: number | null;
  subtotal_ex_gst_cents: number | null;
  currency_code: string;
  job_reference_raw: string | null;
  notes: string | null;
  ocr_provider: string | null;
  ocr_confidence: number | null;
  xero_status: string;
  xero_invoice_id: string | null;
  attached_at: string | null;
  suggested_job_id: string | null;
  suggested_match_score: number | null;
  raw_extracted: { _extraction_method?: string } | null;
  created_at: string;
  line_items: BillLineItem[];
  attached_job?: { id: string; job_number: string; name: string } | null;
  suggested_job?: { id: string; job_number: string; name: string } | null;
}

export function useBill(billId: string | undefined) {
  const [bill, setBill] = useState<BillDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!billId) return;
    setLoading(true);
    setError(null);
    const { data, error: queryErr } = await supabase
      .from('bills')
      .select(
        '*, line_items:bill_line_items(*), attached_job:jobs!job_id(id, job_number, name), suggested_job:jobs!suggested_job_id(id, job_number, name)',
      )
      .eq('id', billId)
      .single();

    if (queryErr) {
      setError(queryErr.message);
      setBill(null);
    } else {
      // Sort line items by line_number ascending
      const billData = data as unknown as BillDetail;
      if (billData.line_items) {
        billData.line_items.sort((a, b) => a.line_number - b.line_number);
      }
      setBill(billData);
    }
    setLoading(false);
  }, [billId]);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  return { bill, loading, error, refresh: fetch };
}

/**
 * Returns a signed URL to view the original file. Re-creates on every call —
 * cheap to refresh, no caching needed for the preview pane.
 */
export async function getBillFileUrl(storageKey: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from('bills')
    .createSignedUrl(storageKey, 60 * 10); // 10 minute window
  if (error || !data) return null;
  return data.signedUrl;
}
