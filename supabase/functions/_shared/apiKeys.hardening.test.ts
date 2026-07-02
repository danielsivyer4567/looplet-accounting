// Tests for the API-key storage + rate-limit hardening (P0-07).
//
// There is no live DB in this worktree, so these are STATIC / logic-level
// assertions of the privilege model authored in migration
//   supabase/migrations/0208_api_key_hardening.sql
// plus the service-role contract that the runtime helper (apiKeys.ts) depends
// on. They guard against a future edit silently re-opening the surface (e.g.
// re-granting hashed_key SELECT, dropping the admin guard, or pointing the
// rate-limit RPC back at authenticated). The end-to-end issue / use / rate-limit
// / revoke / expired walk recorded in api_request_log, and the direct-table
// escalation attempts that must fail, are deploy-gated (see slice live_proof).
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const here = new URL(".", import.meta.url).pathname;
// On Windows the pathname is like /C:/... — strip the leading slash for Deno fs.
const root = here.replace(/^\/([A-Za-z]:)/, "$1");

const migration = await Deno.readTextFile(
  `${root}../../migrations/0208_api_key_hardening.sql`,
);
const apiKeysSrc = await Deno.readTextFile(`${root}apiKeys.ts`);

// Normalise whitespace so multi-space SQL still matches single-space probes.
const sql = migration.replace(/\s+/g, " ");

// ---------------------------------------------------------------------------
// (b) hashed_key must NEVER be SELECTable by interactive / connector roles.
// ---------------------------------------------------------------------------
Deno.test("hashed_key column SELECT is revoked from authenticated, anon and connector", () => {
  assertStringIncludes(
    sql,
    "REVOKE SELECT (hashed_key) ON public.api_keys FROM authenticated;",
  );
  assertStringIncludes(
    sql,
    "REVOKE SELECT (hashed_key) ON public.api_keys FROM anon;",
  );
  assertStringIncludes(
    sql,
    "REVOKE SELECT (hashed_key) ON public.api_keys FROM connector;",
  );
  // And it is never re-granted back to a client role anywhere in the migration.
  assert(
    !/GRANT[^;]*\(hashed_key\)[^;]*TO\s+(authenticated|anon|connector)/i.test(sql),
    "hashed_key SELECT must not be re-granted to a client role",
  );
});

Deno.test("hashed_key is never returned to clients (no GRANT exposing it)", () => {
  // The only legitimate exposure is the one-time plaintext secret minted by
  // issue_api_key; the stored hash stays service-role only (service_role holds
  // GRANT ALL from 0001 and is intentionally exempt — no per-column grant here).
  const grantsHashed = sql.match(/GRANT[^;]*\(hashed_key\)[^;]*;/gi) ?? [];
  assertEquals(grantsHashed, []);
});

// ---------------------------------------------------------------------------
// (c) Direct INSERT/UPDATE/DELETE on api_keys is blocked for client roles.
// ---------------------------------------------------------------------------
Deno.test("direct INSERT/UPDATE/DELETE on api_keys is revoked from client roles", () => {
  assertStringIncludes(
    sql,
    "REVOKE INSERT, UPDATE, DELETE ON public.api_keys FROM authenticated;",
  );
  assertStringIncludes(
    sql,
    "REVOKE INSERT, UPDATE, DELETE ON public.api_keys FROM anon;",
  );
  assertStringIncludes(
    sql,
    "REVOKE INSERT, UPDATE, DELETE ON public.api_keys FROM connector;",
  );
});

Deno.test("the now-unreachable 0056 insert/update RLS policies are dropped", () => {
  assertStringIncludes(sql, "DROP POLICY IF EXISTS api_keys_insert ON public.api_keys;");
  assertStringIncludes(sql, "DROP POLICY IF EXISTS api_keys_update ON public.api_keys;");
  // The SELECT policy is intentionally kept so members can still list keys.
  assert(
    !/DROP POLICY IF EXISTS api_keys_select/i.test(sql),
    "api_keys_select must be kept so members can list their keys",
  );
});

