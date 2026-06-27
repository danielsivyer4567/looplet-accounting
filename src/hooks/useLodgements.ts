import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

export type LodgementType = 'bas' | 'stp' | 'tpar' | 'return' | 'fbt' | 'tbar';
export type LodgementStatus = 'draft' | 'queued' | 'submitted' | 'accepted' | 'rejected' | 'error';

export interface LodgementRow {
  id: string;
  organization_id: string;
  lodgement_type: LodgementType;
  period_label: string;
  payload_hash: string;
  payload: Record<string, unknown>;
  ato_receipt_id: string | null;
  status: LodgementStatus;
  submitted_at: string | null;
  response: Record<string, unknown>;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

const LODGEMENT_COLUMNS =
  'id, organization_id, lodgement_type, period_label, payload_hash, payload, ' +
  'ato_receipt_id, status, submitted_at, response, error_message, created_at, updated_at, created_by';

export function useLodgements(limit = 100) {
  const { currentOrg } = useOrg();
  const [lodgements, setLodgements] = useState<LodgementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg) {
      setLodgements([]);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    const { data, error: err } = await supabase
      .from('lodgements')
      .select(LODGEMENT_COLUMNS)
      .eq('organization_id', currentOrg.id)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (err) {
      setError(err.message);
      setLodgements([]);
    } else {
      setError(null);
      setLodgements((data ?? []) as unknown as LodgementRow[]);
    }
    setLoading(false);
  }, [currentOrg, limit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { lodgements, loading, error, refresh };
}
