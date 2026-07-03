/**
 * generic_api adapter — delivers a bill payload to an org-configured HTTPS
 * endpoint with an HMAC-SHA256 signature so the receiver can verify authenticity.
 *
 * Config lives in public.receipt_sync_endpoints (service-role only; holds the
 * signing secret). If no enabled endpoint is configured for the org, the caller
 * should treat this as a permanent skip ("not configured yet"), NOT a failure.
 *
 * Signature: header `X-Looplet-Signature: sha256=<hex>` over the exact request
 * body, plus `X-Looplet-Timestamp` (unix seconds) to let receivers reject replays.
 */

// Minimal structural type for the one query this adapter runs. Declared locally
// (rather than importing SupabaseClient from the esm.sh URL) so the module has
// ZERO external type deps and can be imported from both the Deno edge runtime
// AND the Node/vitest test context (tsc -b can't resolve a URL import).
// The adapter only needs `from(...)`; the query builder it returns is treated
// opaquely (the real Deno SupabaseClient satisfies this, and so does a test
// double) and its row result is narrowed with an explicit type at the call
// site. Declared locally so there is NO URL import for tsc -b to choke on.
interface SupabaseLike {
  from: (table: string) => unknown;
}

interface EndpointRow {
  endpoint_url?: string;
  signing_secret?: string;
  is_enabled?: boolean;
}
interface EndpointQuery {
  select: (cols: string) => EndpointQuery;
  eq: (col: string, val: unknown) => EndpointQuery;
  maybeSingle: () => Promise<{ data: EndpointRow | null }>;
}

export interface GenericApiBill {
  id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  total_inc_gst_cents: number | null;
  gst_cents: number | null;
  subtotal_ex_gst_cents: number | null;
  currency_code: string;
  supplier_name_raw: string | null;
  job_id: string | null;
  job_reference_raw: string | null;
  line_items?: {
    description: string;
    quantity: number;
    unit_price_cents: number;
    total_cents: number;
    gst_cents: number;
  }[];
}

export interface GenericApiArgs {
  admin: SupabaseLike;
  organizationId: string;
  bill: GenericApiBill;
  job: { id: string; job_number: string; name: string };
  receiptEventId: string;
  /** Override the current time (unix seconds) — tests only. */
  nowSeconds?: number;
}

export interface GenericApiResult {
  delivered: boolean;
  endpointUrl: string;
  status: number;
}

/** Raised when no enabled generic_api endpoint is configured for the org. */
export class GenericApiNotConfigured extends Error {
  constructor() {
    super('Generic API endpoint is not configured yet.');
    this.name = 'GenericApiNotConfigured';
  }
}

/** Raised when the configured endpoint URL is not a permitted delivery target. */
export class GenericApiUnsafeEndpoint extends Error {
  constructor(reason: string) {
    super(`Generic API endpoint is not a permitted delivery target: ${reason}`);
    this.name = 'GenericApiUnsafeEndpoint';
  }
}

/**
 * Validate an org-configured delivery URL before we POST bill data to it. The
 * adapter runs inside a cloud edge function, so it must never be used to deliver
 * over plaintext or to pivot at internal infrastructure (SSRF). We require a
 * public https:// URL and reject loopback, link-local / cloud-metadata, and
 * RFC1918 private hosts. Returns the parsed URL on success; throws otherwise.
 */
export function assertDeliverableEndpoint(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new GenericApiUnsafeEndpoint('malformed URL');
  }
  if (url.protocol !== 'https:') {
    throw new GenericApiUnsafeEndpoint('must use https');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const blockedExact = new Set([
    'localhost',
    '0.0.0.0',
    '::1',
    '::',
    'metadata',
    'metadata.google.internal',
  ]);
  const isBlocked =
    blockedExact.has(host) ||
    host.endsWith('.localhost') ||
    /^127\./.test(host) || // loopback
    /^169\.254\./.test(host) || // link-local (incl. 169.254.169.254 cloud metadata)
    /^10\./.test(host) || // RFC1918
    /^192\.168\./.test(host) || // RFC1918
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || // RFC1918 172.16/12
    /^(?:fc|fd)[0-9a-f]{2}:/.test(host) || // IPv6 ULA fc00::/7
    /^fe80:/.test(host); // IPv6 link-local
  if (isBlocked) {
    throw new GenericApiUnsafeEndpoint('internal or non-public host');
  }
  return url;
}

export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function buildGenericApiBody(args: GenericApiArgs): string {
  const { bill, job, receiptEventId, organizationId } = args;
  return JSON.stringify({
    type: 'receipt.bill.synced',
    organization_id: organizationId,
    receipt_event_id: receiptEventId,
    bill: {
      id: bill.id,
      invoice_number: bill.invoice_number,
      invoice_date: bill.invoice_date,
      due_date: bill.due_date,
      currency: bill.currency_code || 'AUD',
      supplier_name: bill.supplier_name_raw,
      total_inc_gst_cents: bill.total_inc_gst_cents,
      gst_cents: bill.gst_cents,
      subtotal_ex_gst_cents: bill.subtotal_ex_gst_cents,
      job: { id: job.id, number: job.job_number, name: job.name },
      line_items: (bill.line_items ?? []).map((li) => ({
        description: li.description,
        quantity: li.quantity,
        unit_price_cents: li.unit_price_cents,
        total_cents: li.total_cents,
        gst_cents: li.gst_cents,
      })),
    },
  });
}

export async function pushBillToGenericApi(args: GenericApiArgs): Promise<GenericApiResult> {
  const query = args.admin.from('receipt_sync_endpoints') as EndpointQuery;
  const { data: endpoint } = await query
    .select('endpoint_url, signing_secret, is_enabled')
    .eq('organization_id', args.organizationId)
    .eq('provider', 'generic_api')
    .eq('is_enabled', true)
    .maybeSingle();

  if (!endpoint?.endpoint_url || !endpoint.signing_secret) {
    throw new GenericApiNotConfigured();
  }

  // Never deliver over plaintext or to an internal/SSRF target — the URL is
  // org-configured but we run inside a cloud edge function.
  const safeUrl = assertDeliverableEndpoint(endpoint.endpoint_url);

  const body = buildGenericApiBody(args);
  const timestamp = String(args.nowSeconds ?? Math.floor(Date.now() / 1000));
  const signature = await hmacSha256Hex(endpoint.signing_secret, `${timestamp}.${body}`);

  // Bound the request: a hanging endpoint would otherwise stall the whole sequential
  // sync drain. Abort throws → the dispatcher treats it as a retryable failure.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(safeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Looplet-Timestamp': timestamp,
        'X-Looplet-Signature': `sha256=${signature}`,
        // Stable across retries so a lost response doesn't create a duplicate bill at
        // the receiver — receivers should dedup on this key.
        'X-Looplet-Idempotency-Key': args.receiptEventId,
      },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    // Transient/endpoint error → let the caller mark it failed (retryable).
    throw new Error(`Generic API endpoint returned ${response.status}`);
  }

  return { delivered: true, endpointUrl: endpoint.endpoint_url, status: response.status };
}
