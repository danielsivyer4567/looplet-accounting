// ato-lodge (SC-7.B.01)
//
// Phase-7 ATO/SBR gateway scaffold. This slice only proves fail-closed EVTE/DSP
// configuration health. It does not sign, transport, lodge, poll, or send any
// outward request.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { atoConfigHealth, type EnvReader } from "../_shared/ato/config.ts";
import { type CallerCheck, requireSignedInCaller } from "../_shared/authGuards.ts";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { requireLodgeReady } from "../_shared/lodge/gate.ts";
import { supabaseOrgAccessDeps } from "../_shared/orgRole.ts";

/** Decides whether the request's Authorization header belongs to a signed-in user or the service role. */
export type AtoLodgeAuthorizer = (authorization: string | null) => Promise<CallerCheck>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface AtoLodgeRequest {
  approval_id?: string;
  lodgement_id?: string;
  declaration_accepted?: boolean;
}

export async function handleAtoLodge(
  req: Request,
  env: EnvReader,
  authorize: AtoLodgeAuthorizer,
): Promise<Response> {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  // The health response names the ATO, DSP and SBR settings that are missing, so it is for signed-in users only.
  const caller = await authorize(req.headers.get("Authorization"));
  if (!caller.ok) return json({ ok: false, error: caller.error }, caller.status);

  const body = await req.json().catch(() => ({})) as AtoLodgeRequest;
  const isSubmissionAttempt = Boolean(
    body.approval_id || body.lodgement_id || body.declaration_accepted,
  );

  if (isSubmissionAttempt) {
    if (!body.approval_id || !body.lodgement_id) {
      return json({
        ok: false,
        error: "approval_id and lodgement_id are required",
        blocked_action: "ato_sbr_lodgement_submit",
      }, 400);
    }

    if (body.declaration_accepted !== true) {
      return json({
        ok: false,
        error: "FORBIDDEN",
        blocked_action: "true_and_correct_declaration",
        approval_id: body.approval_id,
        lodgement_id: body.lodgement_id,
        requires_true_and_correct_declaration: true,
        reason:
          "Approved lodgement drafts still require a human true-and-correct declaration before any ATO/SBR submission attempt.",
      }, 403);
    }

    const lodgeBlock = requireLodgeReady("ato_sbr_lodgement_submit", env);
    if (lodgeBlock) {
      return json({
        ...lodgeBlock,
        approval_id: body.approval_id,
        lodgement_id: body.lodgement_id,
        declaration_accepted: true,
      }, 403);
    }

    return json({
      ok: false,
      error: "NOT_IMPLEMENTED",
      blocked_action: "ato_sbr_lodgement_submit",
      approval_id: body.approval_id,
      lodgement_id: body.lodgement_id,
      declaration_accepted: true,
      reason:
        "ATO/SBR transport is deliberately not implemented; handoff remains at the external lodgement wall.",
    }, 501);
  }

  const health = atoConfigHealth(env);
  return json({
    ok: true,
    service: "ato-lodge",
    configured: health.configured,
    missing: health.missing,
    required: health.required,
    environment: health.environment,
    signing_ready: false,
    transport_ready: false,
    lodgement_enabled: false,
    reason: health.configured
      ? "ATO signing and SBR/AS4 transport are not implemented in SC-7.B.01."
      : "ATO EVTE/DSP configuration is incomplete.",
  });
}

if (import.meta.main) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) throw new Error("ato-lodge needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const deps = supabaseOrgAccessDeps(admin, serviceKey);
  Deno.serve((req) => handleAtoLodge(req, Deno.env, (authorization) => requireSignedInCaller(authorization, deps)));
}
