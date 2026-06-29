import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type BudgetVarianceRow,
  buildCgtAdviceNote,
  buildFbtAdviceNote,
  buildForecastAdviceNote,
  buildNoopEchoAdviceNote,
  buildProfitExtractionAdviceNote,
  buildStructuringAdviceNote,
  buildYearEndAdviceNote,
  type CashFlowForecastRow,
  type CreateAdviceNoteArgs,
  scheduledPeriodForMode,
  selectSeasonalModes,
  summarizeForecast,
} from "./index.ts";
import type { AdvisoryFacts } from "../_shared/advisoryFacts.ts";
import { type CgtDisposalInput, modelCgt } from "../_shared/models/cgt.ts";
import { type FbtScenarioInputs, modelFbt } from "../_shared/models/fbt.ts";
import { modelProfitExtraction } from "../_shared/models/profitExtraction.ts";
import { modelStructuring } from "../_shared/models/structuring.ts";
import { modelYearEnd } from "../_shared/models/yearEnd.ts";

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

Deno.test("summarizeForecast computes runway and largest budget variances", () => {
  const forecastRows: CashFlowForecastRow[] = [
    {
      week_start: "2026-07-06",
      scheduled_invoice_cents: 0,
      scheduled_bill_cents: -2_000,
      recurring_subscription_cents: 0,
      forecast_net_cents: -2_000,
      actual_net_cents: 0,
      variance_cents: -2_000,
    },
    {
      week_start: "2026-07-13",
      scheduled_invoice_cents: 1_000,
      scheduled_bill_cents: -4_000,
      recurring_subscription_cents: 0,
      forecast_net_cents: -3_000,
      actual_net_cents: 0,
      variance_cents: -3_000,
    },
    {
      week_start: "2026-07-20",
      scheduled_invoice_cents: 0,
      scheduled_bill_cents: -4_000,
      recurring_subscription_cents: 0,
      forecast_net_cents: -4_000,
      actual_net_cents: 0,
      variance_cents: -4_000,
    },
  ];
  const budgetRows: BudgetVarianceRow[] = [
    {
      week_start: "2026-07-06",
      budget_cents: 10_000,
      actual_cents: 15_000,
      variance_cents: 5_000,
      job_count: 1,
    },
    {
      week_start: "2026-07-13",
      budget_cents: 20_000,
      actual_cents: 11_000,
      variance_cents: -9_000,
      job_count: 2,
    },
  ];

  const model = summarizeForecast(forecastRows, budgetRows, 10_000);

  assertEquals(model.runway_weeks, 3);
  assertEquals(model.projected_closing_balance_cents, 1_000);
  assertEquals(
    model.largest_budget_variances.map((row) => row.variance_cents),
    [
      -9_000,
      5_000,
    ],
  );
  assertEquals(model.warnings, []);
});

Deno.test("selectSeasonalModes includes year-end and structuring before 30 June only", () => {
  assertEquals(selectSeasonalModes("2026-06-27"), [
    "forecast",
    "year_end",
    "structuring",
  ]);
  assertEquals(selectSeasonalModes("2026-10-15"), ["forecast"]);
});

Deno.test("scheduledPeriodForMode dedupes forecast weekly and seasonal notes by FY", () => {
  assertEquals(
    scheduledPeriodForMode("forecast", "2026-06-27"),
    "week:2026-06-22",
  );
  assertEquals(
    scheduledPeriodForMode("year_end", "2026-06-27"),
    "fy:2025-2026",
  );
  assertEquals(
    scheduledPeriodForMode("structuring", "2026-10-15"),
    "fy:2026-2027",
  );
});

