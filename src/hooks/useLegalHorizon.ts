import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';

export type LegalChangeStage =
  | 'announced'
  | 'exposure_draft'
  | 'before_parliament'
  | 'passed_pending_assent'
  | 'enacted'
  | 'abandoned';

export interface LegalHorizonRow {
  id: string;
  title: string;
  summary: string | null;
  topic: string | null;
  stage: LegalChangeStage;
  confidence: number;
  proposed_effective_from: string | null;
  source_url: string | null;
  source_excerpt: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

const HORIZON_COLS =
  'id, title, summary, topic, stage, confidence, proposed_effective_from, ' +
  'source_url, source_excerpt, first_seen_at, last_seen_at';

/**
 * Open items from the legal_horizon radar (SC-LC.F.01) — UPCOMING Australian
 * tax/super changes the Sonar scanner (F.02) found, soonest proposed-effective
 * first (then highest confidence).
 *
 * GLOBAL reference data (the legislative pipeline is the same for every tenant) →
 * NOT org-scoped: no organization_id filter, RLS lets any authenticated user SELECT
 * (unlike useApprovals/usePaymentRuns which scope to currentOrg). These rows are
 * PROPOSALS, never settled law — the page labels them accordingly. Hand-typed row +
 * `as unknown as` cast (the repo has no generated Supabase types).
 */
export function useLegalHorizon() {
  const [items, setItems] = useState<LegalHorizonRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    setLoading(true);
    const { data, error: err } = await supabase
      .from('legal_horizon')
      .select(HORIZON_COLS)
      .eq('status', 'open')
      .is('deleted_at', null)
      .order('proposed_effective_from', { ascending: true, nullsFirst: false })
      .order('confidence', { ascending: false })
      .limit(100);

    if (err) {
      setError(err.message);
    } else {
      setError(null);
      setItems((data ?? []) as unknown as LegalHorizonRow[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  return { items, loading, error, refresh: fetch };
}
