import type { AdvisoryFacts } from "../advisoryFacts.ts";
import { STRUCTURING_TAX_CONSTANTS } from "./structuring.ts";

export const YEAR_END_CONSTANTS = {
  as_at_fy: "2025-26",
  year_end_window_start_month: 4,
  year_end_window_start_day: 1,
  concessional_super_cap_cents: 3_000_000,
  concessional_super_contributions_tax_bps: 1500,
  instant_asset_writeoff_limit_cents: 2_000_000,
  default_prepayment_scenario_cents: 1_000_000,
  default_deferrable_revenue_pct_bps: 500,
  default_deferrable_revenue_cap_cents: 5_000_000,
} as const;

export type YearEndLeverKind =
  | "concessional_super"
  | "instant_asset_writeoff"
  | "deductible_prepayment"
  | "profit_deferral";

export interface YearEndLever {
  kind: YearEndLeverKind;
  label: string;
  base_amount_cents: number;
  saving_cents: number;
  assumptions: string[];
}

export interface YearEndScenarioInputs {
  current_concessional_super_cents?: number | null;
  planned_asset_purchase_cents?: number | null;
  planned_prepayment_cents?: number | null;
  deferrable_revenue_cents?: number | null;
}

export interface YearEndModelResult {
  as_at_fy: string;
  as_at_date: string;
  in_year_end_window: boolean;
  deduction_rate_bps: number;
  levers: YearEndLever[];
  warnings: string[];
}

type FactsWithYearEndInputs = AdvisoryFacts & {
  year_end_inputs?: YearEndScenarioInputs;
};

function dateOnly(value: Date | string): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

function isYearEndWindow(asAtDate: string): boolean {
  const [, monthPart, dayPart] = asAtDate.split("-");
  const month = Number(monthPart);
  const day = Number(dayPart);
  if (month < YEAR_END_CONSTANTS.year_end_window_start_month || month > 6) {
    return false;
  }
  if (month === YEAR_END_CONSTANTS.year_end_window_start_month) {
    return day >= YEAR_END_CONSTANTS.year_end_window_start_day;
  }
  return true;
}

function taxAtBps(amountCents: number, rateBps: number): number {
  return Math.round((Math.max(0, amountCents) * rateBps) / 10_000);
}

function individualMarginalRateBps(taxableIncomeCents: number): number {
  const income = Math.max(0, taxableIncomeCents);
  let rate = 0;
  for (const bracket of STRUCTURING_TAX_CONSTANTS.individual_resident_rates) {
    if (income > bracket.from_cents) rate = bracket.rate_bps;
  }
  return rate;
}

function deductionRateBps(facts: AdvisoryFacts): number {
  const entity = facts.profile.entity_type;
  if (entity === "company") {
    return STRUCTURING_TAX_CONSTANTS.company_base_rate_entity_tax_bps;
  }
  if (entity === "trust") return 3000;
  return individualMarginalRateBps(facts.financials.gross_profit_cents ?? 0);
}

function positiveInput(
  value: number | null | undefined,
  fallback: number,
): number {
  return Math.max(0, Math.trunc(value ?? fallback));
}

function lever(
  kind: YearEndLeverKind,
  label: string,
  baseAmountCents: number,
  savingCents: number,
  assumptions: string[],
): YearEndLever | null {
  if (baseAmountCents <= 0 || savingCents <= 0) return null;
  return {
    kind,
    label,
    base_amount_cents: baseAmountCents,
    saving_cents: savingCents,
    assumptions,
  };
}

export function modelYearEnd(
  facts: AdvisoryFacts,
  asAtDate: Date | string,
): YearEndModelResult {
  const date = dateOnly(asAtDate);
  const inWindow = isYearEndWindow(date);
  const rateBps = deductionRateBps(facts);
  const inputs = (facts as FactsWithYearEndInputs).year_end_inputs ?? {};
  const warnings = facts.source_errors.map((err) => `source error: ${err}`);
  if (!inWindow) {
    warnings.push("outside the 1 Apr to 30 Jun year-end planning window");
    return {
      as_at_fy: YEAR_END_CONSTANTS.as_at_fy,
      as_at_date: date,
      in_year_end_window: false,
      deduction_rate_bps: rateBps,
      levers: [],
      warnings,
    };
  }

  const grossProfit = Math.max(0, facts.financials.gross_profit_cents ?? 0);
  const revenue = Math.max(
    0,
    facts.financials.revenue_ex_gst_cents ??
      facts.financials.revenue_inc_gst_cents ?? 0,
  );
  const currentSuper = positiveInput(
    inputs.current_concessional_super_cents,
    0,
  );
  const superHeadroom = Math.max(
    0,
    YEAR_END_CONSTANTS.concessional_super_cap_cents - currentSuper,
  );
  const superNetRate = Math.max(
    0,
    rateBps - YEAR_END_CONSTANTS.concessional_super_contributions_tax_bps,
  );
  const plannedAsset = positiveInput(
    inputs.planned_asset_purchase_cents,
    facts.signals.active_asset_review_possible
      ? YEAR_END_CONSTANTS.instant_asset_writeoff_limit_cents
      : 0,
  );
  const deductibleAsset = Math.min(
    plannedAsset,
    YEAR_END_CONSTANTS.instant_asset_writeoff_limit_cents,
  );
  const plannedPrepayment = positiveInput(
    inputs.planned_prepayment_cents,
    grossProfit > 0 ? YEAR_END_CONSTANTS.default_prepayment_scenario_cents : 0,
  );
  const defaultDeferrable = Math.min(
    YEAR_END_CONSTANTS.default_deferrable_revenue_cap_cents,
    taxAtBps(revenue, YEAR_END_CONSTANTS.default_deferrable_revenue_pct_bps),
  );
  const deferrableRevenue = positiveInput(
    inputs.deferrable_revenue_cents,
    grossProfit > 0 ? defaultDeferrable : 0,
  );

  const levers = [
    lever(
      "concessional_super",
      "Additional concessional super contribution",
      superHeadroom,
      taxAtBps(superHeadroom, superNetRate),
      [
        `General concessional cap assumed at ${YEAR_END_CONSTANTS.concessional_super_cap_cents} cents for ${YEAR_END_CONSTANTS.as_at_fy}.`,
        `Saving uses deduction rate ${rateBps}bps less 15% contributions tax.`,
      ],
    ),
    lever(
      "instant_asset_writeoff",
      "Instant asset write-off purchase",
      deductibleAsset,
      taxAtBps(deductibleAsset, rateBps),
      [
        `Per-asset instant asset write-off limit assumed at ${YEAR_END_CONSTANTS.instant_asset_writeoff_limit_cents} cents for ${YEAR_END_CONSTANTS.as_at_fy}.`,
        "Eligibility and business-use percentage must be confirmed before acting.",
      ],
    ),
    lever(
      "deductible_prepayment",
      "Deductible prepayment before 30 June",
      plannedPrepayment,
      taxAtBps(plannedPrepayment, rateBps),
      [
        "Assumes the prepayment is deductible in the current income year under the relevant prepayment rules.",
      ],
    ),
    lever(
      "profit_deferral",
      "Defer assessable income into next year",
      deferrableRevenue,
      taxAtBps(deferrableRevenue, rateBps),
      [
        "Timing benefit only: deferral moves tax to the next income year rather than permanently eliminating it.",
      ],
    ),
  ].filter((item): item is YearEndLever => item !== null);

  return {
    as_at_fy: YEAR_END_CONSTANTS.as_at_fy,
    as_at_date: date,
    in_year_end_window: true,
    deduction_rate_bps: rateBps,
    levers,
    warnings,
  };
}
