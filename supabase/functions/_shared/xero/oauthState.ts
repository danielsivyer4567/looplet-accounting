const encoder = new TextEncoder();

function stateSecret(): string {
  const secret = Deno.env.get('XERO_OAUTH_STATE_SECRET') ?? Deno.env.get('XERO_CLIENT_SECRET');
  if (!secret) {
    throw new Error('XERO_OAUTH_STATE_SECRET or XERO_CLIENT_SECRET not configured');
  }
  return secret;
}

async function signingKey(): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'raw',
    encoder.encode(stateSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

function base64Url(bytes: ArrayBuffer): string {
  const chars = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(chars).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function sign(payload: string): Promise<string> {
  const key = await signingKey();
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return base64Url(signature);
}

export async function createXeroOAuthState(organizationId: string): Promise<string> {
  const payload = `${organizationId}.${crypto.randomUUID()}`;
  return `${payload}.${await sign(payload)}`;
}

export async function verifyXeroOAuthState(
  state: string,
  organizationId: string,
): Promise<boolean> {
  const parts = state.split('.');
  if (parts.length !== 3) return false;

  const [stateOrgId, nonce, signature] = parts;
  if (!stateOrgId || !nonce || !signature) return false;
  if (stateOrgId !== organizationId) return false;

  const payload = `${stateOrgId}.${nonce}`;
  return safeEqual(signature, await sign(payload));
}
