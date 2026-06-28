import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

/**
 * useSuperBatch (SC-3.H.01) — drives the quarterly super-batch review/approve flow
 * for the current org + (fy, quarter):
 *   - loads the latest super_batch + its per-employee lines (SC-3.F.01),
 *   - generate() builds/refreshes the draft batch (generate_super_batch RPC),
 *   - send() invokes the Tier-2-gated super-batch-send edge fn (SC-3.G.01) and
 *     returns its verdict (sent / already_sent / approval-required) so the UI can
 *     show the same approve-gate UX as the BAS prep flow.
 *
 * Best-effort: super_batches/super_batch_lines (0124) + the send fn are repo-only
 * until the epic's deploy step, so reads degrade to null + an error string rather
 * than throwing. Hand-typed (no generated Supabase types; `as unknown as` cast).
 */

export interface SuperBatchLine {
  id: string;
  employee_id: string;
  employee_name: string;
  super_cents: number;
}

export interface SuperBatch {
  id: string;
  status: string;
  total_super_cents: number;
  line_count: number;
  fy_start_year: number;
  quarter: number;
  lines: SuperBatchLine[];
}

export interface SuperSendResult {
  ok: boolean;
  sent?: boolean;
  already_sent?: boolean;
  approval_id?: string | null;
  error?: string;
}

export function useSuperBatch(fyStartYear: number | null, quarter: number | null) {
  const { currentOrg } = useOrg();
  const [batch, setBatch] = useState<SuperBatch | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg || fyStartYear == null || quarter == null) {
      setBatch(null);
      return;
    }
    setLoading(true);
    setError(null);
    const { data: b, error: bErr } = await supabase
      .from('super_batches' as never)
      .select('id, status, total_super_cents, line_count, fy_start_year, quarter')
      .eq('organization_id', currentOrg.id)
      .eq('fy_start_year', fyStartYear)
      .eq('quarter', quarter)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (bErr) {
      setError(bErr.message);
      setBatch(null);
      setLoading(false);
      return;
    }
    if (!b) {
      setBatch(null);
      setLoading(false);
      return;
    }
    const row = b as unknown as Omit<SuperBatch, 'lines'>;
    const { data: lines } = await supabase
      .from('super_batch_lines' as never)
      .select('id, employee_id, employee_name, super_cents')
      .eq('batch_id', row.id)
      .order('employee_name');
    setBatch({ ...row, lines: (lines ?? []) as unknown as SuperBatchLine[] });
    setLoading(false);
  }, [currentOrg, fyStartYear, quarter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const generate = useCallback(async (): Promise<void> => {
    if (!currentOrg || fyStartYear == null || quarter == null)
      throw new Error('Select a quarter first.');
    const { error: err } = await supabase.rpc('generate_super_batch', {
      p_org: currentOrg.id,
      p_fy_start_year: fyStartYear,
      p_quarter: quarter,
    });
    if (err) throw new Error(err.message);
    await refresh();
  }, [currentOrg, fyStartYear, quarter, refresh]);

  // Send goes through the Tier-2-gated edge fn (SC-3.G.01): it does the approval
  // check + records the pending request on refusal. We surface its verdict.
  const send = useCallback(async (): Promise<SuperSendResult> => {
    if (!currentOrg || !batch) throw new Error('No batch to send.');
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) throw new Error('Not signed in.');
    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/super-batch-send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY ?? '',
      },
      body: JSON.stringify({ organization_id: currentOrg.id, super_batch_id: batch.id }),
    });
    const body = (await res.json().catch(() => ({}))) as SuperSendResult;
    await refresh();
    return { ...body, ok: Boolean(body.ok) };
  }, [currentOrg, batch, refresh]);

  return { batch, loading, error, refresh, generate, send };
}