// ---------------------------------------------------------------------------
// (a) api_key_rate_limit() runs as service_role only, SECURITY DEFINER, pinned.
// ---------------------------------------------------------------------------
Deno.test("api_key_rate_limit is SECURITY DEFINER with a pinned search_path", () => {
  // The function definition carries both clauses.
  assert(
    /CREATE OR REPLACE FUNCTION public\.api_key_rate_limit[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = public/i
      .test(migration),
    "api_key_rate_limit must be SECURITY DEFINER with a pinned search_path",
  );
});

Deno.test("api_key_rate_limit EXECUTE is granted to service_role and revoked from every client role", () => {
  // The grants are emitted via EXECUTE format(..., v_rl_sig), so the migration
  // text carries the %s templates plus the signature bound to v_rl_sig.
  assertStringIncludes(
    sql,
    "v_rl_sig text := 'public.api_key_rate_limit(uuid,integer)';",
  );
  assertStringIncludes(sql, "REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC;', v_rl_sig");
  // Each client principal revoked explicitly (DEFINER-grant gotcha: a blanket
  // REVOKE FROM PUBLIC alone can leave a direct grant in place).
  assertStringIncludes(sql, "REVOKE EXECUTE ON FUNCTION %s FROM anon;', v_rl_sig");
  assertStringIncludes(sql, "REVOKE EXECUTE ON FUNCTION %s FROM authenticated;', v_rl_sig");
  assertStringIncludes(sql, "REVOKE EXECUTE ON FUNCTION %s FROM connector;', v_rl_sig");
  assertStringIncludes(sql, "GRANT EXECUTE ON FUNCTION %s TO service_role;', v_rl_sig");
  // Never granted to a client role (no GRANT ... v_rl_sig targeting a client).
  assert(
    !/GRANT EXECUTE ON FUNCTION %s TO[^']*(authenticated|anon|connector)[^']*',\s*v_rl_sig/i
      .test(sql),
    "rate-limit EXECUTE must not be granted to a client role",
  );
});

// ---------------------------------------------------------------------------
// (d) issue_api_key() requires admin/owner + qualifies pgcrypto safely.
// ---------------------------------------------------------------------------
Deno.test("issue_api_key requires admin/owner on the target org", () => {
  // Must call require_role(p_organization_id, 'admin') and raise on failure.
  assertStringIncludes(
    sql,
    "IF NOT public.require_role(p_organization_id, 'admin'::org_role) THEN",
  );
  // Still keeps the org-accessibility check too (defence in depth).
  assertStringIncludes(
    sql,
    "IF p_organization_id NOT IN (SELECT public.get_accessible_org_ids()) THEN",
  );
});

Deno.test("issue_api_key pins pgcrypto's search_path and fully schema-qualifies it", () => {
  // Widened pinned path so the qualified calls always resolve (0179 precedent).
  assert(
    /CREATE OR REPLACE FUNCTION public\.issue_api_key[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = public, extensions/i
      .test(migration),
    "issue_api_key must pin search_path = public, extensions",
  );
  // pgcrypto calls are schema-qualified to extensions (cannot be shadowed).
  assertStringIncludes(sql, "extensions.gen_random_bytes(8)");
  assertStringIncludes(sql, "extensions.gen_random_bytes(16)");
  assertStringIncludes(sql, "extensions.digest(v_secret, 'sha256')");
  // No BARE (unqualified) pgcrypto call remains in this migration.
  assert(
    !/[^.]\bgen_random_bytes\s*\(/.test(migration.replace(/extensions\.gen_random_bytes/g, "")),
    "no unqualified gen_random_bytes call should remain",
  );
  assert(
    !/[^.]\bdigest\s*\(/.test(migration.replace(/extensions\.digest/g, "")),
    "no unqualified digest call should remain",
  );
});

Deno.test("issue_api_key still hashes the secret (only the hash is persisted)", () => {
  // The plaintext is returned once via (v_prefix || '.' || v_secret); the row
  // stores v_hash in hashed_key — the secret itself is never inserted.
  assertStringIncludes(sql, "v_hash := encode(extensions.digest(v_secret, 'sha256'), 'hex');");
  assert(
    /INSERT INTO public\.api_keys[\s\S]*?hashed_key[\s\S]*?VALUES[\s\S]*?v_hash/i.test(migration),
    "hashed_key column must be populated with the hash, not the plaintext",
  );
});

// ---------------------------------------------------------------------------
// Runtime contract: the helper must keep using the service-role client, which
// is the only role that can read hashed_key / call the rate-limit RPC post-0208.
// ---------------------------------------------------------------------------
Deno.test("apiKeys.ts reads hashed_key and rate-limits under the service-role client", () => {
  // hashed_key is selected (the gateway needs it for the constant-time compare),
  // and the only DB client constructor is the service-role serviceClient().
  assertStringIncludes(apiKeysSrc, "hashed_key");
  assertStringIncludes(apiKeysSrc, "SUPABASE_SERVICE_ROLE_KEY");
  assertStringIncludes(apiKeysSrc, 'db.rpc("api_key_rate_limit"');
  // No user/anon-key client is constructed for these reads.
  assert(
    !/SUPABASE_ANON_KEY/.test(apiKeysSrc),
    "apiKeys.ts must not build an anon-key client (it cannot read hashed_key)",
  );
});

Deno.test("the migration documents that hashed_key is never exposed to clients", () => {
  assertStringIncludes(sql, "NEVER returned to clients");
});
