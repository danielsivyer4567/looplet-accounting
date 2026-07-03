import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

export type JobStatus = 'draft' | 'active' | 'paused' | 'completed' | 'cancelled';

export interface JobListRow {
  id: string;
  job_number: string;
  name: string;
  status: JobStatus;
  created_at: string;
  attached_bills: [{ count: number }] | [];
  suggested_bills: [{ count: number }] | [];
  // Live P&L from v_job_pnl
  cost_bills_cents?: number;
  cost_wages_cents?: number;
  cost_overhead_cents?: number;
  total_cost_cents?: number;
  revenue_inc_gst_cents?: number;
  gross_profit_cents?: number;
  budget_cents?: number;
}

export function useJobs() {
  const { currentOrg } = useOrg();
  const [jobs, setJobs] = useState<JobListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Non-blocking: the job list still renders if only the P&L pipeline fails,
  // but the failure must be observable rather than showing silent zeros.
  const [pnlError, setPnlError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!currentOrg) {
      setJobs([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setPnlError(null);

    // Fetch jobs + bill counts in parallel with v_job_pnl for live numbers
    const [{ data: jobsData, error: jobsErr }, { data: pnlData, error: pnlErr }] =
      await Promise.all([
        supabase
          .from('jobs')
          .select(
            'id, job_number, name, status, created_at, attached_bills:bills!job_id(count), suggested_bills:bills!suggested_job_id(count)',
          )
          .eq('organization_id', currentOrg.id)
          .order('created_at', { ascending: false })
          .limit(200),
        supabase.from('v_job_pnl').select('*').eq('organization_id', currentOrg.id),
      ]);

    if (jobsErr) {
      setError(jobsErr.message);
      setJobs([]);
    } else {
      // Index P&L by job_id for an O(1) merge
      type PnlRow = { job_id: string } & Partial<JobListRow>;
      const pnlByJob = new Map<string, PnlRow>();
      for (const row of (pnlData ?? []) as PnlRow[]) pnlByJob.set(row.job_id, row);

      const merged: JobListRow[] = ((jobsData ?? []) as JobListRow[]).map((j) => ({
        ...j,
        ...(pnlByJob.get(j.id) ?? {}),
      }));
      setJobs(merged);
      // Surface a P&L-pipeline failure without blanking the whole list.
      setPnlError(pnlErr ? pnlErr.message : null);
    }
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  return { jobs, loading, error, pnlError, refresh: fetch };
}
