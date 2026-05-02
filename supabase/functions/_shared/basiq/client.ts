/**
 * Basiq API client — server-token caching, per-org user management,
 * connection / account / transaction primitives.
 *
 * Basiq auth model:
 *   1. Server token (1 hour TTL) obtained via Basic-auth on /token
 *   2. All subsequent calls use Bearer <server_token>
 *   3. Per-org Basiq user_id is created once and reused for all bank
 *      connections that org makes. Stored on organizations.basiq_user_id.
 */

const BASIQ_BASE = Deno.env.get('BASIQ_BASE_URL') ?? 'https://au-api.basiq.io';
const BASIQ_API_KEY = Deno.env.get('BASIQ_API_KEY');

let cachedToken: { value: string; expiresAt: number } | null = null;

/**
 * Get a Basiq server token. Cached in-memory for the function lifetime
 * (tokens last 1 hour; edge function instance lasts ~few minutes).
 */
export async function getBasiqServerToken(): Promise<string> {
  if (!BASIQ_API_KEY) throw new Error('BASIQ_API_KEY not set');
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }

  // Basiq API keys are issued in two forms:
  //   1. Pre-encoded: "<base64(client_id:client_secret)>" — use directly
  //   2. Raw "client_id:client_secret" — needs base64
  // Detect which we have. Pre-encoded keys end in '=' padding or have no colon.
  const looksPreEncoded = !BASIQ_API_KEY.includes(':') || BASIQ_API_KEY.endsWith('=');
  const authHeader = looksPreEncoded
    ? `Basic ${BASIQ_API_KEY}`
    : `Basic ${btoa(BASIQ_API_KEY)}`;

  const resp = await fetch(`${BASIQ_BASE}/token`, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
      'basiq-version': '3.0',
    },
    body: new URLSearchParams({ scope: 'SERVER_ACCESS' }),
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Basiq token ${resp.status}: ${t.slice(0, 300)}`);
  }

  const data = (await resp.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  return data.access_token;
}

async function basiqFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await getBasiqServerToken();
  const resp = await fetch(`${BASIQ_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Basiq ${path} ${resp.status}: ${text.slice(0, 400)}`);
  }
  return (await resp.json()) as T;
}

/** Get or create the Basiq user for an org. Persists basiq_user_id back to organizations. */
export async function getOrCreateBasiqUser(
  admin: any,
  organizationId: string,
  email: string,
  mobile?: string,
): Promise<string> {
  const { data: org } = await admin
    .from('organizations')
    .select('basiq_user_id, name')
    .eq('id', organizationId)
    .maybeSingle();

  if (org?.basiq_user_id) return org.basiq_user_id as string;

  // Basiq mobile must be E.164-style with leading "+"; pass through if provided
  const created = await basiqFetch<{ id: string }>('/users', {
    method: 'POST',
    body: JSON.stringify({
      email,
      mobile: mobile ?? undefined,
      firstName: org?.name ?? 'Looplet',
      lastName: 'Owner',
    }),
  });

  await admin
    .from('organizations')
    .update({ basiq_user_id: created.id })
    .eq('id', organizationId);

  return created.id;
}

/** Patch a Basiq user (e.g. to set a mobile number on an existing user). */
export async function updateBasiqUser(
  basiqUserId: string,
  fields: { mobile?: string; email?: string; firstName?: string; lastName?: string },
): Promise<void> {
  await basiqFetch(`/users/${basiqUserId}`, {
    method: 'POST', // Basiq uses POST (not PATCH) for user updates
    body: JSON.stringify(fields),
  });
}

/**
 * Create an auth_link the user can click to start the Connect flow.
 * Basiq requires a mobile to exist on the user OR be passed in the request.
 */
export async function createAuthLink(
  basiqUserId: string,
  redirectUrl?: string,
  mobile?: string,
): Promise<{ url: string; expiresAt: string }> {
  const body: Record<string, unknown> = {};
  if (mobile) body.mobile = mobile;
  if (redirectUrl) body.callback = redirectUrl;
  const data = await basiqFetch<{
    type: string;
    public_url: string;
    links: { public: string };
    expiresAt: string;
  }>(`/users/${basiqUserId}/auth_link`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return { url: data.public_url ?? data.links?.public, expiresAt: data.expiresAt };
}

export interface BasiqConnection {
  id: string;
  status: string;
  institution: { id: string; name?: string; shortName?: string };
  lastUsed?: string;
  expiryDate?: string;
}

export async function getConnection(
  basiqUserId: string,
  connectionId: string,
): Promise<BasiqConnection> {
  const conn = await basiqFetch<any>(
    `/users/${basiqUserId}/connections/${connectionId}`,
  );
  return {
    id: conn.id,
    status: conn.status,
    institution: conn.institution ?? { id: '' },
    lastUsed: conn.lastUsed,
    expiryDate: conn.expiryDate,
  };
}

export interface BasiqAccount {
  id: string;
  accountNo?: string;          // last digits or full
  name: string;
  balance: string | number;
  availableFunds?: string | number;
  accountHolder?: string;
  class: { type: string };     // "transaction" | "savings" | "credit-card" | "loan" | "investment" | "term-deposit" | "mortgage"
  currency?: string;
  connection?: string;          // connection id
  status?: string;
}

export async function getAccountsForConnection(
  basiqUserId: string,
  connectionId: string,
): Promise<BasiqAccount[]> {
  const data = await basiqFetch<{ data: BasiqAccount[] }>(
    `/users/${basiqUserId}/accounts?filter=connection.id.eq('${connectionId}')`,
  );
  return data.data ?? [];
}

export interface BasiqTransaction {
  id: string;
  status: string;
  description: string;
  amount: string | number;
  postDate: string;
  account: string;
  balance?: string | number;
  class?: string;
  reference?: string;
  subClass?: { code: string; title: string };
  raw?: unknown;
}

/** Fetch all transactions for a connection, paging through Basiq's `next` links. */
export async function getAllTransactionsForConnection(
  basiqUserId: string,
  connectionId: string,
  fromDate?: string,         // ISO date, e.g. "2025-11-01"
): Promise<BasiqTransaction[]> {
  const all: BasiqTransaction[] = [];
  const filterParts = [`account.connection.id.eq('${connectionId}')`];
  if (fromDate) filterParts.push(`postDate.gt('${fromDate}')`);
  let url: string | null =
    `/users/${basiqUserId}/transactions?limit=500&filter=${filterParts.join(',')}`;
  let page = 0;
  while (url && page < 20) {
    const resp = await basiqFetch<{ data: BasiqTransaction[]; links: { next?: string } }>(url);
    if (resp.data) all.push(...resp.data);
    url = resp.links?.next ? resp.links.next.replace(BASIQ_BASE, '') : null;
    page += 1;
  }
  return all;
}

/** Map Basiq account class → bank_account_type enum. */
export function mapBasiqAccountType(klass: string): string {
  const k = (klass ?? '').toLowerCase();
  if (k === 'transaction') return 'checking';
  if (k === 'savings') return 'savings';
  if (k === 'credit-card') return 'credit_card';
  if (k === 'loan' || k === 'mortgage') return 'loan';
  if (k === 'investment' || k === 'term-deposit') return 'investment';
  return 'other';
}

/** Convert Basiq amount string ("-12.34") to cents int (signed). */
export function toCents(amount: string | number | undefined | null): number {
  if (amount == null) return 0;
  const n = typeof amount === 'number' ? amount : parseFloat(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}
