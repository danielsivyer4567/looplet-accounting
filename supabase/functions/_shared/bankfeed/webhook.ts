// Redbark transaction webhooks: reading, verifying and parsing a delivery.
//
// Redbark signs each delivery with HMAC-SHA256 over "<X-Redbark-Timestamp>.<raw body>" using the destination's signing
// secret, and sends `X-Redbark-Signature: sha256=<hex>`. The timestamp is Unix seconds; deliveries more than five
// minutes away from now are refused as replays. https://redbark.com/docs/api-reference/webhooks
// Ported from the clean-room rebuild (server/bankfeed-sync.ts: verifyWebhookSignature, deliveredAccountIds).
//
// A delivery is only a wake-up signal. Its rows use integer minor units, a different money contract from the REST API,
// so they are never imported: bank-sync reads the REST API for the linked accounts the delivery names.

export const MAX_WEBHOOK_BYTES = 4 * 1024 * 1024;
export const SIGNATURE_TOLERANCE_SECONDS = 300;
const BODY_TIMEOUT_MS = 10_000;
const MAX_ACCOUNT_IDS = 200;

/** The raw body as text, refusing more than `maxBytes` (RangeError) or a body that does not arrive in time. */
export async function readBoundedBody(request: Request, maxBytes: number = MAX_WEBHOOK_BYTES): Promise<string> {
  const declared = request.headers.get('Content-Length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) throw new RangeError('Body too large');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Body timeout')), BODY_TIMEOUT_MS);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new RangeError('Body too large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export type SignatureResult = { ok: true } | { ok: false; reason: string };

/**
 * Verifies one delivery. Fails closed on an unset secret and on any missing or malformed part, bounds the timestamp
 * skew in both directions, and compares the digests in constant time.
 */
export async function verifyRedbarkSignature(input: {
  signature: string | null;
  timestamp: string | null;
  rawBody: string;
  secret: string | null | undefined;
  nowMs?: number;
  toleranceSeconds?: number;
}): Promise<SignatureResult> {
  const { signature, timestamp, rawBody, secret, nowMs = Date.now(), toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS } = input;
  if (!secret) return { ok: false, reason: 'secret not configured' };
  if (!signature || !timestamp) return { ok: false, reason: 'signature headers missing' };
  const seconds = Number(timestamp);
  if (!/^\d{1,12}$/.test(timestamp) || !Number.isSafeInteger(seconds) || seconds <= 0 || Math.abs(nowMs / 1000 - seconds) > toleranceSeconds) {
    return { ok: false, reason: 'timestamp outside the replay window' };
  }
  const hex = (signature.startsWith('sha256=') ? signature.slice(7) : signature).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) return { ok: false, reason: 'signature is not a sha256 hex digest' };
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${rawBody}`)));
  const given = new Uint8Array(32);
  for (let i = 0; i < 32; i++) given[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ given[i];
  return diff === 0 ? { ok: true } : { ok: false, reason: 'signature does not match' };
}

/** The provider account ids a delivery names, from `data.new` and `data.updated` rows plus any `accountIds` list. */
export function deliveredAccountIds(payload: unknown): string[] {
  const p = (payload && typeof payload === 'object' ? payload : {}) as {
    data?: { new?: unknown; updated?: unknown };
    accountIds?: unknown;
  };
  const ids = new Set<string>();
  const rows = [...(Array.isArray(p.data?.new) ? p.data.new : []), ...(Array.isArray(p.data?.updated) ? p.data.updated : [])];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const id = [record.accountId, record.account_id, record.account_public_id].find((value) => typeof value === 'string' && value.trim());
    if (typeof id === 'string') ids.add(id.trim());
  }
  if (Array.isArray(p.accountIds)) for (const id of p.accountIds) if (typeof id === 'string' && id.trim()) ids.add(id.trim());
  return [...ids].filter((id) => id.length <= 200).slice(0, MAX_ACCOUNT_IDS);
}

export interface RedbarkEvent {
  /** The event id from the signed body (the unsigned X-Redbark-Delivery-Id header is not trusted for identity). */
  id: string | null;
  type: string | null;
  /** The parsed body, or `{ unparsed_body }` when the signed body is not a JSON object. */
  payload: Record<string, unknown>;
  /** Account ids to wake, for a `transactions.synced` event only. */
  accountIds: string[];
}

export function parseRedbarkEvent(body: string): RedbarkEvent {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { id: null, type: null, payload: { unparsed_body: body }, accountIds: [] };
  }
  const payload = parsed as Record<string, unknown>;
  const text = (value: unknown, max: number) => (typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null);
  const type = text(payload.type, 100);
  return {
    id: text(payload.id, 200),
    type,
    payload,
    accountIds: type === 'transactions.synced' ? deliveredAccountIds(payload) : [],
  };
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
