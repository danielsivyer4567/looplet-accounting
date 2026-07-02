// Edge function: super-batch-send  (SC-3.G.01)
//
// Generates an approved SuperStream/clearing-house transport payload — behind the
// Tier-2 approval gate. Refuses unless a matching approved `approvals` row exists
// (is_action_approved, SC-2.B.03); on first refusal it records the pending Tier-2
// request bound to this exact batch, so an admin can approve it.
//
// On approval it builds build_superstream_payload(batch), refuses if fund details
// are incomplete, and transitions draft/approved → sent with a payload hash and
// manual clearing-house-file response. This is the documented transport path until
// a provider-specific API endpoint is configured; it does not pretend live payment.
//
// Request body: { organization_id: uuid, super_batch_id: uuid }
// Deploy with verify_jwt=false (self-auths via getUser + membership, like
// payment-runs-aba-export). Requires 0124 (super batch) + the approvals stack live.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";

interface RequestBody {
  organization_id?: string;
  super_batch_id?: string;
}

interface SuperBatchRow {
  id: string;
  organization_id: string;
  status: string;
  total_super_cents: number;
  line_count: number;
  fy_start_year: number;
  quarter: number;
  transport_payload_hash: string | null;
}

interface SuperstreamPayload {
  schema_version: "build_superstream_payload:v1";
  summary?: {
    ready_for_external_upload?: boolean;
    validation_error_count?: number;
  };
  evidence?: {
    input_hash?: string;
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceKey || !anonKey) {
    return json({ ok: false, error: "Server config missing" }, 500);
  }

  // Authenticate the caller (self-auth; verify_jwt=false on this fn).
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return json({ ok: false, error: "Unauthenticated" }, 401);

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  const organization_id = body.organization_id;
  const super_batch_id = body.super_batch_id;
  if (!organization_id || !super_batch_id) {
    return json({ ok: false, error: "organization_id and super_batch_id are required" }, 400);
  }

  const admin = createClient(supabaseUrl, serviceKey);

  // Caller must belong to the org (the gate is org-bound; never trust the body alone).
  const { data: membership } = await admin
    .from("organization_memberships")
    .select("id")
    .eq("user_id", user.id)
    .eq("organization_id", organization_id)
    .maybeSingle();
  if (!membership) return json({ ok: false, error: "Forbidden" }, 403);

  const { data: batch, error: batchErr } = await admin
    .from("super_batches")
    .select(
      "id, organization_id, status, total_super_cents, line_count, fy_start_year, quarter, transport_payload_hash",
    )
    .eq("id", super_batch_id)
    .eq("organization_id", organization_id)
    .maybeSingle<SuperBatchRow>();
  if (batchErr || !batch) return json({ ok: false, error: "Super batch not found" }, 404);

  // Idempotency: an already-sent/confirmed batch is never re-sent.
  if (batch.status === "sent" || batch.status === "confirmed") {
    return json({ ok: true, already_sent: true, status: batch.status, super_batch_id });
  }
  if (batch.line_count === 0 || batch.total_super_cents === 0) {
    return json({ ok: false, error: "Super batch has no lines to send" }, 422);
  }

  // Approval payload — bound to the batch contents so editing the batch after
  // approval changes the hash and silently invalidates the stale approval. PG
  // hashes the jsonb (is_action_approved's jsonb overload), so we never depend on
  // Deno JSON.stringify matching Postgres jsonb::text.
  const approvalPayload = {
    super_batch_id,
    fy_start_year: batch.fy_start_year,
    quarter: batch.quarter,
    total_super_cents: batch.total_super_cents,
    line_count: batch.line_count,
  };

  const { data: approved, error: approvedErr } = await admin.rpc("is_action_approved", {
    p_org: organization_id,
    p_resource_type: "super_batch",
    p_resource_id: super_batch_id,
    p_payload: approvalPayload,
  });
  if (approvedErr) {
    return json({ ok: false, error: `Approval check failed: ${approvedErr.message}` }, 500);
  }

  if (!approved) {
    // Record the pending Tier-2 request bound to this exact batch, then refuse
    // (fail-closed). request_approval needs auth.uid(), so it goes via userClient.
    const { data: approvalId, error: reqErr } = await userClient.rpc("request_approval", {
      p_org: organization_id,
      p_resource_type: "super_batch",
      p_resource_id: super_batch_id,
      p_risk_tier: "tier2_approve",
      p_payload: approvalPayload,
    });
    if (reqErr) {
      console.error("request_approval failed", reqErr);
      return json(
        { ok: false, error: `Approval required, but the request could not be recorded: ${reqErr.message}` },
        403,
      );
    }
    return json(
      { ok: false, error: "Approval required before sending this super batch.", approval_id: approvalId ?? null },
      403,
    );
  }

  // build_superstream_payload is SECURITY INVOKER — it re-checks organization_id
  // IN get_accessible_org_ids() itself, which resolves via auth.uid(). Must go
  // through userClient (the caller's own session), never admin (service-role has
  // no auth.uid(), so get_accessible_org_ids() would always return empty and the
  // authz check inside build_superstream_payload would always fail). Same fix
  // shape as request_approval above — this was the one call in this function that
  // used admin by mistake; membership was already proven above via the
  // organization_memberships check, so re-checking via userClient here is safe
  // and correct, not redundant paranoia.
  const { data: payload, error: payloadErr } = await userClient.rpc("build_superstream_payload", {
    p_batch_id: super_batch_id,
  });
  if (payloadErr)
    return json({ ok: false, error: `Payload build failed: ${payloadErr.message}` }, 500);
  const superstreamPayload = payload as SuperstreamPayload | null;
  if (!superstreamPayload?.summary?.ready_for_external_upload) {
    return json(
      {
        ok: false,
        error: "Super batch is missing fund details required for clearing-house upload.",
        validation_error_count: superstreamPayload?.summary?.validation_error_count ?? null,
        payload: superstreamPayload,
      },
      422,
    );
  }
  const payloadHash = superstreamPayload.evidence?.input_hash ?? crypto.randomUUID();

  // Approved → export lifecycle. The conditional UPDATE (status IN draft/approved) is
  // the idempotency guard: a concurrent/repeat export matches zero rows.
  const { data: updated, error: updErr } = await admin
    .from("super_batches")
    .update({
      status: "sent",
      transport_mode: "clearing_house_file",
      transport_payload_hash: payloadHash,
      transported_at: new Date().toISOString(),
      transport_response: {
        live_dispatch_enabled: false,
        manual_upload_required: true,
        source_version: "build_superstream_payload:v1",
      },
    })
    .eq("id", super_batch_id)
    .eq("organization_id", organization_id)
    .in("status", ["draft", "approved"])
    .select("id, status")
    .maybeSingle();
  if (updErr) return json({ ok: false, error: `Send failed: ${updErr.message}` }, 500);
  if (!updated) {
    // Someone else flipped it between our read and write — idempotent success.
    return json({ ok: true, already_sent: true, super_batch_id });
  }

  return json({
    ok: true,
    sent: true,
    transport_mode: "clearing_house_file",
    manual_upload_required: true,
    super_batch_id,
    status: "sent",
    total_super_cents: approvalPayload.total_super_cents,
    line_count: approvalPayload.line_count,
    payload_hash: payloadHash,
    payload: superstreamPayload,
  });
});
