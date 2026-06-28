#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';
import { buildWebhookBody } from './contract.mjs';

const defaultSaleSample = localPath('sample-receipt.json');
const defaultRefundSample = localPath('sample-refund.json');
const defaultVoidSample = localPath('sample-void.json');
const defaultInvalidSample = localPath('sample-invalid-pending.json');

async function main() {
  const args = process.argv.slice(2);
  await loadEnvFileArg(args);
  const outputFile = readOption(args, '--output') ?? process.env.LOOPLET_ACCEPTANCE_EVIDENCE_FILE ?? null;
  const runId = process.env.LOOPLET_ACCEPTANCE_RUN_ID || defaultRunId();
  const config = readConfig();

  assertLiveWriteAllowed(config.webhookUrl);

  const sale = acceptanceSale(await readJson(readOption(args, '--sale') ?? defaultSaleSample), runId);
  const refund = acceptanceRefund(await readJson(readOption(args, '--refund') ?? defaultRefundSample), runId, sale);
  const voidReceipt = acceptanceVoid(await readJson(readOption(args, '--void') ?? defaultVoidSample), runId, sale);
  const invalidPending = acceptanceInvalid(await readJson(readOption(args, '--invalid') ?? defaultInvalidSample), runId);
  copyReceiptIdentityIfMissing(invalidPending, sale);
  const badLineTotals = acceptanceBadLineTotals(sale, runId);
  const badLineGst = acceptanceBadLineGst(sale, runId);
  const missingTender = acceptanceMissingTender(sale, runId);
  const missingOriginalReference = acceptanceMissingOriginalReference(refund, runId);
  const missingVoidOriginalReference = acceptanceMissingOriginalReference(voidReceipt, runId);
  const unresolvedOriginalReference = acceptanceUnresolvedOriginalReference(refund, runId);
  const unresolvedVoidOriginalReference = acceptanceUnresolvedOriginalReference(voidReceipt, runId);
  const idempotencyMismatch = acceptanceIdempotencyMismatch(sale, runId);
  const idempotencyTaxMismatch = acceptanceIdempotencyTaxMismatch(sale);
  const idempotencyPurchaseAtMismatch = acceptanceIdempotencyPurchaseAtMismatch(sale);
  const missingMerchant = acceptanceMissingMerchant(sale, runId);
  const missingPaymentReference = acceptanceMissingPaymentReference(sale, runId);
  const badPaymentLast4 = acceptanceBadPaymentLast4(sale, runId);
  const missingPurchaseAt = acceptanceMissingPurchaseAt(sale, runId);
  const badPurchaseAt = acceptanceBadPurchaseAt(sale, runId);
  const missingGst = acceptanceMissingGst(sale, runId);
  const missingSubtotal = acceptanceMissingSubtotal(sale, runId);
  const badTaxBreakdown = acceptanceBadTaxBreakdown(sale, runId);
  const invalidIdentity = acceptanceInvalidIdentity(sale, runId);

  const checks = {};
  const saleResult = await postReceipt(sale, config);
  assert(saleResult.ok === true, 'sale should be accepted', saleResult);
  assert(saleResult.duplicate === false, 'first sale should not be duplicate', saleResult);
  assert(saleResult.event_type === 'sale', 'sale response event_type mismatch', saleResult);
  assert(Boolean(saleResult.receipt_event_id), 'sale response missing receipt_event_id', saleResult);
  checks.sale = compactResult(saleResult);

  const duplicateResult = await postReceipt(sale, config);
  assert(duplicateResult.ok === true, 'duplicate retry should be accepted', duplicateResult);
  assert(duplicateResult.duplicate === true, 'duplicate retry should be marked duplicate', duplicateResult);
  assert(duplicateResult.receipt_event_id === saleResult.receipt_event_id, 'duplicate retry returned a different receipt_event_id', duplicateResult);
  checks.duplicate = compactResult(duplicateResult);

  const idempotencyMismatchResult = await postReceipt(idempotencyMismatch, config, { raw: true });
  assert(idempotencyMismatchResult.ok === false, 'same idempotency key with changed receipt payload should be rejected', idempotencyMismatchResult);
  assert(idempotencyMismatchResult.status === 400, 'same idempotency key with changed receipt payload should return HTTP 400', idempotencyMismatchResult);
  assert(
    String(idempotencyMismatchResult.error).toLowerCase().includes('idempotency'),
    'idempotency mismatch rejection should explain idempotency key reuse',
    idempotencyMismatchResult,
  );
  checks.idempotency_mismatch_rejection = compactResult(idempotencyMismatchResult);

  const idempotencyTaxMismatchResult = await postReceipt(idempotencyTaxMismatch, config, { raw: true });
  assert(
    idempotencyTaxMismatchResult.ok === false,
    'same idempotency key with changed GST/subtotal should be rejected',
    idempotencyTaxMismatchResult,
  );
  assert(
    idempotencyTaxMismatchResult.status === 400,
    'same idempotency key with changed GST/subtotal should return HTTP 400',
    idempotencyTaxMismatchResult,
  );
  assert(
    String(idempotencyTaxMismatchResult.error).toLowerCase().includes('idempotency') &&
      (
        String(idempotencyTaxMismatchResult.error).toLowerCase().includes('gst') ||
        String(idempotencyTaxMismatchResult.error).toLowerCase().includes('subtotal')
      ),
    'idempotency tax mismatch rejection should explain the changed tax fields',
    idempotencyTaxMismatchResult,
  );
  checks.idempotency_tax_mismatch_rejection = compactResult(idempotencyTaxMismatchResult);

  const idempotencyPurchaseAtMismatchResult = await postReceipt(idempotencyPurchaseAtMismatch, config, { raw: true });
  assert(
    idempotencyPurchaseAtMismatchResult.ok === false,
    'same idempotency key with changed purchase_at should be rejected',
    idempotencyPurchaseAtMismatchResult,
  );
  assert(
    idempotencyPurchaseAtMismatchResult.status === 400,
    'same idempotency key with changed purchase_at should return HTTP 400',
    idempotencyPurchaseAtMismatchResult,
  );
  assert(
    String(idempotencyPurchaseAtMismatchResult.error).toLowerCase().includes('idempotency') &&
      String(idempotencyPurchaseAtMismatchResult.error).toLowerCase().includes('purchase_at'),
    'idempotency purchase_at mismatch rejection should explain the changed timestamp',
    idempotencyPurchaseAtMismatchResult,
  );
  checks.idempotency_purchase_at_mismatch_rejection = compactResult(idempotencyPurchaseAtMismatchResult);

  const idempotencySourceMismatchResult = await postReceipt(sale, config, {
    raw: true,
    idempotencyHeader: `${sale.idempotency_key}-header-mismatch`,
  });
  assert(idempotencySourceMismatchResult.ok === false, 'conflicting idempotency header/body values should be rejected', idempotencySourceMismatchResult);
  assert(idempotencySourceMismatchResult.status === 400, 'conflicting idempotency header/body values should return HTTP 400', idempotencySourceMismatchResult);
  assert(
    String(idempotencySourceMismatchResult.error).toLowerCase().includes('idempotency'),
    'idempotency source mismatch rejection should explain idempotency',
    idempotencySourceMismatchResult,
  );
  checks.idempotency_source_mismatch_rejection = compactResult(idempotencySourceMismatchResult);

  const missingMerchantResult = await postReceipt(missingMerchant, config, { raw: true });
  assert(missingMerchantResult.ok === false, 'missing merchant name should be rejected for POS receipts', missingMerchantResult);
  assert(missingMerchantResult.status === 400, 'missing merchant name should return HTTP 400', missingMerchantResult);
  assert(String(missingMerchantResult.error).toLowerCase().includes('merchant'), 'missing merchant rejection should explain merchant name', missingMerchantResult);
  checks.missing_merchant_rejection = compactResult(missingMerchantResult);

  const missingPaymentReferenceResult = await postReceipt(missingPaymentReference, config, { raw: true });
  assert(
    missingPaymentReferenceResult.ok === false,
    'missing POS payment reference should be rejected',
    missingPaymentReferenceResult,
  );
  assert(
    missingPaymentReferenceResult.status === 400,
    'missing POS payment reference should return HTTP 400',
    missingPaymentReferenceResult,
  );
  assert(
    String(missingPaymentReferenceResult.error).toLowerCase().includes('payment_reference') ||
      String(missingPaymentReferenceResult.error).toLowerCase().includes('payment reference'),
    'missing payment reference rejection should explain payment_reference',
    missingPaymentReferenceResult,
  );
  checks.missing_payment_reference_rejection = compactResult(missingPaymentReferenceResult);

  const badPaymentLast4Result = await postReceipt(badPaymentLast4, config, { raw: true });
  assert(
    badPaymentLast4Result.ok === false,
    'full card number in POS payment_last4 should be rejected',
    badPaymentLast4Result,
  );
  assert(
    badPaymentLast4Result.status === 400,
    'full card number in POS payment_last4 should return HTTP 400',
    badPaymentLast4Result,
  );
  assert(
    String(badPaymentLast4Result.error).toLowerCase().includes('payment_last4') ||
      String(badPaymentLast4Result.error).toLowerCase().includes('card number'),
    'bad payment_last4 rejection should explain card last-four safety',
    badPaymentLast4Result,
  );
  checks.bad_payment_last4_rejection = compactResult(badPaymentLast4Result);

  const missingPurchaseAtResult = await postReceipt(missingPurchaseAt, config, { raw: true });
  assert(
    missingPurchaseAtResult.ok === false,
    'missing POS purchase_at should be rejected',
    missingPurchaseAtResult,
  );
  assert(
    missingPurchaseAtResult.status === 400,
    'missing POS purchase_at should return HTTP 400',
    missingPurchaseAtResult,
  );
  assert(
    String(missingPurchaseAtResult.error).toLowerCase().includes('purchase_at'),
    'missing purchase_at rejection should explain purchase_at',
    missingPurchaseAtResult,
  );
  checks.missing_purchase_at_rejection = compactResult(missingPurchaseAtResult);

  const badPurchaseAtResult = await postReceipt(badPurchaseAt, config, { raw: true });
  assert(
    badPurchaseAtResult.ok === false,
    'invalid POS purchase_at should be rejected',
    badPurchaseAtResult,
  );
  assert(
    badPurchaseAtResult.status === 400,
    'invalid POS purchase_at should return HTTP 400',
    badPurchaseAtResult,
  );
  assert(
    String(badPurchaseAtResult.error).toLowerCase().includes('purchase_at'),
    'bad purchase_at rejection should explain purchase_at',
    badPurchaseAtResult,
  );
  checks.bad_purchase_at_rejection = compactResult(badPurchaseAtResult);

  const missingGstResult = await postReceipt(missingGst, config, { raw: true });
  assert(missingGstResult.ok === false, 'missing POS GST should be rejected', missingGstResult);
  assert(missingGstResult.status === 400, 'missing POS GST should return HTTP 400', missingGstResult);
  assert(
    String(missingGstResult.error).toLowerCase().includes('gst'),
    'missing GST rejection should explain GST',
    missingGstResult,
  );
  checks.missing_gst_rejection = compactResult(missingGstResult);

  const missingSubtotalResult = await postReceipt(missingSubtotal, config, { raw: true });
  assert(missingSubtotalResult.ok === false, 'missing POS subtotal should be rejected', missingSubtotalResult);
  assert(missingSubtotalResult.status === 400, 'missing POS subtotal should return HTTP 400', missingSubtotalResult);
  assert(
    String(missingSubtotalResult.error).toLowerCase().includes('gst') ||
      String(missingSubtotalResult.error).toLowerCase().includes('subtotal'),
    'missing subtotal rejection should explain GST/subtotal',
    missingSubtotalResult,
  );
  checks.missing_subtotal_rejection = compactResult(missingSubtotalResult);

  const badTaxBreakdownResult = await postReceipt(badTaxBreakdown, config, { raw: true });
  assert(badTaxBreakdownResult.ok === false, 'inconsistent POS GST/subtotal breakdown should be rejected', badTaxBreakdownResult);
  assert(badTaxBreakdownResult.status === 400, 'inconsistent POS GST/subtotal breakdown should return HTTP 400', badTaxBreakdownResult);
  assert(
    String(badTaxBreakdownResult.error).toLowerCase().includes('gst') ||
      String(badTaxBreakdownResult.error).toLowerCase().includes('subtotal'),
    'bad tax breakdown rejection should explain GST/subtotal',
    badTaxBreakdownResult,
  );
  checks.bad_tax_breakdown_rejection = compactResult(badTaxBreakdownResult);

  const refundResult = await postReceipt(refund, config);
  assert(refundResult.ok === true, 'refund should be accepted', refundResult);
  assert(refundResult.event_type === 'refund', 'refund response event_type mismatch', refundResult);
  assert(refundResult.related_receipt_event_id === saleResult.receipt_event_id, 'refund should link to sale receipt_event_id', refundResult);
  checks.refund = compactResult(refundResult);

  const refundDuplicateResult = await postReceipt(refund, config);
  assert(refundDuplicateResult.ok === true, 'refund duplicate retry should be accepted', refundDuplicateResult);
  assert(refundDuplicateResult.duplicate === true, 'refund duplicate retry should be marked duplicate', refundDuplicateResult);
  assert(
    refundDuplicateResult.receipt_event_id === refundResult.receipt_event_id,
    'refund duplicate retry returned a different receipt_event_id',
    refundDuplicateResult,
  );
  checks.refund_duplicate = compactResult(refundDuplicateResult);

  const voidResult = await postReceipt(voidReceipt, config);
  assert(voidResult.ok === true, 'void should be accepted', voidResult);
  assert(voidResult.event_type === 'void', 'void response event_type mismatch', voidResult);
  assert(voidResult.related_receipt_event_id === saleResult.receipt_event_id, 'void should link to sale receipt_event_id', voidResult);
  assert(Array.isArray(voidResult.sync_jobs) && voidResult.sync_jobs.length === 0, 'void should not create sync jobs', voidResult);
  checks.void = compactResult(voidResult);

  const voidDuplicateResult = await postReceipt(voidReceipt, config);
  assert(voidDuplicateResult.ok === true, 'void duplicate retry should be accepted', voidDuplicateResult);
  assert(voidDuplicateResult.duplicate === true, 'void duplicate retry should be marked duplicate', voidDuplicateResult);
  assert(
    voidDuplicateResult.receipt_event_id === voidResult.receipt_event_id,
    'void duplicate retry returned a different receipt_event_id',
    voidDuplicateResult,
  );
  checks.void_duplicate = compactResult(voidDuplicateResult);

  const pendingResult = await postReceipt(invalidPending, config, { raw: true });
  assert(pendingResult.ok === false, 'pending tender should be rejected', pendingResult);
  assert(pendingResult.status === 400, 'pending tender should return HTTP 400', pendingResult);
  assert(String(pendingResult.error).toLowerCase().includes('tender'), 'pending tender rejection should explain tender status', pendingResult);
  checks.pending_rejection = compactResult(pendingResult);

  const badLineTotalsResult = await postReceipt(badLineTotals, config, { raw: true });
  assert(badLineTotalsResult.ok === false, 'bad line totals should be rejected', badLineTotalsResult);
  assert(badLineTotalsResult.status === 400, 'bad line totals should return HTTP 400', badLineTotalsResult);
  assert(String(badLineTotalsResult.error).toLowerCase().includes('line'), 'bad line totals rejection should explain line totals', badLineTotalsResult);
  checks.bad_line_totals_rejection = compactResult(badLineTotalsResult);

  const badLineGstResult = await postReceipt(badLineGst, config, { raw: true });
  assert(badLineGstResult.ok === false, 'bad line GST should be rejected', badLineGstResult);
  assert(badLineGstResult.status === 400, 'bad line GST should return HTTP 400', badLineGstResult);
  assert(String(badLineGstResult.error).toLowerCase().includes('gst'), 'bad line GST rejection should explain GST', badLineGstResult);
  checks.bad_line_gst_rejection = compactResult(badLineGstResult);

  const missingTenderResult = await postReceipt(missingTender, config, { raw: true });
  assert(missingTenderResult.ok === false, 'missing POS tender status should be rejected', missingTenderResult);
  assert(missingTenderResult.status === 400, 'missing POS tender status should return HTTP 400', missingTenderResult);
  assert(String(missingTenderResult.error).toLowerCase().includes('tender'), 'missing tender rejection should explain tender status', missingTenderResult);
  checks.missing_tender_rejection = compactResult(missingTenderResult);

  const missingOriginalReferenceResult = await postReceipt(missingOriginalReference, config, { raw: true });
  assert(missingOriginalReferenceResult.ok === false, 'refund without original sale reference should be rejected', missingOriginalReferenceResult);
  assert(missingOriginalReferenceResult.status === 400, 'refund without original sale reference should return HTTP 400', missingOriginalReferenceResult);
  assert(
    String(missingOriginalReferenceResult.error).toLowerCase().includes('original'),
    'missing original reference rejection should explain the required original receipt/event reference',
    missingOriginalReferenceResult,
  );
  checks.missing_original_reference_rejection = compactResult(missingOriginalReferenceResult);

  const missingVoidOriginalReferenceResult = await postReceipt(missingVoidOriginalReference, config, { raw: true });
  assert(missingVoidOriginalReferenceResult.ok === false, 'void without original sale reference should be rejected', missingVoidOriginalReferenceResult);
  assert(missingVoidOriginalReferenceResult.status === 400, 'void without original sale reference should return HTTP 400', missingVoidOriginalReferenceResult);
  assert(
    String(missingVoidOriginalReferenceResult.error).toLowerCase().includes('original'),
    'missing void original reference rejection should explain the required original receipt/event reference',
    missingVoidOriginalReferenceResult,
  );
  checks.missing_void_original_reference_rejection = compactResult(missingVoidOriginalReferenceResult);

  const unresolvedOriginalReferenceResult = await postReceipt(unresolvedOriginalReference, config, { raw: true });
  assert(unresolvedOriginalReferenceResult.ok === false, 'refund with unresolved original sale reference should be rejected', unresolvedOriginalReferenceResult);
  assert(unresolvedOriginalReferenceResult.status === 400, 'refund with unresolved original sale reference should return HTTP 400', unresolvedOriginalReferenceResult);
  assert(
    String(unresolvedOriginalReferenceResult.error).toLowerCase().includes('original'),
    'unresolved original reference rejection should explain the original sale reference problem',
    unresolvedOriginalReferenceResult,
  );
  checks.unresolved_original_reference_rejection = compactResult(unresolvedOriginalReferenceResult);

  const unresolvedVoidOriginalReferenceResult = await postReceipt(unresolvedVoidOriginalReference, config, { raw: true });
  assert(unresolvedVoidOriginalReferenceResult.ok === false, 'void with unresolved original sale reference should be rejected', unresolvedVoidOriginalReferenceResult);
  assert(unresolvedVoidOriginalReferenceResult.status === 400, 'void with unresolved original sale reference should return HTTP 400', unresolvedVoidOriginalReferenceResult);
  assert(
    String(unresolvedVoidOriginalReferenceResult.error).toLowerCase().includes('original'),
    'unresolved void original reference rejection should explain the original sale reference problem',
    unresolvedVoidOriginalReferenceResult,
  );
  checks.unresolved_void_original_reference_rejection = compactResult(unresolvedVoidOriginalReferenceResult);

  const invalidApiResult = await postReceipt(sale, { ...config, apiKey: 'llp_invalid.invalid' });
  assert(invalidApiResult.ok === false, 'invalid API key should be rejected', invalidApiResult);
  assert(invalidApiResult.status === 401, 'invalid API key should return HTTP 401', invalidApiResult);
  checks.invalid_api_key_rejection = compactResult(invalidApiResult);

  const invalidIdentityResult = await postReceipt(invalidIdentity, {
    ...config,
    identityToken: 'rhp_invalid.invalid',
  });
  assert(invalidIdentityResult.ok === false, 'invalid receipt identity should be rejected', invalidIdentityResult);
  assert(invalidIdentityResult.status === 400, 'invalid receipt identity should return HTTP 400', invalidIdentityResult);
  assert(
    String(invalidIdentityResult.error).toLowerCase().includes('identity'),
    'invalid receipt identity rejection should explain identity',
    invalidIdentityResult,
  );
  checks.invalid_identity_rejection = compactResult(invalidIdentityResult);

  const evidence = {
    ok: true,
    run_id: runId,
    webhook_url: config.webhookUrl,
    checks,
    persistence: await verifyPersistence({
      config,
      checks,
      sale,
      refund,
      voidReceipt,
      invalidPending,
      badLineTotals,
      badLineGst,
      missingTender,
      missingOriginalReference,
      missingVoidOriginalReference,
      unresolvedOriginalReference,
      unresolvedVoidOriginalReference,
      missingMerchant,
      missingPaymentReference,
      badPaymentLast4,
      missingPurchaseAt,
      badPurchaseAt,
      missingGst,
      missingSubtotal,
      badTaxBreakdown,
      invalidIdentity,
    }),
  };
  await maybeWriteEvidence(outputFile, evidence);
  console.log(JSON.stringify(evidence, null, 2));
}

