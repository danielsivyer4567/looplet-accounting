// Pure AU termination / ETP tax calculation (SC-3.L.01). No I/O — unit-testable.
//
// PREP-AND-APPROVE / ASSIST: estimates the withholding on a final pay for a human to
// review — it is NOT tax advice and does not lodge anything (no STP event; that is
// SC-3.L.02). Documented simplifications (the reason a human confirms):
//   * assumes all unused annual leave + LSL accrued post-17 Aug 1993 — the pre-1993
//     and pre-18 Aug 1978 LSL tiers (5%/marginal splits) are NOT modelled;
//   * assumes the ETP has NO tax-free component from pre-1 July 1983 service;
//   * Medicare levy is folded into the rates; no low-income/levy-exemption tweaks;
//   * "excluded ETP" = genuine redundancy / invalidity / early retirement (death not
//     modelled here).
//
// Tax constants are indexed annually by the ATO, so they are PARAMETERS, not literals
// baked into the logic. DEFAULT_TAX_CONSTANTS carries FY2024-25 values — update yearly
// (and callers/tests may pass an explicit set). What this module owns is the MECHANICS
// (tax-free cap, excluded vs non-excluded ETP, the lesser-of-caps rule, preservation-
// age rate, above-cap top rate, concessional vs marginal leave), which is what the
// unit test pins.

export type TerminationReason =
  | 'genuine_redundancy'
  | 'invalidity'
  | 'early_retirement'
  | 'resignation'
  | 'dismissal'
  | 'retirement'
  | 'contract_end';

export interface TerminationTaxConstants {
  redundancy_base_cents: number;
  redundancy_per_year_cents: number;
  etp_cap_cents: number;
  whole_of_income_cap_cents: number;
  etp_rate_under_preservation: number; // taxable ETP within cap, under preservation age
  etp_rate_at_preservation: number; //    taxable ETP within cap, at/above preservation age
  etp_rate_above_cap: number; //          taxable ETP above the cap (top marginal)
  leave_rate_concessional: number; //     unused leave on redundancy/invalidity/early-retirement
}

// FY2024-25 figures — UPDATE ANNUALLY (ATO indexes the redundancy + ETP caps).
export const DEFAULT_TAX_CONSTANTS: TerminationTaxConstants = {
  redundancy_base_cents: 1_252_400, //      $12,524
  redundancy_per_year_cents: 626_400, //    $6,264 per completed year of service
  etp_cap_cents: 24_500_000, //             $245,000
  whole_of_income_cap_cents: 18_000_000, // $180,000 (not indexed)
  etp_rate_under_preservation: 0.32, //     30% + 2% Medicare
  etp_rate_at_preservation: 0.17, //        15% + 2% Medicare
  etp_rate_above_cap: 0.47, //              45% + 2% Medicare
  leave_rate_concessional: 0.32, //         30% + 2% Medicare
};

export interface TerminationInput {
  reason: TerminationReason;
  years_of_service: number;
  at_or_above_preservation_age: boolean;
  unused_annual_leave_cents: number;
  unused_long_service_leave_cents: number;
  redundancy_or_severance_cents: number; // the severance / redundancy lump sum
  etp_other_cents: number; //              other ETP amounts (golden handshake, pay in lieu of notice, ex gratia)
  other_taxable_income_cents: number; //   other taxable income this FY (for the whole-of-income cap)
  leave_marginal_rate: number; //          marginal rate for unused leave on a non-concessional termination (0..1)
  constants?: TerminationTaxConstants;
}

export interface TerminationResult {
  reason: TerminationReason;
  is_excluded_etp: boolean;
  redundancy_tax_free_cap_cents: number;
  redundancy_tax_free_cents: number;
  etp_taxable_cents: number;
  etp_applicable_cap_cents: number;
  etp_within_cap_cents: number;
  etp_above_cap_cents: number;
  etp_within_cap_rate: number;
  etp_tax_cents: number;
  unused_leave_cents: number;
  unused_leave_rate: number;
  unused_leave_tax_cents: number;
  gross_termination_cents: number;
  // Total tax-free across components (the net line uses this). Today only the
  // genuine-redundancy tax-free part contributes; pre-1983 ETP / pre-1993 leave
  // tax-free tiers (not yet modelled) would roll up here too.
  tax_free_cents: number;
  total_tax_cents: number;
  net_cents: number;
}

const r = (n: number) => Math.round(n);

export function calculateTermination(input: TerminationInput): TerminationResult {
  const c = input.constants ?? DEFAULT_TAX_CONSTANTS;
  const reason = input.reason;
  // Concessional treatments: genuine redundancy, invalidity, early retirement.
  const concessional =
    reason === "genuine_redundancy" || reason === "invalidity" || reason === "early_retirement";
  const isExcluded = concessional; // excluded ETPs bypass the whole-of-income cap

  // Genuine-redundancy tax-free cap applies ONLY to a genuine redundancy.
  const taxFreeCap =
    reason === "genuine_redundancy"
      ? c.redundancy_base_cents +
        c.redundancy_per_year_cents * Math.max(0, Math.floor(input.years_of_service))
      : 0;
  const taxFreeRedundancy = Math.min(input.redundancy_or_severance_cents, taxFreeCap);
  const excessRedundancy = input.redundancy_or_severance_cents - taxFreeRedundancy;

  // Taxable ETP = redundancy above the tax-free cap + other ETP amounts.
  const etpTaxable = excessRedundancy + input.etp_other_cents;

  // Applicable cap: excluded ETPs use the ETP cap only; others use the LESSER of the
  // ETP cap and the remaining whole-of-income cap (reduced by other taxable income).
  const woiRemaining = Math.max(0, c.whole_of_income_cap_cents - input.other_taxable_income_cents);
  const applicableCap = isExcluded ? c.etp_cap_cents : Math.min(c.etp_cap_cents, woiRemaining);

  const etpWithinCap = Math.min(etpTaxable, applicableCap);
  const etpAboveCap = etpTaxable - etpWithinCap;
  const withinRate = input.at_or_above_preservation_age
    ? c.etp_rate_at_preservation
    : c.etp_rate_under_preservation;
  const etpTax = r(etpWithinCap * withinRate) + r(etpAboveCap * c.etp_rate_above_cap);

  // Unused leave: concessional flat rate for redundancy/invalidity/early-retirement,
  // else the supplied marginal rate.
  const unusedLeave = input.unused_annual_leave_cents + input.unused_long_service_leave_cents;
  const leaveRate = concessional ? c.leave_rate_concessional : input.leave_marginal_rate;
  const leaveTax = r(unusedLeave * leaveRate);

  const gross = input.redundancy_or_severance_cents + input.etp_other_cents + unusedLeave;
  const totalTax = etpTax + leaveTax;

  return {
    reason,
    is_excluded_etp: isExcluded,
    redundancy_tax_free_cap_cents: taxFreeCap,
    redundancy_tax_free_cents: taxFreeRedundancy,
    etp_taxable_cents: etpTaxable,
    etp_applicable_cap_cents: applicableCap,
    etp_within_cap_cents: etpWithinCap,
    etp_above_cap_cents: etpAboveCap,
    etp_within_cap_rate: withinRate,
    etp_tax_cents: etpTax,
    unused_leave_cents: unusedLeave,
    unused_leave_rate: leaveRate,
    unused_leave_tax_cents: leaveTax,
    gross_termination_cents: gross,
    tax_free_cents: taxFreeRedundancy,
    total_tax_cents: totalTax,
    net_cents: gross - totalTax,
  };
}
