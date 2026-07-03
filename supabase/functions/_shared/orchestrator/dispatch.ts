// Engine dispatch for accountant-orchestrator tasks.
//
// This layer turns pure decisions into draft artifacts only. It never lodges,
// pays, sends, or resolves approvals; those remain behind the H/I guardrails.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { OrchestratorDecision, OrchestratorTask } from "./decide.ts";

export type DispatchStatus = "dispatched" | "skipped" | "failed";

export interface DispatchResult {
  task_idempotency_key: string;
  engine: string;
  action: string;
  status: DispatchStatus;
  resource_type: string | null;
  resource_id: string | null;
  message: string;
}

export interface DispatchSummary {
  attempted: number;
  dispatched: number;
  skipped: number;
  failed: number;
  results: DispatchResult[];
}

type AdminClient = SupabaseClient;

interface DraftResource {
  resource_type: string;
  resource_id: string | null;
}

interface SpecialistDraftAdapter {
  draftType: string;
  resourceType: string;
  resultKey: string;
  note: string;
  gate: string;
  externalWalls?: string[];
  rpcName?: string;
  rpcArgs?: (task: OrchestratorTask) => Record<string, unknown>;
}

const ACCOUNTANT_REVIEW_GATE =
  "Draft only. Human accountant approval is required before relying on this workpaper; lodgement, payment, filing, or transmission remains outside automation.";

const LEGAL_WALL_GATE =
  "Human approval only. Any ATO, ASIC, payroll, SMSF, or registered-agent lodgement wall remains outside automation.";

