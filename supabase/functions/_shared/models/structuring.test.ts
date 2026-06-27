import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { AdvisoryFacts } from "../advisoryFacts.ts";
import { individualResidentTaxCents, modelStructuring } from "./structuring.ts";

function facts(
  grossProfitCents: number | null,
  entityType: string | null = "sole_trader",
): AdvisoryFacts {
  return {
    organization_id: "org-1",
    profile: {
      entity_type: entityType,
      turnover_bracket: "under_2m",
      estimated_annual_turnover_cents: grossProfitCents,
      is_gst_registered: true,
      employees_count: 1,
      live_employees_count: 1,
      subbies_count: 0,
      vehicle_count: 0,
      primary_vehicle_business_use_pct: null,
      has_logbook: null,
      live_active_jobs_count: 2,
    },
    financials: {
      revenue_inc_gst_cents: grossProfitCents,
      revenue_ex_gst_cents: grossProfitCents,
      total_cost_cents: 0,
      cost_bills_cents: 0,
      cost_wages_cents: 0,
      cost_overhead_cents: 0,
      gross_profit_cents: grossProfitCents,
      gst_set_aside_cents: 0,
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
}

Deno.test("individualResidentTaxCents applies the stamped marginal brackets", () => {
  assertEquals(individualResidentTaxCents(18_200_00), 0);
  assertEquals(individualResidentTaxCents(45_000_00), 428_800);
  assertEquals(individualResidentTaxCents(80_000_00), 1_478_800);
  assertEquals(individualResidentTaxCents(200_000_00), 5_613_800);
});

Deno.test("modelStructuring computes hand-checked trust savings on an 80k profit fixture", () => {
  const result = modelStructuring(facts(80_000_00));

  assertEquals(result.taxable_profit_cents, 80_000_00);
  assertEquals(result.options.sole_trader.tax_cents, 1_478_800);
  assertEquals(result.options.company.tax_cents, 2_000_000);
  // Trust assumption: two adult residents on $40k each => $3,488 each.
  assertEquals(result.options.discretionary_trust.tax_cents, 697_600);
  assertEquals(result.best_option, "discretionary_trust");
  assertEquals(result.tax_diff_cents, 781_200);
});

Deno.test("modelStructuring computes hand-checked trust savings on a 200k profit fixture", () => {
  const result = modelStructuring(facts(200_000_00));

  assertEquals(result.options.sole_trader.tax_cents, 5_613_800);
  assertEquals(result.options.company.tax_cents, 5_000_000);
  // Trust assumption: two adult residents on $100k each => $20,788 each.
  assertEquals(result.options.discretionary_trust.tax_cents, 4_157_600);
  assertEquals(result.best_option, "discretionary_trust");
  assertEquals(result.tax_diff_cents, 1_456_200);
});

Deno.test("modelStructuring can prefer company tax at higher profit and carries warnings", () => {
  const high = modelStructuring(facts(500_000_00, "company"));

  assertEquals(high.options.sole_trader.tax_cents, 19_113_800);
  assertEquals(high.options.company.tax_cents, 12_500_000);
  assertEquals(high.options.discretionary_trust.tax_cents, 15_727_600);
  assertEquals(high.best_option, "company");
  assertEquals(high.tax_diff_cents, 6_613_800);
  assertEquals(high.current_entity_type, "company");

  const missing = modelStructuring({
    ...facts(null),
    source_errors: ["v_organization_realtime_pnl: unavailable"],
  });
  assertEquals(missing.taxable_profit_cents, 0);
  assertEquals(missing.warnings, [
    "gross_profit_cents unavailable; taxable profit treated as 0 for this estimate",
    "source error: v_organization_realtime_pnl: unavailable",
  ]);
});
