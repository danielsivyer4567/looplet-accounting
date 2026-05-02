import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';

export type JobStatus = 'draft' | 'active' | 'paused' | 'completed' | 'cancelled';

export interface JobListRow {
  id: string;
  job_number: string;
  name: string;
  status: JobStatus;
  created_at: string;
  attached_bills: [{ count: number }] | [];
  suggested_bills: [{ count: number }] | [];
}

export function useJobs() {
  const { currentOrg } = useOrg();
  const [jobs, setJobs] = useState<JobListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!currentOrg) {
      setJobs([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    const { data, error: queryErr } = await supabase
      .from('jobs')
      .select(
        'id, job_number, name, status, created_at, attached_bills:bills!job_id(count), suggested_bills:bills!suggested_job_id(count)',
      )
      .eq('organization_id', currentOrg.id)
      .order('created_at', { ascending: false })
      .limit(200);

    if (queryErr) {
      setError(queryErr.message);
      setJobs([]);
    } else {
      setJobs((data ?? []) as unknown as JobListRow[]);
    }
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  return { jobs, loading, error, refresh: fetch };
}
