import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { AdvisoryFacts } from "../advisoryFacts.ts";
import type { ProfitExtractionStrategy } from "./profitExtraction.ts";
import { modelProfitExtraction } from "./profitExtraction.ts";

type FactsOverrides =
  & Omit<Partial<AdvisoryFacts>, "profile" | "financials" | "signals">
  & {
    profile?: Partial<AdvisoryFacts["profile"]>;
    financials?: Partial<AdvisoryFacts["financials"]>;
    signals?: Partial<AdvisoryFacts["signals"]>;
  };

function facts(overrides: FactsOverrides = {}): AdvisoryFacts {
  const base: AdvisoryFacts = {
    organization_id: "org-1",
    profile: {
      entity_type: "company",
      turnover_bracket: "under_2m",
      estimated_annual_turnover_cents: 200_000_00,
      is_gst_registered: true,
      employees_count: 2,
      live_employees_count: 2,
      subbies_count: 0,
      vehicle_count: 0,
      primary_vehicle_business_use_pct: null,
      has_logbook: null,
      live_active_jobs_count: 2,
    },
    financials: {
      revenue_inc_gst_cents: 220_000_00,
      revenue_ex_gst_cents: 200_000_00,
      total_cost_cents: 0,
      cost_bills_cents: 0,
      cost_wages_cents: 0,
      cost_overhead_cents: 0,
      gross_profit_cents: 200_000_00,
      gst_set_aside_cents: null,
      tax_set_aside_cents: null,
      really_yours_cents: null,
    },
    latest_bas: null,
    signals: {
      wages_vs_drawings: "no_wages_recorded",
      has_vehicle_profile: false,
      vehicle_without_logbook: false,
      active_jobs_present: true,
      active_asset_review_possible: true,
    },
    source_errors: [],
  };

  return {
    ...base,
    ...overrides,
    profile: { ...base.profile, ...overrides.profile },
    financials: { ...base.financials, ...overrides.financials },
    signals: { ...base.signals, ...overrides.signals },
  };
}

function option(
  result: ReturnType<typeof modelProfitExtraction>,
  strategy: ProfitExtractionStrategy,
) {
  return result.options.find((candidate) => candidate.strategy === strategy);
}

Deno.test("modelProfitExtraction computes company wage vs fully franked dividend extraction", () => {
  const result = modelProfitExtraction(facts());
  const dividend = option(result, "franked_dividend");
  const wage = option(result, "owner_wage");

  assertEquals(result.as_at_fy, "2025-26");
  assertEquals(result.profit_available_cents, 200_000_00);
  assertEquals(result.recommended_strategy, "franked_dividend");
  assertEquals(result.recommended_total_tax_cents, 5_613_800);
  assertEquals(result.tax_saving_cents, 0);
  assertEquals(dividend?.total_tax_cents, 5_613_800);
  assertEquals(dividend?.split.franked_dividend_cash_cents, 150_000_00);
  assertEquals(dividend?.split.franking_credit_cents, 50_000_00);
  assertEquals(wage?.total_tax_cents, 5_613_800);
  assertEquals(wage?.split.wages_cents, 200_000_00);
});

Deno.test("modelProfitExtraction recommends the lower-tax trust split on a hand-computed fixture", () => {
  const result = modelProfitExtraction(
    facts({
      profile: {
        entity_type: "trust",
        estimated_annual_turnover_cents: 80_000_00,
      },
      financials: {
        revenue_inc_gst_cents: 88_000_00,
        revenue_ex_gst_cents: 80_000_00,
        gross_profit_cents: 80_000_00,
      },
    }),
  );
  const ownerOnly = option(result, "owner_trust_distribution");
  const split = option(result, "trust_split_distribution");

  assertEquals(result.recommended_strategy, "trust_split_distribution");
  assertEquals(result.recommended_total_tax_cents, 697_600);
  assertEquals(result.tax_saving_cents, 781_200);
  assertEquals(ownerOnly?.total_tax_cents, 1_478_800);
  assertEquals(split?.total_tax_cents, 697_600);
  assertEquals(result.recommended_split.beneficiary_distributions_cents, [
    40_000_00,
    40_000_00,
  ]);
});

Deno.test("modelProfitExtraction reports missing profit and carries source errors", () => {
  const result = modelProfitExtraction(
    facts({
      profile: { entity_type: "sole_trader" },
      financials: { gross_profit_cents: null },
      source_errors: ["v_organization_realtime_pnl: unavailable"],
    }),
  );

  assertEquals(result.profit_available_cents, 0);
  assertEquals(result.recommended_strategy, "sole_trader_drawings");
  assertEquals(result.recommended_total_tax_cents, 0);
  assertEquals(result.warnings, [
    "gross_profit_cents unavailable; profit available treated as 0 for this estimate",
    "source error: v_organization_realtime_pnl: unavailable",
  ]);
});
