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

export interface LegalHorizonScanStats {
  scanned?: number;
  inserted?: number;
  updated?: number;
  skipped?: number;
  dropped?: number;
}

interface LegalHorizonRunResponse {
  ok?: boolean;
  stats?: LegalHorizonScanStats;
  error?: string;
}

const HORIZON_COLS =
  'id, title, summary, topic, stage, confidence, proposed_effective_from, ' +
  'source_url, source_excerpt, first_seen_at, last_seen_at';

function plural(n: number, singular: string, pluralWord = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralWord}`;
}

function scanMessage(stats?: LegalHorizonScanStats): string {
  if (!stats) return 'Sonar scan complete.';
  const scanned = stats.scanned ?? 0;
  const inserted = stats.inserted ?? 0;
  const updated = stats.updated ?? 0;
  const dropped = stats.dropped ?? 0;
  const droppedText = dropped > 0 ? `, ${plural(dropped, 'item')} dropped` : '';
  return `Sonar scan complete: ${plural(scanned, 'item')} scanned, ${plural(inserted, 'new item')}, ${plural(updated, 'refreshed item')}${droppedText}.`;
}

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
  const [scanBusy, setScanBusy] = useState(false);
  const [scanStatus, setScanStatus] = useState<string | null>(null);

  const refresh = useCallback(async () => {
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
    void refresh();
  }, [refresh]);

  const runSonarScan = useCallback(async (): Promise<boolean> => {
    setScanBusy(true);
    setScanStatus(null);
    setError(null);

    try {
      const { data, error: fnErr } = await supabase.functions.invoke<LegalHorizonRunResponse>(
        'legal-horizon-run',
        {
          body: {},
        },
      );

      if (fnErr) {
        setError(fnErr.message);
        return false;
      }

      if (!data?.ok) {
        setError(data?.error ?? 'Sonar legal horizon scan failed.');
        return false;
      }

      setScanStatus(scanMessage(data.stats));
      await refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sonar legal horizon scan failed.');
      return false;
    } finally {
      setScanBusy(false);
    }
  }, [refresh]);

  return { items, loading, error, scanBusy, scanStatus, refresh, runSonarScan };
}
