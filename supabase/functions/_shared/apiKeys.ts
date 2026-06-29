// Shared helper: authenticate an inbound external API key.
// Backed by migration 0056_api_keys.sql. See AUDIT.md §5.
//
// A key is presented as `Authorization: Bearer llp_<prefix>.<secret>`.
// Only the SHA-256 hash of the secret is stored; lookup is by the public prefix,
// then a constant-time compare of the hash. Org + scopes ride on the key row.
//
// SECURITY (migration 0208 — api-key hardening): hashed_key is readable ONLY by
// the service role — interactive (authenticated) and connector tokens have the
// SELECT privilege on that column revoked. The rate-limit RPC is service_role-
// only EXECUTE. Every DB call here therefore MUST go through serviceClient()
// (service-role key); switching to a user/anon client would break the
// hashed_key read, the last_used_at touch, and the api_key_rate_limit() call.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireEnv } from "./env.ts";

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
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
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
 * ceiling OR the limiter could not be evaluated.
 *
 * Fails CLOSED: this is an abuse limiter on a PUBLIC endpoint, so an RPC/DB
 * error must DENY (treat as rate-limited / 429) rather than wave traffic
 * through. The failure is logged server-side so a real DB outage is visible;
 * we do not distinguish "DB down" from "over limit" to the caller.
 */
export async function enforceRateLimit(db: SupabaseClient, keyId: string): Promise<boolean> {
  const { data, error } = await db.rpc("api_key_rate_limit", { p_key_id: keyId, p_window_seconds: 60 });
  if (error) {
    console.error("[rate-limit] api_key_rate_limit RPC failed; failing closed", { keyId, detail: error.message });
    return false; // fail closed
  }
  return data === true;
}

/**
 * Cheap PRE-AUTH throttle for unauthenticated/invalid requests on the public,
 * verify_jwt=false endpoints. Before we ever touch the DB (api_keys lookup, log
 * insert), an anonymous caller is bucketed by source IP in a tiny in-memory
 * fixed-window counter. Over the ceiling → the caller is told to back off and we
 * do NOT run a serviceClient, key lookup, or log insert for that request.
 *
 * In-memory is per-isolate (best-effort) — it is a first line of defence to keep
 * a flood of bad keys from each costing a DB round-trip, not a global guarantee.
 * Authenticated traffic is still governed by the per-key DB limiter above.
 */
const ANON_WINDOW_MS = 60_000;
const ANON_MAX_PER_WINDOW = 30;     // bad/anon requests allowed per IP per minute
const ANON_BUCKET_CAP = 10_000;     // hard cap on distinct IPs tracked (memory guard)
const anonBuckets = new Map<string, { count: number; windowStart: number }>();

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? "unknown";
}

/** Returns true if this anonymous request is allowed, false if it should be 429'd. */
export function allowAnonRequest(ip: string): boolean {
  const now = Date.now();
  const b = anonBuckets.get(ip);
  if (!b || now - b.windowStart >= ANON_WINDOW_MS) {
    if (!b && anonBuckets.size >= ANON_BUCKET_CAP) anonBuckets.clear(); // crude eviction
    anonBuckets.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (b.count >= ANON_MAX_PER_WINDOW) return false;
  b.count++;
  return true;
}

/**
 * Cap anonymous (401) logging: only the first few unauthenticated requests per
 * IP-window are written to api_request_log, so a flood of bad keys can't bloat
 * the table (or its DB cost). Best-effort, per-isolate, separate window/counter
 * from the throttle above so a throttled IP still logs its early samples.
 */
const ANON_LOG_MAX_PER_WINDOW = 3;
const anonLogBuckets = new Map<string, { count: number; windowStart: number }>();

export function shouldLogAnon(ip: string): boolean {
  const now = Date.now();
  const b = anonLogBuckets.get(ip);
  if (!b || now - b.windowStart >= ANON_WINDOW_MS) {
    if (!b && anonLogBuckets.size >= ANON_BUCKET_CAP) anonLogBuckets.clear();
    anonLogBuckets.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (b.count >= ANON_LOG_MAX_PER_WINDOW) return false;
  b.count++;
  return true;
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
