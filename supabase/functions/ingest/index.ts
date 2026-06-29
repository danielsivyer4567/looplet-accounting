// Edge function: ingest  (EPIC F — F2, finished)
// Generic external ingestion endpoint so ANY source can push records in.
//   POST { type: 'bill' | 'bank_transaction' | 'invoice', payload: {...} }
//
// Authenticated by an external API key (NEVER the raw service-role key at the
// edge). Writes under service-role AFTER pinning organization_id to the key's
// org — org is never trusted from the body. Re-pushes are idempotent (dedupe),
// and pushed records get the SAME auto-routing as the Gmail/CSV importers:
//   - bills run through routeBill (auto-attach / suggest / queue) + intake rules
//   - bank_transactions are deduped on (bank_account_id, external_id) and fed to
//     the intake-routing engine, exactly like bank-sync.
//
// SCOPE ENFORCEMENT (write path):
//   Every write is gated by the key's scopes BEFORE any DB mutation: a `bill`
//   push requires `write:bills`, `bank_transaction` requires `write:bank`,
//   `invoice` requires `write:invoices` (see SCOPE_FOR + hasScope below). A key
//   that lacks the scope is rejected 403 and never touches the table. This is
//   the authoritative write-side enforcement: the gateway-minted PostgREST JWT
//   intentionally does NOT carry per-table write authority derived from scopes,
//   so writes must come through THIS function to be scope-checked.
//
// NOTE (read path): the api-gateway mints a `role=connector` org-scoped JWT
//   for PostgREST. The connector Postgres role is SELECT-only and RLS scopes it
//   to the key's single org, but it grants FULL-ORG READ to ANY valid key
//   regardless of the key's scopes — read scopes are not currently enforced at
//   the PostgREST layer. Treat any issued key as able to read all of its org's
//   data over /rest/v1. Do not issue keys to parties who should not see the
//   whole org; write authority is the scoped, enforced boundary. (Tracked for a
//   future RLS read-scope claim.)
//
// REQUIRES: supabase/config.toml -> [functions.ingest] verify_jwt = false
import {
  allowAnonRequest,
  authenticateApiKey,
  clientIp,
  enforceRateLimit,
  hasScope,
  logApiRequest,
  serviceClient,
  sha256Hex,
  shouldLogAnon,
} from '../_shared/apiKeys.ts';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { routeBill } from '../_shared/bills/router.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SCOPE_FOR: Record<string, string> = {
  bill: 'write:bills',
  bank_transaction: 'write:bank',
  invoice: 'write:invoices',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const ip = clientIp(req);
  const ctx = await authenticateApiKey(req.headers.get('authorization'));

  if (!ctx) {
    // Throttle UNauthenticated traffic only (F4). authenticateApiKey does no DB
    // work for a missing/malformed header and at most one indexed lookup for a
    // well-formed-but-invalid key, so this caps anon/bad-key floods without ever
    // 429-ing a legitimate connector — authenticated keys are governed solely by
    // the per-key DB limiter below.
    if (!allowAnonRequest(ip)) {
      return json({ error: 'rate_limited' }, 429);
    }
    // Cap anonymous 401 logging so bad keys can't flood the table.
    if (shouldLogAnon(ip)) {
      await logApiRequest(serviceClient(), {
        organizationId: null,
        apiKeyId: null,
        keyPrefix: null,
        endpoint: 'ingest',
        method: req.method,
        status: 401,
      });
    }
    return json({ error: 'invalid_api_key' }, 401);
  }

  const db = serviceClient();

  // Per-key rate limit (shared with the gateway's ceiling).
  if (!(await enforceRateLimit(db, ctx.keyId))) {
    await logApiRequest(db, {
      organizationId: ctx.organizationId,
      apiKeyId: ctx.keyId,
      keyPrefix: ctx.keyPrefix,
      endpoint: 'ingest',
      method: req.method,
      status: 429,
    });
    return json({ error: 'rate_limited' }, 429);
  }

  let body: { type?: string; payload?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    await log(db, ctx, null, 400);
    return json({ error: 'invalid_json' }, 400);
  }

  const type = body.type ?? '';
  const payload = body.payload;
  if (!payload || typeof payload !== 'object' || !(type in SCOPE_FOR)) {
    await log(db, ctx, type || null, 400);
    return json({ error: 'unsupported_type' }, 400);
  }
  if (!hasScope(ctx, SCOPE_FOR[type])) {
    await log(db, ctx, type, 403);
    return json({ error: 'insufficient_scope' }, 403);
  }

  const orgId = ctx.organizationId; // pinned from the key — never from body

  try {
    let result: { status: number; body: unknown };
    if (type === 'bill') {
      result = await ingestBill(db, orgId, payload);
    } else if (type === 'bank_transaction') {
      result = await ingestBankTransaction(db, orgId, payload);
    } else {
      result = await ingestInvoice(db, orgId, payload);
    }
    await log(db, ctx, type, result.status);
    return json(result.body, result.status);
  } catch (err) {
    // ValidationError carries a caller-safe message (e.g. "customer_id is
    // required"); anything else (raw DB/Postgres errors) is logged server-side
    // and returned as a generic message so we never disclose schema internals.
    await log(db, ctx, type, 400);
    if (err instanceof ValidationError) {
      return json({ error: err.message }, 400);
    }
    console.error('[ingest] write failed', {
      type,
      organizationId: orgId,
      keyPrefix: ctx.keyPrefix,
      detail: err instanceof Error ? err.message : String(err),
    });
    return json({ error: 'ingest_failed' }, 400);
  }
});

