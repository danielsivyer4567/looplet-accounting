import type { AdvisoryFacts } from "../advisoryFacts.ts";

export const STRUCTURING_TAX_CONSTANTS = {
  as_at_fy: "2025-26",
  company_base_rate_entity_tax_bps: 2500,
  trust_adult_beneficiary_count: 2,
  individual_resident_rates: [
    { from_cents: 0, to_cents: 1_820_000, rate_bps: 0 },
    { from_cents: 1_820_000, to_cents: 4_500_000, rate_bps: 1600 },
    { from_cents: 4_500_000, to_cents: 13_500_000, rate_bps: 3000 },
    { from_cents: 13_500_000, to_cents: 19_000_000, rate_bps: 3700 },
    { from_cents: 19_000_000, to_cents: null, rate_bps: 4500 },
  ],
} as const;

export type StructuringOptionKey =
  | "sole_trader"
  | "company"
  | "discretionary_trust";

export interface StructuringOption {
  key: StructuringOptionKey;
  label: string;
  tax_cents: number;
  after_tax_cents: number;
  effective_tax_rate_bps: number;
}

export interface StructuringModelResult {
  as_at_fy: string;
  taxable_profit_cents: number;
  current_entity_type: string | null;
  options: Record<StructuringOptionKey, StructuringOption>;
  best_option: StructuringOptionKey;
  tax_diff_cents: number;
  assumptions: string[];
  warnings: string[];
}

function roundCents(value: number): number {
  return Math.round(value);
}

function taxAtBps(amountCents: number, rateBps: number): number {
  return roundCents((amountCents * rateBps) / 10_000);
}

export function individualResidentTaxCents(taxableIncomeCents: number): number {
  const income = Math.max(0, Math.trunc(taxableIncomeCents));
  let tax = 0;
  for (const bracket of STRUCTURING_TAX_CONSTANTS.individual_resident_rates) {
    if (income <= bracket.from_cents) continue;
    const upper = bracket.to_cents ?? income;
    const taxableInBracket = Math.min(income, upper) - bracket.from_cents;
    tax += taxAtBps(taxableInBracket, bracket.rate_bps);
  }
  return tax;
}

function option(
  key: StructuringOptionKey,
  label: string,
  taxableProfitCents: number,
  taxCents: number,
): StructuringOption {
  return {
    key,
    label,
    tax_cents: taxCents,
    after_tax_cents: taxableProfitCents - taxCents,
    effective_tax_rate_bps: taxableProfitCents > 0
      ? Math.round((taxCents * 10_000) / taxableProfitCents)
      : 0,
  };
}

function trustTaxCents(taxableProfitCents: number): number {
  const count = STRUCTURING_TAX_CONSTANTS.trust_adult_beneficiary_count;
  const baseShare = Math.trunc(taxableProfitCents / count);
  const remainder = taxableProfitCents - baseShare * count;
  let total = 0;
  for (let i = 0; i < count; i++) {
    total += individualResidentTaxCents(baseShare + (i === 0 ? remainder : 0));
  }
  return total;
}

export function modelStructuring(facts: AdvisoryFacts): StructuringModelResult {
  const warnings: string[] = [];
  if (facts.financials.gross_profit_cents == null) {
    warnings.push(
      "gross_profit_cents unavailable; taxable profit treated as 0 for this estimate",
    );
  }
  if (facts.source_errors.length > 0) {
    warnings.push(...facts.source_errors.map((err) => `source error: ${err}`));
  }

  const taxableProfitCents = Math.max(
    0,
    Math.trunc(facts.financials.gross_profit_cents ?? 0),
  );
  const soleTraderTax = individualResidentTaxCents(taxableProfitCents);
  const companyTax = taxAtBps(
    taxableProfitCents,
    STRUCTURING_TAX_CONSTANTS.company_base_rate_entity_tax_bps,
  );
  const trustTax = trustTaxCents(taxableProfitCents);

  const options: Record<StructuringOptionKey, StructuringOption> = {
    sole_trader: option(
      "sole_trader",
      "Sole trader",
      taxableProfitCents,
      soleTraderTax,
    ),
    company: option("company", "Company", taxableProfitCents, companyTax),
    discretionary_trust: option(
      "discretionary_trust",
      "Discretionary trust",
      taxableProfitCents,
      trustTax,
    ),
  };
  const best = (Object.values(options) as StructuringOption[]).reduce((
    winner,
    candidate,
  ) => candidate.tax_cents < winner.tax_cents ? candidate : winner);

  return {
    as_at_fy: STRUCTURING_TAX_CONSTANTS.as_at_fy,
    taxable_profit_cents: taxableProfitCents,
    current_entity_type: facts.profile.entity_type,
    options,
    best_option: best.key,
    tax_diff_cents: options.sole_trader.tax_cents - best.tax_cents,
    assumptions: [
      "Taxable profit is proxied by current-FY gross_profit_cents from v_organization_realtime_pnl.",
      "Individual tax uses resident marginal income-tax brackets only; Medicare levy, offsets, PSI, Division 7A, and state duties are excluded.",
      "Company option assumes a base-rate entity company tax rate of 25% and does not model dividend top-up tax or franking-credit timing.",
      "Discretionary trust option assumes profit is distributed evenly to two adult resident beneficiaries.",
    ],
    warnings,
  };
}
