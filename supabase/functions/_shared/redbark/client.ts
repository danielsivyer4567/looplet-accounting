// Redbark REST v1 client for the bank feed. Server-side only: the API key never leaves the edge function, and it never
// appears in an error message.
//
// Ported to Deno from the clean-room rebuild's tested adapter (server/redbark.ts and shared/bankfeed.ts):
//   - GET /v1/accounts and /v1/transactions are offset-paged (limit 100). Each page carries a `pagination` object whose
//     offset, limit, total and hasMore must agree with the page; anything else is refused rather than guessed at.
//     GET /v1/connections is one unpaged list.
//   - Amounts are signed decimal-dollar strings ("-45.50"). They become integer cents with integer arithmetic only;
//     numbers, exponents and more than two decimal places are refused, never rounded.
//   - Rows are `posted` or `pending`. Pending rows are counted by the caller and never imported.
//   - `X-Redbark-Truncated: true` means the provider cut the requested date window short (about 5,000 rows). The
//     error says so (`truncated`), and history.ts splits the window.
// API reference: https://redbark.com/docs/api-reference/transactions

export const REDBARK_API_BASE = 'https://api.redbark.com/v1';
export const REDBARK_API_VERSION = '2024-01-01';
export const REDBARK_PAGE_LIMIT = 100;

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_LIST_PAGES = 100;

/** A provider failure with a plain message. `truncated` marks a cut-short date window; `retryAt` a Retry-After deadline. */
export class RedbarkError extends Error {
  readonly truncated: boolean;
  readonly retryAt: number | null;
  constructor(message: string, options: { truncated?: boolean; retryAt?: number | null } = {}) {
    super(message);
    this.name = 'RedbarkError';
    this.truncated = options.truncated ?? false;
    this.retryAt = options.retryAt ?? null;
  }
}

export interface FeedAccount {
  externalAccountId: string;
  connectionId: string;
  name: string;
  institution: string | null;
  /** The provider already masks the number; only its last digits are present. */
  accountNumber: string | null;
  currency: string | null;
  accountType: string | null;
}

export interface FeedBalance {
  currentCents: number;
  availableCents: number | null;
  observedAt: string;
}

export interface FeedTransaction {
  id: string;
  accountId: string;
  /** The bank date, YYYY-MM-DD. */
  date: string;
  description: string;
  reference: string | null;
  category: string | null;
  /** Signed integer cents: negative is money out. Never zero. */
  cents: number;
  status: 'posted' | 'pending';
  raw: Record<string, unknown>;
}

export interface FeedPage {
  transactions: FeedTransaction[];
  hasMore: boolean;
  /** Valid rows left out because their amount is zero. */
  skipped: number;
}

export interface RedbarkClient {
  /** Accounts on active banking connections, sorted by institution, name and number. */
  accounts(): Promise<FeedAccount[]>;
  /** A fresh balance observation, or null when the provider has none (stale, unavailable or too old). */
  balance(externalAccountId: string): Promise<FeedBalance | null>;
  /** One page of transactions dated `from` to `to` inclusive (YYYY-MM-DD), starting at `offset`. */
  transactions(externalAccountId: string, connectionId: string, from: string, offset: number, to?: string): Promise<FeedPage>;
}

/** Exact signed decimal dollars to integer cents, or null. Only strings with at most two decimal places convert. */
export function dollarsToCents(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 24) return null;
  const match = /^(-?)(\d{1,18})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const cents = BigInt(match[2]) * 100n + BigInt((match[3] ?? '').padEnd(2, '0'));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return match[1] === '-' && cents !== 0n ? -Number(cents) : Number(cents);
}

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