async function postReceipt(receipt, config, options = {}) {
  let body;
  try {
    body = options.raw ? buildRawWebhookBody(receipt, config) : buildWebhookBody(receipt, config);
  } catch (error) {
    return {
      ok: false,
      status: 400,
      idempotency_key: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': options.idempotencyHeader ?? body.idempotency_key,
      },
      body: JSON.stringify(body),
    });
    const responseBody = await response.json().catch(() => ({}));
    return {
      ...responseBody,
      ok: response.ok && responseBody.ok !== false,
      status: response.status,
      idempotency_key: body.idempotency_key,
      error: responseBody.error ?? null,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      idempotency_key: body.idempotency_key,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildRawWebhookBody(receipt, config) {
  const payload = clone(receipt.payload ?? receipt);
  const eventType = String(receipt.event_type ?? payload.receipt?.event_type ?? 'sale').toLowerCase();
  payload.receipt = { ...payload.receipt, event_type: eventType };
  return {
    identity_token: resolveAcceptanceIdentityToken(receipt, payload, config),
    idempotency_key: receipt.idempotency_key ?? payload.receipt?.external_event_id ?? payload.receipt?.external_id,
    event_type: eventType,
    source_channel: receipt.source_channel ?? 'pos',
    payload,
    sync_targets: config.syncTargets,
  };
}

function acceptanceSale(sample, runId) {
  const receipt = clone(sample);
  receipt.event_type = 'sale';
  receipt.idempotency_key = `acceptance-sale-${runId}`;
  receipt.source_channel = 'pos';
  receipt.payload.receipt.number = `LOOPLET-ACCEPT-${runId}-SALE`;
  receipt.payload.receipt.event_type = 'sale';
  receipt.payload.receipt.external_event_id = receipt.idempotency_key;
  receipt.payload.receipt.payment_reference = `looplet-acceptance-payment-${runId}`;
  receipt.payload.receipt.tender_status = 'completed';
  receipt.payload.classification = {
    business_use: 'personal',
    deductibility: 'requires_review',
    category: 'receipt_acceptance',
  };
  return receipt;
}

function acceptanceRefund(sample, runId, sale) {
  const receipt = clone(sample);
  receipt.event_type = 'refund';
  receipt.idempotency_key = `acceptance-refund-${runId}`;
  receipt.source_channel = 'pos';
  receipt.payload.receipt.number = `LOOPLET-ACCEPT-${runId}-REFUND`;
  receipt.payload.receipt.event_type = 'refund';
  receipt.payload.receipt.external_event_id = receipt.idempotency_key;
  receipt.payload.receipt.original_receipt_number = sale.payload.receipt.number;
  receipt.payload.receipt.original_external_event_id = sale.payload.receipt.external_event_id;
  receipt.payload.receipt.payment_reference = `looplet-acceptance-refund-${runId}`;
  receipt.payload.receipt.tender_status = 'refunded';
  receipt.payload.classification = {
    business_use: 'personal',
    deductibility: 'requires_review',
    category: 'receipt_acceptance',
  };
  return receipt;
}

function acceptanceVoid(sample, runId, sale) {
  const receipt = clone(sample);
  receipt.event_type = 'void';
  receipt.idempotency_key = `acceptance-void-${runId}`;
  receipt.source_channel = 'pos';
  receipt.payload.receipt.number = `LOOPLET-ACCEPT-${runId}-VOID`;
  receipt.payload.receipt.event_type = 'void';
  receipt.payload.receipt.external_event_id = receipt.idempotency_key;
  receipt.payload.receipt.original_receipt_number = sale.payload.receipt.number;
  receipt.payload.receipt.original_external_event_id = sale.payload.receipt.external_event_id;
  receipt.payload.receipt.payment_reference = `looplet-acceptance-void-${runId}`;
  receipt.payload.receipt.tender_status = 'voided';
  receipt.payload.classification = {
    business_use: 'personal',
    deductibility: 'requires_review',
    category: 'receipt_acceptance',
  };
  return receipt;
}

function acceptanceInvalid(sample, runId) {
  const receipt = clone(sample);
  receipt.event_type = 'sale';
  receipt.idempotency_key = `acceptance-pending-${runId}`;
  receipt.source_channel = 'pos';
  receipt.payload.receipt.number = `LOOPLET-ACCEPT-${runId}-PENDING`;
  receipt.payload.receipt.event_type = 'sale';
  receipt.payload.receipt.external_event_id = receipt.idempotency_key;
  receipt.payload.receipt.payment_reference = `looplet-acceptance-pending-${runId}`;
  receipt.payload.receipt.tender_status = 'pending';
  return receipt;
}

function copyReceiptIdentityIfMissing(target, source) {
  if (resolveOptionalReceiptIdentityToken(target, target.payload ?? target)) return;
  const token = resolveOptionalReceiptIdentityToken(source, source.payload ?? source);
  if (token) target.identity_token = token;
}

function acceptanceBadLineTotals(sale, runId) {
  const receipt = clone(sale);
  receipt.idempotency_key = `acceptance-bad-lines-${runId}`;
  receipt.payload.receipt.number = `LOOPLET-ACCEPT-${runId}-BAD-LINES`;
  receipt.payload.receipt.external_event_id = receipt.idempotency_key;
  receipt.payload.receipt.payment_reference = `looplet-acceptance-bad-lines-${runId}`;
  receipt.payload.line_items[0].total_inc_gst_cents += 100;
  return receipt;
}

function acceptanceBadLineGst(sale, runId) {
  const receipt = clone(sale);
  receipt.idempotency_key = `acceptance-bad-line-gst-${runId}`;
  receipt.payload.receipt.number = `LOOPLET-ACCEPT-${runId}-BAD-LINE-GST`;
  receipt.payload.receipt.external_event_id = receipt.idempotency_key;
  receipt.payload.receipt.payment_reference = `looplet-acceptance-bad-line-gst-${runId}`;
  receipt.payload.line_items[0].gst_cents += 100;
  return receipt;
}

function acceptanceIdempotencyMismatch(sale, runId) {
  const receipt = clone(sale);
  receipt.payload.receipt.number = `LOOPLET-ACCEPT-${runId}-REUSED-KEY`;
  receipt.payload.receipt.payment_reference = `looplet-acceptance-reused-key-${runId}`;
  return receipt;
}

function acceptanceIdempotencyTaxMismatch(sale) {
  const receipt = clone(sale);
  receipt.payload.receipt.gst_cents += 100;
  receipt.payload.receipt.subtotal_ex_gst_cents -= 100;
  receipt.payload.line_items[0].gst_cents += 100;
  return receipt;
}

function acceptanceIdempotencyPurchaseAtMismatch(sale) {
  const receipt = clone(sale);
  receipt.payload.receipt.purchase_at = '2026-06-28T04:00:00Z';
  return receipt;
}

function acceptanceMissingMerchant(sale, runId) {
  const receipt = clone(sale);
  receipt.idempotency_key = `acceptance-missing-merchant-${runId}`;
  receipt.payload.receipt.number = `LOOPLET-ACCEPT-${runId}-NO-MERCHANT`;
  receipt.payload.receipt.external_event_id = receipt.idempotency_key;
  receipt.payload.receipt.payment_reference = `looplet-acceptance-no-merchant-${runId}`;
  delete receipt.payload.merchant.name;
  return receipt;
}

function acceptanceMissingPaymentReference(sale, runId) {
  const receipt = clone(sale);
  receipt.idempotency_key = `acceptance-missing-payment-reference-${runId}`;
  receipt.payload.receipt.number = `LOOPLET-ACCEPT-${runId}-NO-PAYMENT-REF`;
  receipt.payload.receipt.external_event_id = receipt.idempotency_key;
  delete receipt.payload.receipt.payment_reference;
  return receipt;
}

function acceptanceBadPaymentLast4(sale, runId) {
  const receipt = clone(sale);
  receipt.idempotency_key = `acceptance-bad-payment-last4-${runId}`;
  receipt.payload.receipt.number = `LOOPLET-ACCEPT-${runId}-BAD-PAN`;
  receipt.payload.receipt.external_event_id = receipt.idempotency_key;
  receipt.payload.receipt.payment_reference = `looplet-acceptance-bad-pan-${runId}`;
  receipt.payload.receipt.payment_last4 = '4111111111111234';
  return receipt;
}

function acceptanceMissingPurchaseAt(sale, runId) {
  const receipt = clone(sale);
  receipt.idempotency_key = `acceptance-missing-purchase-at-${runId}`;
  receipt.payload.receipt.number = `LOOPLET-ACCEPT-${runId}-NO-PURCHASE-AT`;
  receipt.payload.receipt.external_event_id = receipt.idempotency_key;
  receipt.payload.receipt.payment_reference = `looplet-acceptance-no-purchase-at-${runId}`;
  delete receipt.payload.receipt.purchase_at;
  return receipt;
}

function acceptanceBadPurchaseAt(sale, runId) {
  const receipt = clone(sale);
  receipt.idempotency_key = `acceptance-bad-purchase-at-${runId}`;
  receipt.payload.receipt.number = `LOOPLET-ACCEPT-${runId}-BAD-PURCHASE-AT`;
  receipt.payload.receipt.external_event_id = receipt.idempotency_key;
  receipt.payload.receipt.payment_reference = `looplet-acceptance-bad-purchase-at-${runId}`;
  receipt.payload.receipt.purchase_at = 'not-a-date';
  return receipt;
}

function acceptanceMissingGst(sale, runId) {
  const receipt = clone(sale);
  receipt.idempotency_key = `acceptance-missing-gst-${runId}`;
  receipt.payload.receipt.number = `LOOPLET-ACCEPT-${runId}-NO-GST`;
  receipt.payload.receipt.external_event_id = receipt.idempotency_key;
  receipt.payload.receipt.payment_reference = `looplet-acceptance-no-gst-${runId}`;
  delete receipt.payload.receipt.gst_cents;
  return receipt;
}

function acceptanceMissingSubtotal(sale, runId) {
  const receipt = clone(sale);
  receipt.idempotency_key = `acceptance-missing-subtotal-${runId}`;
  receipt.payload.receipt.number = `LOOPLET-ACCEPT-${runId}-NO-SUBTOTAL`;
  receipt.payload.receipt.external_event_id = receipt.idempotency_key;
  receipt.payload.receipt.payment_reference = `looplet-acceptance-no-subtotal-${runId}`;
  delete receipt.payload.receipt.subtotal_ex_gst_cents;
  return receipt;
}

function acceptanceBadTaxBreakdown(sale, runId) {
  const receipt = clone(sale);
  receipt.idempotency_key = `acceptance-bad-tax-${runId}`;
  receipt.payload.receipt.number = `LOOPLET-ACCEPT-${runId}-BAD-TAX`;
  receipt.payload.receipt.external_event_id = receipt.idempotency_key;
  receipt.payload.receipt.payment_reference = `looplet-acceptance-bad-tax-${runId}`;
  receipt.payload.receipt.gst_cents = 1000;
  receipt.payload.receipt.subtotal_ex_gst_cents = 1000;
  return receipt;
}

function acceptanceMissingTender(sale, runId) {
  const receipt = clone(sale);
  receipt.idempotency_key = `acceptance-missing-tender-${runId}`;
  receipt.payload.receipt.number = `LOOPLET-ACCEPT-${runId}-NO-TENDER`;
  receipt.payload.receipt.external_event_id = receipt.idempotency_key;
  receipt.payload.receipt.payment_reference = `looplet-acceptance-no-tender-${runId}`;
  delete receipt.payload.receipt.tender_status;
  return receipt;
}

function acceptanceMissingOriginalReference(refund, runId) {
  const receipt = clone(refund);
  receipt.idempotency_key = `acceptance-missing-${receipt.event_type}-original-${runId}`;
  receipt.payload.receipt.number = `LOOPLET-ACCEPT-${runId}-NO-ORIGINAL`;
  receipt.payload.receipt.external_event_id = receipt.idempotency_key;
  receipt.payload.receipt.payment_reference = `looplet-acceptance-${receipt.event_type}-no-original-${runId}`;
  delete receipt.payload.receipt.original_receipt_number;
  delete receipt.payload.receipt.original_external_event_id;
  return receipt;
}

function acceptanceUnresolvedOriginalReference(refund, runId) {
  const receipt = clone(refund);
  receipt.idempotency_key = `acceptance-unresolved-${receipt.event_type}-original-${runId}`;
  receipt.payload.receipt.number = `LOOPLET-ACCEPT-${runId}-BAD-ORIGINAL-${receipt.event_type.toUpperCase()}`;
  receipt.payload.receipt.external_event_id = receipt.idempotency_key;
  receipt.payload.receipt.payment_reference = `looplet-acceptance-${receipt.event_type}-bad-original-${runId}`;
  receipt.payload.receipt.original_receipt_number = `LOOPLET-ACCEPT-${runId}-MISSING-SALE`;
  receipt.payload.receipt.original_external_event_id = `acceptance-missing-sale-${runId}`;
  return receipt;
}

function acceptanceInvalidIdentity(sale, runId) {
  const receipt = clone(sale);
  receipt.idempotency_key = `acceptance-invalid-identity-${runId}`;
  receipt.identity_token = 'rhp_invalid.invalid';
  receipt.payload.receipt.number = `LOOPLET-ACCEPT-${runId}-BAD-IDENTITY`;
  receipt.payload.receipt.external_event_id = receipt.idempotency_key;
  receipt.payload.receipt.payment_reference = `looplet-acceptance-bad-identity-${runId}`;
  return receipt;
}

async function verifyPersistence({
  config,
  checks,
  sale,
  refund,
  voidReceipt,
  invalidPending,
  badLineTotals,
  badLineGst,
  missingTender,
  missingOriginalReference,
  missingVoidOriginalReference,
  unresolvedOriginalReference,
  unresolvedVoidOriginalReference,
  missingMerchant,
  missingPaymentReference,
  badPaymentLast4,
  missingPurchaseAt,
  badPurchaseAt,
  missingGst,
  missingSubtotal,
  badTaxBreakdown,
  invalidIdentity,
}) {
  const verifyConfig = readPersistenceVerifyConfig(config.webhookUrl);
  if (!verifyConfig) {
    return {
      checked: false,
      reason: 'LOOPLET_ACCEPTANCE_SERVICE_ROLE_KEY not set',
    };
  }

  const saleEventId = checks.sale.receipt_event_id;
  const refundEventId = checks.refund.receipt_event_id;
  const voidEventId = checks.void.receipt_event_id;
  const saleStoredIdempotencyKey = storedExplicitIdempotencyKey(sale.idempotency_key);
  const refundStoredIdempotencyKey = storedExplicitIdempotencyKey(refund.idempotency_key);
  const voidStoredIdempotencyKey = storedExplicitIdempotencyKey(voidReceipt.idempotency_key);
  const rejectedStoredKeys = [
    storedExplicitIdempotencyKey(invalidPending.idempotency_key),
    storedExplicitIdempotencyKey(badLineTotals.idempotency_key),
    storedExplicitIdempotencyKey(badLineGst.idempotency_key),
    storedExplicitIdempotencyKey(missingTender.idempotency_key),
    storedExplicitIdempotencyKey(missingOriginalReference.idempotency_key),
    storedExplicitIdempotencyKey(missingVoidOriginalReference.idempotency_key),
    storedExplicitIdempotencyKey(unresolvedOriginalReference.idempotency_key),
    storedExplicitIdempotencyKey(unresolvedVoidOriginalReference.idempotency_key),
    storedExplicitIdempotencyKey(missingMerchant.idempotency_key),
    storedExplicitIdempotencyKey(missingPaymentReference.idempotency_key),
    storedExplicitIdempotencyKey(badPaymentLast4.idempotency_key),
    storedExplicitIdempotencyKey(missingPurchaseAt.idempotency_key),
    storedExplicitIdempotencyKey(badPurchaseAt.idempotency_key),
    storedExplicitIdempotencyKey(missingGst.idempotency_key),
    storedExplicitIdempotencyKey(missingSubtotal.idempotency_key),
    storedExplicitIdempotencyKey(badTaxBreakdown.idempotency_key),
    storedExplicitIdempotencyKey(invalidIdentity.idempotency_key),
  ];
  const eventIds = [saleEventId, refundEventId, voidEventId];
  const events = await restSelect(verifyConfig, 'receipt_events', {
    select: 'id,organization_id,event_type,idempotency_key,related_receipt_event_id,receipt_number,purchase_at,total_inc_gst_cents,status,business_use,deductibility_status,bill_id,payment_reference,payment_last4,terminal_id,store_id',
    id: `in.(${eventIds.join(',')})`,
  });
  const saleEvent = findRequired(events, 'id', saleEventId, 'sale receipt_event row');
  const refundEvent = findRequired(events, 'id', refundEventId, 'refund receipt_event row');
  const voidEvent = findRequired(events, 'id', voidEventId, 'void receipt_event row');

  assert(saleEvent.event_type === 'sale', 'persisted sale event_type mismatch', saleEvent);
  assert(saleEvent.idempotency_key === saleStoredIdempotencyKey, 'persisted sale idempotency_key mismatch', saleEvent);
  assert(saleEvent.receipt_number === sale.payload.receipt.number, 'persisted sale receipt_number mismatch', saleEvent);
  assert(toIsoDate(saleEvent.purchase_at) === toIsoDate(sale.payload.receipt.purchase_at), 'persisted sale purchase_at mismatch', saleEvent);
  assert(Number(saleEvent.total_inc_gst_cents) === sale.payload.receipt.total_inc_gst_cents, 'persisted sale total mismatch', saleEvent);
  assert(saleEvent.payment_reference === sale.payload.receipt.payment_reference, 'persisted sale payment_reference mismatch', saleEvent);
  assert(saleEvent.payment_last4 === sale.payload.receipt.payment_last4, 'persisted sale payment_last4 mismatch', saleEvent);
  assert(saleEvent.business_use === 'personal', 'acceptance sale should persist as personal evidence', saleEvent);
  assert(refundEvent.event_type === 'refund', 'persisted refund event_type mismatch', refundEvent);
  assert(refundEvent.idempotency_key === refundStoredIdempotencyKey, 'persisted refund idempotency_key mismatch', refundEvent);
  assert(refundEvent.related_receipt_event_id === saleEventId, 'persisted refund should link to sale', refundEvent);
  assert(toIsoDate(refundEvent.purchase_at) === toIsoDate(refund.payload.receipt.purchase_at), 'persisted refund purchase_at mismatch', refundEvent);
  assert(Number(refundEvent.total_inc_gst_cents) === refund.payload.receipt.total_inc_gst_cents, 'persisted refund total mismatch', refundEvent);
  assert(refundEvent.payment_reference === refund.payload.receipt.payment_reference, 'persisted refund payment_reference mismatch', refundEvent);
  assert(voidEvent.event_type === 'void', 'persisted void event_type mismatch', voidEvent);
  assert(voidEvent.idempotency_key === voidStoredIdempotencyKey, 'persisted void idempotency_key mismatch', voidEvent);
  assert(voidEvent.related_receipt_event_id === saleEventId, 'persisted void should link to sale', voidEvent);
  assert(toIsoDate(voidEvent.purchase_at) === toIsoDate(voidReceipt.payload.receipt.purchase_at), 'persisted void purchase_at mismatch', voidEvent);
  assert(Number(voidEvent.total_inc_gst_cents) === voidReceipt.payload.receipt.total_inc_gst_cents, 'persisted void total mismatch', voidEvent);
  assert(voidEvent.payment_reference === voidReceipt.payload.receipt.payment_reference, 'persisted void payment_reference mismatch', voidEvent);
  if (verifyConfig.organizationId) {
    assert(saleEvent.organization_id === verifyConfig.organizationId, 'sale organization_id mismatch', saleEvent);
    assert(refundEvent.organization_id === verifyConfig.organizationId, 'refund organization_id mismatch', refundEvent);
    assert(voidEvent.organization_id === verifyConfig.organizationId, 'void organization_id mismatch', voidEvent);
  }

  const lineItems = await restSelect(verifyConfig, 'receipt_event_line_items', {
    select: 'receipt_event_id,total_inc_gst_cents,gst_cents',
    receipt_event_id: `in.(${eventIds.join(',')})`,
  });
  const saleLines = lineItems.filter((line) => line.receipt_event_id === saleEventId);
  const refundLines = lineItems.filter((line) => line.receipt_event_id === refundEventId);
  const voidLines = lineItems.filter((line) => line.receipt_event_id === voidEventId);
  assert(saleLines.length === sale.payload.line_items.length, 'persisted sale line count mismatch', saleLines);
  assert(sumCents(saleLines) === sale.payload.receipt.total_inc_gst_cents, 'persisted sale line total mismatch', saleLines);
  assert(sumGstCents(saleLines) === sale.payload.receipt.gst_cents, 'persisted sale line GST mismatch', saleLines);
  assert(refundLines.length === refund.payload.line_items.length, 'persisted refund line count mismatch', refundLines);
  assert(sumCents(refundLines) === refund.payload.receipt.total_inc_gst_cents, 'persisted refund line total mismatch', refundLines);
  assert(sumGstCents(refundLines) === refund.payload.receipt.gst_cents, 'persisted refund line GST mismatch', refundLines);
  assert(voidLines.length === voidReceipt.payload.line_items.length, 'persisted void line count mismatch', voidLines);
  assert(sumCents(voidLines) === voidReceipt.payload.receipt.total_inc_gst_cents, 'persisted void line total mismatch', voidLines);
  assert(sumGstCents(voidLines) === voidReceipt.payload.receipt.gst_cents, 'persisted void line GST mismatch', voidLines);

  const auditPackages = await restSelect(verifyConfig, 'receipt_audit_packages', {
    select: 'id,receipt_event_id,bill_id,gst_status,deductibility_status',
    receipt_event_id: `in.(${eventIds.join(',')})`,
  });
  const saleAuditCount = auditPackages.filter((row) => row.receipt_event_id === saleEventId).length;
  const refundAuditCount = auditPackages.filter((row) => row.receipt_event_id === refundEventId).length;
  const voidAuditCount = auditPackages.filter((row) => row.receipt_event_id === voidEventId).length;
  assert(saleAuditCount === 1, 'sale should have exactly one audit package', auditPackages);
  assert(refundAuditCount === 1, 'refund should have exactly one audit package', auditPackages);
  assert(voidAuditCount === 1, 'void should have exactly one audit package', auditPackages);

  const syncJobs = await restSelect(verifyConfig, 'receipt_sync_jobs', {
    select: 'id,receipt_event_id,bill_id,provider,status',
    receipt_event_id: `in.(${eventIds.join(',')})`,
  });
  const refundSyncJobs = syncJobs.filter((row) => row.receipt_event_id === refundEventId);
  const voidSyncJobs = syncJobs.filter((row) => row.receipt_event_id === voidEventId);
  assert(refundSyncJobs.length === 0, 'refund should not create sync jobs', refundSyncJobs);
  assert(voidSyncJobs.length === 0, 'void should not create sync jobs', voidSyncJobs);

  const rejectedEvents = await restSelect(verifyConfig, 'receipt_events', {
    select: 'id,idempotency_key',
    idempotency_key: `in.(${rejectedStoredKeys.join(',')})`,
  });
  assert(rejectedEvents.length === 0, 'rejected negative controls should not persist receipt_events', rejectedEvents);

  const saleKeyEvents = await restSelect(verifyConfig, 'receipt_events', {
    select: 'id,idempotency_key',
    idempotency_key: `eq.${saleStoredIdempotencyKey}`,
  });
  assert(saleKeyEvents.length === 1, 'sale idempotency key should persist exactly one receipt_event', saleKeyEvents);
  const refundKeyEvents = await restSelect(verifyConfig, 'receipt_events', {
    select: 'id,idempotency_key',
    idempotency_key: `eq.${refundStoredIdempotencyKey}`,
  });
  assert(refundKeyEvents.length === 1, 'refund idempotency key should persist exactly one receipt_event', refundKeyEvents);
  const voidKeyEvents = await restSelect(verifyConfig, 'receipt_events', {
    select: 'id,idempotency_key',
    idempotency_key: `eq.${voidStoredIdempotencyKey}`,
  });
  assert(voidKeyEvents.length === 1, 'void idempotency key should persist exactly one receipt_event', voidKeyEvents);

  const apiRequestLogs = await restSelect(verifyConfig, 'api_request_log', {
    select: 'endpoint,method,ingest_type,status,key_prefix',
    organization_id: `eq.${saleEvent.organization_id}`,
    endpoint: 'eq.receipt-webhook',
    key_prefix: `eq.${apiKeyPrefix(config.apiKey)}`,
  });
  const acceptanceLogs = summarizeReceiptWebhookLogs(apiRequestLogs, config.apiKey);
  assert(
    acceptanceLogs.total >= 10,
    'API request log should include the acceptance webhook calls',
    acceptanceLogs,
  );
  assert(acceptanceLogs.post_count >= 10, 'API request log should record POST receipt-webhook calls', acceptanceLogs);
  assert(acceptanceLogs.success_count >= 6, 'API request log should record accepted sale/refund/void and duplicate calls', acceptanceLogs);
  assert(acceptanceLogs.validation_error_count >= 10, 'API request log should record validation rejections', acceptanceLogs);
  assert(acceptanceLogs.key_prefix_matches === true, 'API request log key_prefix should match the POS API key prefix', acceptanceLogs);
  assert(
    acceptanceLogs.ingest_type_values.length === 1 && acceptanceLogs.ingest_type_values[0] === 'receipt',
    'API request log should record ingest_type=receipt',
    acceptanceLogs,
  );

  return {
    checked: true,
    supabase_url: verifyConfig.supabaseUrl,
    organization_id: saleEvent.organization_id,
    receipt_events: {
      sale: saleEventId,
      refund: refundEventId,
      void: voidEventId,
      sale_payment_last4: saleEvent.payment_last4,
      sale_receipt_number: saleEvent.receipt_number,
      sale_purchase_at: saleEvent.purchase_at,
      refund_receipt_number: refundEvent.receipt_number,
      refund_purchase_at: refundEvent.purchase_at,
      void_receipt_number: voidEvent.receipt_number,
      void_purchase_at: voidEvent.purchase_at,
      rejected_negative_controls: rejectedEvents.length,
      sale_idempotency_rows: saleKeyEvents.length,
      refund_idempotency_rows: refundKeyEvents.length,
      void_idempotency_rows: voidKeyEvents.length,
    },
    line_items: {
      sale_count: saleLines.length,
      sale_total_inc_gst_cents: sumCents(saleLines),
      sale_gst_cents: sumGstCents(saleLines),
      refund_count: refundLines.length,
      refund_total_inc_gst_cents: sumCents(refundLines),
      refund_gst_cents: sumGstCents(refundLines),
      void_count: voidLines.length,
      void_total_inc_gst_cents: sumCents(voidLines),
      void_gst_cents: sumGstCents(voidLines),
    },
    audit_packages: {
      sale_count: saleAuditCount,
      refund_count: refundAuditCount,
      void_count: voidAuditCount,
    },
    sync_jobs: syncJobs.map((job) => ({
      receipt_event_id: job.receipt_event_id,
      provider: job.provider,
      status: job.status,
      bill_id: job.bill_id,
    })),
    api_request_log: acceptanceLogs,
  };
}

function summarizeReceiptWebhookLogs(rows, apiKey) {
  const expectedKeyPrefix = asText(apiKey)?.split('.')[0] ?? null;
  const relevant = rows.filter((row) => row.endpoint === 'receipt-webhook');
  const statusCounts = {};
  const ingestTypes = new Set();
  let keyPrefixMatches = true;

  for (const row of relevant) {
    const status = String(row.status ?? 'unknown');
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    if (row.ingest_type) ingestTypes.add(row.ingest_type);
    if (expectedKeyPrefix && row.key_prefix && row.key_prefix !== expectedKeyPrefix) {
      keyPrefixMatches = false;
    }
  }

  return {
    total: relevant.length,
    post_count: relevant.filter((row) => row.method === 'POST').length,
    success_count: relevant.filter((row) => Number(row.status) === 200).length,
    validation_error_count: relevant.filter((row) => Number(row.status) === 400).length,
    unauthorized_count: relevant.filter((row) => Number(row.status) === 401).length,
    status_counts: statusCounts,
    ingest_type_values: Array.from(ingestTypes).sort(),
    key_prefix_matches: keyPrefixMatches,
  };
}

function storedExplicitIdempotencyKey(value) {
  return `explicit:${value}`;
}

function toIsoDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
}