// Caller-safe validation error: its message IS returned to the client. Raw DB
// errors are thrown as plain Error and never surfaced (see catch above).
class ValidationError extends Error {}

function log(
  db: SupabaseClient,
  ctx: { organizationId: string; keyId: string; keyPrefix: string },
  type: string | null,
  status: number,
) {
  return logApiRequest(db, {
    organizationId: ctx.organizationId,
    apiKeyId: ctx.keyId,
    keyPrefix: ctx.keyPrefix,
    endpoint: 'ingest',
    method: 'POST',
    ingestType: type,
    status,
  });
}

// ---------------------------------------------------------------------------
// Handlers — each pins organization_id, dedupes, and triggers the same
// auto-routing the human importers use.
// ---------------------------------------------------------------------------

// Whitelisted, writable bill columns from the API. organization_id/source/
// status are forced; computed/internal columns are never accepted from callers.
const BILL_FIELDS = [
  'supplier_id',
  'job_id',
  'supplier_name_raw',
  'supplier_abn',
  'invoice_number',
  'invoice_date',
  'due_date',
  'total_inc_gst_cents',
  'gst_cents',
  'subtotal_ex_gst_cents',
  'currency_code',
  'job_reference_raw',
  'notes',
  'raw_extracted',
] as const;

// Build a stable, canonical dedupe hash from ONLY the whitelisted, persisted
// fields (sorted keys, undefined/null dropped) plus the org. This is immune to
// key order, whitespace, and any non-persisted junk a caller includes in the
// payload — two semantically-identical pushes always collide.
async function canonicalContentHash(
  orgId: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const canon: Record<string, unknown> = {};
  for (const f of BILL_FIELDS) {
    if (payload[f] !== undefined && payload[f] !== null) canon[f] = payload[f];
  }
  const sortedKeys = Object.keys(canon).sort();
  const stable = sortedKeys.map((k) => [k, canon[k]] as const);
  return await sha256Hex(JSON.stringify({ o: orgId, f: stable }));
}

async function ingestBill(db: SupabaseClient, orgId: string, payload: Record<string, unknown>) {
  // Dedupe key: stable hash of the org + the canonicalized whitelisted bill
  // fields. Mirrors bills-extract's content_sha256 cache so a re-push is a no-op.
  const contentSha256 = await canonicalContentHash(orgId, payload);

  // Re-push? Return the existing row (idempotent).
  const { data: existing } = await db
    .from('bills')
    .select('id, status')
    .eq('organization_id', orgId)
    .eq('content_sha256', contentSha256)
    .is('deleted_at', null)
    .maybeSingle();
  if (existing) {
    return { status: 200, body: { ok: true, id: existing.id, type: 'bill', deduped: true } };
  }

  const row: Record<string, unknown> = {
    organization_id: orgId,
    source: 'api',
    status: 'received',
    content_sha256: contentSha256,
    // NOT NULL file-evidence columns: callers pushing structured data rarely
    // have a file, so synthesise sentinels (a real upload uses bills-extract).
    storage_key: (payload.storage_key as string) ?? `api/${contentSha256}`,
    original_filename: (payload.original_filename as string) ?? 'api-ingest.json',
    mime_type: (payload.mime_type as string) ?? 'application/json',
  };
  for (const f of BILL_FIELDS) {
    if (payload[f] !== undefined) row[f] = payload[f];
  }

  const { data: inserted, error } = await db.from('bills').insert(row).select('id').single();
  if (error) {
    // UNIQUE(org, supplier_id, invoice_number) collision → treat as duplicate.
    if ((error as { code?: string }).code === '23505') {
      return { status: 200, body: { ok: true, id: null, type: 'bill', deduped: true } };
    }
    throw new Error(error.message);
  }

  // Same auto-routing as the Gmail/upload path: score the job ref, auto-attach /
  // suggest / queue, then let the intake-rules engine pick it up.
  let routing: unknown = null;
  try {
    routing = await routeBill({
      admin: db,
      billId: inserted.id,
      organizationId: orgId,
      jobReferenceRaw: (payload.job_reference_raw as string) ?? null,
      extractedConfidence: 'medium',
    });
  } catch {
    /* routing is best-effort; the bill is safely persisted */
  }

  fireIntakeRouting(orgId, 'bill', [inserted.id]);

  return {
    status: 201,
    body: { ok: true, id: inserted.id, type: 'bill', deduped: false, routing },
  };
}

