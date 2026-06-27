import type { AdvisoryFacts } from "../advisoryFacts.ts";

export const FBT_CONSTANTS = {
  as_at_fy: "2025-26",
  statutory_formula_rate_bps: 2000,
  fbt_rate_bps: 4700,
  type_1_gross_up_rate_bps: 20802,
} as const;

export interface FbtScenarioInputs {
  vehicle_base_value_cents?: number | null;
  annual_operating_cost_cents?: number | null;
  employee_contribution_cents?: number | null;
  is_electric_vehicle?: boolean | null;
  work_vehicle_private_use_limited?: boolean | null;
}

export interface FbtMethodResult {
  method: "statutory_formula" | "operating_cost";
  taxable_value_cents: number;
  fbt_cents: number;
}

export interface FbtModelResult {
  as_at_fy: string;
  private_use_bps: number;
  statutory_formula: FbtMethodResult;
  operating_cost: FbtMethodResult;
  lower_cost_method: FbtMethodResult["method"];
  fbt_delta_cents: number;
  exemption_candidates: {
    eligible_ev_exemption: boolean;
    work_vehicle_private_use_limited: boolean;
  };
  warnings: string[];
}

type FactsWithFbtInputs = AdvisoryFacts & {
  fbt_inputs?: FbtScenarioInputs;
};

function bps(amountCents: number, rateBps: number): number {
  return Math.round((Math.max(0, amountCents) * rateBps) / 10_000);
}

function fbtPayableCents(taxableValueCents: number): number {
  const grossedUp = bps(
    taxableValueCents,
    FBT_CONSTANTS.type_1_gross_up_rate_bps,
  );
  return bps(grossedUp, FBT_CONSTANTS.fbt_rate_bps);
}

function positive(value: number | null | undefined): number {
  return Math.max(0, Math.trunc(value ?? 0));
}

export function modelFbt(facts: AdvisoryFacts): FbtModelResult {
  const inputs = (facts as FactsWithFbtInputs).fbt_inputs ?? {};
  const warnings = facts.source_errors.map((err) => `source error: ${err}`);
  const baseValue = positive(inputs.vehicle_base_value_cents);
  const operatingCost = positive(inputs.annual_operating_cost_cents);
  const employeeContribution = positive(inputs.employee_contribution_cents);
  if ((facts.profile.vehicle_count ?? 0) <= 0) {
    warnings.push("no vehicle_count on profile; FBT model is a scenario only");
  }
  if (baseValue === 0) warnings.push("vehicle_base_value_cents not supplied");
  if (operatingCost === 0) {
    warnings.push("annual_operating_cost_cents not supplied");
  }

  const businessUsePct = Math.max(
    0,
    Math.min(100, facts.profile.primary_vehicle_business_use_pct ?? 0),
  );
  const privateUseBps = Math.max(0, 10_000 - Math.round(businessUsePct * 100));
  const statutoryTaxable = Math.max(
    0,
    bps(baseValue, FBT_CONSTANTS.statutory_formula_rate_bps) -
      employeeContribution,
  );
  const operatingTaxable = Math.max(
    0,
    bps(operatingCost, privateUseBps) - employeeContribution,
  );
  const statutory: FbtMethodResult = {
    method: "statutory_formula",
    taxable_value_cents: statutoryTaxable,
    fbt_cents: fbtPayableCents(statutoryTaxable),
  };
  const operating: FbtMethodResult = {
    method: "operating_cost",
    taxable_value_cents: operatingTaxable,
    fbt_cents: fbtPayableCents(operatingTaxable),
  };
  const lower = operating.fbt_cents < statutory.fbt_cents
    ? operating
    : statutory;

  return {
    as_at_fy: FBT_CONSTANTS.as_at_fy,
    private_use_bps: privateUseBps,
    statutory_formula: statutory,
    operating_cost: operating,
    lower_cost_method: lower.method,
    fbt_delta_cents: Math.abs(statutory.fbt_cents - operating.fbt_cents),
    exemption_candidates: {
      eligible_ev_exemption: inputs.is_electric_vehicle === true,
      work_vehicle_private_use_limited:
        inputs.work_vehicle_private_use_limited === true ||
        businessUsePct >= 90,
    },
    warnings,
  };
}
