// Edge function: api-gateway  (EPIC F — F1, finished)
// Exchanges an external API key for a short-lived org-scoped Supabase JWT so
// machine callers can use PostgREST (/rest/v1) with RLS doing enforcement.
//
// REQUIRES:
//   supabase/config.toml -> [functions.api-gateway] verify_jwt = false
//   secret CONNECTOR_JWT_SECRET = the project JWT secret (HS256). It can't be
//   named SUPABASE_JWT_SECRET — Supabase reserves the SUPABASE_ prefix for
//   secrets, so that name is rejected. Paste the same JWT-secret value
//   (Dashboard → Settings → API → JWT Secret) into CONNECTOR_JWT_SECRET.
//
// RLS WIRING (resolved): the minted token has no auth.uid(), so it carries an
// `organization_id` claim instead. Migration 0069 extends get_accessible_org_ids()
// to honour that claim for integration tokens (option (b) from the original
// scaffold NOTE), so every existing org-scoped RLS policy enforces tenancy for
// these tokens without any per-policy change. The claim is only ever minted here
// AFTER a valid API key is authenticated, and is pinned to that key's org — a
// caller cannot forge it without the project JWT secret.
//
// WRITE HARDENING (P0-06): the token is minted under the dedicated `connector`
// Postgres role (migration 0205), NOT `authenticated`. PostgREST SET ROLEs to
// the JWT `role`, and `connector` holds SELECT only — no INSERT/UPDATE/DELETE on
// any public table — so a connector token CANNOT POST/PATCH/DELETE org tables
// over /rest/v1 (denied at the GRANT layer, SQLSTATE 42501, regardless of RLS).
// The scoped `ingest` function (per-type write:* scope check, service role)
// stays the only write surface for connectors. The token also can't be exchanged
// for a broader read JWT: the gateway never mints `authenticated` for a key, and
// `connector` carries no write authority to escalate into. RLS-scoped reads of
// the single pinned org still work because `connector` is a member of
// `authenticated` (so `TO authenticated` SELECT policies apply) — see 0205.
import { create, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import { allowAnonRequest, authenticateApiKey, clientIp, enforceRateLimit, logApiRequest, serviceClient, shouldLogAnon } from "../_shared/apiKeys.ts";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { requireEnv } from "../_shared/env.ts";

const JWT_SECRET = requireEnv("CONNECTOR_JWT_SECRET");
const TTL_SECONDS = 15 * 60;

// The Postgres role the minted token runs as in PostgREST. MUST be the
// read-only `connector` role (migration 0205) and NEVER `authenticated`:
// `authenticated` can write every org table over /rest/v1, `connector` cannot.
export const CONNECTOR_ROLE = "connector";

export interface ConnectorClaims {
  role: string;
  aud: string;
  organization_id: string;
  scopes: string[];
  exp: number;
}

/**
 * Build the JWT claims for a connector token. Pure + exported so tests can assert
 * the security-critical invariants without minting/verifying a real JWT:
 *   - role is the read-only `connector` role, NEVER `authenticated` (no write
 *     authority over PostgREST → cannot be exchanged for a broader/write JWT);
 *   - organization_id is pinned to the authenticated key's org (RLS tenancy);
 *   - scopes ride along informationally only (write enforcement is in `ingest`).
 */
export function buildConnectorClaims(
  organizationId: string,
  scopes: string[],
  ttlSeconds: number = TTL_SECONDS,
): ConnectorClaims {
  return {
    role: CONNECTOR_ROLE,
    aud: CONNECTOR_ROLE,
    organization_id: organizationId, // honoured by get_accessible_org_ids() — see 0069
    scopes,
    exp: getNumericDate(ttlSeconds),
  };
}

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

  const ip = clientIp(req);
  const ctx = await authenticateApiKey(req.headers.get("authorization"));
  if (!ctx) {
    // Throttle UNauthenticated traffic only (F4). authenticateApiKey does no DB
    // work for a missing/malformed header and at most one indexed lookup for a
    // well-formed-but-invalid key, so anon/bad-key floods are capped here without
    // ever 429-ing a legitimate key — authenticated traffic is governed solely
    // by the per-key DB limiter below.
    if (!allowAnonRequest(ip)) {
      return json({ error: "rate_limited" }, 429);
    }
    // No key context → cannot attribute to an org. Cap anonymous 401 logging:
    // only log a small sample per IP-window so bad keys can't flood the table.
    if (shouldLogAnon(ip)) {
      await logApiRequest(serviceClient(), {
        organizationId: null,
        apiKeyId: null,
        keyPrefix: null,
        endpoint: "api-gateway",
        method: req.method,
        status: 401,
      });
    }
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

  // SCOPE NOTE: the minted token runs as the read-only `connector` role and is
  // org-scoped via the `organization_id` claim (RLS in 0069). The key's `scopes`
  // ride along as an informational claim, but PostgREST/RLS does NOT gate reads
  // by them — over /rest/v1 this token can READ the whole org regardless of
  // scope. It CANNOT write any org table over /rest/v1: `connector` holds SELECT
  // only (migration 0205), so POST/PATCH/DELETE are denied at the GRANT layer.
  // WRITE authority is enforced separately and authoritatively in the `ingest`
  // function (per-type write:* scope check before any mutation). So: issuing ANY key grants full-org read; all writes are restricted to the scoped `ingest`
  // surface. (Future: an RLS read-scope claim could narrow reads too.)
  const token = await create(
    { alg: "HS256", typ: "JWT" },
    { ...buildConnectorClaims(ctx.organizationId, ctx.scopes) },
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
