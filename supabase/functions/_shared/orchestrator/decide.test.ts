import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type BooksHealthRow,
  type DecideInput,
  decideOrchestratorTasks,
  type OrganizationProfile,
  type TaxCalendarRow,
} from "./decide.ts";

const healthyBooks: BooksHealthRow = {
  score: 92,
  blocking: false,
  uncoded_count: 0,
  unreconciled_count: 0,
  open_period_count: 0,
  coverage_pct: 98,
};

const blockingBooks: BooksHealthRow = {
  score: 64,
  blocking: true,
  uncoded_count: 5,
  unreconciled_count: 12,
  open_period_count: 3,
  coverage_pct: 71,
};

const companyProfile: OrganizationProfile = {
  organization_id: "org-1",
  entity_type: "company",
  employees_count: 4,
};

function obligation(
  overrides: Partial<TaxCalendarRow>,
): TaxCalendarRow {
  return {
    organization_id: "org-1",
    obligation_key: "bas",
    category: "gst",
    title: "BAS Q3 FY2025-26",
    period_label: "Q3 FY2025-26",
    period_start: "2026-01-01",
    period_end: "2026-03-31",
    due_date: "2026-04-28",
    fy_start_year: 2025,
    days_until_due: 8,
    stage: "due_soon",
    status: "due_soon",
    lodgement_id: null,
    lodged_at: null,
    ...overrides,
  };
}

function decide(
  partial: Partial<DecideInput>,
) {
  return decideOrchestratorTasks({
    organization_id: "org-1",
    as_at_date: "2026-04-20",
    tax_calendar: [],
    books_health: healthyBooks,
    profile: companyProfile,
    ...partial,
  });
}

Deno.test("mid-June schedules year-end planning, structure review, forecast, and EOFY pack", () => {
  const result = decide({
    as_at_date: "2026-06-15",
    tax_calendar: [
      obligation({
        obligation_key: "eofy",
        category: "eofy",
        title: "EOFY 2026 wrap-up",
        period_label: "FY2025-26",
        period_start: "2025-07-01",
        period_end: "2026-06-30",
        due_date: "2026-06-30",
        days_until_due: 15,
        stage: "due_soon",
        status: "due_soon",
      }),
    ],
  });

  assertEquals(result.books_health_blocking, false);
  assertEquals(
    result.tasks.map((task) => task.action),
    [
      "prepare_eofy_pack",
      "run_advisor_year_end",
      "run_advisor_structuring",
      "run_advisor_forecast",
    ],
  );
  assertEquals(result.tasks[0]?.priority, "high");
  assertEquals(result.tasks[1]?.period_label, "fy:2025-2026");
});

Deno.test("late July prioritizes overdue STP finalisation ahead of upcoming super", () => {
  const result = decide({
    as_at_date: "2026-07-20",
    tax_calendar: [
      obligation({
        obligation_key: "super",
        category: "super",
        title: "Super Q4 FY2025-26",
        period_label: "Q4 FY2025-26",
        period_start: "2026-04-01",
        period_end: "2026-06-30",
        due_date: "2026-07-28",
        days_until_due: 8,
        stage: "due_soon",
        status: "due_soon",
      }),
    ],
  });

  assertEquals(result.tasks[0]?.action, "finalise_stp");
  assertEquals(result.tasks[0]?.priority, "urgent");
  assertEquals(result.tasks[0]?.due_date, "2026-07-14");
  assertEquals(result.tasks[1]?.action, "prepare_super_batch");
  assertEquals(result.tasks[2]?.action, "run_advisor_forecast");
});

Deno.test("quarter-end BAS due soon selects the BAS preparation engine", () => {
  const result = decide({
    as_at_date: "2026-04-20",
    tax_calendar: [obligation({ days_until_due: 8 })],
  });

  assertEquals(result.tasks[0]?.engine, "bas");
  assertEquals(result.tasks[0]?.action, "prepare_bas");
  assertEquals(result.tasks[0]?.priority, "high");
  assertEquals(result.tasks[0]?.payload.obligation_key, "bas");
});

Deno.test("books-health blocking creates a remediation task and skips books-dependent engines", () => {
  const result = decide({
    as_at_date: "2026-04-20",
    books_health: blockingBooks,
    tax_calendar: [
      obligation({ obligation_key: "bas" }),
      obligation({
        obligation_key: "asic_annual_review",
        category: "asic",
        title: "ASIC annual review FY2025-26",
        period_label: "FY2025-26",
        due_date: "2026-04-21",
        days_until_due: 1,
      }),
    ],
  });

  assertEquals(result.books_health_blocking, true);
  assertEquals(result.tasks[0]?.action, "resolve_books_health");
  assertEquals(result.tasks[1]?.action, "review_asic_annual_statement");
  assert(!result.tasks.some((task) => task.action === "prepare_bas"));
  assert(!result.tasks.some((task) => task.action === "run_advisor_forecast"));
  assertEquals(
    result.skipped.map((skip) => skip.action),
    ["prepare_bas", "run_advisor_forecast"],
  );
});

Deno.test("completed calendar rows are ignored and idempotency keys are deterministic", () => {
  const result = decide({
    as_at_date: "2026-04-20",
    tax_calendar: [
      obligation({
        status: "done",
        stage: "done",
        lodgement_id: "lodgement-1",
      }),
      obligation({
        period_label: "Q4 FY2025-26",
        due_date: "2026-07-28",
        days_until_due: -1,
        stage: "overdue",
        status: "overdue",
      }),
    ],
  });

  assertEquals(result.tasks[0]?.action, "prepare_bas");
  assertEquals(
    result.tasks[0]?.idempotency_key,
    "org-1:bas:Q4 FY2025-26:prepare_bas",
  );
  assertEquals(
    result.tasks.filter((task) => task.action === "prepare_bas").length,
    1,
  );
});
