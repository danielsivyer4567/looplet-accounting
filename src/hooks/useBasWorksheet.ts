import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

/**
 * useBasWorksheet (SC-3.E.01) — drives the guided BAS prep flow for one AU FY
 * quarter. Pulls three things for the current org + (fy, quarter):
 *   - the full worksheet payload from generate_bas_worksheet (SC-3.C.03),
 *   - the pre-lodge BLOCKERS: GST-treatment exceptions (v_gst_treatment_exceptions,
 *     SC-3.A.02) and the GL-vs-BAS reconciliation variance (v_gst_reconciliation,
 *     SC-3.B.02),
 * and exposes requestLodgeApproval() which opens a Tier-2 approval (request_approval,
 * SC-2.B.01) — the lodge itself is a stub until Phase 7 SC-7.E wires real DSP
 * lodgement, and the lodged-status write-back lands in SC-3.E.02.
 *
 * Best-effort: generate_bas_worksheet (0122) and the two views (0117/0119) are
 * repo-only until the epic's deploy step, so each read degrades to null/0 + an
 * error string rather than throwing — the page renders, just without live figures.
 * Hand-typed (no generated Supabase types; `as unknown as` cast, like useApprovals).
 */

export interface BasWorksheetPayload {
  organization_id: string;
  fy_start_year: number;
  quarter: number;
  quarter_start: string | null;
  quarter_end: string | null;
  due_date: string | null;
  gst: Record<string, number>;
  payg_withholding: Record<string, number>;
  payg_instalment: Record<string, number> | null;
  summary: Record<string, number>;
}

export interface BasBlockers {
  /** Count of per-line GST-treatment mismatches (SC-3.A.02); null = check unavailable. */
  treatmentExceptions: number | null;
  /** GL-vs-BAS net-GST variance in cents (SC-3.B.02); null = unavailable, 0 = reconciled. */
  reconciliationVarianceCents: number | null;
}

const NO_BLOCKERS: BasBlockers = {
  treatmentExceptions: null,
  reconciliationVarianceCents: null,
};

export function useBasWorksheet(fyStartYear: number | null, quarter: number | null) {
  const { currentOrg } = useOrg();
  const [worksheet, setWorksheet] = useState<BasWorksheetPayload | null>(null);
  const [blockers, setBlockers] = useState<BasBlockers>(NO_BLOCKERS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg || fyStartYear == null || quarter == null) {
      setWorksheet(null);
      setBlockers(NO_BLOCKERS);
      return;
    }
    setLoading(true);
    setError(null);

    // The worksheet RPC and the two blocker reads are independent — one round trip.
    // Blockers are best-effort: a view that isn't deployed yet degrades to "unavailable"
    // (null), never a fabricated "clean" — so a missing check can't fail the lodge gate open.
    const [ws, exc, recon] = await Promise.all([
      supabase.rpc('generate_bas_worksheet', {
        p_org: currentOrg.id,
        p_fy_start_year: fyStartYear,
        p_quarter: quarter,
      }),
      supabase
        .from('v_gst_treatment_exceptions' as never)
        .select('bill_line_item_id')
        .eq('organization_id', currentOrg.id),
      supabase
        .from('v_gst_reconciliation' as never)
        .select('variance_cents')
        .eq('organization_id', currentOrg.id)
        .maybeSingle(),
    ]);

    if (ws.error) {
      setError(ws.error.message);
      setWorksheet(null);
    } else {
      setError(null);
      setWorksheet((ws.data ?? null) as unknown as BasWorksheetPayload | null);
    }

    const reconRow = recon.error ? null : (recon.data as { variance_cents: number } | null);
    setBlockers({
      treatmentExceptions: exc.error ? null : (exc.data?.length ?? 0),
      reconciliationVarianceCents: reconRow ? reconRow.variance_cents : null,
    });

    setLoading(false);
  }, [currentOrg, fyStartYear, quarter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Open a Tier-2 approval to lodge this quarter's BAS. resource_id is the org
   * (no per-BAS row exists until SC-3.E.02's obligation-status table); the period
   * + net amount ride in the payload so the approval hash pins exactly what was
   * approved. Throws on failure so the page can surface the message.
   */
  const requestLodgeApproval = useCallback(async (): Promise<void> => {
    if (!currentOrg || fyStartYear == null || quarter == null) {
      throw new Error('Select a BAS quarter first.');
    }
    const { error: err } = await supabase.rpc('request_approval', {
      p_org: currentOrg.id,
      p_resource_type: 'bas_lodgement',
      p_resource_id: currentOrg.id,
      p_risk_tier: 'tier2_approve',
      p_payload: {
        kind: 'bas_lodge',
        fy_start_year: fyStartYear,
        quarter,
        net_amount_cents: worksheet?.summary?.['9_net_amount_cents'] ?? null,
      },
    });
    if (err) throw new Error(err.message);
    await refresh();
  }, [currentOrg, fyStartYear, quarter, worksheet, refresh]);

  return { worksheet, blockers, loading, error, refresh, requestLodgeApproval };
}
