import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { AdvisoryFacts } from "../advisoryFacts.ts";
import { modelYearEnd } from "./yearEnd.ts";

type YearEndTestFacts = AdvisoryFacts & {
  year_end_inputs?: {
    current_concessional_super_cents?: number | null;
    planned_asset_purchase_cents?: number | null;
    planned_prepayment_cents?: number | null;
    deferrable_revenue_cents?: number | null;
  };
};

type FactsOverrides =
  & Omit<Partial<YearEndTestFacts>, "profile" | "financials" | "signals">
  & {
    profile?: Partial<YearEndTestFacts["profile"]>;
    financials?: Partial<YearEndTestFacts["financials"]>;
    signals?: Partial<YearEndTestFacts["signals"]>;
  };

function facts(overrides: FactsOverrides = {}): YearEndTestFacts {
  const base: YearEndTestFacts = {
    organization_id: "org-1",
    profile: {
      entity_type: "company",
      turnover_bracket: "under_2m",
      estimated_annual_turnover_cents: 80_000_000,
      is_gst_registered: true,
      employees_count: 2,
      live_employees_count: 2,
      subbies_count: 1,
      vehicle_count: 1,
      primary_vehicle_business_use_pct: 80,
      has_logbook: true,
      live_active_jobs_count: 4,
    },
    financials: {
      revenue_inc_gst_cents: 55_000_000,
      revenue_ex_gst_cents: 50_000_000,
      total_cost_cents: 30_000_000,
      cost_bills_cents: 20_000_000,
      cost_wages_cents: 8_000_000,
      cost_overhead_cents: 2_000_000,
      gross_profit_cents: 20_000_000,
      gst_set_aside_cents: 1_000_000,
      tax_set_aside_cents: 5_000_000,
      really_yours_cents: 14_000_000,
    },
    latest_bas: null,
    signals: {
      wages_vs_drawings: "wages_recorded",
      has_vehicle_profile: true,
      vehicle_without_logbook: false,
      active_jobs_present: true,
      active_asset_review_possible: true,
    },
    source_errors: [],
    year_end_inputs: {
      current_concessional_super_cents: 1_000_000,
      planned_asset_purchase_cents: 1_800_000,
      planned_prepayment_cents: 1_200_000,
      deferrable_revenue_cents: 5_000_000,
    },
  };

  return {
    ...base,
    ...overrides,
    profile: { ...base.profile, ...overrides.profile },
    financials: { ...base.financials, ...overrides.financials },
    signals: { ...base.signals, ...overrides.signals },
    year_end_inputs: { ...base.year_end_inputs, ...overrides.year_end_inputs },
  };
}

function saving(result: ReturnType<typeof modelYearEnd>, kind: string): number {
  return result.levers.find((lever) => lever.kind === kind)?.saving_cents ?? -1;
}

Deno.test("modelYearEnd computes all four company year-end levers from explicit inputs", () => {
  const result = modelYearEnd(facts(), "2026-06-15");

  assertEquals(result.in_year_end_window, true);
  assertEquals(result.deduction_rate_bps, 2500);
  // $20k cap headroom x (25% company deduction - 15% contributions tax) = $2k.
  assertEquals(saving(result, "concessional_super"), 200_000);
  // $18k planned asset x 25% = $4.5k.
  assertEquals(saving(result, "instant_asset_writeoff"), 450_000);
  // $12k prepayment x 25% = $3k.
  assertEquals(saving(result, "deductible_prepayment"), 300_000);
  // $50k revenue deferral x 25% = $12.5k timing benefit.
  assertEquals(saving(result, "profit_deferral"), 1_250_000);
});

Deno.test("modelYearEnd caps asset write-off and uses marginal sole-trader rate", () => {
  const result = modelYearEnd(
    facts({
      profile: { entity_type: "sole_trader" },
      financials: { gross_profit_cents: 20_000_000 },
      year_end_inputs: {
        current_concessional_super_cents: 0,
        planned_asset_purchase_cents: 2_500_000,
        planned_prepayment_cents: 1_000_000,
        deferrable_revenue_cents: 1_000_000,
      },
    }),
    "2026-06-01",
  );

  assertEquals(result.deduction_rate_bps, 4500);
  assertEquals(saving(result, "concessional_super"), 900_000);
  assertEquals(saving(result, "instant_asset_writeoff"), 900_000);
  assertEquals(saving(result, "deductible_prepayment"), 450_000);
  assertEquals(saving(result, "profit_deferral"), 450_000);
});

Deno.test("modelYearEnd suppresses levers outside the pre-30-June window", () => {
  const result = modelYearEnd(facts(), "2026-02-15");

  assertEquals(result.in_year_end_window, false);
  assertEquals(result.levers, []);
  assertEquals(result.warnings, [
    "outside the 1 Apr to 30 Jun year-end planning window",
  ]);
});

Deno.test("modelYearEnd suppresses non-applicable levers when amounts or headroom are zero", () => {
  const result = modelYearEnd(
    facts({
      year_end_inputs: {
        current_concessional_super_cents: 3_000_000,
        planned_asset_purchase_cents: 0,
        planned_prepayment_cents: 0,
        deferrable_revenue_cents: 0,
      },
    }),
    "2026-06-20",
  );

  assertEquals(result.levers, []);
});
