// accountant-orchestrator (SC-7.I.02)
//
// Service/cron wrapper around the pure SC-7.I.01 decision engine. It reads the
// org's tax calendar, books-health row, and profile, then emits idempotent
// org-wide notifications for the tasks that should be initiated. It does not
// lodge, pay, send externally, or mutate tax/ATO state.

import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import {
  type BooksHealthRow,
  type DecideInput,
  decideOrchestratorTasks,
  type OrchestratorDecision,
  type OrchestratorPriority,
  type OrchestratorTask,
  type OrganizationProfile,
  type TaxCalendarRow,
} from "../_shared/orchestrator/decide.ts";

type SupabaseAdmin = SupabaseClient;

interface RequestBody {
  organization_id?: string;
  as_at_date?: string;
}

export interface TaskNotification {
  category: "orchestrator_task";
  severity: "info" | "warning" | "error";
  title: string;
  body: string;
  link: string | null;
  resource_type: "orchestrator_task";
  resource_id: string;
  metadata: Record<string, unknown>;
}

export interface EmitSummary {
  task_count: number;
  emitted: number;
  skipped_count: number;
}

type EmitNotification = (
  orgId: string,
  notification: TaskNotification,
) => Promise<number>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
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

export function stableUuidFromString(value: string): string {
  const seeds = [0x811c9dc5, 0x12345678, 0x9e3779b9, 0xfeedface];
  const hex = seeds.map((seed, index) => fnv1a32(`${index}:${value}`, seed))
    .join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${(parseInt(hex[16] ?? "0", 16) & 0x3 | 0x8).toString(16)}${
      hex.slice(17, 20)
    }`,
    hex.slice(20, 32),
  ].join("-");
}

function fnv1a32(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function taskToNotification(task: OrchestratorTask): TaskNotification {
  const route = typeof task.payload.route === "string"
    ? task.payload.route
    : null;
  return {
    category: "orchestrator_task",
    severity: severityForPriority(task.priority),
    title: task.title,
    body: task.reason,
    link: route,
    resource_type: "orchestrator_task",
    resource_id: stableUuidFromString(task.idempotency_key),
    metadata: {
      idempotency_key: task.idempotency_key,
      engine: task.engine,
      action: task.action,
      priority: task.priority,
      source: task.source,
      due_date: task.due_date,
      period_label: task.period_label,
      payload: task.payload,
    },
  };
}

export async function emitDecisionNotifications(
  orgId: string,
  decision: OrchestratorDecision,
  emit: EmitNotification,
): Promise<EmitSummary> {
  let emitted = 0;
  for (const task of decision.tasks) {
    emitted += await emit(orgId, taskToNotification(task));
  }
  return {
    task_count: decision.tasks.length,
    emitted,
    skipped_count: decision.skipped.length,
  };
}

function severityForPriority(
  priority: OrchestratorPriority,
): "info" | "warning" | "error" {
  if (priority === "urgent") return "error";
  if (priority === "high") return "warning";
  return "info";
}

async function emitOnce(
  admin: SupabaseAdmin,
  orgId: string,
  notification: TaskNotification,
): Promise<number> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { data: existing, error: existingErr } = await admin
    .from("notifications")
    .select("id")
    .eq("organization_id", orgId)
    .eq("category", notification.category)
    .eq("resource_id", notification.resource_id)
    .gte("created_at", todayStart.toISOString())
    .limit(1);
  if (existingErr) throw existingErr;
  if ((existing ?? []).length > 0) return 0;

  const { error: rpcErr } = await admin.rpc("notify", {
    p_org: orgId,
    p_category: notification.category,
    p_title: notification.title,
    p_body: notification.body,
    p_link: notification.link,
    p_severity: notification.severity,
    p_user_id: null,
    p_resource_type: notification.resource_type,
    p_resource_id: notification.resource_id,
    p_metadata: notification.metadata,
  });
  if (rpcErr) throw rpcErr;
  return 1;
}

async function loadDecisionInput(
  admin: SupabaseAdmin,
  orgId: string,
  asAtDate: string,
): Promise<DecideInput> {
  const [calendarRes, healthRes, profileRes] = await Promise.all([
    admin
      .from("v_tax_calendar")
      .select(
        "organization_id, obligation_key, category, title, period_label, period_start, period_end, due_date, fy_start_year, days_until_due, stage, status, lodgement_id, lodged_at",
      )
      .eq("organization_id", orgId),
    admin
      .from("v_books_health")
      .select(
        "score, blocking, uncoded_count, unreconciled_count, open_period_count, coverage_pct",
      )
      .eq("organization_id", orgId)
      .maybeSingle(),
    admin
      .from("business_profile")
      .select("organization_id, entity_type, employees_count")
      .eq("organization_id", orgId)
      .maybeSingle(),
  ]);

  if (calendarRes.error) {
    throw new Error(`v_tax_calendar: ${calendarRes.error.message}`);
  }
  if (healthRes.error) {
    throw new Error(`v_books_health: ${healthRes.error.message}`);
  }
  if (profileRes.error) {
    throw new Error(`business_profile: ${profileRes.error.message}`);
  }

  return {
    organization_id: orgId,
    as_at_date: asAtDate,
    tax_calendar: (calendarRes.data ?? []) as TaxCalendarRow[],
    books_health: (healthRes.data ?? null) as BooksHealthRow | null,
    profile: (profileRes.data ?? null) as OrganizationProfile | null,
  };
}

async function runForOrg(
  admin: SupabaseAdmin,
  orgId: string,
  asAtDate: string,
): Promise<
  {
    org: string;
    ok: boolean;
    emitted: number;
    task_count: number;
    skipped_count: number;
    error?: string;
  }
> {
  try {
    const input = await loadDecisionInput(admin, orgId, asAtDate);
    const decision = decideOrchestratorTasks(input);
    const summary = await emitDecisionNotifications(
      orgId,
      decision,
      (targetOrg, notification) => emitOnce(admin, targetOrg, notification),
    );
    return { org: orgId, ok: true, ...summary };
  } catch (err) {
    return {
      org: orgId,
      ok: false,
      emitted: 0,
      task_count: 0,
      skipped_count: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function handleAccountantOrchestrator(
  req: Request,
): Promise<Response> {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const cronSecret = Deno.env.get("ACCOUNTANT_ORCHESTRATOR_CRON_SECRET");
  if (!supabaseUrl || !serviceKey || !cronSecret) {
    return json({
      ok: false,
      error: "Server config missing (need ACCOUNTANT_ORCHESTRATOR_CRON_SECRET)",
    }, 500);
  }

  const url = new URL(req.url);
  const urlSecret = url.searchParams.get("secret");
  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (
    !safeEqual(bearer, serviceKey) && !safeEqual(urlSecret ?? "", cronSecret)
  ) {
    return json({ ok: false, error: "forbidden" }, 403);
  }

  const body = (await req.json().catch(() => ({}))) as RequestBody;
  const asAtDate = body.as_at_date ?? new Date().toISOString().slice(0, 10);
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let orgIds: string[];
  if (body.organization_id?.trim()) {
    orgIds = [body.organization_id.trim()];
  } else {
    const { data, error } = await admin
      .from("organizations")
      .select("id")
      .is("deleted_at", null);
    if (error) return json({ ok: false, error: error.message }, 500);
    orgIds = (data ?? []).map((row: { id: string }) => row.id);
  }

  const results = [];
  for (const orgId of orgIds) {
    results.push(await runForOrg(admin, orgId, asAtDate));
  }

  return json({
    ok: results.every((row) => row.ok),
    orgs: orgIds.length,
    emitted: results.reduce((sum, row) => sum + row.emitted, 0),
    results,
  }, results.every((row) => row.ok) ? 200 : 207);
}

if (import.meta.main) {
  Deno.serve(handleAccountantOrchestrator);
}