/** An RFC 3339 instant with an explicit offset, as epoch milliseconds, or null. */
export function feedInstant(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (
    !match || !isCalendarDate(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59 ||
    Number(match[6] ?? 0) > 23 || Number(match[7] ?? 0) > 59 || match[5] === '-00:00'
  ) return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
}

/**
 * The bank date of a transaction. A calendar date field wins; an instant falls back to its AEST (UTC+10) date. A
 * present but invalid field is not hidden by a later valid one.
 */
export function feedDate(record: Record<string, unknown>): string | null {
  for (const key of ['date', 'postDate', 'valueDate']) {
    const value = record[key];
    if (value !== undefined && value !== null) return isCalendarDate(value) ? value : null;
  }
  for (const key of ['datetime', 'postDatetime']) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    const instant = feedInstant(value);
    if (instant === null) return null;
    const date = new Date(instant + 10 * 3600 * 1000).toISOString().slice(0, 10);
    return isCalendarDate(date) ? date : null;
  }
  return null;
}

const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const recordOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * Validates one page of v1 transactions for `accountId`. Any malformed row refuses the whole page: no financial row is
 * silently dropped as unreadable. Valid zero-amount rows are counted in `skipped` and left out.
 */
export function normaliseTransactions(raw: unknown, accountId: string): { transactions: FeedTransaction[]; skipped: number } {
  if (!Array.isArray(raw)) throw new RedbarkError('The bank feed provider returned an invalid transaction page.');
  const transactions: FeedTransaction[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const item of raw) {
    const record = recordOf(item);
    if (!record) throw new RedbarkError('The bank feed provider returned an invalid transaction record.');
    const id = str(record.id), cents = dollarsToCents(record.amount), date = feedDate(record);
    const status = record.status, direction = record.direction, currency = record.currency;
    const currencyOk = currency === undefined || currency === null || (typeof currency === 'string' && currency.toUpperCase() === 'AUD');
    if (
      !id || id !== record.id || id.length > 150 || seen.has(id) || record.accountId !== accountId || cents === null || !date ||
      (status !== 'posted' && status !== 'pending') || !currencyOk
    ) {
      throw new RedbarkError('The bank feed provider returned a transaction that breaks the money contract.');
    }
    // `direction` checks the signed amount; it never rewrites the sign.
    if (
      direction !== undefined && direction !== null &&
      ((direction !== 'debit' && direction !== 'credit') || (cents !== 0 && (direction === 'debit') !== cents < 0))
    ) {
      throw new RedbarkError('The bank feed provider returned a transaction whose direction contradicts its amount.');
    }
    seen.add(id);
    if (cents === 0) {
      skipped++;
      continue;
    }
    const description = (str(record.description) ?? str(record.extendedDescription) ?? str(record.merchantName) ?? 'Bank transaction').slice(0, 1000);
    transactions.push({
      id,
      accountId,
      date,
      description,
      reference: str(record.reference)?.slice(0, 500) ?? null,
      category: str(record.category)?.slice(0, 200) ?? null,
      cents,
      status,
      raw: record,
    });
  }
  return { transactions, skipped };
}

/** Accounts on active banking connections only; an account whose connection is missing is dropped, not assumed. */
export function normaliseAccounts(accounts: unknown, connections: unknown): FeedAccount[] {
  const active = new Map<string, Record<string, unknown>>();
  for (const item of Array.isArray(connections) ? connections : []) {
    const record = recordOf(item);
    if (!record) continue;
    const id = str(record.id);
    if (id && record.category === 'banking' && str(record.status) === 'active') active.set(id, record);
  }
  const result: FeedAccount[] = [];
  for (const item of Array.isArray(accounts) ? accounts : []) {
    const record = recordOf(item);
    if (!record) continue;
    const id = str(record.id), connectionId = str(record.connectionId);
    if (!id || !connectionId || !active.has(connectionId)) continue;
    result.push({
      externalAccountId: id,
      connectionId,
      name: str(record.name) ?? 'Bank account',
      institution: str(record.institutionName) ?? str(active.get(connectionId)?.institutionName),
      accountNumber: str(record.accountNumber),
      currency: str(record.currency),
      accountType: str(record.type),
    });
  }
  return result.sort((left, right) =>
    (left.institution ?? '').localeCompare(right.institution ?? '') || left.name.localeCompare(right.name) ||
    (left.accountNumber ?? '').localeCompare(right.accountNumber ?? '')
  );
}

