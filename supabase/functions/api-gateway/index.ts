// Edge function: api-gateway  (SCAFFOLD — see AUDIT.md §5, B5)
// Exchanges an external API key for a short-lived org-scoped Supabase JWT so
// machine callers can use PostgREST (/rest/v1) with RLS doing enforcement.
//
// REQUIRES:
//   supabase/config.toml -> [functions.api-gateway] verify_jwt = false
//   secret SUPABASE_JWT_SECRET (the project JWT secret, HS256)
//
// NOTE (must finish before relying on the read path): the minted token has no
// auth.uid(), so RLS policies that resolve the org via organization_memberships
// (get_accessible_org_ids()) will see no membership. Choose ONE before shipping:
//   (a) provision a per-org "integration" auth user + membership row and mint the
//       token with that user's `sub`; OR
//   (b) extend the org-scoping RLS helper to also honour an `organization_id`
//       JWT claim (carried below) for service/integration tokens.
// The `ingest` write path does NOT depend on this — it uses service-role + the
// key's pinned organization_id and already enforces tenancy correctly.
import { create, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import { authenticateApiKey } from "../_shared/apiKeys.ts";

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

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const ctx = await authenticateApiKey(req.headers.get("authorization"));
  if (!ctx) {
    return new Response(JSON.stringify({ error: "invalid_api_key" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const token = await create(
    { alg: "HS256", typ: "JWT" },
    {
      role: "authenticated",
      aud: "authenticated",
      organization_id: ctx.organizationId, // see NOTE above re: RLS wiring
      scopes: ctx.scopes,
      exp: getNumericDate(TTL_SECONDS),
    },
    await signingKey(),
  );

  return new Response(
    JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: TTL_SECONDS, organization_id: ctx.organizationId }),
    { headers: { "content-type": "application/json" } },
  );
});
