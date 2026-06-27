// Edge function: ato-correspondence  (SC-7.H.02)
//
// Drafts ATO correspondence responses grounded by ask-bot and source evidence,
// then fails closed on any send attempt unless a Tier-2 approval exists. Even
// with approval, this function does not transmit to the ATO; transport/send is a
// guarded future slice.
//
// AUTH: user-invokable. Reads/writes use a caller-scoped Supabase client, so the
// SC-7.H.01 RLS policies and approval RPCs decide access. No service-role
// fetch-by-id, no external ATO send, and no lodgement.
//
// Request:
//   Draft: { action:"draft", organization_id, correspondence_id, requested_outcome?, period_start?, period_end? }
//   Send gate: { action:"send", organization_id, draft_id }
//
// DEPLOY-GATED: requires 0184_ato_correspondence and ask-bot deployed. This slice
// only adds local code + Deno checks/tests; deploy/live invoke are intentionally
// blocked by the run guardrails.

import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { requireEnv } from "../_shared/env.ts";
import {
  type AskBotDraftGrounding,
  type AtoCorrespondenceRow,
  buildAskBotQuestion,
  buildDraftPayload,
  collectEvidenceLinks,
  requireTier2ApprovalForSend,
  sendApprovalPayload,
  type WorkingPapersBundleLike,
} from "./draft.ts";

interface RequestBody {
  action?: "draft" | "send";
  organization_id?: string;
  correspondence_id?: string;
  draft_id?: string;
  requested_outcome?: string;
  period_start?: string;
  period_end?: string;
}

