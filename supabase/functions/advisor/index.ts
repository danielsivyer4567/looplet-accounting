// advisor (SC-6.B.02+)
//
// Proactive advisory engine entrypoint. Loads grounded org facts, runs a
// selected pure advisory model, emits a draft advice_note via the SC-6.A.02
// RPC, and returns the note id. No recommendation is acted on here; lodgement,
// payment, registered-agent sign-off, and outward sends remain separate gates.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  type AdviceCitationResult,
  citeForAdvice,
} from "../_shared/advisoryCite.ts";
import { enforceAiQuota } from "../_shared/aiRateLimit.ts";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { presentedCronSecret } from "../_shared/cronSecret.ts";
import { requireEnv } from "../_shared/env.ts";
import { supabaseOrgAccessDeps } from "../_shared/orgRole.ts";
import {
  type AdvisoryFacts,
  type AdvisoryFactsClient,
  type AdvisoryFactsQuery,
  loadAdvisoryFacts,
} from "../_shared/advisoryFacts.ts";
import {
  type CgtDisposalInput,
  type CgtModelResult,
  modelCgt,
} from "../_shared/models/cgt.ts";
import {
  type FbtModelResult,
  type FbtScenarioInputs,
  modelFbt,
} from "../_shared/models/fbt.ts";
import {
  modelProfitExtraction,
  type ProfitExtractionModelResult,
} from "../_shared/models/profitExtraction.ts";
import {
  modelStructuring,
  type StructuringModelResult,
} from "../_shared/models/structuring.ts";
import {
  modelYearEnd,
  type YearEndModelResult,
} from "../_shared/models/yearEnd.ts";

export type AdvisorMode =
  | "noop_echo"
  | "scheduled"
  | "forecast"
  | "structuring"
  | "year_end"
  | "cgt"
  | "fbt"
  | "profit_extraction";
export type AdviceNoteKind =
  | "forecast"
  | "structuring"
  | "year_end"
  | "cgt"
  | "fbt"
  | "profit_extraction";

export interface AdvisorRequestBody {
  organization_id?: string;
  mode?: AdvisorMode;
  as_at_date?: string;
  cgt_disposal?: CgtDisposalInput;
  fbt_inputs?: FbtScenarioInputs;
}

export interface CreateAdviceNoteArgs {
  p_org: string;
  p_kind: AdviceNoteKind;
  p_title: string;
  p_summary: string;
  p_inputs: Record<string, unknown>;
  p_numbers: Record<string, unknown>;
  p_assumptions: Record<string, unknown>;
  p_citations: unknown[];
  p_disclaimer: string;
}

interface SupabaseErrorLike {
  message: string;
}

interface SupabaseQueryResultLike {
  data: unknown;
  error: SupabaseErrorLike | null;
}

interface SupabaseQueryFilterLike extends PromiseLike<SupabaseQueryResultLike> {
  select(columns: string): SupabaseQueryFilterLike;
  eq(column: string, value: unknown): SupabaseQueryFilterLike;
  contains(column: string, value: Record<string, unknown>): SupabaseQueryFilterLike;
  is(column: string, value: unknown): SupabaseQueryFilterLike;
  order(column: string, options?: { ascending?: boolean }): SupabaseQueryFilterLike;
  limit(count: number): SupabaseQueryFilterLike;
  single(): Promise<SupabaseQueryResultLike>;
  maybeSingle(): Promise<SupabaseQueryResultLike>;
}

interface SupabaseQueryBuilderLike {
  select(columns: string): SupabaseQueryFilterLike;
  update(values: Record<string, unknown>): SupabaseQueryFilterLike;
  insert(values: Record<string, unknown>): SupabaseQueryFilterLike;
}

interface SupabaseClientLike {
  from(relation: string): SupabaseQueryBuilderLike;
}

interface ExistingAdviceNoteRow {
  id: string;
  status: string;
}

const SUPPORTED_MODES: readonly AdvisorMode[] = [
  "noop_echo",
  "scheduled",
  "forecast",
  "structuring",
  "year_end",
  "cgt",
  "fbt",
  "profit_extraction",
];

const GENERAL_ADVICE_DISCLAIMER =
  "General information only; not tax, legal, or financial advice. Review with a registered agent before acting.";

type ScenarioAdvisorMode = Exclude<AdvisorMode, "scheduled">;

export interface ScheduledAdviceResult {
  kind: AdviceNoteKind;
  period: string;
  action: "inserted" | "updated_draft" | "kept_existing";
  advice_note_id: string | null;
}

