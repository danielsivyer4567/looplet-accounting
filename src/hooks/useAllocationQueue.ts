import { useState, useEffect, useCallback } from 'react';
import { useOrg } from '@/hooks/useOrg';
import { supabase } from '@/lib/supabase';

// Columns match v_allocation_queue exactly:
//   bill_id, organization_id, status, supplier_name_raw, invoice_number,
//   invoice_date, total_inc_gst_cents, job_reference_raw, suggested_job_id,
//   score (alias of suggested_match_score), suggested_job_number,
//   suggested_job_name, suggested_job_status, created_at
export interface AllocationQueueRow {
  bill_id: string;
  organization_id: string;
  status: string | null;
  supplier_name_raw: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  total_inc_gst_cents: number | null;
  job_reference_raw: string | null;
  suggested_job_id: string | null;
  score: number | null;
  suggested_job_number: string | null;
  suggested_job_name: string | null;
  suggested_job_status: string | null;
  created_at: string | null;
}

export interface AllocationQueueStats {
  total: number;
  high_confidence: number;
  needs_review: number;
  no_suggestion: number;
}

export interface RunResult extends AllocationQueueStats {
  ok: boolean;
  error?: string;
}

function computeStats(rows: AllocationQueueRow[]): AllocationQueueStats {
  let high_confidence = 0;
  let needs_review = 0;
  let no_suggestion = 0;

  for (const row of rows) {
    const s = row.score;
    if (s == null || s < 0.5) {
      no_suggestion++;
    } else if (s >= 0.85) {
      high_confidence++;
    } else {
      needs_review++;
    }
  }

  return {
    total: rows.length,
    high_confidence,
    needs_review,
    no_suggestion,
  };
}

const SELECT_COLS = [
  'bill_id',
  'organization_id',
  'status',
  'supplier_name_raw',
  'invoice_number',
  'invoice_date',
  'total_inc_gst_cents',
  'job_reference_raw',
  'suggested_job_id',
  'score',
  'suggested_job_number',
  'suggested_job_name',
  'suggested_job_status',
  'created_at',
].join(', ');

export function useAllocationQueue() {
  const { currentOrg } = useOrg();
  const [queue, setQueue] = useState<AllocationQueueRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<AllocationQueueStats>({
    total: 0,
    high_confidence: 0,
    needs_review: 0,
    no_suggestion: 0,
  });

  const refresh = useCallback(async () => {
    if (!currentOrg?.id) return;

    setLoading(true);
    setError(null);

    try {
      const { data, error: fetchError } = await supabase
        .from('v_allocation_queue')
        .select(SELECT_COLS)
        .eq('organization_id', currentOrg.id);

      if (fetchError) {
        setError(fetchError.message);
        return;
      }

      const rows = (data ?? []) as unknown as AllocationQueueRow[];
      setQueue(rows);
      setStats(computeStats(rows));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [currentOrg?.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const invokeAllocate = useCallback(
    async (mode: string, min_score?: number): Promise<RunResult> => {
      if (!currentOrg?.id) {
        return {
          ok: false,
          error: 'No org selected',
          total: 0,
          high_confidence: 0,
          needs_review: 0,
          no_suggestion: 0,
        };
      }

      try {
        const body: Record<string, unknown> = { org_id: currentOrg.id, mode };
        if (min_score !== undefined) {
          body.min_score = min_score;
        }

        const { error: fnError } = await supabase.functions.invoke('bills-allocate-batch', { body });

        if (fnError) {
          return {
            ok: false,
            error: fnError.message,
            total: 0,
            high_confidence: 0,
            needs_review: 0,
            no_suggestion: 0,
          };
        }

        const { data } = await supabase
          .from('v_allocation_queue')
          .select(SELECT_COLS)
          .eq('organization_id', currentOrg.id);

        const freshRows = (data ?? []) as unknown as AllocationQueueRow[];
        setQueue(freshRows);
        const freshStats = computeStats(freshRows);
        setStats(freshStats);

        return { ok: true, ...freshStats };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          total: 0,
          high_confidence: 0,
          needs_review: 0,
          no_suggestion: 0,
        };
      }
    },
    [currentOrg?.id],
  );

  const runAutoAccept = useCallback(
    (minScore = 0.85): Promise<RunResult> => invokeAllocate('auto_accept', minScore),
    [invokeAllocate],
  );

  const runRematch = useCallback((): Promise<RunResult> => invokeAllocate('rematch'), [invokeAllocate]);

  const runFull = useCallback((): Promise<RunResult> => invokeAllocate('full'), [invokeAllocate]);

  return {
    queue,
    loading,
    error,
    stats,
    runAutoAccept,
    runRematch,
    runFull,
    refresh,
  };
}
