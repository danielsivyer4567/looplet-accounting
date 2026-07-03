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

function cgtInput(over: Partial<Parameters<typeof modelCgt>[1]>) {
  return {
    proceeds_cents: 50_000_000,
    cost_base_cents: 20_000_000,
    acquired_date: "2010-01-01",
    disposal_date: "2026-06-30",
    is_active_asset: true,
    ...over,
  };
}

Deno.test("12-month hold: exactly one year (on the anniversary) does NOT qualify for the discount", () => {
  // Acquired 2024-01-01, disposed 2024-12-31 = 365 days but a day short of the
  // anniversary — the old `>= 365` check wrongly granted the discount here.
  const r = modelCgt(facts("under_2m"), cgtInput({
    acquired_date: "2024-01-01",
    disposal_date: "2024-12-31",
  }));
  assertEquals(r.flags.discount_12_month_eligible, false);
  assertEquals(r.discounted_gain_cents, r.gross_gain_cents); // no 50% discount
});

Deno.test("12-month hold: strictly more than a year qualifies", () => {
  const r = modelCgt(facts("under_2m"), cgtInput({
    acquired_date: "2024-07-01",
    disposal_date: "2025-07-02", // > 12-month anniversary; disposal FY 2025-26
  }));
  assertEquals(r.flags.discount_12_month_eligible, true);
  assertEquals(r.discounted_gain_cents, Math.round(r.gross_gain_cents / 2));
});

Deno.test("12-month hold: leap-year acquisition uses the anniversary, not a 365-day count", () => {
  // Acquired 29 Feb 2024; anniversary normalises to 1 Mar 2025.
  const onAnniversary = modelCgt(facts("under_2m"), cgtInput({
    acquired_date: "2024-02-29",
    disposal_date: "2025-03-01", // == anniversary → not strictly after → ineligible
  }));
  assertEquals(onAnniversary.flags.discount_12_month_eligible, false);

  const dayAfter = modelCgt(facts("under_2m"), cgtInput({
    acquired_date: "2024-02-29",
    disposal_date: "2025-03-02", // strictly after → eligible
  }));
  assertEquals(dayAfter.flags.discount_12_month_eligible, true);
});

Deno.test("unparseable dates drop the discount but WARN instead of silently overstating the gain", () => {
  const r = modelCgt(facts("under_2m"), cgtInput({
    acquired_date: "not-a-date",
    disposal_date: "2026-06-30",
  }));
  assertEquals(r.flags.discount_12_month_eligible, false);
  assertEquals(
    r.warnings.some((w) => w.includes("unparseable")),
    true,
  );
});

Deno.test("a disposal in a different financial year warns that the stamped rates may not apply", () => {
  const r = modelCgt(facts("under_2m"), cgtInput({
    acquired_date: "2016-01-01",
    disposal_date: "2018-06-30", // FY 2017-18, not the stamped 2025-26
  }));
  assertEquals(
    r.warnings.some((w) => w.includes("FY 2017-18")),
    true,
  );
});
