import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

/**
 * useTaxReturn (SC-4.I.01) — the entity-aware draft return for one org + AU FY.
 * Pulls two read-only RPCs in one round trip:
 *   - build_return (SC-4.G, 0145–0147): the GL P&L mapped to tax-return LABELS,
 *     dispatched on business_profile.entity_type (company Item 6 / sole_trader P8 +
 *     Item 15 / partnership + trust Item 5 + distribution scaffold). Book amounts
 *     only — the reconciliation to taxable income is book_to_tax (see useBookToTax).
 *   - compute_tax_payable (SC-4.H.03, 0150): taxable income × the entity rate/scale,
 *     then the offset/credit waterfall → net tax payable / refundable.
 *
 * Both are STABLE/read-only and RLS-scoped to the caller, so this hook auto-loads on
 * mount (like useBasWorksheet), not on an explicit action. They are INDEPENDENT:
 * build_return RAISEs feature_not_supported for smsf / other / no-profile, whereas
 * compute_tax_payable returns zeros for those — so each result is set on its own and a
 * partial success still renders. `error` carries whichever RPC failed (both, if both).
 *
 * Hand-typed against the RPC response shapes (the client has no generated Database
 * types yet; `as unknown as` cast, like useBasWorksheet).
 */

// ---- build_return label shapes (shared across entity branches) ---------------------

/** One return-label line mapped from a GL account. */
export interface ReturnLabelLine {
  account_code: string;
  account_name: string;
  form_item: string;
  label_code: string | null;
  label_name: string;
  amount_cents: number;
}

/** A return-label subtotal / total box (no GL account behind it). */
export interface ReturnLabelTotal {
  form_item: string;
  label_code: string | null;
  label_name: string;
  amount_cents: number;
}

/** Income or expense block: per-account lines + the subtotal box. */
export interface ReturnLabelSection {
  lines: ReturnLabelLine[];
  total: ReturnLabelTotal;
}

interface BuildReturnBase {
  organization_id: string;
  fy_start_year: number;
  period_start: string;
  period_end: string;
  /** basis=cumulative_to_date today (the trial balance is cumulative) — see 0145. */
  basis: string;
  return_form: string;
}

/** entity_type='company' → NAT 0656 Item 6 (total profit or loss). */
export interface CompanyReturn extends BuildReturnBase {
  entity_type: 'company';
  item6_total_profit_or_loss: {
    income: ReturnLabelSection;
    expenses: ReturnLabelSection;
    total_profit_or_loss: ReturnLabelTotal; // 6-T = 6-S − 6-Q
  };
}

/** entity_type='sole_trader' → Item P8 then individual-return Item 15-C transfer. */
export interface SoleTraderReturn extends BuildReturnBase {
  entity_type: 'sole_trader';
  /** GL carries no PP/non-PP signal — defaults to 'non_primary_production'. */
  production_type: string;
  p8_business_income_and_expenses: {
    income: ReturnLabelSection;
    expenses: ReturnLabelSection;
    net_income_or_loss_from_business: ReturnLabelTotal; // P8-Z
  };
  item15_net_income_or_loss_from_business: ReturnLabelTotal & { source_label: string };
}

/** entity_type 'partnership' (NAT 0659) / 'trust' (NAT 0660) → shared Item 5 + flow-through. */
export interface FlowThroughReturn extends BuildReturnBase {
  entity_type: 'partnership' | 'trust';
  production_type: string;
  item5_business_income_and_expenses: {
    income: ReturnLabelSection;
    expenses: ReturnLabelSection;
    net_income_or_loss_from_business: ReturnLabelTotal; // Item 5-R
  };
  /** Statement of distribution; allocations are EMPTY here — the per-partner /
   * per-beneficiary split is the Phase-5 distribution optimiser (SC-5.C). */
  distribution_statement: {
    form_item: string;
    label_name: string;
    distributable_net_cents: number;
    share_labels: string;
    allocations: unknown[];
    note: string;
  };
  /** Trust only: the s95 Item-26 net-income scaffold (business_net_only basis). */
  item26_trust_net_income?: ReturnLabelTotal & { basis: string; source_label: string };
}

/** Discriminated union over entity_type — build_return only ever emits these four. */
export type TaxReturn = CompanyReturn | SoleTraderReturn | FlowThroughReturn;

// ---- compute_tax_payable shape (0150) ----------------------------------------------

export interface TaxPayableRateBasis {
  /** 'company_flat' | 'resident_individual_scale' | 'no_entity_level_tax'. */
  kind: string;
  note: string;
  /** company_flat only: 0.25 (base rate entity) or 0.30. */
  rate?: number;
  base_rate_entity?: boolean;
  turnover_cents?: number | null;
}

export interface TaxPayableNonRefundable {
  sbito_cents: number;
  company_franking_cents: number;
  total_cents: number;
  /** Offset in excess of income tax (lost; for a company → a tax loss, s36-55). */
  unused_cents: number;
  note: string;
}

export interface TaxPayableRefundable {
  franking_cents: number;
  payg_instalments_paid_cents: number;
  total_cents: number;
  note: string;
}

export interface TaxPayable {
  organization_id: string;
  fy_start_year: number;
  period_start: string;
  period_end: string;
  entity_type: string;
  /** From book_to_tax (SC-4.H.02) — one taxable-income definition. */
  taxable_income_cents: number;
  rate_basis: TaxPayableRateBasis;
  income_tax_cents: number;
  medicare_levy_cents: number;
  offsets: {
    non_refundable: TaxPayableNonRefundable;
    refundable: TaxPayableRefundable;
  };
  tax_after_non_refundable_offsets_cents: number;
  total_liability_cents: number;
  /** > 0 when owed to the ATO (result='payable'); 0 otherwise. */
  net_tax_payable_cents: number;
  /** > 0 when refundable (result='refundable'); 0 otherwise. */
  net_refund_cents: number;
  result: 'payable' | 'refundable' | 'nil';
  caveats: string[];
  note: string;
}

// ---- hook --------------------------------------------------------------------------

export function useTaxReturn(fyStartYear: number | null) {
  const { currentOrg } = useOrg();
  const [taxReturn, setTaxReturn] = useState<TaxReturn | null>(null);
  const [taxPayable, setTaxPayable] = useState<TaxPayable | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg || fyStartYear == null) {
      setTaxReturn(null);
      setTaxPayable(null);
      return;
    }
    setLoading(true);
    setError(null);

    // The two RPCs are independent (build_return RAISEs for unsupported entity types;
    // compute_tax_payable returns zeros) — fetch both in one round trip and set each
    // result on its own so a partial success still renders.
    const [ret, pay] = await Promise.all([
      supabase.rpc('build_return', {
        p_org: currentOrg.id,
        p_fy_start_year: fyStartYear,
      }),
      supabase.rpc('compute_tax_payable', {
        p_org: currentOrg.id,
        p_fy_start_year: fyStartYear,
      }),
    ]);

    setTaxReturn(ret.error ? null : ((ret.data ?? null) as unknown as TaxReturn | null));
    setTaxPayable(pay.error ? null : ((pay.data ?? null) as unknown as TaxPayable | null));

    // Surface whichever RPC failed — both messages if both did, so nothing is hidden.
    const messages = [ret.error?.message, pay.error?.message].filter(Boolean);
    setError(messages.length ? messages.join(' · ') : null);

    setLoading(false);
  }, [currentOrg, fyStartYear]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { taxReturn, taxPayable, loading, error, refresh };
}
