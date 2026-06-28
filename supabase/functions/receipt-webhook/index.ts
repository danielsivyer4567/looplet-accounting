/**
 * receipt-webhook — structured Receipt Hub ingestion.
 *
 * Auth modes:
 * - External POS: Authorization: Bearer llp_<prefix>.<secret> with write:receipts.
 * - App simulator: signed-in Supabase JWT plus organization_id in the body.
 *
 * The receipt identity token is separate from caller auth. It identifies the
 * phone/pass/tag used at checkout and is stored hashed in receipt_identities.
 */
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
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
import { requireEnv } from '../_shared/env.ts';
import {
  assertReceiptTenderIsFinal,
  assertReceiptPaymentReferencePresent,
  assertReceiptIdempotencySourcesConsistent,
  assertReceiptIsRetrySafe,
  assertReceiptLinesReliable,
  assertReceiptOriginalReferencePresent,
  assertReceiptOriginalReferenceResolved,
  assertReceiptPayloadSize,
  buildReceiptIdempotencyKey,
  isLoopletApiKeyAuthorization,
  isUniqueViolation,
  normalizeReceiptPaymentLast4,
  normalizeReceiptPurchaseAt,
  normalizeReceiptTaxBreakdown,
  parseReceiptEventType,
  parseReceiptSource,
  ReceiptValidationError,
  type ReceiptEventType,
  type ReceiptSource,
} from './posReliability.ts';

type SyncProvider = 'xero' | 'myob' | 'quickbooks' | 'generic_api';

interface ReceiptLine {
  description?: unknown;
  quantity?: unknown;
  unit_price_cents?: unknown;
  total_inc_gst_cents?: unknown;
  gst_cents?: unknown;
  category?: unknown;
}

interface ReceiptPayload {
  merchant?: {
    name?: unknown;
    abn?: unknown;
    external_id?: unknown;
  };
  receipt?: {
    number?: unknown;
    idempotency_key?: unknown;
    external_id?: unknown;
    external_event_id?: unknown;
    event_type?: unknown;
    original_receipt_number?: unknown;
    original_external_event_id?: unknown;
    purchase_at?: unknown;
    currency?: unknown;
    subtotal_ex_gst_cents?: unknown;
    gst_cents?: unknown;
    total_inc_gst_cents?: unknown;
    payment_method?: unknown;
    payment_last4?: unknown;
    payment_reference?: unknown;
    terminal_id?: unknown;
    store_id?: unknown;
    tender_status?: unknown;
    location?: unknown;
  };
  classification?: {
    business_use?: unknown;
    deductibility?: unknown;
    job_reference?: unknown;
    job_id?: unknown;
    category?: unknown;
    sync_targets?: unknown;
  };
  external_event_id?: unknown;
  line_items?: ReceiptLine[];
}

interface RequestBody {
  organization_id?: string;
  identity_token?: string;
  idempotency_key?: unknown;
  event_type?: unknown;
  source_channel?: ReceiptSource;
  payload?: ReceiptPayload;
  sync_targets?: SyncProvider[];
}

interface ExistingReceipt {
  id: string;
  bill_id: string | null;
  event_type: ReceiptEventType;
  related_receipt_event_id: string | null;
  idempotency_key: string | null;
  merchant_name: string | null;
  receipt_number: string | null;
  subtotal_ex_gst_cents: number | null;
  gst_cents: number | null;
  total_inc_gst_cents: number | null;
  payment_reference: string | null;
  payment_last4: string | null;
  purchase_at: string | null;
  terminal_id: string | null;
  store_id: string | null;
}

interface ReceiptIdentity {
  id: string;
  organization_id: string;
  status: string;
  revoked_at: string | null;
}

class ValidationError extends Error {}