const SPECIALIST_DRAFT_ADAPTERS: Record<string, SpecialistDraftAdapter> = {
  prepare_tpar: {
    draftType: "tpar_workpaper",
    resourceType: "tpar_workpaper",
    resultKey: "tpar_scaffold",
    note:
      "TPAR draft scaffold only. Supplier/payment classification and ATO lodgement require accountant review.",
    gate: LEGAL_WALL_GATE,
  },
  prepare_fbt_return: {
    draftType: "fbt_return_workpaper",
    resourceType: "fbt_return_workpaper",
    resultKey: "fbt_scaffold",
    note:
      "FBT return draft scaffold only. Employee benefit evidence, declarations, and lodgement remain accountant/legal review items.",
    gate: LEGAL_WALL_GATE,
  },
  prepare_fbt_instalment: {
    draftType: "fbt_instalment_workpaper",
    resourceType: "fbt_instalment_workpaper",
    resultKey: "fbt_instalment_scaffold",
    note:
      "FBT instalment draft scaffold only. The instalment amount must be checked against ATO account context before payment/lodgement.",
    gate: LEGAL_WALL_GATE,
  },
  prepare_eofy_pack: {
    draftType: "eofy_pack",
    resourceType: "eofy_pack",
    resultKey: "eofy_pack",
    note:
      "EOFY pack workpaper only. It prepares year-end evidence and readiness; tax returns and lodgements remain separately approved.",
    gate: ACCOUNTANT_REVIEW_GATE,
    rpcName: "generate_eofy_pack",
    rpcArgs: (task) => ({
      p_org: task.payload["organization_id"],
      p_fy_start_year: numberPayload(task, "fy_start_year"),
    }),
  },
  prepare_workcover_declaration: {
    draftType: "workcover_declaration",
    resourceType: "workcover_declaration",
    resultKey: "workcover_declaration",
    note:
      "WorkCover declaration workpaper only. State-specific declarations remain outside automation until approved.",
    gate: LEGAL_WALL_GATE,
    rpcName: "generate_workcover_declaration",
    rpcArgs: (task) => ({
      p_org: task.payload["organization_id"],
      p_fy_start_year: numberPayload(task, "fy_start_year"),
    }),
  },
  prepare_payroll_tax: {
    draftType: "payroll_tax_workpaper",
    resourceType: "payroll_tax_workpaper",
    resultKey: "payroll_tax_scaffold",
    note:
      "Payroll-tax draft scaffold only. State threshold, grouping, and lodgement/payment context require accountant review.",
    gate: LEGAL_WALL_GATE,
  },
  review_asic_annual_statement: {
    draftType: "asic_annual_review",
    resourceType: "asic_review",
    resultKey: "asic_form484_draft",
    note:
      "ASIC annual review draft only. ASIC filing and fee payment remain outside automation.",
    gate: LEGAL_WALL_GATE,
    rpcName: "asic_form484_draft",
    rpcArgs: (task) => ({
      p_org: task.payload["organization_id"],
      p_since: null,
    }),
  },
  prepare_tbar: {
    draftType: "smsf_tbar_workpaper",
    resourceType: "smsf_tbar_workpaper",
    resultKey: "smsf_tbc_tbar",
    note:
      "SMSF TBAR workpaper only. TBAR lodgement and SMSF audit remain external human/legal walls.",
    gate: LEGAL_WALL_GATE,
    externalWalls: [
      "smsf_independent_audit",
      "tbar_registered_agent_lodgement",
    ],
    rpcName: "smsf_tbc_tbar",
    rpcArgs: (task) => ({
      p_org: task.payload["organization_id"],
      p_fy_start_year: numberPayload(task, "fy_start_year"),
    }),
  },
  prepare_trust_distribution_resolution: {
    draftType: "trust_distribution_resolution",
    resourceType: "trust_distribution_resolution",
    resultKey: "trust_distribution_stream",
    note:
      "Trust distribution resolution workpaper only. Trustee minute/finalisation remains approvals-gated.",
    gate: LEGAL_WALL_GATE,
    rpcName: "stream_trust_distribution",
    rpcArgs: (task) => ({
      p_org: task.payload["organization_id"],
      p_fy_start_year: numberPayload(task, "fy_start_year"),
    }),
  },
  prepare_div7a_review: {
    draftType: "div7a_review",
    resourceType: "div7a_review",
    resultKey: "div7a_breach_scan",
    note:
      "Division 7A review workpaper only. Loan agreements, deemed-dividend positions, and tax return treatment require accountant sign-off.",
    gate: LEGAL_WALL_GATE,
    rpcName: "div7a_breach_scan",
    rpcArgs: (task) => ({
      p_org: task.payload["organization_id"],
      p_as_at: String(task.payload["period_end"] ?? task.due_date ?? ""),
    }),
  },
  prepare_sgc_review: {
    draftType: "sgc_review",
    resourceType: "sgc_review",
    resultKey: "sgc_scaffold",
    note:
      "SGC review scaffold only. Super guarantee charge exposure requires payroll/super evidence review and ATO-form handling outside automation.",
    gate: LEGAL_WALL_GATE,
  },
  prepare_franking_account_review: {
    draftType: "franking_account_review",
    resourceType: "franking_account_review",
    resultKey: "book_to_tax_franking_context",
    note:
      "Franking-account review workpaper only. Dividend, benchmark-rate, and franking-deficit tax positions require accountant review.",
    gate: LEGAL_WALL_GATE,
    rpcName: "book_to_tax",
    rpcArgs: (task) => ({
      p_org: task.payload["organization_id"],
      p_fy_start_year: numberPayload(task, "fy_start_year"),
    }),
  },
  prepare_cgt_review: {
    draftType: "cgt_review",
    resourceType: "cgt_review",
    resultKey: "cgt_calc",
    note:
      "CGT review workpaper only. Event capture, concessions, rollovers, and return positions require accountant sign-off.",
    gate: LEGAL_WALL_GATE,
    rpcName: "cgt_calc",
    rpcArgs: (task) => ({
      p_org: task.payload["organization_id"],
      p_fy_start_year: numberPayload(task, "fy_start_year"),
    }),
  },
};

function ok(
  task: OrchestratorTask,
  resource: DraftResource,
  message: string,
): DispatchResult {
  return {
    task_idempotency_key: task.idempotency_key,
    engine: task.engine,
    action: task.action,
    status: "dispatched",
    resource_type: resource.resource_type,
    resource_id: resource.resource_id,
    message,
  };
}

