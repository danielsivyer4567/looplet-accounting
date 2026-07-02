// Tests for the api-gateway connector-token claims (P0-06).
//
// SECURITY INVARIANTS under test (logic level — no live DB):
//   1. A connector token is minted under the read-only `connector` Postgres
//      role, NEVER `authenticated`. Because `connector` holds SELECT only
//      (migration 0205), this is what makes a write-only / read-only key unable
//      to POST/PATCH/DELETE org tables over PostgREST, and unable to be
//      "exchanged for a broader (write-capable) read JWT" — there is no write
//      authority in the role to escalate into.
//   2. The org claim is pinned to the authenticated key's org, so RLS scopes a
//      read-scoped key to ONLY its own org (get_accessible_org_ids() → 0069).
//   3. Scopes ride along informationally only; they never widen the role.
//
// The module reads CONNECTOR_JWT_SECRET at top level, so we set it BEFORE a
// dynamic import (static imports are hoisted above env mutation).
import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.env.set("CONNECTOR_JWT_SECRET", "test-secret-not-used-for-signing-here");

const { buildConnectorClaims, CONNECTOR_ROLE } = await import("./index.ts");

Deno.test("connector token role is the read-only `connector` role, never `authenticated`", () => {
  const claims = buildConnectorClaims("org-1", ["read:financials"]);
  assertEquals(claims.role, "connector");
  assertEquals(CONNECTOR_ROLE, "connector");
  // The crux: never the write-capable PostgREST role.
  assertNotEquals(claims.role, "authenticated");
  assertNotEquals(claims.aud, "authenticated");
});

Deno.test("a write-only key cannot be exchanged for a broader/write JWT", () => {
  // Even a key whose scopes contain writes mints a `connector` (SELECT-only)
  // token — the scopes do NOT promote the role. Writes must go through `ingest`.
  const claims = buildConnectorClaims("org-1", ["write:bills", "write:invoices", "admin:keys"]);
  assertEquals(claims.role, "connector");
  assertNotEquals(claims.role, "authenticated");
  assertNotEquals(claims.role, "service_role");
  // Scopes are preserved verbatim as an informational claim, never reflected
  // into the role/aud that PostgREST acts on.
  assertEquals(claims.scopes, ["write:bills", "write:invoices", "admin:keys"]);
});

Deno.test("a read-scoped key is pinned to exactly its own org for RLS", () => {
  const a = buildConnectorClaims("org-aaaa", ["read:financials"]);
  const b = buildConnectorClaims("org-bbbb", ["read:financials"]);
  assertEquals(a.organization_id, "org-aaaa");
  assertEquals(b.organization_id, "org-bbbb");
  // No cross-bleed: the claim is exactly the org passed in (the gateway pins it
  // from the authenticated key row, never from the request body).
  assertNotEquals(a.organization_id, b.organization_id);
});

Deno.test("claims carry an expiry and default to a short TTL", () => {
  const before = Math.floor(Date.now() / 1000);
  const claims = buildConnectorClaims("org-1", []);
  const after = Math.floor(Date.now() / 1000);
  // 15-minute default TTL; allow a small window for clock/exec drift.
  assert(claims.exp >= before + 15 * 60 - 5, "exp should be ~15m in the future");
  assert(claims.exp <= after + 15 * 60 + 5, "exp should not exceed ~15m");
});

Deno.test("an empty scope list still mints a valid connector token", () => {
  const claims = buildConnectorClaims("org-1", []);
  assertEquals(claims.role, "connector");
  assertEquals(claims.scopes, []);
});
