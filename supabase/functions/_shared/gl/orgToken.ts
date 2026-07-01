// Shared org-scoped token minting for backend callers of SECURITY DEFINER RPCs
// that re-check organization_id IN (SELECT get_accessible_org_ids()) — notably
// post_journal_entry() (0073). A backend caller has no auth.uid(), so
// get_accessible_org_ids() (0069) falls back to the `organization_id` claim of
// an HS256 JWT signed with CONNECTOR_JWT_SECRET (the same secret api-gateway
// uses). This is the ONE place that pattern lives; callers that duplicate it
// inline (e.g. coding-classifier's mintOrgToken) are free to keep doing so —
// this module exists so NEW callers (GST/BAS control posting included) don't
// have to reimplement it.
//
// See docs/gl-posting-interface.md for the frozen contract this module is part of.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { create, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import type { GlOrgClient } from "./client.ts";

// The HMAC signing key is static per deployment; cache it once per isolate.
let cachedSigningKey: CryptoKey | null = null;

async function signingKey(secret: string): Promise<CryptoKey> {
  if (cachedSigningKey) return cachedSigningKey;
  cachedSigningKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return cachedSigningKey;
}

/**
 * Mint a short-lived (5 min) org-scoped JWT so get_accessible_org_ids()
 * authorises a backend caller with no auth.uid(). Returns null (never throws)
 * when CONNECTOR_JWT_SECRET is unset — callers must fail closed on null.
 */
export async function mintOrgToken(orgId: string, secret: string | undefined): Promise<string | null> {
  if (!secret) return null;
  const key = await signingKey(secret);
  return await create(
    { alg: "HS256", typ: "JWT" },
    { role: "authenticated", aud: "authenticated", organization_id: orgId, exp: getNumericDate(300) },
    key,
  );
}

/** Build a Supabase client authenticated as the org-scoped token from mintOrgToken. */
export function createOrgScopedClient(supabaseUrl: string, anonKey: string, token: string): GlOrgClient {
  return createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