export interface LegalHorizonSignal {
  id: string;
  title: string;
  summary: string | null;
  topic: string | null;
  stage: string;
  confidence: number;
  proposed_effective_from: string | null;
  source_url: string | null;
  source_excerpt: string | null;
}

interface LegalHorizonLoadResult {
  signals: LegalHorizonSignal[];
  source_errors: string[];
}

export function selectSeasonalModes(
  asAt: Date | string = new Date(),
): AdviceNoteKind[] {
  const date = parseAsAtDate(asAt);
  const modes: AdviceNoteKind[] = ["forecast"];
  if (isJuneYearEndWindow(date)) {
    modes.push("year_end", "structuring");
  }
  return modes;
}

export function scheduledPeriodForMode(
  mode: AdviceNoteKind,
  asAt: Date | string = new Date(),
): string {
  const date = parseAsAtDate(asAt);
  if (mode === "forecast") return `week:${isoWeekStart(date)}`;
  return `fy:${fyLabel(date)}`;
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

function isJuneYearEndWindow(date: Date): boolean {
  return date.getUTCMonth() === 5 && date.getUTCDate() <= 30;
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

/** Constant-time string compare; false on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function legalHorizonSignal(row: Record<string, unknown>): LegalHorizonSignal {
  return {
    id: String(row.id ?? ""),
    title: String(row.title ?? "Untitled legal horizon item"),
    summary: typeof row.summary === "string" ? row.summary : null,
    topic: typeof row.topic === "string" ? row.topic : null,
    stage: String(row.stage ?? "announced"),
    confidence: Math.max(0, Math.min(1, Number(row.confidence ?? 0))),
    proposed_effective_from:
      typeof row.proposed_effective_from === "string"
        ? row.proposed_effective_from
        : null,
    source_url: typeof row.source_url === "string" ? row.source_url : null,
    source_excerpt: typeof row.source_excerpt === "string"
      ? row.source_excerpt
      : null,
  };
}

export async function loadLegalHorizonSignals(
  admin: SupabaseClientLike,
): Promise<LegalHorizonLoadResult> {
  const { data, error } = await admin
    .from("legal_horizon")
    .select(
      "id,title,summary,topic,stage,confidence,proposed_effective_from,source_url,source_excerpt",
    )
    .eq("status", "open")
    .is("deleted_at", null)
    .order("proposed_effective_from", { ascending: true })
    .limit(8);

  if (error) {
    return {
      signals: [],
      source_errors: [`legal_horizon: ${error.message}`],
    };
  }

  return {
    signals: Array.isArray(data)
      ? data.map((row) => legalHorizonSignal(row as Record<string, unknown>))
      : [],
    source_errors: [],
  };
}

export function attachLegalHorizonContext(
  noteArgs: CreateAdviceNoteArgs,
  signals: LegalHorizonSignal[],
): CreateAdviceNoteArgs {
  if (signals.length === 0) return noteArgs;

  const items = signals.map((signal) => ({
    id: signal.id,
    title: signal.title,
    summary: signal.summary,
    topic: signal.topic,
    stage: signal.stage,
    confidence: signal.confidence,
    proposed_effective_from: signal.proposed_effective_from,
    source_url: signal.source_url,
  }));

  return {
    ...noteArgs,
    p_inputs: {
      ...noteArgs.p_inputs,
      legal_horizon: {
        source: "legal_horizon",
        status: "proposal_context_only",
        items,
      },
    },
    p_numbers: {
      ...noteArgs.p_numbers,
      legal_horizon_open_count: items.length,
    },
    p_assumptions: {
      ...noteArgs.p_assumptions,
      legal_horizon_notice:
        "Legal-horizon rows are proposed or pending changes only. They are not enacted-law citations and require registered-agent review before action.",
    },
  };
}

export interface CashFlowForecastRow {
  week_start: string;
  scheduled_invoice_cents: number;
  scheduled_bill_cents: number;
  recurring_subscription_cents: number;
  forecast_net_cents: number;
  actual_net_cents: number;
  variance_cents: number;
}

export interface BudgetVarianceRow {
  week_start: string;
  budget_cents: number;
  actual_cents: number;
  variance_cents: number;
  job_count: number;
}

export interface ForecastModelResult {
  opening_balance_cents: number;
  runway_weeks: number;
  projected_closing_balance_cents: number;
  forecast_rows: CashFlowForecastRow[];
  largest_budget_variances: BudgetVarianceRow[];
  warnings: string[];
}

function money(cents: number): string {
  return `$${
    (cents / 100).toLocaleString("en-AU", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })
  }`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function requireUuidish(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} required`);
  }
  return value.trim();
}

function numberField(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} required`);
  }
  return value.trim();
}

function booleanField(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be true or false`);
  }
  return value;
}

function optionalNumberField(value: unknown, field: string): number | null {
  if (value == null) return null;
  return numberField(value, field);
}

function optionalBooleanField(value: unknown, field: string): boolean | null {
  if (value == null) return null;
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be true or false`);
  }
  return value;
}

function requireCgtDisposal(value: unknown): CgtDisposalInput {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("cgt_disposal required for cgt mode");
  }
  const row = value as Record<string, unknown>;
  return {
    proceeds_cents: numberField(
      row.proceeds_cents,
      "cgt_disposal.proceeds_cents",
    ),
    cost_base_cents: numberField(
      row.cost_base_cents,
      "cgt_disposal.cost_base_cents",
    ),
    acquired_date: stringField(row.acquired_date, "cgt_disposal.acquired_date"),
    disposal_date: stringField(row.disposal_date, "cgt_disposal.disposal_date"),
    is_active_asset: booleanField(
      row.is_active_asset,
      "cgt_disposal.is_active_asset",
    ),
    active_asset_years: optionalNumberField(
      row.active_asset_years,
      "cgt_disposal.active_asset_years",
    ),
    net_asset_value_cents: optionalNumberField(
      row.net_asset_value_cents,
      "cgt_disposal.net_asset_value_cents",
    ),
    significant_individual_55_or_retiring: optionalBooleanField(
      row.significant_individual_55_or_retiring,
      "cgt_disposal.significant_individual_55_or_retiring",
    ),
  };
}

function advisoryFactsClient(client: {
  from(relation: string): { select(columns: string): unknown };
}): AdvisoryFactsClient {
  return {
    from(relation: string) {
      return {
        select(columns: string): AdvisoryFactsQuery {
          return client.from(relation).select(columns) as AdvisoryFactsQuery;
        },
      };
    },
  };
}

function recordRows(data: unknown): Record<string, unknown>[] {
  return Array.isArray(data)
    ? data.filter((row): row is Record<string, unknown> =>
      row !== null && typeof row === "object" && !Array.isArray(row)
    )
    : [];
}

function numberOrZero(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function forecastRowsFrom(data: unknown): CashFlowForecastRow[] {
  return recordRows(data).map((row) => ({
    week_start: stringOrEmpty(row.week_start),
    scheduled_invoice_cents: numberOrZero(row.scheduled_invoice_cents),
    scheduled_bill_cents: numberOrZero(row.scheduled_bill_cents),
    recurring_subscription_cents: numberOrZero(
      row.recurring_subscription_cents,
    ),
    forecast_net_cents: numberOrZero(row.forecast_net_cents),
    actual_net_cents: numberOrZero(row.actual_net_cents),
    variance_cents: numberOrZero(row.variance_cents),
  })).filter((row) => row.week_start.length > 0);
}

function budgetVarianceRowsFrom(data: unknown): BudgetVarianceRow[] {
  return recordRows(data).map((row) => ({
    week_start: stringOrEmpty(row.week_start),
    budget_cents: numberOrZero(row.budget_cents),
    actual_cents: numberOrZero(row.actual_cents),
    variance_cents: numberOrZero(row.variance_cents),
    job_count: numberOrZero(row.job_count),
  })).filter((row) => row.week_start.length > 0);
}

function openingBalanceCentsFrom(data: unknown): number {
  return recordRows(data).reduce(
    (sum, row) => sum + numberOrZero(row.current_balance_cents),
    0,
  );
}

export function summarizeForecast(
  forecastRows: CashFlowForecastRow[],
  budgetRows: BudgetVarianceRow[],
  openingBalanceCents: number,
): ForecastModelResult {
  const sortedForecast = [...forecastRows].sort((a, b) =>
    a.week_start.localeCompare(b.week_start)
  );
  const sortedBudgetVariances = [...budgetRows]
    .sort((a, b) =>
      Math.abs(b.variance_cents) - Math.abs(a.variance_cents) ||
      a.week_start.localeCompare(b.week_start)
    )
    .slice(0, 5);
  const warnings: string[] = [];
  if (sortedForecast.length === 0) {
    warnings.push(
      "v_cash_flow_forecast returned no rows for this organization",
    );
  }

  let running = openingBalanceCents;
  let runwayWeeks = 0;
  for (const row of sortedForecast) {
    running += row.forecast_net_cents;
    if (running < 0) break;
    runwayWeeks += 1;
  }
  const projectedClosingBalance = sortedForecast.reduce(
    (balance, row) => balance + row.forecast_net_cents,
    openingBalanceCents,
  );

  return {
    opening_balance_cents: openingBalanceCents,
    runway_weeks: runwayWeeks,
    projected_closing_balance_cents: projectedClosingBalance,
    forecast_rows: sortedForecast,
    largest_budget_variances: sortedBudgetVariances,
    warnings,
  };
}

export function buildNoopEchoAdviceNote(
  organizationId: string,
  facts: AdvisoryFacts,
): CreateAdviceNoteArgs {
  return {
    p_org: organizationId,
    p_kind: "forecast",
    p_title: "Advisor fact loader check",
    p_summary:
      "No recommendation generated. This draft confirms the advisor fact loader can read the org profile, financial snapshot, latest BAS quarter, and advisory signals.",
    p_inputs: {
      mode: "noop_echo",
      profile: facts.profile,
      latest_bas: facts.latest_bas,
      signals: facts.signals,
      source_errors: facts.source_errors,
    },
    p_numbers: facts.financials,
    p_assumptions: {
      generated_advice: false,
      purpose: "plumbing_check",
    },
    p_citations: [],
    p_disclaimer: GENERAL_ADVICE_DISCLAIMER,
  };
}

export function buildForecastAdviceNote(
  organizationId: string,
  facts: AdvisoryFacts,
  model: ForecastModelResult,
  citation: AdviceCitationResult,
): CreateAdviceNoteArgs {
  const largestVariance = model.largest_budget_variances[0];
  const varianceLine = largestVariance
    ? `Largest budget variance: ${largestVariance.week_start} at ${
      money(largestVariance.variance_cents)
    }.`
    : "No job budget variance rows were available.";
  const summary = [
    `vCFO cash-flow forecast: runway is ${model.runway_weeks} weeks from an opening balance of ${
      money(model.opening_balance_cents)
    }.`,
    `Projected closing balance across the forecast horizon: ${
      money(model.projected_closing_balance_cents)
    }.`,
    varianceLine,
    citation.text ? `Research context: ${citation.text}` : null,
  ].filter((line): line is string => line !== null).join("\n\n");

  return {
    p_org: organizationId,
    p_kind: "forecast",
    p_title: "Cash-flow forecast and vCFO variance brief",
    p_summary: summary,
    p_inputs: {
      mode: "forecast",
      current_entity_type: facts.profile.entity_type,
      profile: facts.profile,
      signals: facts.signals,
      source_errors: facts.source_errors,
      research_text: citation.text,
    },
    p_numbers: {
      opening_balance_cents: model.opening_balance_cents,
      runway_weeks: model.runway_weeks,
      projected_closing_balance_cents: model.projected_closing_balance_cents,
      forecast_rows: model.forecast_rows,
      largest_budget_variances: model.largest_budget_variances,
    },
    p_assumptions: {
      forecast_horizon: "current week plus 12 future weeks",
      model_warnings: model.warnings,
    },
    p_citations: citation.citations,
    p_disclaimer: GENERAL_ADVICE_DISCLAIMER,
  };
}

export function buildStructuringAdviceNote(
  organizationId: string,
  facts: AdvisoryFacts,
  model: StructuringModelResult,
  citation: AdviceCitationResult,
): CreateAdviceNoteArgs {
  const best = model.options[model.best_option];
  const summary = [
    `Simple current-FY structure comparison: lowest modelled tax is ${best.label} at ${
      money(best.tax_cents)
    }.`,
    `Potential difference versus sole trader: ${money(model.tax_diff_cents)}.`,
    citation.text ? `Research context: ${citation.text}` : null,
  ].filter((line): line is string => line !== null).join("\n\n");

  return {
    p_org: organizationId,
    p_kind: "structuring",
    p_title: "Structuring tax comparison",
    p_summary: summary,
    p_inputs: {
      mode: "structuring",
      current_entity_type: facts.profile.entity_type,
      profile: facts.profile,
      signals: facts.signals,
      source_errors: facts.source_errors,
      research_text: citation.text,
    },
    p_numbers: {
      taxable_profit_cents: model.taxable_profit_cents,
      tax_diff_cents: model.tax_diff_cents,
      best_option: model.best_option,
      options: model.options,
    },
    p_assumptions: {
      as_at_fy: model.as_at_fy,
      model_assumptions: model.assumptions,
      model_warnings: model.warnings,
    },
    p_citations: citation.citations,
    p_disclaimer: GENERAL_ADVICE_DISCLAIMER,
  };
}

export function buildYearEndAdviceNote(
  organizationId: string,
  facts: AdvisoryFacts,
  model: YearEndModelResult,
  citation: AdviceCitationResult,
): CreateAdviceNoteArgs {
  const totalSavingCents = model.levers.reduce(
    (sum, lever) => sum + lever.saving_cents,
    0,
  );
  const leverSummary = model.levers.length > 0
    ? model.levers
      .map((lever) =>
        `${lever.label}: estimated saving ${money(lever.saving_cents)}`
      )
      .join("; ")
    : "No quantified year-end levers surfaced for the selected date.";
  const summary = [
    `Year-end planning model (${model.as_at_date}): ${leverSummary}`,
    `Total modelled saving/timing benefit: ${money(totalSavingCents)}.`,
    citation.text ? `Research context: ${citation.text}` : null,
  ].filter((line): line is string => line !== null).join("\n\n");

  return {
    p_org: organizationId,
    p_kind: "year_end",
    p_title: "Year-end planning levers",
    p_summary: summary,
    p_inputs: {
      mode: "year_end",
      current_entity_type: facts.profile.entity_type,
      profile: facts.profile,
      signals: facts.signals,
      source_errors: facts.source_errors,
      research_text: citation.text,
    },
    p_numbers: {
      as_at_date: model.as_at_date,
      in_year_end_window: model.in_year_end_window,
      deduction_rate_bps: model.deduction_rate_bps,
      total_saving_cents: totalSavingCents,
      levers: model.levers,
    },
    p_assumptions: {
      as_at_fy: model.as_at_fy,
      model_warnings: model.warnings,
    },
    p_citations: citation.citations,
    p_disclaimer: GENERAL_ADVICE_DISCLAIMER,
  };
}

export function buildCgtAdviceNote(
  organizationId: string,
  facts: AdvisoryFacts,
  disposal: CgtDisposalInput,
  model: CgtModelResult,
  citation: AdviceCitationResult,
): CreateAdviceNoteArgs {
  const summary = [
    `CGT concession screen: gross gain ${
      money(model.gross_gain_cents)
    }, discounted gain ${money(model.discounted_gain_cents)}.`,
    model.flags.basic_conditions_met
      ? "The model flags the Division 152 basic-condition evidence as present."
      : "The model does not have enough evidence for the Division 152 basic conditions.",
    citation.text ? `Research context: ${citation.text}` : null,
  ].filter((line): line is string => line !== null).join("\n\n");

  return {
    p_org: organizationId,
    p_kind: "cgt",
    p_title: "CGT concession screen",
    p_summary: summary,
    p_inputs: {
      mode: "cgt",
      disposal,
      current_entity_type: facts.profile.entity_type,
      profile: facts.profile,
      signals: facts.signals,
      source_errors: facts.source_errors,
      research_text: citation.text,
    },
    p_numbers: {
      gross_gain_cents: model.gross_gain_cents,
      discounted_gain_cents: model.discounted_gain_cents,
      ownership_days: model.ownership_days,
      flags: model.flags,
    },
    p_assumptions: {
      as_at_fy: model.as_at_fy,
      model_warnings: model.warnings,
    },
    p_citations: citation.citations,
    p_disclaimer: GENERAL_ADVICE_DISCLAIMER,
  };
}

export function buildFbtAdviceNote(
  organizationId: string,
  facts: AdvisoryFacts,
  inputs: FbtScenarioInputs,
  model: FbtModelResult,
  citation: AdviceCitationResult,
): CreateAdviceNoteArgs {
  const lower = model.lower_cost_method === "statutory_formula"
    ? model.statutory_formula
    : model.operating_cost;
  const summary = [
    `FBT car-benefit comparison: lower modelled method is ${lower.method} at ${
      money(lower.fbt_cents)
    } FBT.`,
    `Modelled FBT delta between methods: ${money(model.fbt_delta_cents)}.`,
    citation.text ? `Research context: ${citation.text}` : null,
  ].filter((line): line is string => line !== null).join("\n\n");

  return {
    p_org: organizationId,
    p_kind: "fbt",
    p_title: "FBT strategy comparison",
    p_summary: summary,
    p_inputs: {
      mode: "fbt",
      fbt_inputs: inputs,
      current_entity_type: facts.profile.entity_type,
      profile: facts.profile,
      signals: facts.signals,
      source_errors: facts.source_errors,
      research_text: citation.text,
    },
    p_numbers: {
      private_use_bps: model.private_use_bps,
      lower_cost_method: model.lower_cost_method,
      fbt_delta_cents: model.fbt_delta_cents,
      statutory_formula: model.statutory_formula,
      operating_cost: model.operating_cost,
      exemption_candidates: model.exemption_candidates,
    },
    p_assumptions: {
      as_at_fy: model.as_at_fy,
      model_warnings: model.warnings,
    },
    p_citations: citation.citations,
    p_disclaimer: GENERAL_ADVICE_DISCLAIMER,
  };
}

export function buildProfitExtractionAdviceNote(
  organizationId: string,
  facts: AdvisoryFacts,
  model: ProfitExtractionModelResult,
  citation: AdviceCitationResult,
): CreateAdviceNoteArgs {
  const summary = [
    `Profit extraction model: recommended strategy is ${model.recommended_strategy} with total tax ${
      money(model.recommended_total_tax_cents)
    }.`,
    `Potential saving versus the baseline: ${money(model.tax_saving_cents)}.`,
    citation.text ? `Research context: ${citation.text}` : null,
  ].filter((line): line is string => line !== null).join("\n\n");

  return {
    p_org: organizationId,
    p_kind: "profit_extraction",
    p_title: "Profit extraction comparison",
    p_summary: summary,
    p_inputs: {
      mode: "profit_extraction",
      current_entity_type: facts.profile.entity_type,
      profile: facts.profile,
      signals: facts.signals,
      source_errors: facts.source_errors,
      research_text: citation.text,
    },
    p_numbers: {
      profit_available_cents: model.profit_available_cents,
      recommended_strategy: model.recommended_strategy,
      recommended_split: model.recommended_split,
      recommended_total_tax_cents: model.recommended_total_tax_cents,
      tax_saving_cents: model.tax_saving_cents,
      options: model.options,
    },
    p_assumptions: {
      as_at_fy: model.as_at_fy,
      model_assumptions: model.assumptions,
      model_warnings: model.warnings,
    },
    p_citations: citation.citations,
    p_disclaimer: GENERAL_ADVICE_DISCLAIMER,
  };
}

async function buildAdviceNoteForMode({
  mode,
  orgId,
  facts,
  client,
  body,
  cgtDisposal,
  asAt,
}: {
  mode: ScenarioAdvisorMode;
  orgId: string;
  facts: AdvisoryFacts;
  client: SupabaseClientLike;
  body: AdvisorRequestBody;
  cgtDisposal: CgtDisposalInput | null;
  asAt: Date;
}): Promise<CreateAdviceNoteArgs> {
  switch (mode) {
    case "forecast": {
      const [forecastResult, budgetResult, bankResult] = await Promise.all([
        client
          .from("v_cash_flow_forecast")
          .select("*")
          .eq("organization_id", orgId)
          .order("week_start", { ascending: true }),
        client
          .from("v_budget_vs_actual_weekly")
          .select("*")
          .eq("organization_id", orgId)
          .order("week_start", { ascending: true }),
        client
          .from("bank_accounts")
          .select("current_balance_cents")
          .eq("organization_id", orgId)
          .eq("is_active", true),
      ]);
      if (forecastResult.error) {
        throw new Error(
          `v_cash_flow_forecast: ${forecastResult.error.message}`,
        );
      }
      if (budgetResult.error) {
        throw new Error(
          `v_budget_vs_actual_weekly: ${budgetResult.error.message}`,
        );
      }
      if (bankResult.error) {
        throw new Error(`bank_accounts: ${bankResult.error.message}`);
      }
      return buildForecastAdviceNote(
        orgId,
        facts,
        summarizeForecast(
          forecastRowsFrom(forecastResult.data),
          budgetVarianceRowsFrom(budgetResult.data),
          openingBalanceCentsFrom(bankResult.data),
        ),
        await citeForAdvice(
          "Which cash-flow forecasting and budget variance factors should an Australian small business review in a vCFO cash-flow brief?",
          facts,
          Deno.env.get("PERPLEXITY_API_KEY"),
        ),
      );
    }
    case "structuring":
      return buildStructuringAdviceNote(
        orgId,
        facts,
        modelStructuring(facts),
        await citeForAdvice(
          "Which Australian tax and business-structure rules matter when comparing sole trader, company, and discretionary trust structures for this business?",
          facts,
          Deno.env.get("PERPLEXITY_API_KEY"),
        ),
      );
    case "year_end":
      return buildYearEndAdviceNote(
        orgId,
        facts,
        modelYearEnd(facts, asAt),
        await citeForAdvice(
          "Which Australian year-end tax planning rules matter for concessional super contributions, instant asset write-off purchases, deductible prepayments, and income deferral?",
          facts,
          Deno.env.get("PERPLEXITY_API_KEY"),
        ),
      );
    case "cgt":
      if (!cgtDisposal) throw new Error("cgt_disposal required for cgt mode");
      return buildCgtAdviceNote(
        orgId,
        facts,
        cgtDisposal,
        modelCgt(facts, cgtDisposal),
        await citeForAdvice(
          "Which Australian small-business CGT concession rules matter when screening a business asset disposal?",
          facts,
          Deno.env.get("PERPLEXITY_API_KEY"),
        ),
      );
    case "fbt": {
      const fbtInputs = body.fbt_inputs ?? {};
      const fbtFacts = { ...facts, fbt_inputs: fbtInputs };
      return buildFbtAdviceNote(
        orgId,
        facts,
        fbtInputs,
        modelFbt(fbtFacts),
        await citeForAdvice(
          "Which Australian FBT car-benefit rules matter when comparing statutory-formula and operating-cost methods, electric vehicle exemptions, and work-vehicle private-use limits?",
          facts,
          Deno.env.get("PERPLEXITY_API_KEY"),
        ),
      );
    }
    case "profit_extraction":
      return buildProfitExtractionAdviceNote(
        orgId,
        facts,
        modelProfitExtraction(facts),
        await citeForAdvice(
          "Which Australian tax rules matter when comparing owner wages, fully franked dividends, and trust distribution mixes for extracting business profits?",
          facts,
          Deno.env.get("PERPLEXITY_API_KEY"),
        ),
      );
    case "noop_echo":
      return buildNoopEchoAdviceNote(orgId, facts);
  }
}

function withScheduledInputs(
  noteArgs: CreateAdviceNoteArgs,
  period: string,
  asAt: Date,
): CreateAdviceNoteArgs {
  return {
    ...noteArgs,
    p_inputs: {
      ...noteArgs.p_inputs,
      scheduled: true,
      scheduler_period: period,
      scheduler_kind: noteArgs.p_kind,
      scheduler_as_at_date: isoDate(asAt),
    },
  };
}

async function upsertScheduledAdviceNote(
  admin: SupabaseClientLike,
  noteArgs: CreateAdviceNoteArgs,
  period: string,
): Promise<ScheduledAdviceResult> {
  const { data: existingRows, error: existingError } = await admin
    .from("advice_notes")
    .select("id,status")
    .eq("organization_id", noteArgs.p_org)
    .eq("kind", noteArgs.p_kind)
    .contains("inputs", {
      scheduled: true,
      scheduler_period: period,
      scheduler_kind: noteArgs.p_kind,
    })
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (existingError) {
    throw new Error(`advice_notes dedupe: ${existingError.message}`);
  }

  const existing: ExistingAdviceNoteRow | null = Array.isArray(existingRows)
    ? (existingRows[0] as ExistingAdviceNoteRow | undefined) ?? null
    : null;
  if (existing && existing.status !== "draft") {
    return {
      kind: noteArgs.p_kind,
      period,
      action: "kept_existing",
      advice_note_id: String(existing.id ?? ""),
    };
  }

  const row = {
    organization_id: noteArgs.p_org,
    kind: noteArgs.p_kind,
    title: noteArgs.p_title,
    summary: noteArgs.p_summary,
    inputs: noteArgs.p_inputs,
    numbers: noteArgs.p_numbers,
    assumptions: noteArgs.p_assumptions,
    citations: noteArgs.p_citations,
    disclaimer: noteArgs.p_disclaimer,
  };

  if (existing) {
    const { data, error } = await admin
      .from("advice_notes")
      .update(row)
      .eq("id", existing.id)
      .select("id")
      .single();
    if (error) throw new Error(`advice_notes update: ${error.message}`);
    return {
      kind: noteArgs.p_kind,
      period,
      action: "updated_draft",
      advice_note_id: rowId(data) || String(existing.id ?? ""),
    };
  }

  const { data, error } = await admin
    .from("advice_notes")
    .insert(row)
    .select("id")
    .single();
  if (error) throw new Error(`advice_notes insert: ${error.message}`);

  return {
    kind: noteArgs.p_kind,
    period,
    action: "inserted",
    advice_note_id: rowId(data),
  };
}

function rowId(row: unknown): string {
  if (!row || typeof row !== "object" || !("id" in row)) return "";
  const id = (row as { id?: unknown }).id;
  return id == null ? "" : String(id);
}

async function runScheduledAdvisor(
  admin: SupabaseClientLike,
  orgId: string,
  body: AdvisorRequestBody,
): Promise<{
  scheduled_modes: AdviceNoteKind[];
  results: ScheduledAdviceResult[];
  source_errors: string[];
}> {
  const asAt = parseAsAtDate(body.as_at_date ?? new Date());
  const { data: org, error: orgError } = await admin
    .from("organizations")
    .select("id")
    .eq("id", orgId)
    .is("deleted_at", null)
    .maybeSingle();
  if (orgError) throw new Error(`organizations: ${orgError.message}`);
  if (!org) throw new Error("organization not found or deleted");

  const facts = await loadAdvisoryFacts(advisoryFactsClient(admin), orgId);
  const legalHorizon = await loadLegalHorizonSignals(admin);
  const scheduledModes = selectSeasonalModes(asAt);
  const results: ScheduledAdviceResult[] = [];

  for (const scheduledMode of scheduledModes) {
    const period = scheduledPeriodForMode(scheduledMode, asAt);
    const noteArgs = withScheduledInputs(
      attachLegalHorizonContext(
        await buildAdviceNoteForMode({
          mode: scheduledMode,
          orgId,
          facts,
          client: admin,
          body,
          cgtDisposal: null,
          asAt,
        }),
        legalHorizon.signals,
      ),
      period,
      asAt,
    );
    results.push(await upsertScheduledAdviceNote(admin, noteArgs, period));
  }

  return {
    scheduled_modes: scheduledModes,
    results,
    source_errors: [...facts.source_errors, ...legalHorizon.source_errors],
  };
}

async function handleAdvisor(req: Request): Promise<Response> {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const cronSecret = Deno.env.get("ADVISOR_CRON_SECRET");
  const givenSecret = presentedCronSecret(req) ?? "";
  const isServiceRole = serviceKey.length > 0 && safeEqual(bearer, serviceKey);
  const secretOk = !!cronSecret && safeEqual(givenSecret, cronSecret);
  const cronAuthorized = isServiceRole || secretOk;
  const hasBearer = bearer.length > 0;

  if (!cronAuthorized && !hasBearer) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  let body: AdvisorRequestBody;
  try {
    body = (await req.json()) as AdvisorRequestBody;
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  let orgId: string;
  try {
    orgId = requireUuidish(body.organization_id, "organization_id");
  } catch (err) {
    const message = err instanceof Error
      ? err.message
      : "organization_id required";
    return json({ ok: false, error: message }, 400);
  }

  const mode = body.mode ?? "noop_echo";
  if (!SUPPORTED_MODES.includes(mode as AdvisorMode)) {
    return json({
      ok: false,
      error: `Unsupported advisor mode: ${String(mode)}`,
    }, 400);
  }

  if (mode === "scheduled" && !cronAuthorized) {
    return json({ ok: false, error: "Scheduled mode requires cron auth" }, 403);
  }
  if (mode !== "scheduled" && !hasBearer) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }

  let cgtDisposal: CgtDisposalInput | null = null;
  try {
    if (mode === "cgt") {
      cgtDisposal = requireCgtDisposal(body.cgt_disposal);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: message }, 400);
  }

  let asAt: Date;
  try {
    asAt = parseAsAtDate(body.as_at_date ?? new Date());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: message }, 400);
  }

  try {
    const supabaseUrl = requireEnv("SUPABASE_URL");
    const anonKey = requireEnv("SUPABASE_ANON_KEY");

    if (mode === "scheduled") {
      const admin = createClient(
        supabaseUrl,
        requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
        { auth: { persistSession: false, autoRefreshToken: false } },
      );
      const scheduled = await runScheduledAdvisor(admin as unknown as SupabaseClientLike, orgId, {
        ...body,
        as_at_date: isoDate(asAt),
      });
      return json({
        ok: true,
        mode,
        organization_id: orgId,
        ...scheduled,
      });
    }

    // Advice modes cite sources through Perplexity: a bearer that is merely present (such as the public
    // anon key) is not enough, and signed-in users get an hourly quota. The service role is not limited.
    if (mode !== "noop_echo" && !isServiceRole) {
      const admin = createClient(supabaseUrl, requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const userId = await supabaseOrgAccessDeps(admin, serviceKey).userIdFromJwt(bearer);
      if (!userId) return json({ ok: false, error: "Unauthorized" }, 401);
      const limited = await enforceAiQuota(admin, userId, "advisor", corsHeaders);
      if (limited) return limited;
    }

    const client = createClient(
      supabaseUrl,
      anonKey,
      { global: { headers: { Authorization: authHeader } } },
    );

    const clientLike = client as unknown as SupabaseClientLike;
    const facts = await loadAdvisoryFacts(advisoryFactsClient(clientLike), orgId);
    const noteArgs = await buildAdviceNoteForMode({
      mode: mode as ScenarioAdvisorMode,
      orgId,
      facts,
      client: clientLike,
      body,
      cgtDisposal,
      asAt,
    });
    const { data, error } = await client.rpc("create_advice_note", noteArgs);
    if (error) throw new Error(error.message);

    return json({
      ok: true,
      mode,
      advice_note_id:
        (data as { advice_note_id?: string } | null)?.advice_note_id ?? null,
      source_errors: facts.source_errors,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: message }, 500);
  }
}

if (import.meta.main) {
  Deno.serve(handleAdvisor);
}
