import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type {
  OrchestratorDecision,
  OrchestratorTask,
} from "./decide.ts";
import { dispatchOrchestratorTasks } from "./dispatch.ts";

interface Call {
  kind: "rpc" | "upsert";
  name: string;
  args: Record<string, unknown>;
}

function task(
  action: string,
  engine: string,
  extraPayload: Record<string, unknown> = {},
): OrchestratorTask {
  return {
    engine,
    action,
    priority: "normal",
    title: action,
    reason: "test",
    source: "tax_calendar",
    due_date: "2026-04-28",
    period_label: "Q3 FY2025-26",
    idempotency_key: `org-1:${action}`,
    payload: {
      organization_id: "org-1",
      fy_start_year: 2025,
      period_label: "Q3 FY2025-26",
      period_start: "2026-01-01",
      ...extraPayload,
    },
  };
}

function fakeAdmin(calls: Call[]): SupabaseClient {
  return {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ kind: "rpc", name, args });
      const data: Record<string, unknown> = {
        prepare_bas_lodgement_draft_system: {
          lodgement_id: "11111111-1111-4111-8111-111111111111",
          approval_id: "22222222-2222-4222-8222-222222222222",
        },
        generate_super_batch: "33333333-3333-4333-8333-333333333333",
        build_return: { ok: true, return_form: "Company tax return" },
        book_to_tax: { ok: true, taxable_income_subtotal_cents: 12345 },
        request_system_approval: "55555555-5555-4555-8555-555555555555",
      };
      return Promise.resolve({ data: data[name] ?? null, error: null });
    },
    from(name: string) {
      return {
        upsert(row: Record<string, unknown>) {
          calls.push({ kind: "upsert", name, args: row });
          return {
            select() {
              return {
                single() {
                  return Promise.resolve({
                    data: { id: "44444444-4444-4444-8444-444444444444" },
                    error: null,
                  });
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
}

Deno.test("dispatchOrchestratorTasks invokes draft engines and records durable draft rows", async () => {
  const calls: Call[] = [];
  const decision: OrchestratorDecision = {
    organization_id: "org-1",
    as_at_date: "2026-04-20",
    books_health_blocking: false,
    skipped: [],
    tasks: [
      task("prepare_bas", "bas"),
      task("prepare_super_batch", "super"),
      task("prepare_income_tax_return", "income_tax"),
      task("prepare_tpar", "tpar"),
      task("prepare_fbt_return", "fbt"),
      task("prepare_fbt_instalment", "fbt"),
      task("prepare_eofy_pack", "eofy"),
      task("prepare_workcover_declaration", "workcover"),
      task("prepare_payroll_tax", "payroll_tax"),
      task("review_asic_annual_statement", "asic"),
      task("prepare_tbar", "smsf"),
      task("prepare_trust_distribution_resolution", "trust"),
      task("prepare_div7a_review", "div7a"),
      task("prepare_sgc_review", "sgc"),
      task("prepare_franking_account_review", "franking"),
      task("prepare_cgt_review", "cgt"),
    ],
  };

  const summary = await dispatchOrchestratorTasks(fakeAdmin(calls), decision);

  assertEquals(summary.attempted, 16);
  assertEquals(summary.dispatched, 16);
  assertEquals(summary.skipped, 0);
  assertEquals(summary.failed, 0);
  const rpcNames = calls.filter((call) => call.kind === "rpc").map((call) =>
    call.name
  );
  assert(rpcNames.includes("prepare_bas_lodgement_draft_system"));
  assert(rpcNames.includes("generate_super_batch"));
  assert(rpcNames.includes("build_return"));
  assert(rpcNames.includes("book_to_tax"));
  assert(rpcNames.includes("generate_eofy_pack"));
  assert(rpcNames.includes("generate_workcover_declaration"));
  assert(rpcNames.includes("asic_form484_draft"));
  assert(rpcNames.includes("smsf_tbc_tbar"));
  assert(rpcNames.includes("stream_trust_distribution"));
  assert(rpcNames.includes("div7a_breach_scan"));
  assert(rpcNames.includes("cgt_calc"));
  const approvalCall = calls.find((call) =>
    call.kind === "rpc" && call.name === "request_system_approval"
  );
  assertEquals(approvalCall?.args.p_resource_type, "compliance_draft");
  assertEquals(approvalCall?.args.p_risk_tier, "tier2_approve");
  assert(
    JSON.stringify(approvalCall?.args.p_payload).includes(
      "True-and-correct declaration and lodgement remain external legal walls",
    ),
  );
  assertEquals(
    calls.filter((call) => call.kind === "upsert").map((call) => call.name),
    Array.from({ length: 15 }, () => "compliance_drafts"),
  );
  assert(
    calls.some((call) =>
      call.kind === "upsert" &&
      call.name === "compliance_drafts" &&
      call.args.draft_type === "smsf_tbar_workpaper" &&
      JSON.stringify(call.args.payload).includes("SMSF audit") &&
      JSON.stringify(call.args.payload).includes("smsf_independent_audit")
    ),
  );
  assert(
    calls.some((call) =>
      call.kind === "rpc" &&
      call.name === "request_system_approval" &&
      JSON.stringify(call.args.p_payload).includes("smsf_independent_audit")
    ),
  );
  assert(
    calls.some((call) =>
      call.kind === "upsert" &&
      call.name === "compliance_drafts" &&
      call.args.draft_type === "div7a_review" &&
      JSON.stringify(call.args.payload).includes("Division 7A")
    ),
  );
});