Deno.test("buildForecastAdviceNote echoes runway and largest budget variances into numbers", () => {
  const model = summarizeForecast(
    [
      {
        week_start: "2026-07-06",
        scheduled_invoice_cents: 10_000,
        scheduled_bill_cents: -3_000,
        recurring_subscription_cents: -2_000,
        forecast_net_cents: 5_000,
        actual_net_cents: 3_000,
        variance_cents: 2_000,
      },
    ],
    [
      {
        week_start: "2026-07-06",
        budget_cents: 8_000,
        actual_cents: 11_000,
        variance_cents: 3_000,
        job_count: 1,
      },
    ],
    10_000,
  );
  const payload = buildForecastAdviceNote("org-1", facts, model, {
    text:
      "Cash-flow forecasts should compare expected receipts, payments, and variance drivers [1].",
    citations: ["https://www.ato.gov.au/cash-flow"],
  });

  assertEquals(payload.p_org, "org-1");
  assertEquals(payload.p_kind, "forecast");
  assertEquals(
    payload.p_title,
    "Cash-flow forecast and vCFO variance brief",
  );
  assertEquals(payload.p_numbers.runway_weeks, 1);
  assertEquals(payload.p_numbers.projected_closing_balance_cents, 15_000);
  assertEquals(
    (payload.p_numbers.largest_budget_variances as BudgetVarianceRow[])[0]
      ?.variance_cents,
    3_000,
  );
  assertEquals(payload.p_inputs.mode, "forecast");
  assertEquals(payload.p_citations, ["https://www.ato.gov.au/cash-flow"]);
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

Deno.test("buildYearEndAdviceNote carries every year-end lever into numbers", () => {
  const yearEndFacts = {
    ...facts,
    year_end_inputs: {
      current_concessional_super_cents: 1_000_000,
      planned_asset_purchase_cents: 1_800_000,
      planned_prepayment_cents: 1_200_000,
      deferrable_revenue_cents: 5_000_000,
    },
  };
  const model = modelYearEnd(yearEndFacts, "2026-06-15");
  const payload = buildYearEndAdviceNote("org-1", facts, model, {
    text: "Year-end deductions generally need action before 30 June [1].",
    citations: ["https://www.ato.gov.au/year-end"],
  });

  assertEquals(payload.p_org, "org-1");
  assertEquals(payload.p_kind, "year_end");
  assertEquals(payload.p_title, "Year-end planning levers");
  assertEquals(payload.p_numbers.levers, model.levers);
  assertEquals(payload.p_numbers.total_saving_cents, 2_200_000);
  assertEquals(payload.p_numbers.in_year_end_window, true);
  assertEquals(payload.p_citations, ["https://www.ato.gov.au/year-end"]);
  assertEquals(payload.p_inputs.mode, "year_end");
  assertEquals(
    payload.p_inputs.research_text,
    "Year-end deductions generally need action before 30 June [1].",
  );
});

Deno.test("buildCgtAdviceNote echoes the CGT model headline numbers", () => {
  const disposal: CgtDisposalInput = {
    proceeds_cents: 50_000_000,
    cost_base_cents: 20_000_000,
    acquired_date: "2010-01-01",
    disposal_date: "2026-06-30",
    is_active_asset: true,
    active_asset_years: 16,
    significant_individual_55_or_retiring: true,
  };
  const model = modelCgt(facts, disposal);
  const payload = buildCgtAdviceNote("org-1", facts, disposal, model, {
    text: "Small business CGT concessions depend on basic conditions [1].",
    citations: ["https://www.ato.gov.au/cgt"],
  });

  assertEquals(payload.p_org, "org-1");
  assertEquals(payload.p_kind, "cgt");
  assertEquals(payload.p_title, "CGT concession screen");
  assertEquals(payload.p_numbers.gross_gain_cents, model.gross_gain_cents);
  assertEquals(
    payload.p_numbers.discounted_gain_cents,
    model.discounted_gain_cents,
  );
  assertEquals(payload.p_numbers.flags, model.flags);
  assertEquals(payload.p_inputs.mode, "cgt");
  assertEquals(payload.p_inputs.disposal, disposal);
  assertEquals(payload.p_citations, ["https://www.ato.gov.au/cgt"]);
});

Deno.test("buildFbtAdviceNote echoes the FBT lower-cost method and delta", () => {
  const fbtInputs: FbtScenarioInputs = {
    vehicle_base_value_cents: 6_000_000,
    annual_operating_cost_cents: 1_200_000,
    employee_contribution_cents: 0,
    is_electric_vehicle: false,
    work_vehicle_private_use_limited: false,
  };
  const fbtFacts: AdvisoryFacts & { fbt_inputs: FbtScenarioInputs } = {
    ...facts,
    fbt_inputs: fbtInputs,
  };
  const model = modelFbt(fbtFacts);
  const payload = buildFbtAdviceNote("org-1", facts, fbtInputs, model, {
    text:
      "FBT car benefits can be calculated using statutory formula or operating cost methods [1].",
    citations: ["https://www.ato.gov.au/fbt"],
  });

  assertEquals(payload.p_org, "org-1");
  assertEquals(payload.p_kind, "fbt");
  assertEquals(payload.p_title, "FBT strategy comparison");
  assertEquals(payload.p_numbers.lower_cost_method, "operating_cost");
  assertEquals(payload.p_numbers.fbt_delta_cents, 938_586);
  assertEquals(payload.p_numbers.operating_cost, model.operating_cost);
  assertEquals(payload.p_inputs.mode, "fbt");
  assertEquals(payload.p_inputs.fbt_inputs, fbtInputs);
  assertEquals(payload.p_citations, ["https://www.ato.gov.au/fbt"]);
});

Deno.test("buildProfitExtractionAdviceNote echoes the recommended strategy and tax result", () => {
  const model = modelProfitExtraction(facts);
  const payload = buildProfitExtractionAdviceNote("org-1", facts, model, {
    text:
      "Owner wages, franked dividends, and trust distributions have different tax mechanics [1].",
    citations: ["https://www.ato.gov.au/profit-extraction"],
  });

  assertEquals(payload.p_org, "org-1");
  assertEquals(payload.p_kind, "profit_extraction");
  assertEquals(payload.p_title, "Profit extraction comparison");
  assertEquals(
    payload.p_numbers.profit_available_cents,
    model.profit_available_cents,
  );
  assertEquals(
    payload.p_numbers.recommended_strategy,
    model.recommended_strategy,
  );
  assertEquals(
    payload.p_numbers.recommended_total_tax_cents,
    model.recommended_total_tax_cents,
  );
  assertEquals(payload.p_numbers.options, model.options);
  assertEquals(payload.p_inputs.mode, "profit_extraction");
  assertEquals(payload.p_citations, [
    "https://www.ato.gov.au/profit-extraction",
  ]);
});
