import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

export interface PaymentRunRow {
  id: string;
  organization_id: string;
  pay_date: string;
  status: 'draft' | 'approved' | 'exported' | 'paid' | 'cancelled';
  total_cents: number;
  bill_count: number;
  aba_file_generated_at: string | null;
  aba_file_size_bytes: number | null;
  notes: string | null;
  created_at: string;
  payer_bank_account_id: string | null;
}

export interface UnpaidBillForRun {
  bill_id: string;
  organization_id: string;
  supplier_id: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  total_inc_gst_cents: number;
  supplier_name_raw: string | null;
  supplier_name: string | null;
  payee_bsb: string | null;
  payee_account_number: string | null;
  payee_account_name: string | null;
  has_bank_details: boolean;
}

export interface PaymentRunItem {
  id: string;
  bill_id: string;
  amount_cents: number;
  payee_bsb: string;
  payee_account_number: string;
  payee_account_name: string;
  reference: string | null;
}

export function usePaymentRuns() {
  const { currentOrg } = useOrg();
  const [runs, setRuns] = useState<PaymentRunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!currentOrg) {
      setRuns([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data, error: err } = await supabase
      .from('payment_runs')
      .select(
        'id, organization_id, pay_date, status, total_cents, bill_count, aba_file_generated_at, aba_file_size_bytes, notes, created_at, payer_bank_account_id',
      )
      .eq('organization_id', currentOrg.id)
      .order('created_at', { ascending: false })
      .limit(100);

    if (err) {
      setError(err.message);
    } else {
      setRuns((data ?? []) as unknown as PaymentRunRow[]);
    }
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => { void fetch(); }, [fetch]);

  return { runs, loading, error, refresh: fetch };
}

export function useUnpaidBillsForRun() {
  const { currentOrg } = useOrg();
  const [bills, setBills] = useState<UnpaidBillForRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentOrg) {
      setBills([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    void (async () => {
      const { data, error: err } = await supabase
        .from('v_unpaid_bills_for_payment_run')
        .select('*')
        .eq('organization_id', currentOrg.id)
        .order('due_date', { ascending: true, nullsFirst: false });

      if (err) {
        setError(err.message);
      } else {
        setBills((data ?? []) as unknown as UnpaidBillForRun[]);
      }
      setLoading(false);
    })();
  }, [currentOrg]);

  return { bills, loading, error };
}

export function usePaymentRunDetail(id: string | undefined) {
  const { currentOrg } = useOrg();
  const [run, setRun] = useState<PaymentRunRow | null>(null);
  const [items, setItems] = useState<PaymentRunItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!currentOrg || !id) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const [runRes, itemsRes] = await Promise.all([
      supabase
        .from('payment_runs')
        .select(
          'id, organization_id, pay_date, status, total_cents, bill_count, aba_file_generated_at, aba_file_size_bytes, notes, created_at, payer_bank_account_id',
        )
        .eq('id', id)
        .eq('organization_id', currentOrg.id)
        .maybeSingle(),
      supabase
        .from('payment_run_items')
        .select('id, bill_id, amount_cents, payee_bsb, payee_account_number, payee_account_name, reference')
        .eq('payment_run_id', id)
        .order('created_at', { ascending: true }),
    ]);

    if (runRes.error) {
      setError(runRes.error.message);
    } else {
      setRun(runRes.data as unknown as PaymentRunRow);
      setItems((itemsRes.data ?? []) as unknown as PaymentRunItem[]);
    }
    setLoading(false);
  }, [currentOrg, id]);

  useEffect(() => { void fetch(); }, [fetch]);

  return { run, items, loading, error, refresh: fetch };
}
