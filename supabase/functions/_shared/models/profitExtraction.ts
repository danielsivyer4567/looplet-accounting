import type { AdvisoryFacts } from "../advisoryFacts.ts";
import {
  individualResidentTaxCents,
  STRUCTURING_TAX_CONSTANTS,
} from "./structuring.ts";

export type ProfitExtractionStrategy =
  | "owner_wage"
  | "franked_dividend"
  | "owner_trust_distribution"
  | "trust_split_distribution"
  | "sole_trader_drawings";

export interface ProfitExtractionSplit {
  wages_cents: number;
  franked_dividend_cash_cents: number;
  franking_credit_cents: number;
  trust_distribution_cents: number;
  retained_cents: number;
  beneficiary_distributions_cents: number[];
}

export interface ProfitExtractionOption {
  strategy: ProfitExtractionStrategy;
  label: string;
  total_tax_cents: number;
  after_tax_cash_cents: number;
  effective_tax_rate_bps: number;
  split: ProfitExtractionSplit;
  notes: string[];
}

export interface ProfitExtractionModelResult {
  as_at_fy: string;
  entity_type: string | null;
  profit_available_cents: number;
  recommended_strategy: ProfitExtractionStrategy;
  recommended_split: ProfitExtractionSplit;
  recommended_total_tax_cents: number;
  tax_saving_cents: number;
  options: ProfitExtractionOption[];
  assumptions: string[];
  warnings: string[];
}

function positiveCents(value: number | null | undefined): number {
  const cents = Math.trunc(value ?? 0);
  return Number.isFinite(cents) ? Math.max(0, cents) : 0;
}

function taxAtBps(amountCents: number, rateBps: number): number {
  return Math.round((Math.max(0, amountCents) * rateBps) / 10_000);
}

function rateBps(taxCents: number, profitCents: number): number {
  return profitCents > 0 ? Math.round((taxCents * 10_000) / profitCents) : 0;
}

function split(
  overrides: Partial<ProfitExtractionSplit> = {},
): ProfitExtractionSplit {
  return {
    wages_cents: 0,
    franked_dividend_cash_cents: 0,
    franking_credit_cents: 0,
    trust_distribution_cents: 0,
    retained_cents: 0,
    beneficiary_distributions_cents: [],
    ...overrides,
  };
}

function option(
  strategy: ProfitExtractionStrategy,
  label: string,
  profitCents: number,
  totalTaxCents: number,
  strategySplit: ProfitExtractionSplit,
  notes: string[],
): ProfitExtractionOption {
  return {
    strategy,
    label,
    total_tax_cents: totalTaxCents,
    after_tax_cash_cents: profitCents - totalTaxCents,
    effective_tax_rate_bps: rateBps(totalTaxCents, profitCents),
    split: strategySplit,
    notes,
  };
}

function ownerWageOption(profitCents: number): ProfitExtractionOption {
  const tax = individualResidentTaxCents(profitCents);
  return option(
    "owner_wage",
    "Owner wage",
    profitCents,
    tax,
    split({ wages_cents: profitCents }),
    [
      "Company taxable profit is reduced by the wage; payroll tax, superannuation, and PAYG timing are excluded.",
    ],
  );
}

function frankedDividendOption(profitCents: number): ProfitExtractionOption {
  const companyTax = taxAtBps(
    profitCents,
    STRUCTURING_TAX_CONSTANTS.company_base_rate_entity_tax_bps,
  );
  const cashDividend = Math.max(0, profitCents - companyTax);
  const ownerTaxBeforeCredits = individualResidentTaxCents(
    cashDividend + companyTax,
  );
  const ownerTopUpTax = Math.max(0, ownerTaxBeforeCredits - companyTax);
  const frankingRefund = Math.max(0, companyTax - ownerTaxBeforeCredits);
  const totalTax = companyTax + ownerTopUpTax - frankingRefund;

  return option(
    "franked_dividend",
    "Fully franked dividend",
    profitCents,
    totalTax,
    split({
      franked_dividend_cash_cents: cashDividend,
      franking_credit_cents: companyTax,
    }),
    [
      "Dividend option assumes the whole after-company-tax profit is paid as a fully franked dividend.",
      `Owner top-up tax is ${ownerTopUpTax} cents and franking refund is ${frankingRefund} cents.`,
    ],
  );
}

