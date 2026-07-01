// Pure accountant-orchestrator decision engine (SC-7.I.01).
//
// Inputs are plain rows loaded by the future cron wrapper: v_tax_calendar,
// v_books_health, and business_profile. This module does no I/O and can be
// deterministically tested without Supabase, cron, or edge-function runtime.

export type OrchestratorPriority = "urgent" | "high" | "normal" | "low";

export type OrchestratorTaskSource =
  | "books_health"
  | "tax_calendar"
  | "seasonal";

export interface TaxCalendarRow {
  organization_id: string;
  obligation_key: string;
  category: string;
  title: string;
  period_label: string;
  period_start: string;
  period_end: string;
  due_date: string;
  fy_start_year: number;
  days_until_due: number;
  stage: string;
  status: string;
  lodgement_id?: string | null;
  lodged_at?: string | null;
}

export interface BooksHealthRow {
  score: number;
  blocking: boolean;
  uncoded_count: number;
  unreconciled_count: number;
  open_period_count: number;
  coverage_pct: number;
}

export interface OrganizationProfile {
  organization_id: string;
  entity_type: string | null;
  employees_count?: number | null;
}

export interface DecideInput {
  organization_id: string;
  as_at_date: string | Date;
  tax_calendar: TaxCalendarRow[];
  books_health: BooksHealthRow | null;
  profile: OrganizationProfile | null;
}

export interface OrchestratorTask {
  engine: string;
  action: string;
  priority: OrchestratorPriority;
  title: string;
  reason: string;
  source: OrchestratorTaskSource;
  due_date: string | null;
  period_label: string | null;
  idempotency_key: string;
  payload: Record<string, unknown>;
}

export interface SkippedTask {
  source: OrchestratorTaskSource;
  engine: string;
  action: string;
  obligation_key?: string;
  period_label?: string;
  reason: string;
}

export interface OrchestratorDecision {
  organization_id: string;
  as_at_date: string;
  books_health_blocking: boolean;
  tasks: OrchestratorTask[];
  skipped: SkippedTask[];
}

interface ObligationMapping {
  engine: string;
  action: string;
  title: (row: TaxCalendarRow) => string;
  route: string;
  requiresCleanBooks: boolean;
}

const COMPLETED_STATUSES = new Set([
  "accepted",
  "done",
  "lodged",
  "paid",
]);

const PRIORITY_RANK: Record<OrchestratorPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

const OBLIGATION_MAPPINGS: Record<string, ObligationMapping> = {
  bas: {
    engine: "bas",
    action: "prepare_bas",
    title: (row) => `Prepare ${row.title}`,
    route: "/reports/bas",
    requiresCleanBooks: true,
  },
  super: {
    engine: "super",
    action: "prepare_super_batch",
    title: (row) => `Prepare ${row.title}`,
    route: "/payroll",
    requiresCleanBooks: false,
  },
  tpar: {
    engine: "tpar",
    action: "prepare_tpar",
    title: (row) => `Prepare ${row.title}`,
    route: "/reports/tpar",
    requiresCleanBooks: true,
  },
  fbt: {
    engine: "fbt",
    action: "prepare_fbt_return",
    title: (row) => `Prepare ${row.title}`,
    route: "/reports",
    requiresCleanBooks: true,
  },
  fbt_instalment: {
    engine: "fbt",
    action: "prepare_fbt_instalment",
    title: (row) => `Prepare ${row.title}`,
    route: "/reports",
    requiresCleanBooks: true,
  },
  income_tax: {
    engine: "income_tax",
    action: "prepare_income_tax_return",
    title: (row) => `Prepare ${row.title}`,
    route: "/reports/tax-return",
    requiresCleanBooks: true,
  },
  eofy: {
    engine: "eofy",
    action: "prepare_eofy_pack",
    title: (row) => `Prepare ${row.title}`,
    route: "/reports/eofy",
    requiresCleanBooks: true,
  },
  workcover: {
    engine: "workcover",
    action: "prepare_workcover_declaration",
    title: (row) => `Prepare ${row.title}`,
    route: "/reports",
    requiresCleanBooks: true,
  },
  payroll_tax: {
    engine: "payroll_tax",
    action: "prepare_payroll_tax",
    title: (row) => `Prepare ${row.title}`,
    route: "/payroll",
    requiresCleanBooks: false,
  },
  asic_annual_review: {
    engine: "asic",
    action: "review_asic_annual_statement",
    title: (row) => `Review ${row.title}`,
    route: "/settings/audit-log",
    requiresCleanBooks: false,
  },
  tbar: {
    engine: "smsf",
    action: "prepare_tbar",
    title: (row) => `Prepare ${row.title}`,
    route: "/smsf",
    requiresCleanBooks: true,
  },
  trust_distribution: {
    engine: "trust",
    action: "prepare_trust_distribution_resolution",
    title: (row) => `Prepare ${row.title}`,
    route: "/trusts",
    requiresCleanBooks: true,
  },
};

