/**
 * _shared/basiq/durability.ts — pure, side-effect-free helpers that make the
 * Basiq bank feed durable, idempotent and replayable. Kept separate from the
 * edge-function handlers (which need Deno.serve + network) so the logic is
 * unit-testable, mirroring receipt-webhook/posReliability.ts.
 *
 * Covers:
 *   - deriveWebhookEventId  : stable id for a webhook event so replays dedupe
 *   - verifyWebhookSignature: constant-time HMAC-SHA256 (when a provider sends
 *                             one) with a documented URL-token fallback
 *   - classifyWebhookAction : map a Basiq event type → the action we take
 *   - dedupeTransactions     : drop duplicate external ids before upsert
 *   - isDuplicateKeyError    : recognise a Postgres 23505 / duplicate-key error
 *   - summariseSyncRun       : derive a bank_sync_runs status from per-conn stats
 */

export class BasiqWebhookError extends Error {}

/**
 * Postgres duplicate-key (23505) recogniser. A unique-violation on
 * bank_transactions(bank_account_id, external_id) means the txn was already
 * synced — that is a successful dedupe, NOT an error, so callers count it as
 * "deduped" rather than failing the run.
 */
export function isDuplicateKeyError(
  error: { code?: string; message?: string } | null | undefined,
): boolean {
  if (!error) return false;
  return error.code === '23505' || (error.message ?? '').toLowerCase().includes('duplicate key');
}

/**
 * Derive a stable external event id for a Basiq webhook so that replays of the
 * SAME event collapse onto one bank_webhook_events row. Basiq events most
 * reliably carry an id at the top level or under data; when absent we hash the
 * canonical (type + connection + sorted-keys payload) so two byte-identical
 * deliveries map to the same id while genuinely different events do not.
 */
export function deriveWebhookEventId(payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  const data = (p.data ?? {}) as Record<string, unknown>;

  const explicit =
    asNonEmptyString(p.id) ??
    asNonEmptyString(p.eventId) ??
    asNonEmptyString(p.event_id) ??
    asNonEmptyString(data.id) ??
    asNonEmptyString(data.eventId);
  if (explicit) return explicit;

  // No provider id — derive a deterministic one from the canonical payload.
  return `derived:${djb2Hex(stableStringify(p))}`;
}

/** Pull a usable event type out of varied Basiq payload shapes. */
export function parseWebhookEventType(payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  return (
    asNonEmptyString(p.type) ??
    asNonEmptyString((p.data as Record<string, unknown> | undefined)?.type) ??
    'unknown'
  );
}

/**
 * Extract the Basiq connection id from the many shapes Basiq uses across event
 * types. Returns null if none is present (the event is still persisted).
 */
export function extractConnectionId(payload: unknown): string | null {
  const p = (payload ?? {}) as Record<string, unknown>;
  const data = (p.data ?? {}) as Record<string, unknown>;
  const connection = data.connection as { id?: unknown } | undefined;
  return (
    asNonEmptyString(data.connectionId) ??
    asNonEmptyString(connection?.id) ??
    asNonEmptyString(data.id) ??
    null
  );
}

export type WebhookAction = 'sync' | 'mark_revoked' | 'mark_expired' | 'touch' | 'ignore';

/**
 * Map a Basiq event type → the action bank-webhook should take. Pure so the
 * routing decision is independently testable.
 */
export function classifyWebhookAction(eventType: string): WebhookAction {
  const t = (eventType ?? '').toLowerCase();
  if (t.includes('invalid')) return 'mark_revoked';
  if (t.includes('expired')) return 'mark_expired';
  if (t.includes('transaction')) return 'sync';
  if (t.includes('error')) return 'mark_expired';
  if (t.includes('updated')) return 'sync';
  if (t === 'unknown' || t === '') return 'ignore';
  return 'touch';
}

export interface WebhookAuthInput {
  /** Raw request body, exactly as received (needed for HMAC over the body). */
  rawBody: string;
  /** Provider signature header value, if any (e.g. hex HMAC-SHA256). */
  signatureHeader: string | null;
  /** Shared HMAC secret, if configured (BASIQ_WEBHOOK_HMAC_SECRET). */
  hmacSecret: string | null;
  /** URL ?token= value presented by the caller. */
  urlToken: string | null;
  /** Expected URL token (BASIQ_WEBHOOK_VERIFY_TOKEN). */
  expectedUrlToken: string | null;
}

export interface WebhookAuthResult {
  ok: boolean;
  /** Which gate authorised (or rejected) the request — for logging. */
  method: 'hmac' | 'url_token' | 'none';
  reason?: string;
}

