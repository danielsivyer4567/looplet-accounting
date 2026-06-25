import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

// One needs_review row from coding_review_queue (0092): a low-confidence coding
// suggestion a human still owns. account_code/tax_code are the classifier's
// proposal (advisory text, not FKs); rationale carries the matcher evidence.
export interface CodingSuggestion {
  id: string;
  organization_id: string;
  bill_id: string;
  account_code: string | null;
  tax_code: string | null;
  confidence: number;
  status: string;
  rationale: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

// A human-corrected code pair for the override path.
export interface CodingOverride {
  account_code: string;
  tax_code: string | null;
}

// Drives the low-confidence coding review queue: lists needs_review suggestions for
// the active org and exposes accept/override mutations. coding_suggestions is
// client-read-only (0092 RLS is SELECT-only), so both decisions route through the
// backend writer (the coding-classifier edge fn, the sole sanctioned post path)
// rather than mutating the table from the client.
export function useCodingQueue() {
  const { currentOrg } = useOrg();
  const [suggestions, setSuggestions] = useState<CodingSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!currentOrg) {
      setSuggestions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { data, error: queryErr } = await supabase
      .from('coding_review_queue')
      .select(
        'id, organization_id, bill_id, account_code, tax_code, confidence, status, rationale, created_at, updated_at, created_by',
      )
      .eq('organization_id', currentOrg.id)
      .order('confidence', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });

    if (queryErr) {
      setError(queryErr.message);
      setSuggestions([]);
    } else {
      setSuggestions((data ?? []) as unknown as CodingSuggestion[]);
    }
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  // Route a review decision through the classifier's post path (the table is
  // backend-written), then refresh so a resolved row leaves the queue. Throws on
  // transport or edge-fn error so the caller can surface it.
  //
  // DECISION MODE (landed in SC-1.D.02): coding-classifier applies the `decision:
  // 'accept' | 'override'` + corrected account_code/tax_code fields below and
  // force-posts the bill's journal regardless of the 0.9 auto-threshold (the human
  // is the posting gate). `accept` reuses the suggestion's proposed codes; `override`
  // posts the human-corrected ones. The resolved row then leaves coding_review_queue.
  const decide = useCallback(
    async (suggestion: CodingSuggestion, body: Record<string, unknown>) => {
      const { data, error: fnErr } = await supabase.functions.invoke('coding-classifier', {
        body: { bill_id: suggestion.bill_id, ...body },
      });
      if (fnErr) throw new Error(fnErr.message);
      const res = data as { ok?: boolean; error?: string } | null;
      if (!res?.ok) throw new Error(res?.error ?? 'coding decision failed');
      await fetch();
      return res;
    },
    [fetch],
  );

  // Accept the proposed codes as-is and post.
  const accept = useCallback(
    (suggestion: CodingSuggestion) => decide(suggestion, { decision: 'accept' }),
    [decide],
  );

  // Replace the proposed codes with a human-corrected pair, then post.
  const override = useCallback(
    (suggestion: CodingSuggestion, codes: CodingOverride) =>
      decide(suggestion, {
        decision: 'override',
        account_code: codes.account_code,
        tax_code: codes.tax_code,
      }),
    [decide],
  );

  return { suggestions, loading, error, refresh: fetch, accept, override };
}