export type BankAccountType = 'checking' | 'savings' | 'credit_card' | 'loan' | 'investment' | 'other';

/** The app's bank account types from Redbark's free-text account type. Unknown types are 'other', never guessed. */
export function mapAccountType(type: string | null): BankAccountType {
  const value = (type ?? '').toLowerCase();
  if (/credit/.test(value)) return 'credit_card';
  if (/loan|mortgage/.test(value)) return 'loan';
  if (/saving/.test(value)) return 'savings';
  if (/transaction|everyday|cheque|checking|current/.test(value)) return 'checking';
  if (/invest|term|deposit/.test(value)) return 'investment';
  return 'other';
}

/** The last four digits of the provider's (already masked) account number. */
export function lastFour(accountNumber: string | null): string | null {
  const digits = (accountNumber ?? '').replace(/\D/g, '');
  return digits ? digits.slice(-4) : null;
}

// HTTP Retry-After: whole seconds or the IMF-fixdate form. Anything else leaves ordinary backoff in force.
function retryDeadline(header: string | null, now: number): number | null {
  if (!header) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) {
    const deadline = now + Number(value) * 1000;
    return Number.isSafeInteger(deadline) ? deadline : null;
  }
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return null;
  const deadline = Date.parse(value);
  return Number.isSafeInteger(deadline) && new Date(deadline).toUTCString() === value ? deadline : null;
}

// Bound the body before parsing it, so a runaway response cannot exhaust the function's memory.
async function boundedJson(response: Response): Promise<unknown> {
  const tooLarge = () => new RedbarkError('The bank feed provider response exceeds the 4 MiB safety limit.');
  const declared = response.headers.get('Content-Length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) throw new RedbarkError('The bank feed provider returned an empty response.');
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_RESPONSE_BYTES);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      bytes.set(value, length);
      length += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
  } catch {
    throw new RedbarkError('The bank feed provider returned an unreadable response.');
  }
}

export interface RedbarkClientOptions {
  now?: () => number;
  timeoutMs?: number;
}