function trustOptions(profitCents: number): ProfitExtractionOption[] {
  const ownerTax = individualResidentTaxCents(profitCents);
  const beneficiaryCount =
    STRUCTURING_TAX_CONSTANTS.trust_adult_beneficiary_count;
  const baseShare = Math.trunc(profitCents / beneficiaryCount);
  const remainder = profitCents - baseShare * beneficiaryCount;
  const distributions = Array.from(
    { length: beneficiaryCount },
    (_, index) => baseShare + (index === 0 ? remainder : 0),
  );
  const splitTax = distributions.reduce(
    (total, distribution) => total + individualResidentTaxCents(distribution),
    0,
  );

  return [
    option(
      "owner_trust_distribution",
      "Owner-only trust distribution",
      profitCents,
      ownerTax,
      split({ trust_distribution_cents: profitCents }),
      ["Trust income is distributed entirely to the owner beneficiary."],
    ),
    option(
      "trust_split_distribution",
      "Even adult-beneficiary trust split",
      profitCents,
      splitTax,
      split({
        trust_distribution_cents: profitCents,
        beneficiary_distributions_cents: distributions,
      }),
      [
        `Trust income is split evenly across ${beneficiaryCount} adult resident beneficiaries.`,
      ],
    ),
  ];
}

function soleTraderOption(profitCents: number): ProfitExtractionOption {
  const tax = individualResidentTaxCents(profitCents);
  return option(
    "sole_trader_drawings",
    "Sole trader drawings",
    profitCents,
    tax,
    split(),
    [
      "Drawings are not deductible; taxable business profit is taxed to the individual owner.",
    ],
  );
}

function optionsForEntity(
  entityType: string | null,
  profitCents: number,
): ProfitExtractionOption[] {
  if (entityType === "company") {
    return [frankedDividendOption(profitCents), ownerWageOption(profitCents)];
  }
  if (entityType === "trust") {
    return trustOptions(profitCents);
  }
  return [soleTraderOption(profitCents)];
}

export function modelProfitExtraction(
  facts: AdvisoryFacts,
): ProfitExtractionModelResult {
  const warnings: string[] = [];
  if (facts.financials.gross_profit_cents == null) {
    warnings.push(
      "gross_profit_cents unavailable; profit available treated as 0 for this estimate",
    );
  }
  if (facts.source_errors.length > 0) {
    warnings.push(...facts.source_errors.map((err) => `source error: ${err}`));
  }

  const profitCents = positiveCents(facts.financials.gross_profit_cents);
  const options = optionsForEntity(facts.profile.entity_type, profitCents);
  const baseline = options[0];
  const best = options.reduce((winner, candidate) =>
    candidate.total_tax_cents < winner.total_tax_cents ? candidate : winner
  );

  return {
    as_at_fy: STRUCTURING_TAX_CONSTANTS.as_at_fy,
    entity_type: facts.profile.entity_type,
    profit_available_cents: profitCents,
    recommended_strategy: best.strategy,
    recommended_split: best.split,
    recommended_total_tax_cents: best.total_tax_cents,
    tax_saving_cents: baseline.total_tax_cents - best.total_tax_cents,
    options,
    assumptions: [
      "Profit available is proxied by current-FY gross_profit_cents from v_organization_realtime_pnl.",
      "Individual tax uses resident marginal income-tax brackets from the structuring model; Medicare levy, offsets, PSI, payroll tax, superannuation, and timing effects are excluded.",
      "Company extraction compares owner wage against a fully franked dividend using the base-rate entity company tax rate.",
      "Trust split assumes the structuring-model adult beneficiary count and ignores beneficiary non-tax constraints.",
    ],
    warnings,
  };
}
