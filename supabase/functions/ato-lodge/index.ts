// ato-lodge (SC-7.B.01)
//
// Phase-7 ATO/SBR gateway scaffold. This slice only proves fail-closed EVTE/DSP
// configuration health. It does not sign, transport, lodge, poll, or send any
// outward request.

import { atoConfigHealth } from "../_shared/ato/config.ts";
import { corsHeaders, preflight } from "../_shared/cors.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export async function handleAtoLodge(req: Request): Promise<Response> {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const health = atoConfigHealth();
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
  Deno.serve(handleAtoLodge);
}
