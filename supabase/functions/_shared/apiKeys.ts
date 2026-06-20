// Shared helper: authenticate an inbound external API key.
// Backed by migration 0056_api_keys.sql. See AUDIT.md §5.
//
// A key is presented as `Authorization: Bearer llp_<prefix>.<secret>`.
// Only the SHA-256 hash of the secret is stored; lookup is by the public prefix,
// then a constant-time compare of the hash. Org + scopes ride on the key row.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface ApiKeyContext {
  organizationId: string;
  scopes: string[];
  keyId: string;
  keyPrefix: string;
}

const enc = new TextEncoder();

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

/**
 * Validate the Authorization header. Returns the org/scopes on success, or null
 * on any failure — never leak which check failed.
 */
export async function authenticateApiKey(authHeader: string | null): Promise<ApiKeyContext | null> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  const dot = token.indexOf(".");
  if (!token.startsWith("llp_") || dot < 0) return null;
  const prefix = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!prefix || !secret) return null;

  const db = serviceClient();
  const { data, error } = await db
    .from("api_keys")
    .select("id, organization_id, hashed_key, scopes, expires_at, revoked_at")
    .eq("key_prefix", prefix)
    .maybeSingle();
  if (error || !data || data.revoked_at) return null;
  if (data.expires_at && new Date(data.expires_at) < new Date()) return null;

  const presented = await sha256Hex(secret);
  if (!timingSafeEqual(presented, data.hashed_key)) return null;

  // best-effort usage touch; ignore failures
  await db.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", data.id);
  return { organizationId: data.organization_id, scopes: data.scopes ?? [], keyId: data.id, keyPrefix: prefix };
}

export function hasScope(ctx: ApiKeyContext, scope: string): boolean {
  return ctx.scopes.includes(scope) || ctx.scopes.includes("admin:keys");
}

/**
 * Per-key fixed-window rate limit (migration 0068). Returns true if the call is
 * allowed (and the counter was incremented), false if the key is over its
 * ceiling. Fails OPEN on RPC error so a logging/DB hiccup never bricks the API.
 */
export async function enforceRateLimit(db: SupabaseClient, keyId: string): Promise<boolean> {
  const { data, error } = await db.rpc("api_key_rate_limit", { p_key_id: keyId, p_window_seconds: 60 });
  if (error) return true; // fail open
  return data === true;
}

export interface ApiRequestLogEntry {
  organizationId: string | null;
  apiKeyId: string | null;
  keyPrefix: string | null;
  endpoint: string;
  method?: string | null;
  ingestType?: string | null;
  status: number;
}

/** Best-effort insert into api_request_log (migration 0068). Never throws. */
export async function logApiRequest(db: SupabaseClient, e: ApiRequestLogEntry): Promise<void> {
  try {
    await db.from("api_request_log").insert({
      organization_id: e.organizationId,
      api_key_id: e.apiKeyId,
      key_prefix: e.keyPrefix,
      endpoint: e.endpoint,
      method: e.method ?? null,
      ingest_type: e.ingestType ?? null,
      status: e.status,
    });
  } catch {
    // logging must never affect the response
  }
}