function readPersistenceVerifyConfig(webhookUrl) {
  const serviceRoleKey = process.env.LOOPLET_ACCEPTANCE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) return null;
  return {
    supabaseUrl: process.env.LOOPLET_ACCEPTANCE_SUPABASE_URL || inferSupabaseUrl(webhookUrl),
    serviceRoleKey,
    organizationId: process.env.LOOPLET_ACCEPTANCE_ORG_ID || null,
  };
}

function inferSupabaseUrl(webhookUrl) {
  const url = new URL(webhookUrl);
  return `${url.protocol}//${url.host}`;
}

async function restSelect(config, table, filters) {
  const url = new URL(`/rest/v1/${table}`, config.supabaseUrl);
  for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      Accept: 'application/json',
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`PostgREST ${table} read failed (${response.status}): ${JSON.stringify(body)}`);
  }
  if (!Array.isArray(body)) throw new Error(`PostgREST ${table} did not return an array`);
  return body;
}

function findRequired(rows, key, value, label) {
  const row = rows.find((candidate) => candidate[key] === value);
  if (!row) throw new Error(`Missing ${label}: ${value}`);
  return row;
}

function sumCents(rows) {
  return rows.reduce((sum, row) => sum + Number(row.total_inc_gst_cents ?? 0), 0);
}