interface DraftRow {
  id: string;
  organization_id: string;
  correspondence_id: string;
  subject: string;
  body: string;
  evidence: unknown;
  status: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SIGNED_URL_SECONDS = 60 * 60;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function validPeriod(start: unknown, end: unknown): start is string {
  return typeof start === "string" &&
    typeof end === "string" &&
    DATE_RE.test(start) &&
    DATE_RE.test(end) &&
    end >= start;
}

async function loadNotice(
  client: SupabaseClient,
  organizationId: string,
  correspondenceId: string,
): Promise<AtoCorrespondenceRow | null> {
  const { data, error } = await client
    .from("ato_correspondence")
    .select(
      "id, organization_id, notice_type, subject, ato_reference, received_at, due_date, source_doc_ref, details",
    )
    .eq("organization_id", organizationId)
    .eq("id", correspondenceId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    throw new Error(`ato_correspondence read failed: ${error.message}`);
  }
  return (data ?? null) as AtoCorrespondenceRow | null;
}

async function signNoticeSource(
  client: SupabaseClient,
  notice: AtoCorrespondenceRow,
): Promise<AtoCorrespondenceRow> {
  const source = notice.source_doc_ref ?? {};
  const storageKey = typeof source.storage_key === "string"
    ? source.storage_key.trim()
    : "";
  if (!storageKey) return notice;

  const bucket = typeof source.bucket === "string" && source.bucket.trim()
    ? source.bucket.trim()
    : "bills";
  const { data, error } = await client.storage.from(bucket).createSignedUrl(
    storageKey,
    SIGNED_URL_SECONDS,
  );
  if (error || !data?.signedUrl) return notice;

  return {
    ...notice,
    source_doc_ref: {
      ...source,
      bucket,
      signed_url: data.signedUrl,
      signed_url_expires_in_seconds: SIGNED_URL_SECONDS,
    },
  };
}

async function invokeAskBot(
  client: SupabaseClient,
  organizationId: string,
  question: string,
): Promise<AskBotDraftGrounding> {
  const { data, error } = await client.functions.invoke("ask-bot", {
    body: {
      organization_id: organizationId,
      question,
      response_rule:
        "Return a concise legal/tax response strategy for a registered tax agent to review. Do not claim anything was sent.",
    },
  });
  if (error) throw new Error(`ask-bot failed: ${error.message}`);
  const result = (data ?? {}) as AskBotDraftGrounding;
  if (result.ok === false) {
    throw new Error(
      `ask-bot failed: ${
        String((data as { error?: unknown }).error ?? "unknown error")
      }`,
    );
  }
  return result;
}

async function maybeLoadWorkingPapers(
  client: SupabaseClient,
  body: RequestBody,
): Promise<WorkingPapersBundleLike | null> {
  if (
    !body.organization_id || !validPeriod(body.period_start, body.period_end)
  ) return null;

  const { data, error } = await client.functions.invoke("working-papers", {
    body: {
      organization_id: body.organization_id,
      period_start: body.period_start,
      period_end: body.period_end,
    },
  });
  if (error || !data) return null;
  return ((data as { bundle?: WorkingPapersBundleLike }).bundle ?? null) as
    | WorkingPapersBundleLike
    | null;
}

async function handleDraft(
  client: SupabaseClient,
  body: RequestBody,
): Promise<Response> {
  const organizationId = (body.organization_id ?? "").trim();
  const correspondenceId = (body.correspondence_id ?? "").trim();
  if (!organizationId || !correspondenceId) {
    return json({
      ok: false,
      error: "organization_id and correspondence_id are required",
    }, 400);
  }

  const rawNotice = await loadNotice(client, organizationId, correspondenceId);
  if (!rawNotice) {
    return json({ ok: false, error: "ATO correspondence not found" }, 404);
  }

  const [notice, workingPapers] = await Promise.all([
    signNoticeSource(client, rawNotice),
    maybeLoadWorkingPapers(client, body),
  ]);
  const question = buildAskBotQuestion(notice, body.requested_outcome ?? null);
  const askBot = await invokeAskBot(client, organizationId, question);
  const evidence = collectEvidenceLinks(notice, workingPapers, askBot);
  if (
    !evidence.some((item) =>
      item.resolved && item.href && item.type !== "legal_citation"
    )
  ) {
    return json({
      ok: false,
      error:
        "At least one resolved source evidence link is required before drafting ATO correspondence.",
      evidence,
    }, 422);
  }

  const draft = buildDraftPayload(notice, askBot, evidence);
  const { data, error } = await client
    .from("ato_correspondence_drafts")
    .insert({
      organization_id: organizationId,
      correspondence_id: correspondenceId,
      draft_type: draft.draft_type,
      subject: draft.subject,
      body: draft.body,
      evidence: draft.evidence,
      status: "draft",
    })
    .select(
      "id, organization_id, correspondence_id, draft_type, status, subject, body, evidence, created_at",
    )
    .single();
  if (error) {
    return json(
      { ok: false, error: `draft insert failed: ${error.message}` },
      500,
    );
  }

  return json({ ok: true, draft: data, ask_bot: askBot, evidence });
}

async function loadDraft(
  client: SupabaseClient,
  organizationId: string,
  draftId: string,
): Promise<DraftRow | null> {
  const { data, error } = await client
    .from("ato_correspondence_drafts")
    .select(
      "id, organization_id, correspondence_id, subject, body, evidence, status",
    )
    .eq("organization_id", organizationId)
    .eq("id", draftId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(`draft read failed: ${error.message}`);
  return (data ?? null) as DraftRow | null;
}

async function handleSendGate(
  client: SupabaseClient,
  body: RequestBody,
): Promise<Response> {
  const organizationId = (body.organization_id ?? "").trim();
  const draftId = (body.draft_id ?? "").trim();
  if (!organizationId || !draftId) {
    return json({
      ok: false,
      error: "organization_id and draft_id are required",
    }, 400);
  }

  const draft = await loadDraft(client, organizationId, draftId);
  if (!draft) {
    return json(
      { ok: false, error: "ATO correspondence draft not found" },
      404,
    );
  }
  const approvalPayload = sendApprovalPayload(draft);

  const { data: approved, error: approvedErr } = await client.rpc(
    "is_action_approved",
    {
      p_org: organizationId,
      p_resource_type: "ato_correspondence_draft",
      p_resource_id: draftId,
      p_payload: approvalPayload,
    },
  );
  if (approvedErr) {
    return json({
      ok: false,
      error: `Approval check failed: ${approvedErr.message}`,
    }, 500);
  }

  if (approved !== true) {
    const { data: approvalId, error: requestErr } = await client.rpc(
      "request_approval",
      {
        p_org: organizationId,
        p_resource_type: "ato_correspondence_draft",
        p_resource_id: draftId,
        p_risk_tier: "tier2_approve",
        p_payload: approvalPayload,
      },
    );
    if (requestErr) {
      return json({
        ok: false,
        error:
          `Approval required, but the approval request could not be recorded: ${requestErr.message}`,
      }, 403);
    }
    return json({
      ok: false,
      error: "Tier-2 approval required before sending ATO correspondence.",
      approval_id: approvalId ?? null,
      approval_payload: approvalPayload,
    }, 403);
  }

  requireTier2ApprovalForSend(true);
  return json({
    ok: false,
    approved: true,
    error:
      "ATO correspondence send/transport is not implemented. Download the approved draft for registered-agent review and manual send.",
    approval_payload: approvalPayload,
  }, 501);
}

export async function handleAtoCorrespondence(req: Request): Promise<Response> {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ ok: false, error: "Unauthorized" }, 401);

    const supabaseUrl = requireEnv("SUPABASE_URL");
    const anonKey = requireEnv("SUPABASE_ANON_KEY");
    const client = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    const body = (await req.json().catch(() => ({}))) as RequestBody;
    return body.action === "send"
      ? await handleSendGate(client, body)
      : await handleDraft(client, body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
}

if (import.meta.main) {
  Deno.serve(handleAtoCorrespondence);
}