export function decideOrchestratorTasks(
  input: DecideInput,
): OrchestratorDecision {
  const asAt = parseAsAtDate(input.as_at_date);
  const asAtDate = isoDate(asAt);
  const blocking = input.books_health?.blocking === true;
  const tasks: OrchestratorTask[] = [];
  const skipped: SkippedTask[] = [];

  if (blocking && input.books_health) {
    tasks.push(booksHealthTask(input.organization_id, input.books_health));
  }

  for (
    const row of dueCalendarRows(input.tax_calendar, input.organization_id)
  ) {
    const mapping = OBLIGATION_MAPPINGS[row.obligation_key];
    if (!mapping) {
      // A due obligation with no engine mapping must not vanish silently — surface it
      // as skipped so it shows up for review instead of being dropped without a trace.
      skipped.push({
        source: "tax_calendar",
        engine: "unknown",
        action: "unmapped_obligation",
        obligation_key: row.obligation_key,
        period_label: row.period_label,
        reason: `No engine mapping for obligation_key '${row.obligation_key}'.`,
      });
      continue;
    }
    if (blocking && mapping.requiresCleanBooks) {
      skipped.push({
        source: "tax_calendar",
        engine: mapping.engine,
        action: mapping.action,
        obligation_key: row.obligation_key,
        period_label: row.period_label,
        reason:
          "Skipped because books-health is blocking and this engine depends on clean books.",
      });
      continue;
    }
    tasks.push(calendarTask(input.organization_id, row, mapping));
  }

  tasks.push(
    ...seasonalTasks(
      input.organization_id,
      asAt,
      input.profile,
      blocking,
      skipped,
    ),
  );

  return {
    organization_id: input.organization_id,
    as_at_date: asAtDate,
    books_health_blocking: blocking,
    tasks: sortTasks(tasks),
    skipped,
  };
}

function dueCalendarRows(
  rows: TaxCalendarRow[],
  organizationId: string,
): TaxCalendarRow[] {
  return rows.filter((row) =>
    row.organization_id === organizationId &&
    !COMPLETED_STATUSES.has(row.status) &&
    !COMPLETED_STATUSES.has(row.stage) &&
    (row.stage === "overdue" || row.stage === "due_soon" ||
      row.days_until_due <= 0)
  );
}

function calendarTask(
  organizationId: string,
  row: TaxCalendarRow,
  mapping: ObligationMapping,
): OrchestratorTask {
  const priority = priorityForCalendarRow(row);
  return {
    engine: mapping.engine,
    action: mapping.action,
    priority,
    title: mapping.title(row),
    reason: `${row.status} obligation due ${row.due_date}`,
    source: "tax_calendar",
    due_date: row.due_date,
    period_label: row.period_label,
    idempotency_key:
      `${organizationId}:${row.obligation_key}:${row.period_label}:${mapping.action}`,
    payload: {
      organization_id: organizationId,
      obligation_key: row.obligation_key,
      category: row.category,
      period_label: row.period_label,
      period_start: row.period_start,
      period_end: row.period_end,
      due_date: row.due_date,
      stage: row.stage,
      status: row.status,
      route: mapping.route,
    },
  };
}

function booksHealthTask(
  organizationId: string,
  booksHealth: BooksHealthRow,
): OrchestratorTask {
  return {
    engine: "books_health",
    action: "resolve_books_health",
    priority: "urgent",
    title: "Resolve books-health blockers",
    reason:
      `Books-health score ${booksHealth.score} is blocking downstream engines.`,
    source: "books_health",
    due_date: null,
    period_label: null,
    idempotency_key: `${organizationId}:books_health:resolve`,
    payload: {
      organization_id: organizationId,
      score: booksHealth.score,
      uncoded_count: booksHealth.uncoded_count,
      unreconciled_count: booksHealth.unreconciled_count,
      open_period_count: booksHealth.open_period_count,
      coverage_pct: booksHealth.coverage_pct,
      route: "/quality",
    },
  };
}

