import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { AdvisoryFacts } from "../advisoryFacts.ts";
import type { FbtScenarioInputs } from "./fbt.ts";
import { modelFbt } from "./fbt.ts";

type FbtTestFacts = AdvisoryFacts & {
  fbt_inputs?: FbtScenarioInputs;
};

type FactsOverrides =
  & Omit<Partial<FbtTestFacts>, "profile" | "financials" | "signals">
  & {
    profile?: Partial<FbtTestFacts["profile"]>;
    financials?: Partial<FbtTestFacts["financials"]>;
    signals?: Partial<FbtTestFacts["signals"]>;
  };

function facts(overrides: FactsOverrides = {}): FbtTestFacts {
  const base: FbtTestFacts = {
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
    fbt_inputs: {
      vehicle_base_value_cents: 6_000_000,
      annual_operating_cost_cents: 1_200_000,
      employee_contribution_cents: 0,
      is_electric_vehicle: false,
      work_vehicle_private_use_limited: false,
    },
  };

  return {
    ...base,
    ...overrides,
    profile: { ...base.profile, ...overrides.profile },
    financials: { ...base.financials, ...overrides.financials },
    signals: { ...base.signals, ...overrides.signals },
    fbt_inputs: { ...base.fbt_inputs, ...overrides.fbt_inputs },
  };
}

Deno.test("modelFbt compares statutory formula and operating cost methods on a hand-checked fixture", () => {
  const result = modelFbt(facts());

  assertEquals(result.as_at_fy, "2025-26");
  assertEquals(result.private_use_bps, 2000);
  assertEquals(result.statutory_formula, {
    method: "statutory_formula",
    taxable_value_cents: 1_200_000,
    fbt_cents: 1_173_233,
  });
  assertEquals(result.operating_cost, {
    method: "operating_cost",
    taxable_value_cents: 240_000,
    fbt_cents: 234_647,
  });
  assertEquals(result.lower_cost_method, "operating_cost");
  assertEquals(result.fbt_delta_cents, 938_586);
  assertEquals(result.exemption_candidates, {
    eligible_ev_exemption: false,
    work_vehicle_private_use_limited: false,
  });
  assertEquals(result.warnings, []);
});

Deno.test("modelFbt flags EV and limited-private-use exemption candidates without suppressing the method estimates", () => {
  const result = modelFbt(
    facts({
      profile: { primary_vehicle_business_use_pct: 95 },
      fbt_inputs: {
        is_electric_vehicle: true,
        work_vehicle_private_use_limited: true,
      },
    }),
  );

  assertEquals(result.private_use_bps, 500);
  assertEquals(result.exemption_candidates, {
    eligible_ev_exemption: true,
    work_vehicle_private_use_limited: true,
  });
  assertEquals(result.statutory_formula.fbt_cents, 1_173_233);
  assertEquals(result.operating_cost.fbt_cents, 58_662);
});

Deno.test("modelFbt carries source errors and warns when vehicle scenario inputs are missing", () => {
  const result = modelFbt(
    facts({
      profile: {
        vehicle_count: 0,
        primary_vehicle_business_use_pct: null,
      },
      fbt_inputs: {
        vehicle_base_value_cents: null,
        annual_operating_cost_cents: null,
      },
      source_errors: ["v_business_context: timeout"],
    }),
  );

  assertEquals(result.private_use_bps, 10000);
  assertEquals(result.statutory_formula.fbt_cents, 0);
  assertEquals(result.operating_cost.fbt_cents, 0);
  assertEquals(result.warnings, [
    "source error: v_business_context: timeout",
    "no vehicle_count on profile; FBT model is a scenario only",
    "vehicle_base_value_cents not supplied",
    "annual_operating_cost_cents not supplied",
  ]);
});
