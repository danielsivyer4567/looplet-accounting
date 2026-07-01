import type { AdvisoryFacts } from "../advisoryFacts.ts";

export const CGT_CONSTANTS = {
  as_at_fy: "2025-26",
  small_business_turnover_threshold_cents: 200_000_000,
  maximum_net_asset_value_threshold_cents: 600_000_000,
  discount_minimum_ownership_days: 365,
  fifteen_year_exemption_minimum_years: 15,
} as const;

export interface CgtDisposalInput {
  proceeds_cents: number;
  cost_base_cents: number;
  acquired_date: string;
  disposal_date: string;
  is_active_asset: boolean;
  active_asset_years?: number | null;
  net_asset_value_cents?: number | null;
  significant_individual_55_or_retiring?: boolean | null;
}

export interface CgtConcessionFlags {
  size_test_eligible: boolean;
  active_asset_test_met: boolean;
  basic_conditions_met: boolean;
  discount_12_month_eligible: boolean;
  fifteen_year_exemption_eligible: boolean;
  active_asset_50pct_reduction_eligible: boolean;
  retirement_exemption_eligible: boolean;
  rollover_eligible: boolean;
}

export interface CgtModelResult {
  as_at_fy: string;
  gross_gain_cents: number;
  discounted_gain_cents: number;
  ownership_days: number;
  flags: CgtConcessionFlags;
  warnings: string[];
}

function daysBetween(start: string, end: string): number {
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return 0;
  }
  return Math.floor((endMs - startMs) / 86_400_000);
}

function isParseableDate(date: string): boolean {
  return Number.isFinite(Date.parse(`${date}T00:00:00Z`));
}

/**
 * ATO s115-25: the asset must be held for at least 12 months, counting neither the
 * acquisition day nor the CGT-event day — i.e. the disposal must fall strictly after
 * the 12-month anniversary. Anniversary arithmetic (not a raw 365-day count) is what
 * makes this correct across leap years (a hold spanning 29 Feb needs 366 elapsed days
 * to reach the anniversary, one that does not needs 365).
 */
function meetsTwelveMonthHold(acquired: string, disposal: string): boolean {
  const acqMs = Date.parse(`${acquired}T00:00:00Z`);
  const dispMs = Date.parse(`${disposal}T00:00:00Z`);
  if (!Number.isFinite(acqMs) || !Number.isFinite(dispMs)) return false;
  const acq = new Date(acqMs);
  const anniversaryMs = Date.UTC(
    acq.getUTCFullYear() + 1,
    acq.getUTCMonth(),
    acq.getUTCDate(),
  );
  return dispMs > anniversaryMs;
}

/** AU financial-year label for a date, e.g. "2018-19" (July boundary), or null if unparseable. */
function financialYearLabel(date: string): string | null {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const startYear = d.getUTCMonth() >= 6 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${startYear}-${String(startYear + 1).slice(2)}`;
}

function turnoverSizeEligible(facts: AdvisoryFacts): boolean {
  return facts.profile.turnover_bracket === "under_2m";
}

function netAssetSizeEligible(disposal: CgtDisposalInput): boolean {
  return disposal.net_asset_value_cents != null &&
    disposal.net_asset_value_cents <=
      CGT_CONSTANTS.maximum_net_asset_value_threshold_cents;
}

export function modelCgt(
  facts: AdvisoryFacts,
  disposal: CgtDisposalInput,
): CgtModelResult {
  const warnings = facts.source_errors.map((err) => `source error: ${err}`);
  if (
    facts.profile.turnover_bracket == null &&
    disposal.net_asset_value_cents == null
  ) {
    warnings.push(
      "no turnover bracket or net asset value supplied for small-business size test",
    );
  }

  const grossGain = Math.max(
    0,
    Math.trunc(disposal.proceeds_cents) - Math.trunc(disposal.cost_base_cents),
  );
  const ownershipDays = daysBetween(
    disposal.acquired_date,
    disposal.disposal_date,
  );
  // Fail safe: an unparseable acquisition/disposal date would silently drop the 50%
  // discount (overstating the gain) with no signal — warn rather than assess it away.
  if (
    !isParseableDate(disposal.acquired_date) ||
    !isParseableDate(disposal.disposal_date)
  ) {
    warnings.push(
      "acquired_date/disposal_date unparseable; 12-month discount not assessed",
    );
  }
  // The rate table is stamped for a single financial year; a disposal in a different
  // year may attract different discount/threshold rules. Surface the mismatch instead
  // of silently applying current-year rates to a prior/future-year event.
  const disposalFy = financialYearLabel(disposal.disposal_date);
  if (disposalFy && disposalFy !== CGT_CONSTANTS.as_at_fy) {
    warnings.push(
      `rates are as_at_fy ${CGT_CONSTANTS.as_at_fy} but disposal falls in FY ${disposalFy}; verify period discount and small-business thresholds`,
    );
  }
  const discountEligible = meetsTwelveMonthHold(
    disposal.acquired_date,
    disposal.disposal_date,
  );
  const sizeEligible = turnoverSizeEligible(facts) ||
    netAssetSizeEligible(disposal);
  const activeAssetTestMet = disposal.is_active_asset === true;
  const basicConditionsMet = grossGain > 0 && sizeEligible &&
    activeAssetTestMet;
  const fifteenYearEligible = basicConditionsMet &&
    (disposal.active_asset_years ?? 0) >=
      CGT_CONSTANTS.fifteen_year_exemption_minimum_years &&
    disposal.significant_individual_55_or_retiring === true;

  return {
    as_at_fy: CGT_CONSTANTS.as_at_fy,
    gross_gain_cents: grossGain,
    discounted_gain_cents: discountEligible
      ? Math.round(grossGain / 2)
      : grossGain,
    ownership_days: ownershipDays,
    flags: {
      size_test_eligible: sizeEligible,
      active_asset_test_met: activeAssetTestMet,
      basic_conditions_met: basicConditionsMet,
      discount_12_month_eligible: discountEligible,
      fifteen_year_exemption_eligible: fifteenYearEligible,
      active_asset_50pct_reduction_eligible: basicConditionsMet,
      retirement_exemption_eligible: basicConditionsMet,
      rollover_eligible: basicConditionsMet,
    },
    warnings,
  };
}
