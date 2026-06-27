import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildNoopEchoAdviceNote,
  buildStructuringAdviceNote,
  type CreateAdviceNoteArgs,
} from "./index.ts";
import type { AdvisoryFacts } from "../_shared/advisoryFacts.ts";
import { modelStructuring } from "../_shared/models/structuring.ts";

const facts: AdvisoryFacts = {
  organization_id: "org-1",
  profile: {
    entity_type: "company",
    turnover_bracket: "under_2m",
    estimated_annual_turnover_cents: 15000000,
    is_gst_registered: true,
    employees_count: 2,
    live_employees_count: 2,
    subbies_count: 1,
    vehicle_count: 1,
    primary_vehicle_business_use_pct: 80,
    has_logbook: false,
    live_active_jobs_count: 3,
  },
  financials: {
    revenue_inc_gst_cents: 22000000,
    revenue_ex_gst_cents: 20000000,
    total_cost_cents: 9000000,
    cost_bills_cents: 5000000,
    cost_wages_cents: 3000000,
    cost_overhead_cents: 1000000,
    gross_profit_cents: 13000000,
    gst_set_aside_cents: 900000,
    tax_set_aside_cents: 3250000,
    really_yours_cents: 8850000,
  },
  latest_bas: {
    fy_start_year: 2025,
    quarter_num: 4,
    quarter_start: "2026-04-01",
    quarter_end: "2026-06-30",
    due_date: "2026-07-28",
    gst_collected_cents: 1200000,
    gst_paid_cents: 300000,
    net_gst_cents: 900000,
  },
  signals: {
    wages_vs_drawings: "wages_recorded",
    has_vehicle_profile: true,
    vehicle_without_logbook: true,
    active_jobs_present: true,
    active_asset_review_possible: true,
  },
  source_errors: [],
};

Deno.test("buildNoopEchoAdviceNote creates a non-advisory draft payload over grounded facts", () => {
  const payload: CreateAdviceNoteArgs = buildNoopEchoAdviceNote("org-1", facts);

  assertEquals(payload.p_org, "org-1");
  assertEquals(payload.p_kind, "forecast");
  assertEquals(payload.p_title, "Advisor fact loader check");
  assertEquals(payload.p_citations, []);
  assertEquals(payload.p_assumptions, {
    generated_advice: false,
    purpose: "plumbing_check",
  });
  assertEquals(payload.p_numbers.gross_profit_cents, 13000000);
  assertEquals(
    (payload.p_inputs.profile as AdvisoryFacts["profile"]).entity_type,
    "company",
  );
  assertEquals(
    (payload.p_inputs.latest_bas as AdvisoryFacts["latest_bas"])?.net_gst_cents,
    900000,
  );
  assertEquals(
    (payload.p_inputs.signals as AdvisoryFacts["signals"])
      .vehicle_without_logbook,
    true,
  );
});

Deno.test("buildStructuringAdviceNote echoes the calculator tax_diff_cents into numbers", () => {
  const model = modelStructuring(facts);
  const payload = buildStructuringAdviceNote("org-1", facts, model, {
    text: "Company and trust structures have different tax treatment [1].",
    citations: ["https://www.ato.gov.au/structure"],
  });

  assertEquals(payload.p_org, "org-1");
  assertEquals(payload.p_kind, "structuring");
  assertEquals(payload.p_title, "Structuring tax comparison");
  assertEquals(payload.p_numbers.tax_diff_cents, model.tax_diff_cents);
  assertEquals(payload.p_numbers.best_option, model.best_option);
  assertEquals(payload.p_numbers.options, model.options);
  assertEquals(payload.p_citations, ["https://www.ato.gov.au/structure"]);
  assertEquals(payload.p_inputs.mode, "structuring");
  assertEquals(
    payload.p_inputs.research_text,
    "Company and trust structures have different tax treatment [1].",
  );
  assertEquals(
    (payload.p_assumptions.model_assumptions as string[])[0],
    "Taxable profit is proxied by current-FY gross_profit_cents from v_organization_realtime_pnl.",
  );
});
