import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import type { CgtAssetType } from '@/hooks/useCgtEvents';

/**
 * useBookToTax (SC-4.I.01) — the book-to-tax reconciliation + CGT schedule for one
 * org + AU FY. Pulls two read-only RPCs in one round trip:
 *   - book_to_tax (SC-4.H.01/4.H.02, 0148–0149): accounting profit → TAXABLE INCOME
 *     via non-deductible add-backs, the book-vs-tax depreciation difference, the net
 *     capital gain (s102-5), the franking gross-up (s207-20), and carried-forward
 *     revenue losses (Div 36). Stops at taxable income (tax payable is useTaxReturn).
 *   - cgt_calc (SC-4.E/4.F, 0139–0144): the full CGT schedule — per-event detail plus
 *     the loss-netting, Div 115 discount and Subdiv 152 small-business concessions
 *     behind book_to_tax's capital-gains summary.
 *
 * Both are STABLE/read-only and RLS-scoped to the caller, so this hook auto-loads on
 * mount (like useBasWorksheet), not on an explicit action. They are set independently
 * so a partial success still renders; `error` carries whichever RPC failed.
 *
 * Hand-typed against the RPC response shapes (no generated Database types yet;
 * `as unknown as` cast, like useBasWorksheet).
 */

// ---- book_to_tax shape (0149) ------------------------------------------------------

/** One non-deductible add-back line (a matched GL expense account). */
export interface BookToTaxAddBackLine {
  account_code: string;
  account_name: string;
  amount_cents: number;
  reason: string;
}

export interface BookToTax {
  organization_id: string;
  fy_start_year: number;
  period_start: string;
  period_end: string;
  entity_type: string;
  /** basis=cumulative_to_date today (the trial balance is cumulative). */
  basis: string;
  accounting_profit_cents: number;
  add_backs: {
    lines: BookToTaxAddBackLine[];
    total_cents: number;
  };
  depreciation_reconciliation: {
    book_depreciation_cents: number;
    tax_depreciation_cents: number;
    /** book − tax: positive increases taxable income. */
    difference_cents: number;
    note: string;
  };
  /** Subtotal = accounting profit + add-backs + dep diff (pre-CGT/franking/loss). */
  taxable_income_subtotal_cents: number;
  /** Net capital gain folded in (s102-5); detail is in cgt below. */
  capital_gains: {
    net_capital_gain_cents: number;
    current_year_capital_gains_cents: number;
    current_year_capital_losses_cents: number;
    carried_forward_capital_losses_applied_cents: number;
    net_capital_loss_carried_forward_cents: number;
    source: string;
  };
  franking: {
    credits_received_cents: number;
    grossed_up_into_assessable_income: boolean;
    note: string;
  };
  /** Subtotal + net capital gain + franking gross-up, before revenue-loss recoupment. */
  assessable_income_before_losses_cents: number;
  /** Carried-forward REVENUE losses (Div 36) — distinct from the capital losses above. */
  revenue_losses: {
    available_cents: number;
    applied_cents: number;
    current_year_loss_cents: number;
    carried_forward_cents: number;
    source: string;
  };
  /** FINAL taxable income (>= 0); tax payable is compute_tax_payable (useTaxReturn). */
  taxable_income_cents: number;
  caveats: string[];
  note: string;
}

// ---- cgt_calc shape (0144) ---------------------------------------------------------

export type CgtConcessionStatus =
  'fifteen_year_exempt' | 'active_asset_reduction' | 'discount_only' | 'none';

/** Per-event row in the CGT schedule (asset_type reused from useCgtEvents). */
export interface CgtCalcEvent {
  id: string;
  asset_description: string;
  asset_type: CgtAssetType;
  event_type: string;
  acquisition_date: string | null;
  disposal_date: string;
  proceeds_cents: number;
  cost_base_cents: number;
  reduced_cost_base_cents: number;
  gain_cents: number;
  loss_cents: number;
  discount_eligible: boolean;
  retirement_exemption_elected_cents: number;
  small_business_rollover_elected_cents: number;
  concession_status: CgtConcessionStatus;
}

