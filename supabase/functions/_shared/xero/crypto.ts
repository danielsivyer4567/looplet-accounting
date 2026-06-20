/**
 * Symmetric token encryption for Xero refresh/access tokens.
 * AES-256-GCM via Deno's WebCrypto. Key derived from ENCRYPTION_KEY env via SHA-256.
 *
 * Format of encrypted output: base64(iv:12 || ciphertext || tag)
 * (WebCrypto encrypt() returns ciphertext+tag concatenated; we just prepend iv.)
 *
 * Port of Loopletnumero `services/accounting/crypto.ts` (Node `crypto` →
 * Web Crypto). Same on-disk format so a future migration could re-decrypt
 * tokens encrypted on the Loopletnumero side if needed.
 */

const ALGO = 'AES-GCM';

let cachedKey: CryptoKey | null = null;

async function getKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const raw = Deno.env.get('ENCRYPTION_KEY');
  if (!raw) {
    throw new Error('ENCRYPTION_KEY not set — required for Xero token storage.');
  }
  const enc = new TextEncoder().encode(raw);
  const hash = await crypto.subtle.digest('SHA-256', enc);
  cachedKey = await crypto.subtle.importKey('raw', hash, ALGO, false, ['encrypt', 'decrypt']);
  return cachedKey;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export async function encryptToken(plaintext: string): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: ALGO, iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const ctBytes = new Uint8Array(ct);
  const out = new Uint8Array(iv.length + ctBytes.length);
  out.set(iv, 0);
  out.set(ctBytes, iv.length);
  return bytesToBase64(out);
}

export async function decryptToken(encoded: string): Promise<string> {
  const key = await getKey();
  const buf = base64ToBytes(encoded);
  const iv = buf.subarray(0, 12);
  const ct = buf.subarray(12);
  const pt = await crypto.subtle.decrypt({ name: ALGO, iv }, key, ct);
  return new TextDecoder().decode(pt);
}