function skipped(task: OrchestratorTask, message: string): DispatchResult {
  return {
    task_idempotency_key: task.idempotency_key,
    engine: task.engine,
    action: task.action,
    status: "skipped",
    resource_type: null,
    resource_id: null,
    message,
  };
}

function failed(task: OrchestratorTask, error: unknown): DispatchResult {
  return {
    task_idempotency_key: task.idempotency_key,
    engine: task.engine,
    action: task.action,
    status: "failed",
    resource_type: null,
    resource_id: null,
    message: error instanceof Error ? error.message : String(error),
  };
}

async function rpc<T>(
  admin: AdminClient,
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

function numberPayload(task: OrchestratorTask, key: string): number {
  const value = task.payload[key];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  throw new Error(`${task.action} requires numeric payload.${key}`);
}

function quarterFromTask(task: OrchestratorTask): number {
  const direct = task.payload["quarter"];
  if (typeof direct === "number" && direct >= 1 && direct <= 4) return direct;
  if (typeof direct === "string" && /^[1-4]$/.test(direct)) return Number(direct);

  const periodLabel = String(task.period_label ?? task.payload["period_label"] ?? "");
  const match = periodLabel.match(/\bQ([1-4])\b/i);
  if (match) return Number(match[1]);

  const periodStart = String(task.payload["period_start"] ?? "");
  const date = new Date(`${periodStart}T00:00:00Z`);
  if (!Number.isNaN(date.getTime())) {
    const month = date.getUTCMonth() + 1;
    if (month >= 7 && month <= 9) return 1;
    if (month >= 10 && month <= 12) return 2;
    if (month >= 1 && month <= 3) return 3;
    if (month >= 4 && month <= 6) return 4;
  }

  throw new Error(`${task.action} requires a BAS/AU quarter`);
}

async function upsertComplianceDraft(
  admin: AdminClient,
  task: OrchestratorTask,
  draftType: string,
  payload: Record<string, unknown>,
  resourceType: string,
  resourceId: string | null = null,
): Promise<DraftResource> {
  const row = {
    organization_id: String(task.payload["organization_id"]),
    engine: task.engine,
    action: task.action,
    draft_type: draftType,
    period_label: task.period_label,
    source: "accountant_orchestrator",
    source_key: task.idempotency_key,
    resource_type: resourceType,
    resource_id: resourceId,
    status: "draft",
    payload,
  };

  const { data, error } = await admin
    .from("compliance_drafts")
    .upsert(row, { onConflict: "organization_id,source_key" })
    .select("id")
    .single();
  if (error) throw new Error(`compliance_drafts upsert: ${error.message}`);

  return {
    resource_type: "compliance_draft",
    resource_id: String((data as { id: string }).id),
  };
}

async function openSystemApproval(
  admin: AdminClient,
  task: OrchestratorTask,
  resource: DraftResource,
  payload: Record<string, unknown>,
): Promise<string> {
  if (!resource.resource_id) {
    throw new Error(`${task.action} cannot open approval without resource_id`);
  }
  return await rpc<string>(admin, "request_system_approval", {
    p_org: task.payload["organization_id"],
    p_resource_type: resource.resource_type,
    p_resource_id: resource.resource_id,
    p_risk_tier: "tier2_approve",
    p_payload: payload,
  });
}

async function prepareSpecialistDraft(
  admin: AdminClient,
  task: OrchestratorTask,
  adapter: SpecialistDraftAdapter,
): Promise<DispatchResult> {
  const engineOutput = adapter.rpcName && adapter.rpcArgs
    ? await rpc<Record<string, unknown>>(admin, adapter.rpcName, adapter.rpcArgs(task))
    : {
      status: "needs_review",
      required_inputs: [
        "source evidence",
        "period totals",
        "accountant review",
      ],
      generated_by: "accountant_orchestrator_scaffold",
    };
  const payload = {
    source_task: task,
    [adapter.resultKey]: engineOutput,
    note: adapter.note,
    gate: adapter.gate,
    external_walls: adapter.externalWalls ?? [],
  };
  const draft = await upsertComplianceDraft(
    admin,
    task,
    adapter.draftType,
    payload,
    adapter.resourceType,
  );
  const approvalId = await openSystemApproval(admin, task, draft, {
    source_task: task,
    draft_resource: draft,
    draft_type: adapter.draftType,
    payload,
    gate: adapter.gate,
    external_walls: adapter.externalWalls ?? [],
  });
  return ok(
    task,
    draft,
    `Prepared ${adapter.draftType} draft workpaper and opened approval ${approvalId}.`,
  );
}

async function dispatchTask(
  admin: AdminClient,
  task: OrchestratorTask,
): Promise<DispatchResult> {
  try {
    switch (task.action) {
      case "prepare_bas": {
        const data = await rpc<Record<string, unknown>>(
          admin,
          "prepare_bas_lodgement_draft_system",
          {
            p_org: task.payload["organization_id"],
            p_fy_start_year: numberPayload(task, "fy_start_year"),
            p_quarter: quarterFromTask(task),
          },
        );
        return ok(
          task,
          {
            resource_type: "bas_lodgement",
            resource_id: typeof data["lodgement_id"] === "string"
              ? data["lodgement_id"]
              : null,
          },
          "Prepared BAS lodgement draft and opened system approval request.",
        );
      }

      case "prepare_super_batch": {
        const superBatchId = await rpc<string>(admin, "generate_super_batch", {
          p_org: task.payload["organization_id"],
          p_fy_start_year: numberPayload(task, "fy_start_year"),
          p_quarter: quarterFromTask(task),
        });
        const draft = await upsertComplianceDraft(
          admin,
          task,
          "super_batch",
          {
            source_task: task,
            super_batch_id: superBatchId,
            note:
              "Draft super batch only. Send remains behind super-batch-send approval gate.",
          },
          "super_batch",
          superBatchId,
        );
        return ok(task, draft, "Prepared draft super batch.");
      }

      case "prepare_income_tax_return": {
        const fy = numberPayload(task, "fy_start_year");
        const [returnDraft, bookToTax] = await Promise.all([
          rpc<Record<string, unknown>>(admin, "build_return", {
            p_org: task.payload["organization_id"],
            p_fy_start_year: fy,
          }),
          rpc<Record<string, unknown>>(admin, "book_to_tax", {
            p_org: task.payload["organization_id"],
            p_fy_start_year: fy,
          }),
        ]);
        const draft = await upsertComplianceDraft(
          admin,
          task,
          "income_tax_return",
          {
            source_task: task,
            return_draft: returnDraft,
            book_to_tax: bookToTax,
            note:
              "Draft return and book-to-tax workpaper only. Lodgement remains outside automation.",
          },
          "income_tax_return",
        );
        const approvalId = await openSystemApproval(admin, task, draft, {
          source_task: task,
          draft_resource: draft,
          return_draft: returnDraft,
          book_to_tax: bookToTax,
          gate:
            "Human approval only. True-and-correct declaration and lodgement remain external legal walls.",
        });
        return ok(
          task,
          draft,
          `Prepared income-tax return draft workpaper and opened approval ${approvalId}.`,
        );
      }

      default:
        if (task.action in SPECIALIST_DRAFT_ADAPTERS) {
          return await prepareSpecialistDraft(
            admin,
            task,
            SPECIALIST_DRAFT_ADAPTERS[task.action],
          );
        }
        return skipped(
          task,
          `No safe dispatch adapter for ${task.engine}.${task.action}.`,
        );
    }
  } catch (err) {
    return failed(task, err);
  }
}

export async function dispatchOrchestratorTasks(
  admin: AdminClient,
  decision: OrchestratorDecision,
): Promise<DispatchSummary> {
  const results: DispatchResult[] = [];
  for (const task of decision.tasks) {
    results.push(await dispatchTask(admin, task));
  }
  return {
    attempted: decision.tasks.length,
    dispatched: results.filter((row) => row.status === "dispatched").length,
    skipped: results.filter((row) => row.status === "skipped").length,
    failed: results.filter((row) => row.status === "failed").length,
    results,
  };
}