export function createRedbarkClient(apiKey: string, fetchImpl: typeof fetch = fetch, options: RedbarkClientOptions = {}): RedbarkClient {
  if (!apiKey) throw new RedbarkError('The bank feed is not configured on the server.');
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const get = async (path: string): Promise<Record<string, unknown>> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(REDBARK_API_BASE + path, {
          headers: { Authorization: 'Bearer ' + apiKey, 'Redbark-Version': REDBARK_API_VERSION, Accept: 'application/json' },
          signal: controller.signal,
        });
      } catch {
        throw new RedbarkError('Could not reach the bank feed provider.');
      }
      const reject = async (message: string, extra: { truncated?: boolean; retryAt?: number | null } = {}): Promise<never> => {
        await response.body?.cancel().catch(() => undefined);
        throw new RedbarkError(message, extra);
      };
      if (response.status === 401 || response.status === 403) await reject('The bank feed provider rejected the server key.');
      if (!response.ok) {
        const retryAt = response.status === 429 || response.status === 503 ? retryDeadline(response.headers.get('Retry-After'), now()) : null;
        await reject(`The bank feed provider returned HTTP ${response.status}.`, { retryAt });
      }
      if (response.headers.get('X-Redbark-Truncated')?.toLowerCase() === 'true') {
        await reject('The bank feed provider truncated the requested history.', { truncated: true });
      }
      const body = recordOf(await boundedJson(response));
      if (!body || body.data === undefined) throw new RedbarkError('The bank feed provider returned no data.');
      return body;
    } finally {
      clearTimeout(timer);
    }
  };

  const pageAt = async (path: string, offset: number): Promise<{ data: unknown[]; hasMore: boolean }> => {
    const body = await get(path);
    const meta = recordOf(body.pagination);
    if (
      !Array.isArray(body.data) || body.data.length > REDBARK_PAGE_LIMIT || !meta || typeof meta.hasMore !== 'boolean' ||
      meta.offset !== offset || meta.limit !== REDBARK_PAGE_LIMIT || !Number.isSafeInteger(meta.total) ||
      Number(meta.total) < offset + body.data.length || (!meta.hasMore && meta.total !== offset + body.data.length)
    ) {
      throw new RedbarkError('The bank feed provider returned invalid pagination.');
    }
    if (meta.hasMore && body.data.length === 0) throw new RedbarkError('The bank feed provider paging stalled.');
    return { data: body.data, hasMore: meta.hasMore };
  };

  const uniqueIds = (rows: unknown[], seen: Set<string>, what: string) => {
    for (const item of rows) {
      const record = recordOf(item);
      if (!record || typeof record.id !== 'string' || !record.id.trim() || seen.has(record.id)) {
        throw new RedbarkError(`The bank feed provider returned an invalid or repeated ${what}.`);
      }
      seen.add(record.id);
    }
  };

  const list = async (path: string): Promise<unknown[]> => {
    const rows: unknown[] = [];
    const seen = new Set<string>();
    for (let offset = 0, page = 0; page < MAX_LIST_PAGES; page++) {
      const { data, hasMore } = await pageAt(`${path}?limit=${REDBARK_PAGE_LIMIT}&offset=${offset}`, offset);
      uniqueIds(data, seen, 'account');
      rows.push(...data);
      if (!hasMore) return rows;
      offset += data.length;
    }
    throw new RedbarkError('The bank feed provider list is too long to read.');
  };

  return {
    async accounts() {
      const [accounts, connections] = await Promise.all([list('/accounts'), get('/connections')]);
      if (!Array.isArray(connections.data)) throw new RedbarkError('The bank feed provider returned an invalid connection list.');
      uniqueIds(connections.data, new Set(), 'connection');
      return normaliseAccounts(accounts, connections.data);
    },

    async balance(externalAccountId) {
      const { data } = await get(`/balances?accountIds=${encodeURIComponent(externalAccountId)}`);
      if (!Array.isArray(data) || data.length > 1 || data.some((item) => recordOf(item)?.accountId !== externalAccountId)) {
        throw new RedbarkError('The bank feed provider returned an invalid balance list.');
      }
      const record = recordOf(data[0]);
      if (!record) return null;
      if (record.freshness !== undefined && !['fresh', 'stale', 'unavailable'].includes(String(record.freshness))) {
        throw new RedbarkError('The bank feed provider returned invalid balance freshness.');
      }
      if (record.currentBalance === null || record.freshness === 'stale' || record.freshness === 'unavailable') return null;
      const current = dollarsToCents(record.currentBalance);
      const hasAvailable = record.availableBalance !== undefined && record.availableBalance !== null;
      const available = hasAvailable ? dollarsToCents(record.availableBalance) : null;
      if (current === null || record.currency !== 'AUD' || (hasAvailable && available === null)) {
        throw new RedbarkError('The bank feed provider returned a balance that breaks the money contract.');
      }
      // Never invent an observation time; an old or future-dated observation does not replace the stored balance.
      const instant = feedInstant(record.observedAt), at = now();
      if (instant === null || instant > at + 5 * 60_000 || at - instant >= 4 * 3600_000) return null;
      return { currentCents: current, availableCents: available, observedAt: record.observedAt as string };
    },

    async transactions(externalAccountId, connectionId, from, offset, to) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new RedbarkError('Invalid bank feed offset.');
      const params = new URLSearchParams({
        connectionId,
        accountId: externalAccountId,
        from,
        ...(to ? { to } : {}),
        limit: String(REDBARK_PAGE_LIMIT),
        offset: String(offset),
      });
      const { data, hasMore } = await pageAt(`/transactions?${params}`, offset);
      return { ...normaliseTransactions(data, externalAccountId), hasMore };
    },
  };
}