export async function handleReceiptWebhookRequest(req: Request): Promise<Response> {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const admin = serviceClient();
  const auth = await resolveCaller(req, body, admin);
  if ('response' in auth) return auth.response;

  try {
    const result = await ingestReceipt(admin, auth.organizationId, body, req);
    await writeLog(admin, auth, 200);
    return json({ ok: true, ...result });
  } catch (err) {
    const validationError = err instanceof ValidationError || err instanceof ReceiptValidationError;
    const msg = validationError ? err.message : 'receipt_ingest_failed';
    if (!validationError) {
      console.error('[receipt-webhook] failed', {
        organizationId: auth.organizationId,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    await writeLog(admin, auth, validationError ? 400 : 500);
    return json({ ok: false, error: msg }, validationError ? 400 : 500);
  }
}

if (import.meta.main) {
  Deno.serve(handleReceiptWebhookRequest);
}

async function resolveCaller(
  req: Request,
  body: RequestBody,
  admin: SupabaseClient,
): Promise<
  | { mode: 'api_key'; organizationId: string; keyId: string; keyPrefix: string }
  | { mode: 'user_jwt'; organizationId: string }
  | { response: Response }
> {
  const authHeader = req.headers.get('authorization');
  const ip = clientIp(req);
  const apiCtx = await authenticateApiKey(authHeader);
  if (apiCtx) {
    if (!(await enforceRateLimit(admin, apiCtx.keyId))) {
      await logApiRequest(admin, {
        organizationId: apiCtx.organizationId,
        apiKeyId: apiCtx.keyId,
        keyPrefix: apiCtx.keyPrefix,
        endpoint: 'receipt-webhook',
        method: req.method,
        ingestType: 'receipt',
        status: 429,
      });
      return { response: json({ ok: false, error: 'rate_limited' }, 429) };
    }
    if (!hasScope(apiCtx, 'write:receipts')) {
      await logApiRequest(admin, {
        organizationId: apiCtx.organizationId,
        apiKeyId: apiCtx.keyId,
        keyPrefix: apiCtx.keyPrefix,
        endpoint: 'receipt-webhook',
        method: req.method,
        ingestType: 'receipt',
        status: 403,
      });
      return { response: json({ ok: false, error: 'insufficient_scope' }, 403) };
    }
    return {
      mode: 'api_key',
      organizationId: apiCtx.organizationId,
      keyId: apiCtx.keyId,
      keyPrefix: apiCtx.keyPrefix,
    };
  }

  if (isLoopletApiKeyAuthorization(authHeader)) {
    if (!allowAnonRequest(ip)) return { response: json({ ok: false, error: 'rate_limited' }, 429) };
    if (shouldLogAnon(ip)) {
      await logApiRequest(admin, {
        organizationId: null,
        apiKeyId: null,
        keyPrefix: null,
        endpoint: 'receipt-webhook',
        method: req.method,
        ingestType: 'receipt',
        status: 401,
      });
    }
    return { response: json({ ok: false, error: 'invalid_api_key' }, 401) };
  }

  if (!authHeader) {
    if (!allowAnonRequest(ip)) return { response: json({ ok: false, error: 'rate_limited' }, 429) };
    if (shouldLogAnon(ip)) {
      await logApiRequest(admin, {
        organizationId: null,
        apiKeyId: null,
        keyPrefix: null,
        endpoint: 'receipt-webhook',
        method: req.method,
        ingestType: 'receipt',
        status: 401,
      });
    }
    return { response: json({ ok: false, error: 'unauthorized' }, 401) };
  }

  if (!body.organization_id) {
    return { response: json({ ok: false, error: 'organization_id required for app simulator' }, 400) };
  }

  const userClient = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: org, error } = await userClient
    .from('organizations')
    .select('id')
    .eq('id', body.organization_id)
    .maybeSingle();
  if (error || !org) return { response: json({ ok: false, error: 'organization_not_accessible' }, 403) };
  return { mode: 'user_jwt', organizationId: body.organization_id };
}

async function ingestReceipt(admin: SupabaseClient, organizationId: string, body: RequestBody, req: Request) {
  if (!body.identity_token) throw new ValidationError('identity_token required');
  if (!body.payload) throw new ValidationError('payload required');

  assertReceiptPayloadSize(body.payload, req.headers.get('content-length'));
  const identity = await resolveReceiptIdentity(admin, organizationId, body.identity_token);
  const payload = body.payload;
  stripReceiptIdentitySecrets(payload);
  const eventType = parseReceiptEventType(body.event_type ?? payload.receipt?.event_type);
  const sourceChannel = parseReceiptSource(body.source_channel);
  const merchantNameRaw = asText(payload.merchant?.name);
  if (sourceChannel === 'pos' && (!merchantNameRaw || merchantNameRaw.length < 2)) {
    throw new ValidationError('merchant.name required for POS receipt ingestion');
  }
  const merchantName = merchantNameRaw ?? 'Unknown merchant';
  if (merchantName.length < 2) throw new ValidationError('merchant.name required');

  assertReceiptTenderIsFinal(eventType, payload.receipt?.tender_status, {
    required: sourceChannel === 'pos',
  });
  assertReceiptPaymentReferencePresent(payload.receipt?.payment_reference, {
    required: sourceChannel === 'pos',
  });
  const paymentLast4 = normalizeReceiptPaymentLast4(payload.receipt?.payment_last4);
  if (payload.receipt) {
    if (paymentLast4) {
      payload.receipt.payment_last4 = paymentLast4;
    } else {
      delete payload.receipt.payment_last4;
    }
  }
  const totalCents = asCents(payload.receipt?.total_inc_gst_cents);
  if (totalCents == null || totalCents < 0 || (eventType !== 'void' && totalCents === 0)) {
    throw new ValidationError(
      eventType === 'void'
        ? 'receipt.total_inc_gst_cents must be zero or greater'
        : 'receipt.total_inc_gst_cents must be greater than zero',
    );
  }
  const { gstCents, subtotalCents, gstEstimated } = normalizeReceiptTaxBreakdown(
    totalCents,
    payload.receipt?.gst_cents,
    payload.receipt?.subtotal_ex_gst_cents,
    { requireBothSupplied: sourceChannel === 'pos' },
  );
  const purchaseAt = normalizeReceiptPurchaseAt(payload.receipt?.purchase_at, {
    required: sourceChannel === 'pos',
  }) ?? new Date().toISOString();
  if (payload.receipt) payload.receipt.purchase_at = purchaseAt;
  const receiptNumber = asText(payload.receipt?.number);
  assertReceiptIdempotencySourcesConsistent(req.headers.get('idempotency-key'), body.idempotency_key, payload);
  const idempotencyKey = buildReceiptIdempotencyKey({
    headerValue: req.headers.get('idempotency-key'),
    bodyValue: body.idempotency_key,
    payload,
    merchantName,
    receiptNumber,
    eventType,
  });
  assertReceiptIsRetrySafe(idempotencyKey);
  assertReceiptLinesReliable(payload.line_items, totalCents, {
    requireItemised: sourceChannel === 'pos',
    requireLineGst: sourceChannel === 'pos',
    expectedGstCents: gstCents,
  });
  const classification = classifyReceipt(payload, merchantName, totalCents);
  const job = await resolveJob(admin, organizationId, classification.jobId, classification.jobReference);
  const originalReceiptNumber = asText(payload.receipt?.original_receipt_number);
  const originalExternalEventId = asText(payload.receipt?.original_external_event_id);
  assertReceiptOriginalReferencePresent(eventType, originalReceiptNumber, originalExternalEventId, {
    required: sourceChannel === 'pos',
  });
  const relatedReceipt = await findRelatedReceipt(admin, {
    organizationId,
    merchantName,
    originalReceiptNumber,
    originalExternalEventId,
  });
  assertReceiptOriginalReferenceResolved(eventType, Boolean(relatedReceipt), {
    required: sourceChannel === 'pos',
  });

  const existing = await findExistingReceipt(admin, {
    organizationId,
    sourceChannel,
    eventType,
    idempotencyKey,
    merchantName,
    receiptNumber,
  });
  if (existing) {
    assertExistingReceiptMatchesRetry(existing, {
      idempotencyKey,
      merchantName,
      receiptNumber,
      subtotalCents,
      gstCents,
      totalCents,
      paymentReference: asText(payload.receipt?.payment_reference),
      paymentLast4,
      purchaseAt,
      terminalId: asText(payload.receipt?.terminal_id),
      storeId: asText(payload.receipt?.store_id),
    });
    return existingReceiptResult(admin, identity.id, existing);
  }

  const eventInsert = {
    organization_id: organizationId,
    receipt_identity_id: identity.id,
    idempotency_key: idempotencyKey,
    event_type: eventType,
    related_receipt_event_id: relatedReceipt?.id ?? null,
    source_channel: sourceChannel,
    status: initialReceiptStatus(eventType, classification.businessUse),
    merchant_name: merchantName,
    merchant_abn: asText(payload.merchant?.abn),
    merchant_external_id: asText(payload.merchant?.external_id),
    receipt_number: receiptNumber,
    purchase_at: purchaseAt,
    location: asObject(payload.receipt?.location),
    subtotal_ex_gst_cents: subtotalCents,
    gst_cents: gstCents,
    total_inc_gst_cents: totalCents,
    currency_code: asCurrency(payload.receipt?.currency),
    payment_method: asText(payload.receipt?.payment_method),
    payment_last4: paymentLast4,
    payment_reference: asText(payload.receipt?.payment_reference),
    terminal_id: asText(payload.receipt?.terminal_id),
    store_id: asText(payload.receipt?.store_id),
    business_use: classification.businessUse,
    deductibility_status: classification.deductibility,
    job_reference_raw: classification.jobReference,
    raw_payload: payload,
    classification: {
      ...classification,
      jobId: job?.id ?? null,
      gstEstimated,
      reason: classification.reason,
    },
  };
  const { data: receiptEvent, error: eventErr } = await admin
    .from('receipt_events')
    .insert(eventInsert)
    .select('id, bill_id')
    .single();
  if (eventErr || !receiptEvent) {
    if (isUniqueViolation(eventErr)) {
      const duplicate = await findExistingReceipt(admin, {
        organizationId,
        sourceChannel,
        eventType,
        idempotencyKey,
        merchantName,
        receiptNumber,
      });
      if (duplicate) {
        assertExistingReceiptMatchesRetry(duplicate, {
          idempotencyKey,
          merchantName,
          receiptNumber,
          subtotalCents,
          gstCents,
          totalCents,
          paymentReference: asText(payload.receipt?.payment_reference),
          paymentLast4,
          purchaseAt,
          terminalId: asText(payload.receipt?.terminal_id),
          storeId: asText(payload.receipt?.store_id),
        });
        return existingReceiptResult(admin, identity.id, duplicate);
      }
    }
    throw new Error(eventErr?.message ?? 'receipt event insert failed');
  }

  const eventId = receiptEvent.id as string;
  let billId: string | null = null;
  try {
    const lineItems = normalizeLines(payload.line_items, totalCents, gstCents, classification.category);
    await insertReceiptLines(admin, organizationId, eventId, lineItems);

    if (eventType === 'sale' && classification.businessUse !== 'personal') {
      billId = await createBillFromReceipt(admin, {
        organizationId,
        eventId,
        jobId: job?.id ?? null,
        merchantName,
        merchantAbn: asText(payload.merchant?.abn),
        receiptNumber,
        purchaseAt,
        totalCents,
        gstCents,
        subtotalCents,
        gstEstimated,
        currency: asCurrency(payload.receipt?.currency),
        jobReference: classification.jobReference,
        payload,
        sourceChannel,
        lineItems,
      });
    }

    const auditPackageId = await createAuditPackage(admin, {
      organizationId,
      eventId,
      billId,
      storageKey: `receipt-hub/${organizationId}/${eventId}.json`,
      payload,
      classification,
      gstEstimated,
      sourceChannel,
      eventType,
      relatedReceiptEventId: relatedReceipt?.id ?? null,
    });
    const syncJobs = await queueSyncJobs(admin, {
      organizationId,
      eventId,
      billId,
      targets: eventType === 'sale' ? syncTargets(body, payload) : [],
      payload,
    });

    const { error: updateErr } = await admin.from('receipt_events').update({
      bill_id: billId,
      job_id: job?.id ?? null,
      status: finalReceiptStatus(eventType, classification.businessUse, classification.deductibility),
    }).eq('id', eventId);
    if (updateErr) throw new Error(updateErr.message);

    await markIdentityUsed(admin, identity.id);

    return {
      duplicate: false,
      event_type: eventType,
      receipt_event_id: eventId,
      related_receipt_event_id: relatedReceipt?.id ?? null,
      bill_id: billId,
      audit_package_id: auditPackageId,
      sync_jobs: syncJobs,
      classification: {
        business_use: classification.businessUse,
        deductibility_status: classification.deductibility,
        job_id: job?.id ?? null,
        job_reference: classification.jobReference,
        gst_estimated: gstEstimated,
        reason: classification.reason,
      },
    };
  } catch (error) {
    await cleanupFailedReceiptIngest(admin, { organizationId, eventId, billId });
    throw error;
  }
}

async function findExistingReceipt(
  admin: SupabaseClient,
  args: {
    organizationId: string;
    sourceChannel: ReceiptSource;
    eventType: ReceiptEventType;
    idempotencyKey: string;
    merchantName: string;
    receiptNumber: string | null;
  },
): Promise<ExistingReceipt | null> {
  const { data: byKey } = await admin
    .from('receipt_events')
    .select('id, bill_id, event_type, related_receipt_event_id, idempotency_key, merchant_name, receipt_number, subtotal_ex_gst_cents, gst_cents, total_inc_gst_cents, payment_reference, payment_last4, purchase_at, terminal_id, store_id')
    .eq('organization_id', args.organizationId)
    .eq('source_channel', args.sourceChannel)
    .eq('event_type', args.eventType)
    .eq('idempotency_key', args.idempotencyKey)
    .maybeSingle();
  if (byKey) return byKey as ExistingReceipt;

  if (!args.receiptNumber) return null;
  const { data: byReceiptNumber } = await admin
    .from('receipt_events')
    .select('id, bill_id, event_type, related_receipt_event_id, idempotency_key, merchant_name, receipt_number, subtotal_ex_gst_cents, gst_cents, total_inc_gst_cents, payment_reference, payment_last4, purchase_at, terminal_id, store_id')
    .eq('organization_id', args.organizationId)
    .eq('source_channel', args.sourceChannel)
    .eq('event_type', args.eventType)
    .eq('merchant_name', args.merchantName)
    .eq('receipt_number', args.receiptNumber)
    .maybeSingle();
  return (byReceiptNumber as ExistingReceipt | null) ?? null;
}

function assertExistingReceiptMatchesRetry(
  receipt: ExistingReceipt,
  expected: {
    idempotencyKey: string;
    merchantName: string;
    receiptNumber: string | null;
    subtotalCents: number;
    gstCents: number;
    totalCents: number;
    paymentReference: string | null;
    paymentLast4: string | null;
    purchaseAt: string;
    terminalId: string | null;
    storeId: string | null;
  },
) {
  const mismatches: string[] = [];
  if (receipt.idempotency_key && receipt.idempotency_key !== expected.idempotencyKey) {
    mismatches.push('idempotency_key');
  }
  if (receipt.merchant_name && receipt.merchant_name !== expected.merchantName) {
    mismatches.push('merchant.name');
  }
  if (receipt.receipt_number && expected.receiptNumber && receipt.receipt_number !== expected.receiptNumber) {
    mismatches.push('receipt.number');
  }
  if (receipt.subtotal_ex_gst_cents != null && Number(receipt.subtotal_ex_gst_cents) !== expected.subtotalCents) {
    mismatches.push('receipt.subtotal_ex_gst_cents');
  }
  if (receipt.gst_cents != null && Number(receipt.gst_cents) !== expected.gstCents) {
    mismatches.push('receipt.gst_cents');
  }
  if (Number(receipt.total_inc_gst_cents) !== expected.totalCents) {
    mismatches.push('receipt.total_inc_gst_cents');
  }
  if (receipt.payment_reference && expected.paymentReference && receipt.payment_reference !== expected.paymentReference) {
    mismatches.push('receipt.payment_reference');
  }
  if (receipt.payment_last4 && expected.paymentLast4 && receipt.payment_last4 !== expected.paymentLast4) {
    mismatches.push('receipt.payment_last4');
  }
  if (receipt.purchase_at && toIsoDate(receipt.purchase_at) !== expected.purchaseAt) {
    mismatches.push('receipt.purchase_at');
  }
  if (receipt.terminal_id && expected.terminalId && receipt.terminal_id !== expected.terminalId) {
    mismatches.push('receipt.terminal_id');
  }
  if (receipt.store_id && expected.storeId && receipt.store_id !== expected.storeId) {
    mismatches.push('receipt.store_id');
  }
  if (mismatches.length > 0) {
    throw new ValidationError(
      `idempotency key reused with different receipt payload fields: ${mismatches.join(', ')}`,
    );
  }
}

async function findRelatedReceipt(
  admin: SupabaseClient,
  args: {
    organizationId: string;
    merchantName: string;
    originalReceiptNumber: string | null;
    originalExternalEventId: string | null;
  },
): Promise<{ id: string; bill_id: string | null } | null> {
  if (args.originalExternalEventId) {
    const { data } = await admin
      .from('receipt_events')
      .select('id, bill_id')
      .eq('organization_id', args.organizationId)
      .eq('event_type', 'sale')
      .eq('idempotency_key', `explicit:${args.originalExternalEventId}`)
      .maybeSingle();
    if (data) return data as { id: string; bill_id: string | null };
  }

  if (!args.originalReceiptNumber) return null;
  const { data } = await admin
    .from('receipt_events')
    .select('id, bill_id')
    .eq('organization_id', args.organizationId)
    .eq('event_type', 'sale')
    .eq('merchant_name', args.merchantName)
    .eq('receipt_number', args.originalReceiptNumber)
    .maybeSingle();
  return (data as { id: string; bill_id: string | null } | null) ?? null;
}

async function existingReceiptResult(
  admin: SupabaseClient,
  identityId: string,
  receipt: ExistingReceipt,
) {
  await assertExistingReceiptComplete(admin, receipt);
  const { data: syncJobs } = await admin
    .from('receipt_sync_jobs')
    .select('id, provider, status')
    .eq('receipt_event_id', receipt.id)
    .order('created_at', { ascending: true });

  await markIdentityUsed(admin, identityId);
  return {
    duplicate: true,
    event_type: receipt.event_type,
    receipt_event_id: receipt.id,
    related_receipt_event_id: receipt.related_receipt_event_id,
    bill_id: receipt.bill_id,
    sync_jobs: syncJobs ?? [],
  };
}

async function assertExistingReceiptComplete(admin: SupabaseClient, receipt: ExistingReceipt) {
  const [lineCount, auditPackageCount] = await Promise.all([
    countRows(admin, 'receipt_event_line_items', 'receipt_event_id', receipt.id),
    countRows(admin, 'receipt_audit_packages', 'receipt_event_id', receipt.id),
  ]);
  const missing: string[] = [];
  if (lineCount < 1) missing.push('receipt_event_line_items');
  if (auditPackageCount < 1) missing.push('receipt_audit_packages');
  if (missing.length > 0) {
    throw new Error(`duplicate receipt retry found incomplete prior write: missing ${missing.join(', ')}`);
  }
}

async function countRows(admin: SupabaseClient, table: string, column: string, value: string): Promise<number> {
  const { count, error } = await admin
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq(column, value);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function cleanupFailedReceiptIngest(
  admin: SupabaseClient,
  args: { organizationId: string; eventId: string; billId: string | null },
) {
  const failures: string[] = [];
  for (const table of ['receipt_sync_jobs', 'receipt_audit_packages', 'receipt_event_line_items']) {
    const { error } = await admin
      .from(table)
      .delete()
      .eq('organization_id', args.organizationId)
      .eq('receipt_event_id', args.eventId);
    if (error) failures.push(`${table}: ${error.message}`);
  }

  const { error: eventErr } = await admin
    .from('receipt_events')
    .delete()
    .eq('organization_id', args.organizationId)
    .eq('id', args.eventId);
  if (eventErr) failures.push(`receipt_events: ${eventErr.message}`);

  if (args.billId) {
    const { error: billLinesErr } = await admin
      .from('bill_line_items')
      .delete()
      .eq('organization_id', args.organizationId)
      .eq('bill_id', args.billId);
    if (billLinesErr) failures.push(`bill_line_items: ${billLinesErr.message}`);

    const { error: billErr } = await admin
      .from('bills')
      .delete()
      .eq('organization_id', args.organizationId)
      .eq('id', args.billId);
    if (billErr) failures.push(`bills: ${billErr.message}`);
  }

  if (failures.length > 0) {
    console.error('[receipt-webhook] failed to clean up incomplete receipt ingest', {
      organizationId: args.organizationId,
      eventId: args.eventId,
      billId: args.billId,
      failures,
    });
  }
}

async function resolveReceiptIdentity(admin: SupabaseClient, organizationId: string, token: string): Promise<ReceiptIdentity> {
  const dot = token.indexOf('.');
  if (!token.startsWith('rhp_') || dot < 0) throw new ValidationError('invalid identity_token');
  const prefix = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  const tokenHash = await sha256Hex(secret);
  const { data, error } = await admin
    .from('receipt_identities')
    .select('id, organization_id, status, revoked_at')
    .eq('organization_id', organizationId)
    .eq('token_prefix', prefix)
    .eq('token_hash', tokenHash)
    .maybeSingle();
  if (error || !data || data.status !== 'active' || data.revoked_at) {
    throw new ValidationError('receipt identity not found or inactive');
  }
  return data as ReceiptIdentity;
}

function classifyReceipt(payload: ReceiptPayload, merchantName: string, totalCents: number) {
  const explicitUse = asText(payload.classification?.business_use);
  const explicitDeductibility = asText(payload.classification?.deductibility);
  const jobReference = asText(payload.classification?.job_reference);
  const jobId = asText(payload.classification?.job_id);
  const category = asText(payload.classification?.category) ?? 'receipt_hub';
  const merchant = merchantName.toLowerCase();
  const businessSignals = ['bunnings', 'reece', 'officeworks', 'ampol', 'bp ', 'caltex', 'trade', 'electrical', 'plumbing'];
  const personalSignals = ['mcdonald', 'kfc', 'nandos', 'uber eats', 'netflix', 'spotify'];

  let businessUse = normalizeBusinessUse(explicitUse);
  let reason = 'explicit receipt classification';
  if (!businessUse) {
    if (jobReference || jobId || businessSignals.some((signal) => merchant.includes(signal.trim()))) {
      businessUse = 'business';
      reason = 'matched job or trade-supplier signal';
    } else if (personalSignals.some((signal) => merchant.includes(signal))) {
      businessUse = 'personal';
      reason = 'matched personal-spend signal';
    } else {
      businessUse = 'review';
      reason = 'no deterministic business/personal signal';
    }
  }

  let deductibility = normalizeDeductibility(explicitDeductibility);
  if (!deductibility) {
    deductibility =
      businessUse === 'personal'
        ? 'personal'
        : businessUse === 'business' && totalCents > 0
          ? 'deductible'
          : 'requires_review';
  }

  return { businessUse, deductibility, jobReference, jobId, category, reason };
}

function initialReceiptStatus(
  eventType: ReceiptEventType,
  businessUse: 'business' | 'personal' | 'mixed' | 'review',
): 'received' | 'personal' | 'refunded' | 'voided' {
  if (eventType === 'refund') return 'refunded';
  if (eventType === 'void') return 'voided';
  return businessUse === 'personal' ? 'personal' : 'received';
}

function finalReceiptStatus(
  eventType: ReceiptEventType,
  businessUse: 'business' | 'personal' | 'mixed' | 'review',
  deductibility: 'deductible' | 'non_deductible' | 'requires_review' | 'personal',
): 'processed' | 'flagged' | 'personal' | 'refunded' | 'voided' {
  if (eventType === 'refund') return 'refunded';
  if (eventType === 'void') return 'voided';
  if (businessUse === 'personal') return 'personal';
  return deductibility === 'requires_review' ? 'flagged' : 'processed';
}

async function resolveJob(admin: SupabaseClient, organizationId: string, explicitJobId: string | null, jobReference: string | null) {
  if (explicitJobId) {
    const { data } = await admin
      .from('jobs')
      .select('id, job_number, name')
      .eq('organization_id', organizationId)
      .eq('id', explicitJobId)
      .maybeSingle();
    if (data) return data as { id: string; job_number: string; name: string };
  }
  if (!jobReference) return null;
  const { data } = await admin
    .from('jobs')
    .select('id, job_number, name')
    .eq('organization_id', organizationId)
    .or(`job_number.eq.${escapePostgrestValue(jobReference)},name.ilike.%${escapePostgrestValue(jobReference)}%`)
    .limit(1)
    .maybeSingle();
  return (data as { id: string; job_number: string; name: string } | null) ?? null;
}

async function createBillFromReceipt(admin: SupabaseClient, args: {
  organizationId: string;
  eventId: string;
  jobId: string | null;
  merchantName: string;
  merchantAbn: string | null;
  receiptNumber: string | null;
  purchaseAt: string;
  totalCents: number;
  gstCents: number;
  subtotalCents: number;
  gstEstimated: boolean;
  currency: string;
  jobReference: string | null;
  payload: ReceiptPayload;
  sourceChannel: ReceiptSource;
  lineItems: NormalizedLine[];
}): Promise<string> {
  const { data, error } = await admin
    .from('bills')
    .insert({
      organization_id: args.organizationId,
      job_id: args.jobId,
      status: args.jobId ? 'attached' : 'verified',
      source: 'api',
      storage_key: `receipt-hub/${args.organizationId}/${args.eventId}.json`,
      original_filename: `${args.receiptNumber ?? args.eventId}.receipt.json`,
      mime_type: 'application/json',
      file_size_bytes: new TextEncoder().encode(JSON.stringify(args.payload)).byteLength,
      supplier_name_raw: args.merchantName,
      supplier_abn: args.merchantAbn,
      invoice_number: args.receiptNumber,
      invoice_date: args.purchaseAt.slice(0, 10),
      due_date: args.purchaseAt.slice(0, 10),
      total_inc_gst_cents: args.totalCents,
      gst_cents: args.gstCents,
      subtotal_ex_gst_cents: args.subtotalCents,
      gst_estimated: args.gstEstimated,
      currency_code: args.currency,
      job_reference_raw: args.jobReference,
      document_kind: 'receipt',
      is_probable_bill: true,
      is_personal: false,
      raw_extracted: {
        source: 'receipt_hub',
        receipt_event_id: args.eventId,
        source_channel: args.sourceChannel,
        payload: args.payload,
      },
      ocr_provider: 'structured_receipt',
      ocr_confidence: 1,
      notes: 'Receipt Hub structured receipt',
      attached_at: args.jobId ? new Date().toISOString() : null,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(error?.message ?? 'bill insert failed');

  const billId = data.id as string;
  const billLines = args.lineItems.map((line) => ({
    organization_id: args.organizationId,
    bill_id: billId,
    line_number: line.lineNumber,
    description: line.description,
    quantity: line.quantity,
    unit_price_cents: line.unitPriceCents,
    total_cents: line.totalIncGstCents,
    gst_cents: line.gstCents,
    category: line.category,
    metadata: { source: 'receipt_hub', receipt_event_id: args.eventId },
  }));
  const { error: lineErr } = await admin.from('bill_line_items').insert(billLines);
  if (lineErr) throw new Error(lineErr.message);
  return billId;
}

async function insertReceiptLines(admin: SupabaseClient, organizationId: string, eventId: string, lines: NormalizedLine[]) {
  const rows = lines.map((line) => ({
    organization_id: organizationId,
    receipt_event_id: eventId,
    line_number: line.lineNumber,
    description: line.description,
    quantity: line.quantity,
    unit_price_cents: line.unitPriceCents,
    total_inc_gst_cents: line.totalIncGstCents,
    gst_cents: line.gstCents,
    category: line.category,
    metadata: line.metadata,
  }));
  const { error } = await admin.from('receipt_event_line_items').insert(rows);
  if (error) throw new Error(error.message);
}

async function createAuditPackage(admin: SupabaseClient, args: {
  organizationId: string;
  eventId: string;
  billId: string | null;
  storageKey: string;
  payload: ReceiptPayload;
  classification: ReturnType<typeof classifyReceipt>;
  gstEstimated: boolean;
  sourceChannel: ReceiptSource;
  eventType: ReceiptEventType;
  relatedReceiptEventId: string | null;
}) {
  const { data, error } = await admin
    .from('receipt_audit_packages')
    .insert({
      organization_id: args.organizationId,
      receipt_event_id: args.eventId,
      bill_id: args.billId,
      storage_key: args.storageKey,
      evidence: {
        source_channel: args.sourceChannel,
        event_type: args.eventType,
        related_receipt_event_id: args.relatedReceiptEventId,
        merchant: args.payload.merchant ?? {},
        receipt: args.payload.receipt ?? {},
        line_count: Array.isArray(args.payload.line_items) ? args.payload.line_items.length : 0,
      },
      decision_path: {
        root: 'Receipt Hub decision',
        branches: [
          { title: 'Identity', detail: 'Receipt pass token matched active Looplet identity.' },
          { title: 'GST', detail: args.gstEstimated ? 'GST was estimated from total using AU 1/11 rule.' : 'GST was supplied by POS payload.' },
          { title: 'Business use', detail: args.classification.businessUse },
          { title: 'Deductibility', detail: args.classification.deductibility },
          {
            title: 'Next sync',
            detail: args.billId
              ? 'Bill created and sync jobs queued.'
              : args.eventType === 'sale'
                ? 'Stored as personal/review evidence.'
                : 'Stored as refund/void evidence; accounting credit handling is a separate workflow.',
          },
        ],
      },
      gst_status: args.gstEstimated ? 'estimated' : 'supplied',
      deductibility_status: args.classification.deductibility,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(error?.message ?? 'audit package insert failed');
  return data.id as string;
}

async function queueSyncJobs(admin: SupabaseClient, args: {
  organizationId: string;
  eventId: string;
  billId: string | null;
  targets: SyncProvider[];
  payload: ReceiptPayload;
}) {
  const uniqueTargets = Array.from(new Set(args.targets));
  if (uniqueTargets.length === 0) return [];
  const rows = uniqueTargets.map((provider) => ({
    organization_id: args.organizationId,
    receipt_event_id: args.eventId,
    bill_id: args.billId,
    provider,
    status: args.billId ? 'pending' : 'skipped',
    payload: {
      source: 'receipt_hub',
      provider,
      receipt_payload: args.payload,
      bill_id: args.billId,
    },
  }));
  const { data, error } = await admin.from('receipt_sync_jobs').insert(rows).select('id, provider, status');
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function markIdentityUsed(admin: SupabaseClient, identityId: string) {
  await admin.from('receipt_identities').update({ last_used_at: new Date().toISOString() }).eq('id', identityId);
}

async function writeLog(
  admin: SupabaseClient,
  auth: { mode: 'api_key'; organizationId: string; keyId: string; keyPrefix: string } | { mode: 'user_jwt'; organizationId: string },
  status: number,
) {
  await logApiRequest(admin, {
    organizationId: auth.organizationId,
    apiKeyId: auth.mode === 'api_key' ? auth.keyId : null,
    keyPrefix: auth.mode === 'api_key' ? auth.keyPrefix : null,
    endpoint: 'receipt-webhook',
    method: 'POST',
    ingestType: 'receipt',
    status,
  });
}

interface NormalizedLine {
  lineNumber: number;
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalIncGstCents: number;
  gstCents: number;
  category: string | null;
  metadata: Record<string, unknown>;
}

function normalizeLines(lines: ReceiptLine[] | undefined, totalCents: number, gstCents: number, category: string): NormalizedLine[] {
  if (!Array.isArray(lines) || lines.length === 0) {
    return [{
      lineNumber: 1,
      description: 'Structured receipt',
      quantity: 1,
      unitPriceCents: totalCents,
      totalIncGstCents: totalCents,
      gstCents,
      category,
      metadata: { generated: true },
    }];
  }
  return lines.map((line, index) => {
    const quantity = asNumber(line.quantity) ?? 1;
    const unitPrice = asCents(line.unit_price_cents);
    const lineTotal = asCents(line.total_inc_gst_cents) ?? (unitPrice != null ? Math.round(quantity * unitPrice) : 0);
    return {
      lineNumber: index + 1,
      description: asText(line.description) ?? `Receipt line ${index + 1}`,
      quantity,
      unitPriceCents: unitPrice ?? (quantity > 0 ? Math.round(lineTotal / quantity) : lineTotal),
      totalIncGstCents: lineTotal,
      gstCents: asCents(line.gst_cents) ?? Math.round(lineTotal / 11),
      category: asText(line.category) ?? category,
      metadata: { source: 'pos_line_item' },
    };
  });
}

function syncTargets(body: RequestBody, payload: ReceiptPayload): SyncProvider[] {
  const fromBody = Array.isArray(body.sync_targets) ? body.sync_targets : [];
  const fromPayload = Array.isArray(payload.classification?.sync_targets)
    ? payload.classification?.sync_targets
    : [];
  const candidates = [...fromBody, ...fromPayload];
  const allowed = new Set<SyncProvider>(['xero', 'myob', 'quickbooks', 'generic_api']);
  const parsed = candidates.filter((v): v is SyncProvider => typeof v === 'string' && allowed.has(v as SyncProvider));
  return parsed.length > 0 ? parsed : ['xero'];
}

function normalizeBusinessUse(value: string | null): 'business' | 'personal' | 'mixed' | 'review' | null {
  if (value === 'business' || value === 'personal' || value === 'mixed' || value === 'review') return value;
  return null;
}

function normalizeDeductibility(value: string | null): 'deductible' | 'non_deductible' | 'requires_review' | 'personal' | null {
  if (value === 'deductible' || value === 'non_deductible' || value === 'requires_review' || value === 'personal') return value;
  if (value === 'approved') return 'deductible';
  if (value === 'flagged' || value === 'review') return 'requires_review';
  return null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function asCents(value: unknown): number | null {
  const n = asNumber(value);
  return n != null && Number.isInteger(n) ? n : null;
}

function asCurrency(value: unknown): string {
  const text = asText(value)?.toUpperCase();
  return text && /^[A-Z]{3}$/.test(text) ? text : 'AUD';
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stripReceiptIdentitySecrets(payload: ReceiptPayload): void {
  if (payload.receipt && typeof payload.receipt === 'object' && !Array.isArray(payload.receipt)) {
    delete (payload.receipt as Record<string, unknown>).identity_token;
  }
  const payloadRecord = payload as Record<string, unknown>;
  const customer = payloadRecord.customer;
  if (customer && typeof customer === 'object' && !Array.isArray(customer)) {
    delete (customer as Record<string, unknown>).looplet_identity_token;
  }
}

function escapePostgrestValue(value: string): string {
  return value.replace(/[(),]/g, ' ').trim();
}

function toIsoDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