/**
 * Authenticate an inbound Basiq webhook.
 *
 * PROVIDER CONSTRAINT (documented): Basiq's v3 webhooks do not ship a
 * per-request HMAC signature header; delivery integrity rests on the
 * pre-registered HTTPS callback URL plus a shared secret in the URL query.
 * We therefore:
 *   1. Verify an HMAC-SHA256 signature IF (and only if) both a signature header
 *      and an hmacSecret are present — covers any provider/version that does
 *      sign, and is constant-time.
 *   2. Otherwise fall back to the documented URL-token gate, which must be
 *      configured (expectedUrlToken) and must match — FAIL CLOSED if unset.
 *
 * This is async because HMAC uses WebCrypto.
 */
export async function verifyWebhookSignature(
  input: WebhookAuthInput,
): Promise<WebhookAuthResult> {
  // 1. HMAC path — only when a provider actually signed AND we hold a secret.
  if (input.signatureHeader && input.hmacSecret) {
    const expected = await hmacSha256Hex(input.hmacSecret, input.rawBody);
    const got = normaliseSignature(input.signatureHeader);
    if (constantTimeEqual(expected, got)) {
      return { ok: true, method: 'hmac' };
    }
    return { ok: false, method: 'hmac', reason: 'hmac_mismatch' };
  }

  // 2. Documented URL-token gate. Fail closed if the secret is not configured.
  if (!input.expectedUrlToken) {
    return { ok: false, method: 'none', reason: 'verify_token_not_configured' };
  }
  if (constantTimeEqual(input.urlToken ?? '', input.expectedUrlToken)) {
    return { ok: true, method: 'url_token' };
  }
  return { ok: false, method: 'url_token', reason: 'url_token_mismatch' };
}

/**
 * Drop duplicate external ids from a batch BEFORE upsert. Keeps the FIRST
 * occurrence (Basiq pages newest-first, but order is preserved either way).
 * This makes a single sync pass idempotent even when Basiq returns the same
 * transaction twice across overlapping pages, independent of the DB unique
 * constraint — fewer wasted upserts and a deterministic deduped count.
 */
export function dedupeTransactions<T extends { id?: string | null }>(
  txns: readonly T[],
): { unique: T[]; duplicates: number } {
  const seen = new Set<string>();
  const unique: T[] = [];
  let duplicates = 0;
  for (const t of txns) {
    const id = asNonEmptyString(t.id);
    if (!id) {
      // No external id — cannot dedupe; pass through (caller will skip/handle).
      unique.push(t);
      continue;
    }
    if (seen.has(id)) {
      duplicates += 1;
      continue;
    }
    seen.add(id);
    unique.push(t);
  }
  return { unique, duplicates };
}

export interface SyncStat {
  inserted: number;
  deduped: number;
  skipped: number;
  error?: string | null;
}

export type SyncRunStatus = 'success' | 'partial' | 'error';

/**
 * Derive the bank_sync_runs status from per-connection results:
 *   - all errored                       → 'error'
 *   - some errored, some succeeded       → 'partial'
 *   - none errored                       → 'success'
 */
export function summariseSyncRun(stats: readonly SyncStat[]): {
  status: SyncRunStatus;
  inserted: number;
  deduped: number;
  skipped: number;
  errors: number;
} {
  let inserted = 0;
  let deduped = 0;
  let skipped = 0;
  let errors = 0;
  for (const s of stats) {
    inserted += s.inserted;
    deduped += s.deduped;
    skipped += s.skipped;
    if (s.error) errors += 1;
  }
  let status: SyncRunStatus;
  if (stats.length > 0 && errors === stats.length) status = 'error';
  else if (errors > 0) status = 'partial';
  else status = 'success';
  return { status, inserted, deduped, skipped, errors };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/** Strip common "sha256=" / "hmac-sha256=" prefixes and lower-case hex. */
function normaliseSignature(sig: string): string {
  const v = sig.trim();
  const eq = v.lastIndexOf('=');
  // "sha256=abcdef" → "abcdef"; leave bare hex untouched.
  const candidate = eq > 0 && /^[a-z0-9-]+$/i.test(v.slice(0, eq)) ? v.slice(eq + 1) : v;
  return candidate.toLowerCase();
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Length-checked constant-time string comparison. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/** Deterministic JSON with sorted object keys so hashing is stable. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** djb2 string hash → 8-char hex. Non-cryptographic; only for dedupe ids. */
function djb2Hex(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
