// Edge function: api-gateway  (EPIC F — F1, finished)
// Exchanges an external API key for a short-lived org-scoped Supabase JWT so
// machine callers can use PostgREST (/rest/v1) with RLS doing enforcement.
//
// REQUIRES:
//   supabase/config.toml -> [functions.api-gateway] verify_jwt = false
//   secret SUPABASE_JWT_SECRET (the project JWT secret, HS256)
//
// RLS WIRING (resolved): the minted token has no auth.uid(), so it carries an
// `organization_id` claim instead. Migration 0069 extends get_accessible_org_ids()
// to honour that claim for integration tokens (option (b) from the original
// scaffold NOTE), so every existing org-scoped RLS policy enforces tenancy for
// these tokens without any per-policy change. The claim is only ever minted here
// AFTER a valid API key is authenticated, and is pinned to that key's org — a
// caller cannot forge it without the project JWT secret.
import { create, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import { authenticateApiKey, enforceRateLimit, logApiRequest, serviceClient } from "../_shared/apiKeys.ts";
import { corsHeaders, preflight } from "../_shared/cors.ts";

const JWT_SECRET = Deno.env.get("SUPABASE_JWT_SECRET")!;
const TTL_SECONDS = 15 * 60;

async function signingKey(): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const ctx = await authenticateApiKey(req.headers.get("authorization"));
  if (!ctx) {
    // No key context → cannot attribute to an org; log anonymously.
    await logApiRequest(serviceClient(), {
      organizationId: null,
      apiKeyId: null,
      keyPrefix: null,
      endpoint: "api-gateway",
      method: req.method,
      status: 401,
    });
    return json({ error: "invalid_api_key" }, 401);
  }

  const db = serviceClient();

  // Per-key fixed-window rate limit (F3). Over-ceiling → 429.
  const allowed = await enforceRateLimit(db, ctx.keyId);
  if (!allowed) {
    await logApiRequest(db, {
      organizationId: ctx.organizationId,
      apiKeyId: ctx.keyId,
      keyPrefix: ctx.keyPrefix,
      endpoint: "api-gateway",
      method: req.method,
      status: 429,
    });
    return json({ error: "rate_limited" }, 429);
  }

  const token = await create(
    { alg: "HS256", typ: "JWT" },
    {
      role: "authenticated",
      aud: "authenticated",
      organization_id: ctx.organizationId, // honoured by get_accessible_org_ids() — see 0069
      scopes: ctx.scopes,
      exp: getNumericDate(TTL_SECONDS),
    },
    await signingKey(),
  );

  await logApiRequest(db, {
    organizationId: ctx.organizationId,
    apiKeyId: ctx.keyId,
    keyPrefix: ctx.keyPrefix,
    endpoint: "api-gateway",
    method: req.method,
    status: 200,
  });

  return json({
    access_token: token,
    token_type: "Bearer",
    expires_in: TTL_SECONDS,
    organization_id: ctx.organizationId,
  });
});
