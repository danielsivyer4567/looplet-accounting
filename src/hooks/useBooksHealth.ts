import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

// The four raw signals from compute_books_health (0090), surfaced via v_books_health (0091).
export interface BooksHealthComponents {
  uncoded_count: number;
  unreconciled_count: number;
  open_period_count: number;
  coverage_pct: number;
}

interface BooksHealthRow extends BooksHealthComponents {
  organization_id: string;
  score: number;
  blocking: boolean;
}

// Reads the books-health score for the current org from v_books_health (one row per
// accessible org; we scope to the active one). `blocking` is the gate downstream tax
// engines read before they run. Shape mirrors useRealtimePnl: one row of state, the
// score/components/blocking views derived on return.
export function useBooksHealth() {
  const { currentOrg } = useOrg();
  const [row, setRow] = useState<BooksHealthRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentOrg) {
      setRow(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void supabase
      .from('v_books_health')
      .select(
        'organization_id, uncoded_count, unreconciled_count, open_period_count, coverage_pct, score, blocking',
      )
      .eq('organization_id', currentOrg.id)
      .maybeSingle()
      .then(({ data, error: queryErr }) => {
        if (queryErr) {
          setError(queryErr.message);
          setRow(null);
        } else {
          setRow(data as BooksHealthRow | null);
        }
        setLoading(false);
      });
  }, [currentOrg]);

  return {
    score: row?.score ?? null,
    components: row
      ? {
          uncoded_count: row.uncoded_count,
          unreconciled_count: row.unreconciled_count,
          open_period_count: row.open_period_count,
          coverage_pct: row.coverage_pct,
        }
      : null,
    blocking: row?.blocking ?? false,
    loading,
    error,
  };
}
