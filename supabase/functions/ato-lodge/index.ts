// ato-lodge (SC-7.B.01, P2-LODGE-1)
//
// Phase-7 ATO/SBR gateway scaffold. It can build a draft BAS SBR/AS4 envelope
// from an immutable BAS worksheet snapshot, but it does not sign, transport,
// lodge, poll, or send any outward request.

import { atoConfigHealth } from "../_shared/ato/config.ts";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { type EnvReader } from "../_shared/ato/config.ts";
import { requireLodgeReady } from "../_shared/lodge/gate.ts";
import {
  BAS_AS4_BLOCKED_ACTION,
  type BasWorksheetSnapshot,
  buildBasLodgementDraft,
  type SbrParty,
} from "../_shared/sbr/as4-envelope.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text.trim()) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asSnapshot(value: unknown): BasWorksheetSnapshot {
  if (!isRecord(value)) throw new Error("snapshot is required");
  return value as unknown as BasWorksheetSnapshot;
}

function asParty(value: unknown, path: string): SbrParty {
  if (!isRecord(value)) throw new Error(`${path} is required`);
  return value as unknown as SbrParty;
}

export async function handleAtoLodge(
  req: Request,
  env: EnvReader = Deno.env,
): Promise<Response> {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch (err) {
    return json({
      ok: false,
      error: err instanceof Error ? err.message : "Invalid JSON body",
    }, 400);
  }

  if (body.action === "build_bas_as4_draft") {
    try {
      const draft = await buildBasLodgementDraft({
        snapshot: asSnapshot(body.snapshot),
        taxpayer: asParty(body.taxpayer, "taxpayer"),
        ...(isRecord(body.agent)
          ? { agent: body.agent as unknown as SbrParty }
          : {}),
        ...(isRecord(body.declaration)
          ? {
            declaration: {
              accepted_at: typeof body.declaration.accepted_at === "string"
                ? body.declaration.accepted_at
                : undefined,
              signer_name: typeof body.declaration.signer_name === "string"
                ? body.declaration.signer_name
                : undefined,
              signer_role: typeof body.declaration.signer_role === "string"
                ? body.declaration.signer_role
                : undefined,
            },
          }
          : {}),
        ...(typeof body.message_id === "string"
          ? { message_id: body.message_id }
          : {}),
        ...(typeof body.conversation_id === "string"
          ? { conversation_id: body.conversation_id }
          : {}),
        ...(typeof body.correlation_id === "string"
          ? { correlation_id: body.correlation_id }
          : {}),
        ...(typeof body.created_at === "string"
          ? { created_at: body.created_at }
          : {}),
      }, env);

      return json({
        ok: true,
        service: "ato-lodge",
        operation: "build_bas_as4_draft",
        lodgement_enabled: false,
        draft,
        transport_gate: draft.payload.transport_gate,
      });
    } catch (err) {
      return json({
        ok: false,
        error: err instanceof Error
          ? err.message
          : "Failed to build BAS SBR/AS4 draft",
      }, 400);
    }
  }

  const block = requireLodgeReady(BAS_AS4_BLOCKED_ACTION, env);
  if (block) return json(block, 403);

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
      ? "ATO signing and SBR/AS4 transport are not implemented. P2-LODGE-1 only builds drafts."
      : "ATO EVTE/DSP configuration is incomplete.",
  });
}

if (import.meta.main) {
  Deno.serve((req) => handleAtoLodge(req));
}
