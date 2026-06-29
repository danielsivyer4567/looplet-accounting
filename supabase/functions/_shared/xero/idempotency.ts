/**
 * Stable Xero Idempotency-Key derivation.
 *
 * THE BUG THIS FIXES (audit finding):
 *   Every push used `crypto.randomUUID()` as the Xero `Idempotency-Key` header.
 *   Xero's idempotency contract keys on that header: a POST with a *previously
 *   seen* key returns the already-created invoice instead of creating a new one.
 *   With a fresh random key per attempt, that protection is dead — a retry after
 *   a network timeout / "unknown result" (where Xero may have actually committed
 *   the invoice but the response was lost) creates a DUPLICATE ACCPAY/ACCREC.
 *
 * THE FIX:
 *   Derive the key DETERMINISTICALLY from the source entity, so every retry of
 *   the same logical push REUSES the same key and Xero dedupes server-side.
 *   The key is `org + record_kind + record_id` hashed to a UUIDv5-style value.
 *
 * Two distinct "idempotency keys" exist in this codebase — do not conflate:
 *   - The Xero HTTP `Idempotency-Key` header  → STABLE, this module. Same logical
 *     push ⇒ same key across all retries.
 *   - `xero_sync_log.idempotency_key`          → per-log-row UNIQUE audit id. Each
 *     attempt appends its own row, so that stays a fresh random UUID.
 *
 * Xero accepts an opaque string up to 128 chars for Idempotency-Key. We emit a
 * canonical UUID (36 chars) so it also satisfies the `xero_push_queue` UUID
 * column and is trivially greppable in logs.
 */

export type XeroPushKind = 'bill' | 'invoice';

/**
 * SHA-256 → RFC-4122 v5-shaped UUID string. Deterministic for a given input.
 * (We don't need true namespacing semantics, only stable + well-distributed.)
 */
async function sha256ToUuid(input: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)),
  );
  // Take the first 16 bytes and stamp version (5) + RFC-4122 variant bits so the
  // result is a syntactically valid UUID (Xero/Postgres both accept it).
  const b = bytes.slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  );
}

/**
 * The canonical, version-stable seed string for a push. Changing this format
 * would re-key every entity (and so re-enable duplicates on the first retry
 * after a deploy), so it is intentionally minimal and append-only.
 */
export function pushKeySeed(
  organizationId: string,
  kind: XeroPushKind,
  recordId: string,
): string {
  return `xero:v1:${organizationId}:${kind}:${recordId}`;
}

/**
 * Deterministic Xero Idempotency-Key for one logical push. Identical args ⇒
 * identical key, so a retry reuses it and Xero returns the existing invoice
 * rather than creating a duplicate.
 */
export async function deriveXeroIdempotencyKey(
  organizationId: string,
  kind: XeroPushKind,
  recordId: string,
): Promise<string> {
  return await sha256ToUuid(pushKeySeed(organizationId, kind, recordId));
}

/**
 * Backoff hint (ISO timestamp) for the durable push queue's `next_attempt_at`.
 *
 * - 429 (rate limit): Xero returns Retry-After ~60s; back off at least a minute.
 * - 401 (auth): a re-auth/refresh is needed but is cheap to re-drive soon.
 * - 5xx / transient / unknown: exponential-ish backoff capped, scaled by attempt.
 *
 * Returns null when the attempt cap is reached (no further auto-retry is owed).
 */
export function computeNextAttemptAt(
  httpStatus: number | null,
  attempts: number,
  maxAttempts = 3,
  now: Date = new Date(),
): string | null {
  if (attempts >= maxAttempts) return null;
  let delaySeconds: number;
  if (httpStatus === 429) {
    delaySeconds = 60 * attempts; // honour rate-limit window, grow with attempts
  } else if (httpStatus === 401) {
    delaySeconds = 30; // refresh then retry soon
  } else {
    delaySeconds = Math.min(300, 15 * 2 ** (attempts - 1)); // 15s,30s,60s… cap 5m
  }
  return new Date(now.getTime() + delaySeconds * 1000).toISOString();
}
