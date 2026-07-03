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
// TRIGGER (A4): this is an INBOUND-PUSH endpoint — its "trigger" is the external
// connector calling it (api-gateway mints the token; the caller POSTs here). There
// is no internal cron by design. A `document` push enqueues a `bill_extract`
// automation job (see ingestDocument), which is how connector uploads feed the
// extraction queue (B1). Handler logic lives in ./handlers.ts so it is unit-tested
// (ingest/handlers.test.ts) independently of this Deno.serve shell.
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
// NOTE (read path): the api-gateway mints a `role=connector` org-scoped JWT for
//   PostgREST. RLS scopes it to the key's single org, but it grants FULL-ORG READ
//   to ANY valid key regardless of the key's scopes — read scopes are not
//   currently enforced at the PostgREST layer. Treat any issued key as able to
//   read all of its org's data over /rest/v1. The SELECT-only connector role
//   denies direct PostgREST writes; write authority is the scoped, enforced
//   boundary. (Tracked for a future RLS read-scope claim.)
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
  shouldLogAnon,
} from '../_shared/apiKeys.ts';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  ingestBankTransaction,
  ingestBill,
  ingestDocument,
  ingestInvoice,
  ingestPayment,
  ValidationError,
} from './handlers.ts';

const SCOPE_FOR: Record<string, string> = {
  bill: 'write:bills',
  bank_transaction: 'write:bank',
  invoice: 'write:invoices',
  document: 'write:documents',
  payment: 'write:payments',
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

  // Idempotency-Key header — honoured for all types; required for document/payment.
  const idempotencyKey = req.headers.get('Idempotency-Key') ?? undefined;

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
    } else if (type === 'document') {
      result = await ingestDocument(db, orgId, payload, idempotencyKey);
    } else if (type === 'payment') {
      result = await ingestPayment(db, orgId, payload, idempotencyKey);
    } else {
      result = await ingestInvoice(db, orgId, payload);
    }
    await log(db, ctx, type, result.status);
    return json(result.body, result.status);
  } catch (err) {
    // ValidationError carries a caller-safe message (e.g. "customer_id is
    // required"); anything else (raw DB/Postgres errors) is logged server-side
    // and returned as a generic message so we never disclose schema internals.
    if (err instanceof ValidationError) {
      await log(db, ctx, type, 400);
      return json({ error: err.message }, 400);
    }
    await log(db, ctx, type, 500);
    console.error('[ingest] write failed', {
      type,
      organizationId: orgId,
      keyPrefix: ctx.keyPrefix,
      detail: err instanceof Error ? err.message : String(err),
    });
    return json({ error: 'ingest_failed' }, 500);
  }
});

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