const BANK_TXN_FIELDS = [
  'posted_at',
  'description',
  'amount_cents',
  'running_balance_cents',
  'reference',
  'category_external',
  'raw',
] as const;

async function ingestBankTransaction(
  db: SupabaseClient,
  orgId: string,
  payload: Record<string, unknown>,
) {
  const bankAccountId = payload.bank_account_id as string | undefined;
  const externalId = payload.external_id as string | undefined;
  if (!bankAccountId || !externalId) {
    throw new ValidationError('bank_account_id and external_id are required');
  }

  // The bank account must belong to the key's org (tenant pin).
  const { data: acct } = await db
    .from('bank_accounts')
    .select('id')
    .eq('id', bankAccountId)
    .eq('organization_id', orgId)
    .maybeSingle();
  if (!acct) throw new ValidationError('bank_account not found for this organization');

  const row: Record<string, unknown> = {
    organization_id: orgId,
    bank_account_id: bankAccountId,
    external_id: externalId,
    description: (payload.description as string) ?? '(no description)',
  };
  for (const f of BANK_TXN_FIELDS) {
    if (payload[f] !== undefined) row[f] = payload[f];
  }

  // Idempotent on (bank_account_id, external_id) — identical to bank-sync.
  const { data: txn, error } = await db
    .from('bank_transactions')
    .upsert(row, { onConflict: 'bank_account_id,external_id', ignoreDuplicates: false })
    .select('id')
    .single();
  if (error) throw new Error(error.message);

  fireIntakeRouting(orgId, 'bank_transaction', [txn.id]);

  return { status: 201, body: { ok: true, id: txn.id, type: 'bank_transaction' } };
}

// NOTE: `status` is deliberately NOT writable from the API — invoices always
// start at the DB default ('draft'), exactly like bills force 'received'. A
// caller must not be able to mint an invoice already 'paid'/'void'. Status
// transitions go through the authenticated app/RPCs, not raw ingest.
const INVOICE_FIELDS = [
  'customer_id',
  'job_id',
  'issue_date',
  'due_date',
  'terms_days',
  'subtotal_ex_gst_cents',
  'gst_cents',
  'total_inc_gst_cents',
  'currency_code',
  'notes',
] as const;

async function ingestInvoice(db: SupabaseClient, orgId: string, payload: Record<string, unknown>) {
  const invoiceNumber = payload.invoice_number as string | undefined;
  const customerId = payload.customer_id as string | undefined;
  if (!invoiceNumber) throw new ValidationError('invoice_number is required');
  if (!customerId) throw new ValidationError('customer_id is required');
  if (!payload.due_date) throw new ValidationError('due_date is required');

  // Customer must belong to the key's org.
  const { data: cust } = await db
    .from('customers')
    .select('id')
    .eq('id', customerId)
    .eq('organization_id', orgId)
    .maybeSingle();
  if (!cust) throw new ValidationError('customer not found for this organization');

  // Dedupe on UNIQUE(org, invoice_number): re-push returns the existing row.
  const { data: existing } = await db
    .from('invoices')
    .select('id')
    .eq('organization_id', orgId)
    .eq('invoice_number', invoiceNumber)
    .is('deleted_at', null)
    .maybeSingle();
  if (existing) {
    return { status: 200, body: { ok: true, id: existing.id, type: 'invoice', deduped: true } };
  }

  const row: Record<string, unknown> = {
    organization_id: orgId,
    invoice_number: invoiceNumber,
    customer_id: customerId,
  };
  for (const f of INVOICE_FIELDS) {
    if (payload[f] !== undefined) row[f] = payload[f];
  }

  const { data: inserted, error } = await db.from('invoices').insert(row).select('id').single();
  if (error) {
    if ((error as { code?: string }).code === '23505') {
      return { status: 200, body: { ok: true, id: null, type: 'invoice', deduped: true } };
    }
    throw new Error(error.message);
  }

  return { status: 201, body: { ok: true, id: inserted.id, type: 'invoice', deduped: false } };
}

// Fire-and-forget into intake-routing-apply — mirrors bank-sync. Never blocks.
function fireIntakeRouting(
  orgId: string,
  target: 'bill' | 'bank_transaction',
  targetIds: string[],
) {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey || targetIds.length === 0) return;
  void fetch(`${url}/functions/v1/intake-routing-apply`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ organization_id: orgId, target, target_ids: targetIds }),
  }).catch(() => {
    /* routing is non-critical */
  });
}