/** The SIZE limb of the Subdiv 152-A basic conditions (cgt_sbe_size_eligible, 0142). */
export interface CgtSizeCondition {
  passed: boolean;
  turnover_test: {
    passed: boolean | null;
    threshold_cents: number;
    aggregated_turnover_cents: number;
    turnover_bracket: string | null;
    source: string;
    reason: string;
  };
  mnav_test: {
    passed: boolean;
    threshold_cents: number;
    net_asset_value_cents: number;
    total_assets_cents: number;
    total_liabilities_cents: number;
    basis: string;
  };
}

export interface CgtCalc {
  organization_id: string;
  fy_start_year: number;
  period_start: string;
  period_end: string;
  entity_type: string;
  /** Div 115 discount rate (0.5 individuals/trusts, 0.333… super, 0 companies). */
  cgt_discount_rate: number;
  sbe_eligible: boolean;
  size_condition: CgtSizeCondition;
  event_count: number;
  current_year_capital_gains_cents: number;
  current_year_capital_losses_cents: number;
  carried_forward_losses_available_cents: number;
  carried_forward_losses_applied_cents: number;
  discountable_gain_cents: number;
  cgt_discount_cents: number;
  active_asset_reduction_cents: number; // Subdiv 152-C
  fifteen_year_exemption_cents: number; // Subdiv 152-B
  retirement_exemption_elected_cents: number; // Subdiv 152-D, as elected
  retirement_exemption_cap_remaining_cents: number; // $500k lifetime, before this FY
  retirement_exemption_applied_cents: number; // after cap + pool clamp
  small_business_rollover_elected_cents: number; // Subdiv 152-E, as elected
  small_business_rollover_deferred_cents: number; // after pool clamp
  /** True when an elected D/E amount was clamped to the cap/pool — reconcile elected vs applied. */
  sbe_election_clamped: boolean;
  net_capital_gain_before_discount_cents: number;
  net_capital_gain_before_sbe_concessions_cents: number;
  /** FINAL post-ALL-concessions assessable amount (what book_to_tax folds in). */
  net_capital_gain_cents: number;
  net_capital_loss_carried_forward_cents: number;
  sbe_concession_caveats: string[];
  events: CgtCalcEvent[];
}

// ---- hook --------------------------------------------------------------------------

export function useBookToTax(fyStartYear: number | null) {
  const { currentOrg } = useOrg();
  const [bookToTax, setBookToTax] = useState<BookToTax | null>(null);
  const [cgt, setCgt] = useState<CgtCalc | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg || fyStartYear == null) {
      setBookToTax(null);
      setCgt(null);
      return;
    }
    setLoading(true);
    setError(null);

    // book_to_tax already calls cgt_calc internally for its capital-gains summary; we
    // fetch cgt_calc here too for the full per-event schedule the page renders. Both
    // are independent — set each on its own so a partial success still renders.
    const [btt, cgtRes] = await Promise.all([
      supabase.rpc('book_to_tax', {
        p_org: currentOrg.id,
        p_fy_start_year: fyStartYear,
      }),
      supabase.rpc('cgt_calc', {
        p_org: currentOrg.id,
        p_fy_start_year: fyStartYear,
      }),
    ]);

    setBookToTax(btt.error ? null : ((btt.data ?? null) as unknown as BookToTax | null));
    setCgt(cgtRes.error ? null : ((cgtRes.data ?? null) as unknown as CgtCalc | null));

    const messages = [btt.error?.message, cgtRes.error?.message].filter(Boolean);
    setError(messages.length ? messages.join(' · ') : null);

    setLoading(false);
  }, [currentOrg, fyStartYear]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { bookToTax, cgt, loading, error, refresh };
}
