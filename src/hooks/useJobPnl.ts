import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';

export interface JobPnl {
  job_id: string;
  organization_id: string;
  job_number: string;
  job_name: string;
  job_status: 'draft' | 'active' | 'paused' | 'completed' | 'cancelled';
  start_date: string | null;
  end_date: string | null;
  revenue_inc_gst_cents: number;
  revenue_ex_gst_cents: number;
  gst_collected_cents: number;
  cost_bills_cents: number;
  cost_wages_cents: number;
  cost_overhead_cents: number;
  gst_input_credit_cents: number;
  total_cost_cents: number;
  gross_profit_cents: number;
  budget_cents: number;
  currency_code: string;
}

export function useJobPnl() {
  const { currentOrg } = useOrg();
  const [jobs, setJobs] = useState<JobPnl[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentOrg) {
      setJobs([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void supabase
      .from('v_job_pnl')
      .select('*')
      .eq('organization_id', currentOrg.id)
      .order('start_date', { ascending: false, nullsFirst: false })
      .then(({ data, error }) => {
        if (error) {
          setError(error.message);
          setJobs([]);
        } else {
          setJobs((data ?? []) as JobPnl[]);
        }
        setLoading(false);
      });
  }, [currentOrg]);

  return { jobs, loading, error };
}
