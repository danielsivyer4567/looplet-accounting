import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { base64ToBlob, downloadBlob } from '@/lib/download';

// One SMSF the org administers (SC-5.H, table `smsf_funds`). Typed against the columns the
// workspace list surfaces.
export interface SmsfFundRow {
  id: string;
  name: string;
  abn: string | null;
  trustee_structure: string;
  establishment_date: string | null;
  created_at: string;
}

// One fund member (SC-5.H, table `smsf_members`). The recorded balance is the sum of the
// tax-free + taxable components on the row (the roll-forward closing balance is SC-5.I.01,
// surfaced in the financials panel — SC-5.N.02).
export interface SmsfMemberRow {
  id: string;
  fund_id: string;
  name: string;
  role: string;
  date_of_birth: string | null;
  tax_free_component_cents: number;
  taxable_component_cents: number;
}

/**
 * Lists the org's SMSF funds + their members + whether the org is itself an SMSF entity (the
 * visibility gate for the SMSF workspace lives on business_profile.entity_type, not
 * organizations). Mirrors useTrusts: org-scoped, RLS does the rest; loading/error/refresh.
 */
export function useSmsf() {
  const { currentOrg } = useOrg();
  const [funds, setFunds] = useState<SmsfFundRow[]>([]);
  const [members, setMembers] = useState<SmsfMemberRow[]>([]);
  const [isSmsfEntity, setIsSmsfEntity] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!currentOrg) {
      setFunds([]);
      setMembers([]);
      setIsSmsfEntity(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    const [fundsRes, membersRes, profileRes] = await Promise.all([
      supabase
        .from('smsf_funds')
        .select('id, name, abn, trustee_structure, establishment_date, created_at')
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .order('name', { ascending: true }),
      supabase
        .from('smsf_members')
        .select('id, fund_id, name, role, date_of_birth, tax_free_component_cents, taxable_component_cents')
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .order('name', { ascending: true }),
      supabase
        .from('business_profile')
        .select('entity_type')
        .eq('organization_id', currentOrg.id)
        .maybeSingle(),
    ]);

    if (fundsRes.error) {
      setError(fundsRes.error.message);
      setFunds([]);
      setMembers([]);
      setLoading(false);
      return;
    }

    setFunds((fundsRes.data ?? []) as SmsfFundRow[]);
    setMembers((membersRes.data ?? []) as SmsfMemberRow[]);
    setIsSmsfEntity(
      (profileRes.data as { entity_type?: string } | null)?.entity_type === 'smsf',
    );
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  return { funds, members, isSmsfEntity, loading, error, refresh: fetch };
}

// ---- per-fund panel data (SC-5.N.02) ---------------------------------------------------
// Response shapes are hand-typed against the SMSF RPC jsonb (no generated Database types yet,
// the same `as unknown as` convention as useDiv7a/useTrustDistribution). Only the fields the
// panels render are typed. The SMSF chain (0162-0171) + the smsf-audit-pack edge fn deploy as a
// batch; until then each call returns an error the panel surfaces (it does not blank the others).

/** smsf_operating_statement (SC-5.J.01, 0166). */
export interface SmsfOperatingStatement {
  ok: boolean;
  assessable_income_cents: number;
  income_tax_cents: number;
  net_result_cents: number;
}

/** smsf_financial_position (SC-5.J.02, 0167). */
export interface SmsfFinancialPosition {
  ok: boolean;
  assets: { total_assets_cents: number };
  liabilities_cents: number;
  members_funds_cents: number;
}

/** smsf_caps totals (SC-5.L.01, 0170). */
export interface SmsfCaps {
  ok: boolean;
  totals: {
    members_over_concessional: number;
    members_over_non_concessional: number;
    members_div293: number;
  };
}

/** smsf_pension_drawdown totals (SC-5.L.02, 0171). */
export interface SmsfDrawdown {
  ok: boolean;
  totals: { pension_count: number; under_minimum_count: number; total_required_minimum_cents: number };
}

/** smsf_tbc_tbar (SC-5.I.02, 0165) — transfer-balance cap tracker. */
export interface SmsfTbc {
  ok: boolean;
  tbc_cents: number;
  members: { member_id: string; name: string; tba_balance_cents: number; available_cap_cents: number }[];
}

export interface SmsfFundPanels {
  operating: SmsfOperatingStatement | null;
  financial: SmsfFinancialPosition | null;
  caps: SmsfCaps | null;
  drawdown: SmsfDrawdown | null;
  tbc: SmsfTbc | null;
}

const EMPTY_PANELS: SmsfFundPanels = {
  operating: null, financial: null, caps: null, drawdown: null, tbc: null,
};

/** Cast a supabase RPC result to its hand-typed shape, or null if the call errored. */
function castPanel<T>(res: { error: unknown; data: unknown }): T | null {
  return res.error ? null : (res.data as unknown as T);
}

/**
 * Loads the per-fund panels (financials SC-5.J, cap/Div293/drawdown flags SC-5.L, TBC tracker
 * SC-5.I.02) for a fund + income year, and exposes the audit-pack (SC-5.M) + return-draft
 * (SC-5.K) download actions and a mark-lodged STUB (real lodgement is Phase 7 — SC-7.B/7.D).
 * RLS-scoped to the caller. Each RPC can fail independently (e.g. undeployed) without blanking
 * the rest; the panel surfaces the error.
 */
export function useSmsfFund(fundId: string | undefined, fyStartYear: number) {
  const { currentOrg } = useOrg();
  const [panels, setPanels] = useState<SmsfFundPanels>(EMPTY_PANELS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<null | 'audit' | 'return' | 'lodge'>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg || !fundId) {
      setPanels(EMPTY_PANELS);
      return;
    }
    setLoading(true);
    setError(null);
    const args = { p_org: currentOrg.id, p_fy_start_year: fyStartYear, p_fund: fundId };
    const [os, fp, caps, draw, tbc] = await Promise.all([
      supabase.rpc('smsf_operating_statement', args),
      supabase.rpc('smsf_financial_position', args),
      supabase.rpc('smsf_caps', args),
      supabase.rpc('smsf_pension_drawdown', args),
      supabase.rpc('smsf_tbc_tbar', args),
    ]);
    // The first error surfaces; each section still fills in if its own call succeeded.
    setError([os, fp, caps, draw, tbc].find((r) => r.error)?.error?.message ?? null);
    setPanels({
      operating: castPanel<SmsfOperatingStatement>(os),
      financial: castPanel<SmsfFinancialPosition>(fp),
      caps: castPanel<SmsfCaps>(caps),
      drawdown: castPanel<SmsfDrawdown>(draw),
      tbc: castPanel<SmsfTbc>(tbc),
    });
    setLoading(false);
  }, [currentOrg, fundId, fyStartYear]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Download the auditor hand-off pack (smsf-audit-pack edge fn, SC-5.M.01 — returns pdf_base64). */
  const downloadAuditPack = useCallback(async (): Promise<boolean> => {
    if (!fundId) return false;
    setActionBusy('audit');
    setError(null);
    const { data, error: fnErr } = await supabase.functions.invoke<{ ok: boolean; pdf_base64?: string }>(
      'smsf-audit-pack',
      { body: { fund_id: fundId, fy_start_year: fyStartYear } },
    );
    setActionBusy(null);
    if (fnErr || !data?.pdf_base64) {
      setError(fnErr?.message ?? 'Could not generate the audit pack.');
      return false;
    }
    downloadBlob(base64ToBlob(data.pdf_base64, 'application/pdf'), `smsf-audit-pack-${fyStartYear + 1}.pdf`);
    return true;
  }, [fundId, fyStartYear]);

  /** Download the SMSF annual return draft as JSON (smsf_return_draft, SC-5.K.01). */
  const downloadReturnDraft = useCallback(async (): Promise<boolean> => {
    if (!currentOrg || !fundId) return false;
    setActionBusy('return');
    setError(null);
    const { data, error: rpcErr } = await supabase.rpc('smsf_return_draft', {
      p_org: currentOrg.id, p_fy_start_year: fyStartYear, p_fund: fundId,
    });
    setActionBusy(null);
    if (rpcErr || !data) {
      setError(rpcErr?.message ?? 'Could not generate the return draft.');
      return false;
    }
    const json = JSON.stringify(data, null, 2);
    downloadBlob(new Blob([json], { type: 'application/json' }), `smsf-annual-return-draft-${fyStartYear + 1}.json`);
    return true;
  }, [currentOrg, fundId, fyStartYear]);

  /**
   * Mark-lodged STUB. Electronic lodgement of the SMSF annual return is gated by the DSP/EVTE
   * gateway (Phase 7 — SC-7.B machine-credential signing, SC-7.D transport); nothing is lodged
   * here. Returns the gated message so the UI can show why the action is unavailable.
   */
  const markLodged = useCallback((): string => {
    return 'Lodgement is not yet available — it is gated by the ATO lodgement gateway (Phase 7). The return draft is ready to download for review.';
  }, []);

  return { panels, loading, error, actionBusy, refresh, downloadAuditPack, downloadReturnDraft, markLodged };
}
