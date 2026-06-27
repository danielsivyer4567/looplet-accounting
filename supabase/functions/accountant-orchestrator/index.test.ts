import {
  assert,
  assertEquals,
  assertMatch,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type BooksHealthRow,
  decideOrchestratorTasks,
  type OrganizationProfile,
  type TaxCalendarRow,
} from "../_shared/orchestrator/decide.ts";
import {
  emitDecisionNotifications,
  stableUuidFromString,
  type TaskNotification,
  taskToNotification,
} from "./index.ts";

const healthyBooks: BooksHealthRow = {
  score: 95,
  blocking: false,
  uncoded_count: 0,
  unreconciled_count: 0,
  open_period_count: 0,
  coverage_pct: 99,
};

const profile: OrganizationProfile = {
  organization_id: "org-1",
  entity_type: "company",
  employees_count: 3,
};

function obligation(overrides: Partial<TaxCalendarRow> = {}): TaxCalendarRow {
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

Deno.test("stableUuidFromString returns deterministic UUID-shaped values", () => {
  const first = stableUuidFromString("org-1:bas:Q3 FY2025-26:prepare_bas");
  const again = stableUuidFromString("org-1:bas:Q3 FY2025-26:prepare_bas");
  const different = stableUuidFromString(
    "org-1:super:Q4 FY2025-26:prepare_super_batch",
  );

  assertEquals(first, again);
  assert(first !== different);
  assertMatch(
    first,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
});

Deno.test("taskToNotification maps urgency, route, metadata, and deterministic resource id", () => {
  const decision = decideOrchestratorTasks({
    organization_id: "org-1",
    as_at_date: "2026-04-29",
    tax_calendar: [
      obligation({
        days_until_due: -1,
        stage: "overdue",
        status: "overdue",
      }),
    ],
    books_health: healthyBooks,
    profile,
  });

  const basTask = decision.tasks.find((task) => task.action === "prepare_bas");
  assert(basTask);
  const notification = taskToNotification(basTask);

  assertEquals(notification.category, "orchestrator_task");
  assertEquals(notification.severity, "error");
  assertEquals(notification.link, "/reports/bas");
  assertEquals(notification.resource_type, "orchestrator_task");
  assertEquals(
    notification.resource_id,
    stableUuidFromString("org-1:bas:Q3 FY2025-26:prepare_bas"),
  );
  assertEquals(notification.metadata.engine, "bas");
  assertEquals(notification.metadata.action, "prepare_bas");
  assertEquals(notification.metadata.priority, "urgent");
  assertEquals(notification.metadata.due_date, "2026-04-28");
});

Deno.test("emitDecisionNotifications dedupes repeated simulated cron sweeps by resource id", async () => {
  const decision = decideOrchestratorTasks({
    organization_id: "org-1",
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
      }),
    ],
    books_health: healthyBooks,
    profile,
  });

  const seen = new Set<string>();
  const emitted: TaskNotification[] = [];
  const emit = (
    orgId: string,
    notification: TaskNotification,
  ): Promise<number> => {
    const key = `${orgId}:${notification.category}:${notification.resource_id}`;
    if (seen.has(key)) return Promise.resolve(0);
    seen.add(key);
    emitted.push(notification);
    return Promise.resolve(1);
  };

  const first = await emitDecisionNotifications("org-1", decision, emit);
  const second = await emitDecisionNotifications("org-1", decision, emit);

  assertEquals(
    decision.tasks.map((task) => task.action),
    ["finalise_stp", "prepare_super_batch", "run_advisor_forecast"],
  );
  assertEquals(first.task_count, 3);
  assertEquals(first.emitted, 3);
  assertEquals(first.skipped_count, 0);
  assertEquals(second.task_count, 3);
  assertEquals(second.emitted, 0);
  assertEquals(emitted.map((notification) => notification.title), [
    "Finalise STP for payroll year",
    "Prepare Super Q4 FY2025-26",
    "Refresh cash-flow forecast",
  ]);
});