function sumGstCents(rows) {
  return rows.reduce((sum, row) => sum + Number(row.gst_cents ?? 0), 0);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readConfig() {
  return {
    webhookUrl: requiredEnv('LOOPLET_RECEIPT_WEBHOOK_URL'),
    apiKey: requiredEnv('LOOPLET_POS_API_KEY'),
    identityToken: process.env.LOOPLET_RECEIPT_IDENTITY_TOKEN || null,
    syncTargets: (process.env.LOOPLET_SYNC_TARGETS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  };
}

function resolveAcceptanceIdentityToken(receipt, payload, config = {}) {
  const token = resolveOptionalReceiptIdentityToken(receipt, payload, config);
  if (!token) {
    throw new Error(
      'receipt identity_token is required; include the scanned Looplet identity per receipt or configure LOOPLET_RECEIPT_IDENTITY_TOKEN as a fallback',
    );
  }
  return token;
}

function resolveOptionalReceiptIdentityToken(receipt, payload, config = {}) {
  return asText(receipt.identity_token) ??
    asText(payload.receipt?.identity_token) ??
    asText(payload.customer?.looplet_identity_token) ??
    asText(config.identityToken);
}

function asText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function apiKeyPrefix(apiKey) {
  const text = asText(apiKey);
  return text?.split('.')[0] ?? '';
}

function assertLiveWriteAllowed(webhookUrl) {
  const url = new URL(webhookUrl);
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (!isLocal && process.env.LOOPLET_ACCEPTANCE_CONFIRM_LIVE !== '1') {
    throw new Error('Set LOOPLET_ACCEPTANCE_CONFIRM_LIVE=1 before running acceptance against a non-local endpoint.');
  }
}

async function maybeWriteEvidence(outputFile, evidence) {
  if (!outputFile) return;
  await mkdir(dirname(outputFile), { recursive: true });
  await writeFile(outputFile, `${JSON.stringify(evidence, null, 2)}\n`);
}

function compactResult(result) {
  return {
    ok: result.ok,
    status: result.status,
    duplicate: result.duplicate ?? false,
    event_type: result.event_type ?? null,
    idempotency_key: result.idempotency_key ?? null,
    receipt_event_id: result.receipt_event_id ?? null,
    related_receipt_event_id: result.related_receipt_event_id ?? null,
    bill_id: result.bill_id ?? null,
    sync_jobs: Array.isArray(result.sync_jobs)
      ? result.sync_jobs.map((job) => ({ id: job.id, provider: job.provider, status: job.status }))
      : [],
    error: result.error ?? null,
  };
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

async function loadEnvFileArg(args) {
  const index = args.indexOf('--env-file');
  if (index === -1) return;
  const file = args[index + 1];
  if (!file) throw new Error('--env-file requires a path');
  await loadEnvFile(file);
  args.splice(index, 2);
}

async function loadEnvFile(file) {
  const content = await readFile(file, 'utf8');
  for (const [lineNumber, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equalsAt = line.indexOf('=');
    if (equalsAt <= 0) throw new Error(`${file}:${lineNumber + 1} must be KEY=value`);
    const key = line.slice(0, equalsAt).trim();
    const value = unquoteEnvValue(line.slice(equalsAt + 1).trim());
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`${file}:${lineNumber + 1} has invalid env key ${key}`);
    process.env[key] = value;
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function defaultRunId() {
  return new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
}

function localPath(fileName) {
  return new URL(fileName, import.meta.url).pathname.replace(/^\/([A-Za-z]:\/)/, '$1');
}

function assert(condition, message, details) {
  if (condition) return;
  const suffix = details ? `\n${JSON.stringify(details, null, 2)}` : '';
  throw new Error(`${message}${suffix}`);
}

await main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});
