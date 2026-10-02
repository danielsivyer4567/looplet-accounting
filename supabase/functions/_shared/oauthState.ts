// Signed OAuth `state` for the Xero and Gmail connect flows.
//
// The state carries who started the flow (provider, organisation and user) and when it expires, signed with HMAC-SHA256.
// The callback only accepts a state that was issued to the same signed-in user for the same organisation and provider,
// within the time limit. Without that binding, someone could start a flow with their own Xero or Google account and lure
// a member of another organisation to the callback link, connecting that organisation's books to the attacker's account.
// The browser additionally checks the state against the copy it stored when the flow started (src/lib/oauthState.ts).

export type OAuthProvider = 'xero' | 'gmail';

export interface OAuthStateClaims {
  provider: OAuthProvider;
  organizationId: string;
  userId: string;
}

export type OAuthStateCheck = { ok: true } | { ok: false; reason: string };

export const OAUTH_STATE_TTL_SECONDS = 15 * 60;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface StatePayload {
  v: 1;
  p: OAuthProvider;
  o: string;
  u: string;
  n: string;
  exp: number;
}

/** The signing secret for a provider: a dedicated state secret, else the provider's client secret. */
export function oauthStateSecret(provider: OAuthProvider, env: { get(name: string): string | undefined } = Deno.env): string {
  const names = provider === 'xero'
    ? ['XERO_OAUTH_STATE_SECRET', 'XERO_CLIENT_SECRET']
    : ['GMAIL_OAUTH_STATE_SECRET', 'GMAIL_CLIENT_SECRET'];
  for (const name of names) {
    const value = env.get(name);
    if (value) return value;
  }
  throw new Error(`${names.join(' or ')} not configured`);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let chars = '';
  for (const byte of bytes) chars += String.fromCharCode(byte);
  return btoa(chars).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function sign(payload: string, secret: string): Promise<string> {
  if (!secret) throw new Error('OAuth state secret is empty');
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64UrlEncode(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload))));
}

export async function createOAuthState(claims: OAuthStateClaims, secret: string, nowMs = Date.now()): Promise<string> {
  if (!claims.organizationId || !claims.userId) throw new Error('OAuth state needs an organisation and a user');
  const payload: StatePayload = {
    v: 1,
    p: claims.provider,
    o: claims.organizationId,
    u: claims.userId,
    n: crypto.randomUUID(),
    exp: Math.floor(nowMs / 1000) + OAUTH_STATE_TTL_SECONDS,
  };
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  return `${body}.${await sign(body, secret)}`;
}

export async function verifyOAuthState(
  state: string | null | undefined,
  expected: OAuthStateClaims,
  secret: string,
  nowMs = Date.now(),
): Promise<OAuthStateCheck> {
  if (typeof state !== 'string' || !state) return { ok: false, reason: 'state missing' };
  const parts = state.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'state malformed' };
  const [body, signature] = parts;
  if (!safeEqual(signature, await sign(body, secret))) return { ok: false, reason: 'state signature invalid' };

  const bytes = base64UrlDecode(body);
  let payload: Partial<StatePayload> | null = null;
  try {
    payload = bytes ? JSON.parse(decoder.decode(bytes)) : null;
  } catch {
    payload = null;
  }
  if (!payload || payload.v !== 1) return { ok: false, reason: 'state malformed' };
  if (payload.p !== expected.provider) return { ok: false, reason: 'state issued for another provider' };
  if (payload.o !== expected.organizationId) return { ok: false, reason: 'state issued for another organisation' };
  if (payload.u !== expected.userId) return { ok: false, reason: 'state issued to another user' };
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(nowMs / 1000)) return { ok: false, reason: 'state expired' };
  return { ok: true };
}
