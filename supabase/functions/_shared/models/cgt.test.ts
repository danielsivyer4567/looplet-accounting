import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { AdvisoryFacts } from "../advisoryFacts.ts";
import { modelCgt } from "./cgt.ts";

function facts(turnoverBracket: string | null): AdvisoryFacts {
  return {
    organization_id: "org-1",
    profile: {
      entity_type: "company",
      turnover_bracket: turnoverBracket,
      estimated_annual_turnover_cents: null,
      is_gst_registered: true,
      employees_count: 2,
      live_employees_count: 2,
      subbies_count: 0,
      vehicle_count: 0,
      primary_vehicle_business_use_pct: null,
      has_logbook: null,
      live_active_jobs_count: 1,
    },
    financials: {
      revenue_inc_gst_cents: null,
      revenue_ex_gst_cents: null,
      total_cost_cents: null,
      cost_bills_cents: null,
      cost_wages_cents: null,
      cost_overhead_cents: null,
      gross_profit_cents: null,
      gst_set_aside_cents: null,
      tax_set_aside_cents: null,
      really_yours_cents: null,
    },
    latest_bas: null,
    signals: {
      wages_vs_drawings: "unknown",
      has_vehicle_profile: false,
      vehicle_without_logbook: false,
      active_jobs_present: true,
      active_asset_review_possible: true,
    },
    source_errors: [],
  };
}

Deno.test("modelCgt computes gain, 12-month discount, and all concession flags on an eligible fixture", () => {
  const result = modelCgt(facts("under_2m"), {
    proceeds_cents: 50_000_000,
    cost_base_cents: 20_000_000,
    acquired_date: "2010-01-01",
    disposal_date: "2026-06-30",
    is_active_asset: true,
    active_asset_years: 16,
    net_asset_value_cents: 300_000_000,
    significant_individual_55_or_retiring: true,
  });

  assertEquals(result.gross_gain_cents, 30_000_000);
  assertEquals(result.discounted_gain_cents, 15_000_000);
  assertEquals(result.flags, {
    size_test_eligible: true,
    active_asset_test_met: true,
    basic_conditions_met: true,
    discount_12_month_eligible: true,
    fifteen_year_exemption_eligible: true,
    active_asset_50pct_reduction_eligible: true,
    retirement_exemption_eligible: true,
    rollover_eligible: true,
  });
});

Deno.test("modelCgt uses net-asset value as the size-test fallback when turnover is above SBE threshold", () => {
  const result = modelCgt(facts("over_50m"), {
    proceeds_cents: 80_000_000,
    cost_base_cents: 60_000_000,
    acquired_date: "2024-01-01",
    disposal_date: "2026-06-30",
    is_active_asset: true,
    active_asset_years: 2,
    net_asset_value_cents: 500_000_000,
    significant_individual_55_or_retiring: false,
  });

  assertEquals(result.gross_gain_cents, 20_000_000);
  assertEquals(result.discounted_gain_cents, 10_000_000);
  assertEquals(result.flags.size_test_eligible, true);
  assertEquals(result.flags.basic_conditions_met, true);
  assertEquals(result.flags.fifteen_year_exemption_eligible, false);
  assertEquals(result.flags.active_asset_50pct_reduction_eligible, true);
  assertEquals(result.flags.retirement_exemption_eligible, true);
  assertEquals(result.flags.rollover_eligible, true);
});

Deno.test("modelCgt suppresses concessions when discount, size, or active-asset tests fail", () => {
  const result = modelCgt(facts("over_50m"), {
    proceeds_cents: 30_000_000,
    cost_base_cents: 25_000_000,
    acquired_date: "2026-01-01",
    disposal_date: "2026-06-30",
    is_active_asset: false,
    active_asset_years: 0,
    net_asset_value_cents: 700_000_000,
    significant_individual_55_or_retiring: true,
  });

  assertEquals(result.gross_gain_cents, 5_000_000);
  assertEquals(result.discounted_gain_cents, 5_000_000);
  assertEquals(result.flags, {
    size_test_eligible: false,
    active_asset_test_met: false,
    basic_conditions_met: false,
    discount_12_month_eligible: false,
    fifteen_year_exemption_eligible: false,
    active_asset_50pct_reduction_eligible: false,
    retirement_exemption_eligible: false,
    rollover_eligible: false,
  });
});

Deno.test("modelCgt reports missing size-test evidence instead of treating it as eligible", () => {
  const result = modelCgt(facts(null), {
    proceeds_cents: 30_000_000,
    cost_base_cents: 20_000_000,
    acquired_date: "2020-01-01",
    disposal_date: "2026-06-30",
    is_active_asset: true,
  });

  assertEquals(result.flags.size_test_eligible, false);
  assertEquals(result.flags.basic_conditions_met, false);
  assertEquals(result.warnings, [
    "no turnover bracket or net asset value supplied for small-business size test",
  ]);
});