function seasonalTasks(
  organizationId: string,
  asAt: Date,
  profile: OrganizationProfile | null,
  booksHealthBlocking: boolean,
  skipped: SkippedTask[],
): OrchestratorTask[] {
  const tasks: OrchestratorTask[] = [];
  const asAtDate = isoDate(asAt);

  if (employeeCount(profile) > 0 && asAt.getUTCMonth() === 6) {
    const dueDate = `${asAt.getUTCFullYear()}-07-14`;
    const overdue = asAtDate > dueDate;
    tasks.push({
      engine: "payroll",
      action: "finalise_stp",
      priority: overdue ? "urgent" : "high",
      title: "Finalise STP for payroll year",
      reason: overdue
        ? `STP finalisation was due ${dueDate}`
        : `STP finalisation is due ${dueDate}`,
      source: "seasonal",
      due_date: dueDate,
      period_label: `FY${asAt.getUTCFullYear() - 1}-${
        String(asAt.getUTCFullYear()).slice(2)
      }`,
      idempotency_key: `${organizationId}:stp_finalisation:${dueDate}`,
      payload: {
        organization_id: organizationId,
        route: "/payroll",
      },
    });
  }

  const advisoryModes = seasonalAdvisoryModes(asAt, profile);
  for (const mode of advisoryModes) {
    if (booksHealthBlocking) {
      skipped.push({
        source: "seasonal",
        engine: "advisor",
        action: `run_advisor_${mode}`,
        reason:
          "Skipped because books-health is blocking and advisory engines need grounded current books.",
      });
      continue;
    }
    tasks.push(advisoryTask(organizationId, mode, asAt));
  }

  return tasks;
}

function advisoryTask(
  organizationId: string,
  mode: "forecast" | "structuring" | "year_end",
  asAt: Date,
): OrchestratorTask {
  const period = mode === "forecast"
    ? `week:${isoWeekStart(asAt)}`
    : `fy:${fyLabel(asAt)}`;
  const title = mode === "forecast"
    ? "Refresh cash-flow forecast"
    : mode === "year_end"
    ? "Run year-end planning review"
    : "Run structure review";
  return {
    engine: "advisor",
    action: `run_advisor_${mode}`,
    priority: mode === "forecast" ? "low" : "normal",
    title,
    reason: mode === "forecast"
      ? "Weekly advisory cadence"
      : "June year-end advisory cadence",
    source: "seasonal",
    due_date: null,
    period_label: period,
    idempotency_key: `${organizationId}:advisor:${mode}:${period}`,
    payload: {
      organization_id: organizationId,
      mode,
      scheduled_period: period,
      route: "/settings/audit-log",
    },
  };
}

function seasonalAdvisoryModes(
  asAt: Date,
  profile: OrganizationProfile | null,
): ("forecast" | "structuring" | "year_end")[] {
  const modes: ("forecast" | "structuring" | "year_end")[] = ["forecast"];
  if (asAt.getUTCMonth() === 5 && asAt.getUTCDate() <= 30) {
    modes.push("year_end");
    if (profile?.entity_type !== "smsf") modes.push("structuring");
  }
  return modes;
}

function priorityForCalendarRow(row: TaxCalendarRow): OrchestratorPriority {
  if (row.stage === "overdue" || row.days_until_due < 0) return "urgent";
  if (row.stage === "due_soon" || row.days_until_due <= 7) return "high";
  return "normal";
}

function sortTasks(tasks: OrchestratorTask[]): OrchestratorTask[] {
  return [...tasks].sort((a, b) =>
    taskSortRank(a) - taskSortRank(b) ||
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
    dateSortValue(a.due_date) - dateSortValue(b.due_date) ||
    sourceSortRank(a.source) - sourceSortRank(b.source) ||
    a.engine.localeCompare(b.engine)
  );
}

function taskSortRank(task: OrchestratorTask): number {
  if (task.source === "books_health") return 0;
  return 1;
}

function sourceSortRank(source: OrchestratorTaskSource): number {
  if (source === "tax_calendar") return 0;
  if (source === "seasonal") return 1;
  return 2;
}

function dateSortValue(value: string | null): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  return Date.parse(`${value}T00:00:00Z`);
}

function employeeCount(profile: OrganizationProfile | null): number {
  return Math.max(0, Math.trunc(Number(profile?.employees_count ?? 0)));
}

function parseAsAtDate(value: Date | string): Date {
  const date = value instanceof Date
    ? new Date(value.getTime())
    : new Date(value.length <= 10 ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("as_at_date must be a valid ISO date");
  }
  return date;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isoWeekStart(date: Date): string {
  const copy = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  ));
  const day = copy.getUTCDay() || 7;
  copy.setUTCDate(copy.getUTCDate() - day + 1);
  return isoDate(copy);
}

function fyLabel(date: Date): string {
  const startYear = date.getUTCMonth() >= 6
    ? date.getUTCFullYear()
    : date.getUTCFullYear() - 1;
  return `${startYear}-${startYear + 1}`;
}
