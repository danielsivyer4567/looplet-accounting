import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

export interface CodingQueueRow {
  id: string;
  bank_transaction_id: string;
  category_code: string | null;
  category_label: string | null;
  category_xero_account_code: string | null;
  job_id: string | null;
  confidence: number;
  status: string;
  rationale: Record<string, unknown>;
  // Denormalised from bank_transactions
  txn_description: string;
  txn_amount_cents: number;
  txn_posted_at: string;
  txn_coding_status: string;
  txn_suggested_job_id: string | null;
  txn_suggested_job_score: number | null;
}

export function useBankCodingQueue() {
  const { currentOrg } = useOrg();
  const [rows, setRows] = useState<CodingQueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);

    const { data, error: err } = await supabase
      .from('bank_tx_coding_queue')
      .select('*')
      .eq('organization_id', currentOrg.id)
      .order('confidence', { ascending: false })
      .limit(100);

    if (err) {
      setError(err.message);
    } else {
      setRows((data ?? []) as CodingQueueRow[]);
    }
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => void refresh(), [refresh]);

  async function postDecision(
    bankTransactionId: string,
    decision: 'accept' | 'override',
    categoryCode?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    setBusyId(bankTransactionId);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) return { ok: false, error: 'Not authenticated' };

      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/bank-transaction-classifier`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          bank_transaction_id: bankTransactionId,
          decision,
          ...(categoryCode ? { category_code: categoryCode } : {}),
        }),
      });

      const body = (await res.json()) as { ok: boolean; error?: string };
      if (!body.ok) return { ok: false, error: body.error ?? '' };

      // Optimistic removal from queue
      setRows((prev) => prev.filter((r) => r.bank_transaction_id !== bankTransactionId));
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    } finally {
      setBusyId(null);
    }
  }

  async function confirmAll(minConfidence = 0.8) {
    const high = rows.filter((r) => r.confidence >= minConfidence);
    for (const row of high) {
      if (!row.category_code) continue;
      await postDecision(row.bank_transaction_id, 'accept');
    }
    void refresh();
  }

  return { rows, loading, error, busyId, refresh, postDecision, confirmAll };
}
