import { useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

// ---- response shapes (hand-typed against the RPCs; no generated Database types yet,
// same `as unknown as` convention as useBookToTax) ----------------------------------

/** One beneficiary's streamed share, from stream_trust_distribution (SC-5.C.03, 0157). */
export interface StreamedShare {
  beneficiary_id: string;
  name: string;
  entity_kind: string;
  eligible: boolean;
  exclusion_reason: string | null;
  amount_cents: number;
  capital_gain_cents: number;
  franked_dividend_cents: number;
  franking_credits_cents: number;
  other_cents: number;
}

/** The streaming overlay proposal (stream_trust_distribution, 0157). */
export interface DistributionProposal {
  organization_id: string;
  trust_id: string;
  fy_start_year: number;
  method: string;
  streaming_allowed: boolean;
  net_income_cents: number;
  streamed: StreamedShare[];
  totals: {
    net_income_cents: number;
    distributed_amount_cents: number;
    streamed_capital_gain_cents: number;
    streamed_franked_dividend_cents: number;
    streamed_franking_credits_cents: number;
    other_cents: number;
    trustee_retained_cents: number;
    grossed_reconciles: boolean;
  };
  caveats?: string[];
}

/** The persist summary (distribution_persist, SC-5.C.04, 0158). */
export interface PersistResult {
  ok: boolean;
  drafts_replaced: number;
  drafts_written: number;
}

/**
 * The distribution wizard's data layer (SC-5.G.03). Action-driven (not auto-load):
 *   - runProposal: stream_trust_distribution (0157) — the per-beneficiary streamed
 *     proposal (net capital gain / franked dividends + credits / other), the overlay on
 *     the SC-5.C.02 optimiser; richest view for the wizard.
 *   - persistDraft: distribution_persist (0158) — writes the proposal to
 *     trust_distributions as draft rows (idempotent replace).
 * Both are RLS-scoped to the caller (SECURITY INVOKER). The trust chain RPCs deploy as a
 * batch; until then these calls return an error the wizard surfaces.
 */
export function useTrustDistribution() {
  const { currentOrg } = useOrg();
  const [proposal, setProposal] = useState<DistributionProposal | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [persisting, setPersisting] = useState(false);
  const [persistResult, setPersistResult] = useState<PersistResult | null>(null);

  const runProposal = useCallback(
    async (trustId: string, fyStartYear: number): Promise<DistributionProposal | null> => {
      if (!currentOrg) {
        setError('No organisation selected.');
        return null;
      }
      setLoading(true);
      setError(null);
      setPersistResult(null);

      const { data, error: rpcErr } = await supabase.rpc('stream_trust_distribution', {
        p_org: currentOrg.id,
        p_fy_start_year: fyStartYear,
        p_trust: trustId,
      });

      setLoading(false);
      if (rpcErr) {
        setError(rpcErr.message);
        setProposal(null);
        return null;
      }
      const result = data as unknown as DistributionProposal;
      setProposal(result);
      return result;
    },
    [currentOrg],
  );

  const persistDraft = useCallback(
    async (trustId: string, fyStartYear: number): Promise<PersistResult | null> => {
      if (!currentOrg) {
        setError('No organisation selected.');
        return null;
      }
      setPersisting(true);
      setError(null);

      const { data, error: rpcErr } = await supabase.rpc('distribution_persist', {
        p_org: currentOrg.id,
        p_fy_start_year: fyStartYear,
        p_trust: trustId,
      });

      setPersisting(false);
      if (rpcErr) {
        setError(rpcErr.message);
        return null;
      }
      const result = data as unknown as PersistResult;
      setPersistResult(result);
      return result;
    },
    [currentOrg],
  );

  const reset = useCallback(() => {
    setProposal(null);
    setError(null);
    setPersistResult(null);
  }, []);

  return { proposal, loading, error, persisting, persistResult, runProposal, persistDraft, reset };
}
