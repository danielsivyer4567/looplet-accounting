import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

export interface RealtimePnl {
  organization_id: string;
  organization_name: string;
  revenue_inc_gst_cents: number;
  revenue_ex_gst_cents: number;
  gst_collected_cents: number;
  gst_input_credit_cents: number;
  gst_set_aside_cents: number;
  cost_bills_cents: number;
  cost_wages_cents: number;
  cost_overhead_cents: number;
  total_cost_cents: number;
  gross_profit_cents: number;
  tax_set_aside_cents: number;
  really_yours_cents: number;
}

export function useRealtimePnl() {
  const { currentOrg } = useOrg();
  const [pnl, setPnl] = useState<RealtimePnl | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentOrg) {
      setPnl(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void supabase
      .from('v_organization_realtime_pnl')
      .select('*')
      .eq('organization_id', currentOrg.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) {
          setError(error.message);
          setPnl(null);
        } else {
          setPnl(data as RealtimePnl | null);
        }
        setLoading(false);
      });
  }, [currentOrg]);

  return { pnl, loading, error };
}
