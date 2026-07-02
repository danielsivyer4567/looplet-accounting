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

  // Per Basiq's docs (api.basiq.io/reference/posttoken, "API key format"
  // callout): unlike standard HTTP Basic Auth, the key is passed VERBATIM as
  // issued from the dashboard — base64-encoding it produces a 400. Do not
  // re-derive or transform BASIQ_API_KEY here under any circumstance.
  const authHeader = `Basic ${BASIQ_API_KEY}`;

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

const BASIQ_MAX_ATTEMPTS = 4;

async function basiqFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  let lastErr = '';
  for (let attempt = 0; attempt < BASIQ_MAX_ATTEMPTS; attempt++) {
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
    if (resp.ok) return (await resp.json()) as T;

    const text = await resp.text();
    lastErr = `Basiq ${path} ${resp.status}: ${text.slice(0, 400)}`;

    // A revoked/expired cached token wedges every subsequent call — drop it and
    // retry once with a freshly minted token.
    if (resp.status === 401 && attempt < BASIQ_MAX_ATTEMPTS - 1) {
      cachedToken = null;
      continue;
    }

    // Transient throttle / server error: back off (honouring Retry-After) and retry
    // rather than aborting the whole sync on a temporary condition.
    if ((resp.status === 429 || resp.status >= 500) && attempt < BASIQ_MAX_ATTEMPTS - 1) {
      const retryAfter = parseInt(resp.headers.get('Retry-After') ?? '', 10);
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter, 60) * 1000
        : 500 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    // Non-retryable status, or attempts exhausted.
    throw new Error(lastErr);
  }
  throw new Error(lastErr || `Basiq ${path}: exhausted retries`);
}

/**
 * Minimal subset of the Supabase client surface used by this module. Left loose
 * (not chained-interface-checked) because the real supabase-js query builder's
 * .select()/.update()/.eq() return progressively narrower generic types that
 * don't structurally satisfy a hand-rolled chain interface — the chain works
 * fine at runtime (this is a type-checker-only mismatch), so callers just pass
 * their real SupabaseClient straight through.
 */
interface SupabaseLike {
  // deno-lint-ignore no-explicit-any
  from(table: string): any;
}

/** Get or create the Basiq user for an org. Persists basiq_user_id back to organizations. */
export async function getOrCreateBasiqUser(
  admin: SupabaseLike,
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

  await admin.from('organizations').update({ basiq_user_id: created.id }).eq('id', organizationId);

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
  // Basiq may return the link under either key; fail loudly rather than handing back
  // a { url: undefined } that renders as a dead "connect your bank" link.
  const url = data.public_url ?? data.links?.public;
  if (!url) throw new Error('Basiq auth_link returned no URL');
  return { url, expiresAt: data.expiresAt };
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
  const conn = await basiqFetch<{
    id: string;
    status: string;
    institution?: { id: string; name?: string; shortName?: string };
    lastUsed?: string;
    expiryDate?: string;
  }>(`/users/${basiqUserId}/connections/${connectionId}`);
  return {
    id: conn.id,
    status: conn.status,
    institution: conn.institution ?? { id: '' },
    lastUsed: conn.lastUsed,
    expiryDate: conn.expiryDate,
  };
}

/**
 * Purge all data Basiq holds for a connection (POST .../purge, 204 no body —
 * NOT basiqFetch, which assumes a JSON body on success). Only valid for an
 * active connection per Basiq's docs; call this BEFORE removing/disabling a
 * bank feed so the upstream consent is actually torn down, not just hidden
 * in our own bank_connections row.
 */
export async function purgeConnection(basiqUserId: string, connectionId: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getBasiqServerToken();
    const resp = await fetch(
      `${BASIQ_BASE}/users/${basiqUserId}/connections/${connectionId}/purge`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      },
    );
    if (resp.status === 204 || resp.ok) return;
    if (resp.status === 401 && attempt === 0) {
      cachedToken = null;
      continue;
    }
    const text = await resp.text();
    throw new Error(`Basiq purge ${connectionId} ${resp.status}: ${text.slice(0, 400)}`);
  }
}

/** List all connections that exist for a Basiq user (server-side discovery). */
export async function listConnections(basiqUserId: string): Promise<BasiqConnection[]> {
  const data = await basiqFetch<{
    data: {
      id: string;
      status: string;
      institution?: { id: string; name?: string; shortName?: string };
      lastUsed?: string;
      expiryDate?: string;
    }[];
  }>(`/users/${basiqUserId}/connections`);
  return (data.data ?? []).map((c) => ({
    id: c.id,
    status: c.status,
    institution: c.institution ?? { id: '' },
    lastUsed: c.lastUsed,
    expiryDate: c.expiryDate,
  }));
}

export interface BasiqAccount {
  id: string;
  accountNo?: string; // last digits or full
  name: string;
  balance: string | number;
  availableFunds?: string | number;
  accountHolder?: string;
  class: { type: string }; // "transaction" | "savings" | "credit-card" | "loan" | "investment" | "term-deposit" | "mortgage"
  currency?: string;
  connection?: string; // connection id
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

interface BasiqTransactionsResponse {
  data?: BasiqTransaction[];
  links?: { next?: string };
}

/** Fetch all transactions for a connection, paging through Basiq's `next` links. */
export async function getAllTransactionsForConnection(
  basiqUserId: string,
  connectionId: string,
  fromDate?: string, // ISO date, e.g. "2025-11-01"
): Promise<BasiqTransaction[]> {
  const all: BasiqTransaction[] = [];
  const filterParts = [`account.connection.id.eq('${connectionId}')`];
  // Use gte (not strict gt) on a date-only bound so same-day transactions on the
  // boundary aren't permanently skipped on incremental sync; the upsert-by-external_id
  // downstream makes the one-day overlap idempotent.
  if (fromDate) filterParts.push(`postDate.gte('${fromDate}')`);
  let url: string | null =
    `/users/${basiqUserId}/transactions?limit=500&filter=${filterParts.join(',')}`;
  let page = 0;
  const MAX_PAGES = 100;
  while (url && page < MAX_PAGES) {
    const resp: BasiqTransactionsResponse = await basiqFetch<BasiqTransactionsResponse>(url);
    if (resp.data) all.push(...resp.data);
    url = resp.links?.next ? resp.links.next.replace(BASIQ_BASE, '') : null;
    page += 1;
  }
  // Never silently truncate: if there is still a next page after the cap, surface it so
  // a large account narrows its fromDate rather than dropping transactions unnoticed.
  if (url) {
    throw new Error(
      `Basiq transaction pagination exceeded ${MAX_PAGES} pages for connection ${connectionId}; narrow fromDate to avoid dropping transactions`,
    );
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
