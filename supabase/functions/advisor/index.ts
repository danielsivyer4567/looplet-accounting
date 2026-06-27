// advisor (SC-6.B.02)
//
// Proactive advisory engine entrypoint. This skeleton only supports
// mode:"noop_echo": load grounded facts, emit a draft advice_note via the
// SC-6.A.02 RPC, and return the note id. Real scenario modes land in later
// slices; no recommendation, lodgement, payment, or external send happens here.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  type AdviceCitationResult,
  citeForAdvice,
} from "../_shared/advisoryCite.ts";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { requireEnv } from "../_shared/env.ts";
import {
  type AdvisoryFacts,
  type AdvisoryFactsClient,
  type AdvisoryFactsQuery,
  loadAdvisoryFacts,
} from "../_shared/advisoryFacts.ts";
import {
  modelStructuring,
  type StructuringModelResult,
} from "../_shared/models/structuring.ts";

export type AdvisorMode = "noop_echo" | "structuring";
export type AdviceNoteKind = "forecast" | "structuring";

export interface AdvisorRequestBody {
  organization_id?: string;
  mode?: AdvisorMode;
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
    p_disclaimer:
      "General information only; not tax, legal, or financial advice. Review with a registered agent before acting.",
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
    p_disclaimer:
      "General information only; not tax, legal, or financial advice. Review with a registered agent before acting.",
  };
}

async function handleAdvisor(req: Request): Promise<Response> {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ ok: false, error: "Unauthorized" }, 401);

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
  if (mode !== "noop_echo" && mode !== "structuring") {
    return json({
      ok: false,
      error: `Unsupported advisor mode: ${String(mode)}`,
    }, 400);
  }

  try {
    const client = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_ANON_KEY"),
      { global: { headers: { Authorization: authHeader } } },
    );

    const facts = await loadAdvisoryFacts(advisoryFactsClient(client), orgId);
    const noteArgs = mode === "structuring"
      ? buildStructuringAdviceNote(
        orgId,
        facts,
        modelStructuring(facts),
        await citeForAdvice(
          "Which Australian tax and business-structure rules matter when comparing sole trader, company, and discretionary trust structures for this business?",
          facts,
          Deno.env.get("PERPLEXITY_API_KEY"),
        ),
      )
      : buildNoopEchoAdviceNote(orgId, facts);
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
