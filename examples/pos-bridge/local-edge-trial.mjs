#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import process from 'node:process';

const DEFAULT_FUNCTIONS_URL = 'http://127.0.0.1:55321/functions/v1';
const DEFAULT_DB_CONTAINER = 'supabase_db_receiptresetcheck';

const runId = randomUUID().slice(0, 8);
const organizationId = randomUUID();
const otherOrganizationId = randomUUID();
const apiPrefix = `llp_trial_${runId}`;
const apiSecret = `secret_${runId}`;
const otherApiPrefix = `llp_other_${runId}`;
const otherApiSecret = `othersecret_${runId}`;
const receiptPrefix = `rhp_trial_${runId}`;
const receiptSecret = `receiptsecret_${runId}`;
const otherReceiptPrefix = `rhp_other_${runId}`;
const otherReceiptSecret = `otherreceiptsecret_${runId}`;

const dbContainer = process.env.LOOPLET_LOCAL_DB_CONTAINER ?? (await detectDbContainer());
const stackSuffix = dbContainer.replace(/^supabase_db_/, '');
const serviceRoleKey = cleanLocalSecret(
  process.env.LOOPLET_LOCAL_SERVICE_ROLE_KEY ?? (await detectServiceRoleKey(stackSuffix)),
);
const anonKey = cleanLocalSecret(process.env.LOOPLET_LOCAL_ANON_KEY ?? (await detectAnonKey(stackSuffix)));
const supabaseApiUrl = await detectSupabaseApiUrl(stackSuffix);
let localEdgeServer = null;
const functionsUrl = process.env.LOOPLET_LOCAL_FUNCTIONS_URL ??
  (await startBundledLocalEdgeServer(supabaseApiUrl, serviceRoleKey, anonKey));

let seeded = false;

try {
  await assertLocalEdgeReady();
  await assertRequiredSchema();
  await seedLocalDatabase();
  seeded = true;

  const sale = await postReceipt(
    'sale',
    'examples/pos-bridge/sample-receipt.json',
    200,
    (body) => {
      body.payload.receipt.identity_token = body.identity_token;
    },
  );
  assert(sale.ok === true && sale.duplicate === false, 'sale should be accepted');
  assert(sale.event_type === 'sale', 'sale response event_type mismatch');
  assert(Boolean(sale.bill_id), 'sale should create a bill');
  assert(
    Array.isArray(sale.sync_jobs) && sale.sync_jobs.length === 2,
    'sale should queue two sync jobs',
  );

  const duplicate = await postReceipt(
    'sale_duplicate',
    'examples/pos-bridge/sample-receipt.json',
    200,
  );
  assert(
    duplicate.ok === true && duplicate.duplicate === true,
    'duplicate retry should be acknowledged',
  );
  assert(
    duplicate.receipt_event_id === sale.receipt_event_id,
    'duplicate retry should return the original receipt_event_id',
  );

  const partialDuplicateRawKey = `pos-payment-evt-100042-partial-${runId}`;
  const partialDuplicateMutation = (body) => {
    body.idempotency_key = partialDuplicateRawKey;
    body.payload.receipt.external_event_id = partialDuplicateRawKey;
    body.payload.receipt.number = `${body.payload.receipt.number}-PARTIAL`;
    body.payload.receipt.payment_reference = `${body.payload.receipt.payment_reference}-partial`;
  };
  await seedIncompleteReceiptEvent('examples/pos-bridge/sample-receipt.json', partialDuplicateMutation);
  const partialDuplicate = await postReceipt(
    'partial_duplicate_incomplete_invalid',
    'examples/pos-bridge/sample-receipt.json',
    500,
    partialDuplicateMutation,
  );
  assert(
    partialDuplicate.ok === false && partialDuplicate.error === 'receipt_ingest_failed',
    'retrying a partially written duplicate must not be acknowledged as a successful duplicate',
  );
  await deleteReceiptEventByIdempotencyKey(`explicit:${partialDuplicateRawKey}`);

  const badLineQuantity = await postReceipt(
    'bad_line_quantity_invalid',
    'examples/pos-bridge/sample-receipt.json',
    400,
    (body) => {
      body.idempotency_key = `${body.idempotency_key}-bad-line-quantity`;
      body.payload.receipt.external_event_id = body.idempotency_key;
      body.payload.receipt.number = `${body.payload.receipt.number}-BAD-LINE-QUANTITY`;
      body.payload.receipt.payment_reference = `${body.payload.receipt.payment_reference}-bad-line-quantity`;
      body.payload.line_items = [{
        description: 'Oversized quantity validation proof',
        quantity: 1_000_000_000_000,
        unit_price_cents: 0,
        total_inc_gst_cents: body.payload.receipt.total_inc_gst_cents,
        gst_cents: body.payload.receipt.gst_cents,
      }];
    },
  );
  assert(
    badLineQuantity.ok === false && String(badLineQuantity.error).includes('quantity'),
    'oversized POS line quantity should be rejected before database writes',
  );

  const cleanupFailureRawKey = `pos-payment-evt-100042-cleanup-${runId}`;
  const cleanupFailureReceiptNumber = 'POS-2026-0001-CLEANUP';
  const cleanupFailureMutation = (body) => {
    body.idempotency_key = cleanupFailureRawKey;
    body.payload.receipt.external_event_id = cleanupFailureRawKey;
    body.payload.receipt.number = cleanupFailureReceiptNumber;
    body.payload.receipt.payment_reference = `${body.payload.receipt.payment_reference}-cleanup`;
  };
  await installAuditPackageFailureConstraint(cleanupFailureReceiptNumber);
  let cleanupFailure;
  try {
    cleanupFailure = await postReceipt(
      'post_event_insert_failure_cleanup_invalid',
      'examples/pos-bridge/sample-receipt.json',
      500,
      cleanupFailureMutation,
    );
  } finally {
    await dropAuditPackageFailureConstraint();
  }
  assert(
    cleanupFailure.ok === false && cleanupFailure.error === 'receipt_ingest_failed',
    'post-event insert failure should return a server failure, not a partial success',
  );
  const cleanupFailureResidue = await queryReceiptResidue(
    `explicit:${cleanupFailureRawKey}`,
    cleanupFailureReceiptNumber,
  );
  assert(
    Object.values(cleanupFailureResidue).every((value) => Number(value) === 0),
    `post-event insert failure should clean up all unacknowledged receipt artifacts, got ${
      JSON.stringify(cleanupFailureResidue)
    }`,
  );

  const idempotencyMismatch = await postReceipt(
    'idempotency_mismatch_invalid',
    'examples/pos-bridge/sample-receipt.json',
    400,
    (body) => {
      body.payload.receipt.number = `${body.payload.receipt.number}-REUSED-KEY`;
      body.payload.receipt.payment_reference = `${body.payload.receipt.payment_reference}-reused-key`;
    },
  );
  assert(
    idempotencyMismatch.ok === false && String(idempotencyMismatch.error).includes('idempotency'),
    'same idempotency key with changed receipt payload should be rejected',
  );

  const idempotencyTaxMismatch = await postReceipt(
    'idempotency_tax_mismatch_invalid',
    'examples/pos-bridge/sample-receipt.json',
    400,
    (body) => {
      body.payload.receipt.gst_cents += 100;
      body.payload.receipt.subtotal_ex_gst_cents -= 100;
      body.payload.line_items[0].gst_cents += 100;
    },
  );
  assert(
    idempotencyTaxMismatch.ok === false &&
      String(idempotencyTaxMismatch.error).includes('idempotency') &&
      String(idempotencyTaxMismatch.error).includes('gst_cents'),
    'same idempotency key with changed GST/subtotal should be rejected',
  );

  const idempotencyPurchaseAtMismatch = await postReceipt(
    'idempotency_purchase_at_mismatch_invalid',
    'examples/pos-bridge/sample-receipt.json',
    400,
    (body) => {
      body.payload.receipt.purchase_at = '2026-06-28T04:00:00Z';
    },
  );
  assert(
    idempotencyPurchaseAtMismatch.ok === false &&
      String(idempotencyPurchaseAtMismatch.error).includes('idempotency') &&
      String(idempotencyPurchaseAtMismatch.error).includes('purchase_at'),
    'same idempotency key with changed purchase_at should be rejected',
  );

  const idempotencySourceMismatch = await postReceipt(
    'idempotency_source_mismatch_invalid',
    'examples/pos-bridge/sample-receipt.json',
    400,
    (body) => ({ idempotencyHeader: `${body.idempotency_key}-header-mismatch` }),
  );
  assert(
    idempotencySourceMismatch.ok === false && String(idempotencySourceMismatch.error).includes('Idempotency-Key'),
    'conflicting idempotency header/body values should be rejected',
  );

  const crossOrgIdentity = await postReceipt(
    'cross_org_identity_invalid',
    'examples/pos-bridge/sample-receipt.json',
    400,
    null,
    { identityPrefix: otherReceiptPrefix, identitySecret: otherReceiptSecret },
  );
  assert(
    crossOrgIdentity.ok === false && String(crossOrgIdentity.error).includes('identity'),
    'org A POS API key must not ingest with org B receipt identity',
  );

  const reverseCrossOrgIdentity = await postReceipt(
    'reverse_cross_org_identity_invalid',
    'examples/pos-bridge/sample-receipt.json',
    400,
    null,
    {
      apiPrefix: otherApiPrefix,
      apiSecret: otherApiSecret,
      identityPrefix: receiptPrefix,
      identitySecret: receiptSecret,
    },
  );
  assert(
    reverseCrossOrgIdentity.ok === false && String(reverseCrossOrgIdentity.error).includes('identity'),
    'org B POS API key must not ingest with org A receipt identity',
  );

  const missingMerchant = await postReceipt(
    'missing_merchant_invalid',
    'examples/pos-bridge/sample-receipt.json',
    400,
    (body) => {
      body.idempotency_key = `${body.idempotency_key}-missing-merchant`;
      body.payload.receipt.external_event_id = body.idempotency_key;
      body.payload.receipt.number = `${body.payload.receipt.number}-NO-MERCHANT`;
      delete body.payload.merchant.name;
    },
  );
  assert(
    missingMerchant.ok === false && String(missingMerchant.error).includes('merchant'),
    'missing POS merchant name should be rejected',
  );

  const missingPaymentReference = await postReceipt(
    'missing_payment_reference_invalid',
    'examples/pos-bridge/sample-receipt.json',
    400,
    (body) => {
      body.idempotency_key = `${body.idempotency_key}-missing-payment-reference`;
      body.payload.receipt.external_event_id = body.idempotency_key;
      body.payload.receipt.number = `${body.payload.receipt.number}-NO-PAYMENT-REF`;
      delete body.payload.receipt.payment_reference;
    },
  );
  assert(
    missingPaymentReference.ok === false && String(missingPaymentReference.error).includes('payment_reference'),
    'missing POS payment_reference should be rejected',
  );

  const badPaymentLast4 = await postReceipt(
    'bad_payment_last4_invalid',
    'examples/pos-bridge/sample-receipt.json',
    400,
    (body) => {
      body.idempotency_key = `${body.idempotency_key}-bad-payment-last4`;
      body.payload.receipt.external_event_id = body.idempotency_key;
      body.payload.receipt.number = `${body.payload.receipt.number}-BAD-PAN`;
      body.payload.receipt.payment_reference = `${body.payload.receipt.payment_reference}-bad-pan`;
      body.payload.receipt.payment_last4 = '4111111111111234';
    },
  );
  assert(
    badPaymentLast4.ok === false && String(badPaymentLast4.error).includes('payment_last4'),
    'full card number in POS payment_last4 should be rejected',
  );

  const missingPurchaseAt = await postReceipt(
    'missing_purchase_at_invalid',
    'examples/pos-bridge/sample-receipt.json',
    400,
    (body) => {
      body.idempotency_key = `${body.idempotency_key}-missing-purchase-at`;
      body.payload.receipt.external_event_id = body.idempotency_key;
      body.payload.receipt.number = `${body.payload.receipt.number}-NO-PURCHASE-AT`;
      body.payload.receipt.payment_reference = `${body.payload.receipt.payment_reference}-no-purchase-at`;
      delete body.payload.receipt.purchase_at;
    },
  );
  assert(
    missingPurchaseAt.ok === false && String(missingPurchaseAt.error).includes('purchase_at'),
    'missing POS purchase_at should be rejected',
  );

  const badPurchaseAt = await postReceipt(
    'bad_purchase_at_invalid',
    'examples/pos-bridge/sample-receipt.json',
    400,
    (body) => {
      body.idempotency_key = `${body.idempotency_key}-bad-purchase-at`;
      body.payload.receipt.external_event_id = body.idempotency_key;
      body.payload.receipt.number = `${body.payload.receipt.number}-BAD-PURCHASE-AT`;
      body.payload.receipt.payment_reference = `${body.payload.receipt.payment_reference}-bad-purchase-at`;
      body.payload.receipt.purchase_at = 'not-a-date';
    },
  );
  assert(
    badPurchaseAt.ok === false && String(badPurchaseAt.error).includes('purchase_at'),
    'invalid POS purchase_at should be rejected',
  );

  const missingTaxBreakdown = await postReceipt(
    'missing_gst_invalid',
    'examples/pos-bridge/sample-receipt.json',
    400,
    (body) => {
      body.idempotency_key = `${body.idempotency_key}-missing-gst`;
      body.payload.receipt.external_event_id = body.idempotency_key;
      body.payload.receipt.number = `${body.payload.receipt.number}-NO-GST`;
      delete body.payload.receipt.gst_cents;
    },
  );
  assert(
    missingTaxBreakdown.ok === false && String(missingTaxBreakdown.error).includes('gst'),
    'missing POS GST should be rejected',
  );

  const missingSubtotal = await postReceipt(
    'missing_subtotal_invalid',
    'examples/pos-bridge/sample-receipt.json',
    400,
    (body) => {
      body.idempotency_key = `${body.idempotency_key}-missing-subtotal`;
      body.payload.receipt.external_event_id = body.idempotency_key;
      body.payload.receipt.number = `${body.payload.receipt.number}-NO-SUBTOTAL`;
      delete body.payload.receipt.subtotal_ex_gst_cents;
    },
  );
  assert(
    missingSubtotal.ok === false && String(missingSubtotal.error).includes('subtotal'),
    'missing POS subtotal should be rejected',
  );

  const badTaxBreakdown = await postReceipt(
    'bad_tax_breakdown_invalid',
    'examples/pos-bridge/sample-receipt.json',
    400,
    (body) => {
      body.idempotency_key = `${body.idempotency_key}-bad-tax`;
      body.payload.receipt.external_event_id = body.idempotency_key;
      body.payload.receipt.number = `${body.payload.receipt.number}-BAD-TAX`;
      body.payload.receipt.gst_cents = 1000;
      body.payload.receipt.subtotal_ex_gst_cents = 1000;
    },
  );
  assert(
    badTaxBreakdown.ok === false && String(badTaxBreakdown.error).includes('GST'),
    'inconsistent POS GST/subtotal breakdown should be rejected',
  );

  const badLineTotals = await postReceipt(
    'bad_line_totals_invalid',
    'examples/pos-bridge/sample-receipt.json',
    400,
    (body) => {
      body.idempotency_key = `${body.idempotency_key}-bad-line-total`;
      body.payload.receipt.external_event_id = body.idempotency_key;
      body.payload.receipt.number = `${body.payload.receipt.number}-BAD-LINE-TOTAL`;
      body.payload.line_items[0].total_inc_gst_cents += 100;
    },
  );
  assert(
    badLineTotals.ok === false && String(badLineTotals.error).includes('line_items total'),
    'bad POS line totals should be rejected',
  );

  const badLineGst = await postReceipt(
    'bad_line_gst_invalid',
    'examples/pos-bridge/sample-receipt.json',
    400,
    (body) => {
      body.idempotency_key = `${body.idempotency_key}-bad-line-gst`;
      body.payload.receipt.external_event_id = body.idempotency_key;
      body.payload.receipt.number = `${body.payload.receipt.number}-BAD-LINE-GST`;
      body.payload.line_items[0].gst_cents += 100;
    },
  );
  assert(
    badLineGst.ok === false && String(badLineGst.error).includes('GST'),
    'bad POS line GST should be rejected',
  );

  const refund = await postReceipt('refund', 'examples/pos-bridge/sample-refund.json', 200);
  assert(refund.ok === true && refund.event_type === 'refund', 'refund should be accepted');
  assert(refund.bill_id === null, 'refund should not create a positive bill');
  assert(
    refund.related_receipt_event_id === sale.receipt_event_id,
    'refund should link to the original sale',
  );
  assert(
    Array.isArray(refund.sync_jobs) && refund.sync_jobs.length === 0,
    'refund should not queue accounting sync jobs',
  );
  const refundDuplicate = await postReceipt(
    'refund_duplicate',
    'examples/pos-bridge/sample-refund.json',
    200,
  );
  assert(
    refundDuplicate.ok === true && refundDuplicate.duplicate === true,
    'refund duplicate retry should be acknowledged',
  );
  assert(
    refundDuplicate.receipt_event_id === refund.receipt_event_id,
    'refund duplicate retry should return the original refund receipt_event_id',
  );

  const voidReceipt = await postReceipt('void', 'examples/pos-bridge/sample-void.json', 200);
  assert(voidReceipt.ok === true && voidReceipt.event_type === 'void', 'void should be accepted');
  assert(voidReceipt.bill_id === null, 'void should not create a positive bill');
  assert(
    voidReceipt.related_receipt_event_id === sale.receipt_event_id,
    'void should link to the original sale',
  );
  assert(
    Array.isArray(voidReceipt.sync_jobs) && voidReceipt.sync_jobs.length === 0,
    'void should not queue accounting sync jobs',
  );
  const voidDuplicate = await postReceipt(
    'void_duplicate',
    'examples/pos-bridge/sample-void.json',
    200,
  );
  assert(
    voidDuplicate.ok === true && voidDuplicate.duplicate === true,
    'void duplicate retry should be acknowledged',
  );
  assert(
    voidDuplicate.receipt_event_id === voidReceipt.receipt_event_id,
    'void duplicate retry should return the original void receipt_event_id',
  );

  const refundSameReceiptNumber = await postReceipt(
    'refund_same_receipt_number',
    'examples/pos-bridge/sample-refund.json',
    200,
    (body) => {
      body.idempotency_key = `${body.idempotency_key}-same-receipt-number`;
      body.payload.receipt.external_event_id = body.idempotency_key;
      body.payload.receipt.number = 'POS-2026-0001';
      body.payload.receipt.original_receipt_number = 'POS-2026-0001';
      body.payload.receipt.original_external_event_id = 'pos-event-0001';
    },
  );
  assert(
    refundSameReceiptNumber.ok === true && refundSameReceiptNumber.event_type === 'refund',
    'refund should be accepted when the POS reuses the sale receipt number',
  );
  assert(
    refundSameReceiptNumber.related_receipt_event_id === sale.receipt_event_id,
    'same-number refund should still link to the original sale',
  );

  const voidSameReceiptNumber = await postReceipt(
    'void_same_receipt_number',
    'examples/pos-bridge/sample-void.json',
    200,
    (body) => {
      body.idempotency_key = `${body.idempotency_key}-same-receipt-number`;
      body.payload.receipt.external_event_id = body.idempotency_key;
      body.payload.receipt.number = 'POS-2026-0001';
      body.payload.receipt.original_receipt_number = 'POS-2026-0001';
      body.payload.receipt.original_external_event_id = 'pos-event-0001';
    },
  );
  assert(
    voidSameReceiptNumber.ok === true && voidSameReceiptNumber.event_type === 'void',
    'void should be accepted when the POS reuses the sale receipt number',
  );
  assert(
    voidSameReceiptNumber.related_receipt_event_id === sale.receipt_event_id,
    'same-number void should still link to the original sale',
  );

  const pending = await postReceipt(
    'pending_invalid',
    'examples/pos-bridge/sample-invalid-pending.json',
    400,
  );
  assert(
    pending.ok === false && String(pending.error).includes('tender'),
    'pending tender should be rejected',
  );

  const missingTender = await postReceipt(
    'missing_tender_invalid',
    'examples/pos-bridge/sample-receipt.json',
    400,
    (body) => {
      body.idempotency_key = `${body.idempotency_key}-missing-tender`;
      body.payload.receipt.external_event_id = body.idempotency_key;
      body.payload.receipt.number = `${body.payload.receipt.number}-NO-TENDER`;
      delete body.payload.receipt.tender_status;
    },
  );
  assert(
    missingTender.ok === false && String(missingTender.error).includes('tender'),
    'missing POS tender status should be rejected',
  );

  const missingOriginalReference = await postReceipt(
    'missing_original_invalid',
    'examples/pos-bridge/sample-refund.json',
    400,
    (body) => {
      body.idempotency_key = `${body.idempotency_key}-missing-original`;
      body.payload.receipt.external_event_id = body.idempotency_key;
      body.payload.receipt.number = `${body.payload.receipt.number}-NO-ORIGINAL`;
      delete body.payload.receipt.original_receipt_number;
      delete body.payload.receipt.original_external_event_id;
    },
  );
  assert(
    missingOriginalReference.ok === false &&
      String(missingOriginalReference.error).includes('original'),
    'refund without original sale reference should be rejected',
  );

  const missingVoidOriginalReference = await postReceipt(
    'missing_void_original_invalid',
    'examples/pos-bridge/sample-void.json',
    400,
    (body) => {
      body.idempotency_key = `${body.idempotency_key}-missing-original`;
      body.payload.receipt.external_event_id = body.idempotency_key;
      body.payload.receipt.number = `${body.payload.receipt.number}-NO-ORIGINAL`;
      delete body.payload.receipt.original_receipt_number;
      delete body.payload.receipt.original_external_event_id;
    },
  );
  assert(
    missingVoidOriginalReference.ok === false &&
      String(missingVoidOriginalReference.error).includes('original'),
    'void without original sale reference should be rejected',
  );

  const unresolvedOriginalReference = await postReceipt(
    'unresolved_original_invalid',
    'examples/pos-bridge/sample-refund.json',
    400,
    (body) => {
      body.idempotency_key = `${body.idempotency_key}-unresolved-original`;
      body.payload.receipt.external_event_id = body.idempotency_key;
      body.payload.receipt.number = `${body.payload.receipt.number}-BAD-ORIGINAL`;
      body.payload.receipt.original_receipt_number = 'POS-DOES-NOT-EXIST';
      body.payload.receipt.original_external_event_id = 'pos-event-does-not-exist';
    },
  );
  assert(
    unresolvedOriginalReference.ok === false &&
      String(unresolvedOriginalReference.error).includes('original'),
    'refund with unresolved original sale reference should be rejected',
  );

  const unresolvedVoidOriginalReference = await postReceipt(
    'unresolved_void_original_invalid',
    'examples/pos-bridge/sample-void.json',
    400,
    (body) => {
      body.idempotency_key = `${body.idempotency_key}-unresolved-original`;
      body.payload.receipt.external_event_id = body.idempotency_key;
      body.payload.receipt.number = `${body.payload.receipt.number}-BAD-ORIGINAL`;
      body.payload.receipt.original_receipt_number = 'POS-DOES-NOT-EXIST';
      body.payload.receipt.original_external_event_id = 'pos-event-does-not-exist';
    },
  );
  assert(
    unresolvedVoidOriginalReference.ok === false &&
      String(unresolvedVoidOriginalReference.error).includes('original'),
    'void with unresolved original sale reference should be rejected',
  );

  const dispatch = await postDispatch();
  assert(
    dispatch.ok === true && dispatch.processed >= 2,
    'dispatch should process the queued sale sync jobs',
  );
  const dispatchStatuses = new Set(dispatch.results?.map((result) => result.status));
  assert(
    dispatchStatuses.has('skipped'),
    'dispatch should mark known local prerequisites as skipped, not retryable failures',
  );

  const persisted = await queryPersistedState();
  assert(persisted.sale_events === 1, 'expected one persisted sale event');
  assert(persisted.other_org_receipt_events === 0, 'expected no receipts to persist for the cross-org negative control');
  assert(persisted.refund_events === 2, 'expected original and same-number refund events');
  assert(persisted.void_events === 2, 'expected original and same-number void events');
  assert(persisted.bills === 1, 'expected one bill from the sale');
  assert(persisted.line_items === 6, 'expected sale, refund, void, and same-number reversal line items');
  assert(persisted.audit_packages === 5, 'expected one audit package for each accepted receipt event');
  assert(persisted.sale_payment_last4 === '1234', 'expected sale payment_last4 to persist as final four digits only');
  assert(
    persisted.sale_raw_receipt_identity_token === null,
    'expected receipt identity token to be stripped from persisted raw payload',
  );
  assert(
    new Date(persisted.sale_purchase_at).toISOString() === '2026-06-28T03:00:00.000Z',
    'expected sale purchase_at to persist as original POS timestamp',
  );
  assert(persisted.sale_line_gst_cents === 3273, 'expected sale line GST to match receipt GST');
  assert(persisted.refund_line_gst_cents === 1090, 'expected refund line GST to match both refund receipts');
  assert(persisted.void_line_gst_cents === 0, 'expected void line GST to match receipt GST');
  assert(persisted.refund_linked === true, 'expected refund to link to the sale');
  assert(persisted.void_linked === true, 'expected void to link to the sale');
  assert(persisted.same_number_refund_events === 1, 'expected one same-receipt-number refund event');
  assert(persisted.same_number_void_events === 1, 'expected one same-receipt-number void event');
  assert(
    persisted.skipped_sync_jobs === 2,
    'expected the two unconfigured/prerequisite sync jobs to be skipped',
  );
  assert(
    persisted.failed_sync_jobs === 0,
    'expected no retryable sync failures in the local edge trial',
  );
  assert(persisted.api_log_total >= 20, 'expected receipt-webhook API request logs to persist');
  assert(persisted.api_log_post_count === persisted.api_log_total, 'expected all receipt API logs to be POST calls');
  assert(
    persisted.api_log_receipt_type_count === persisted.api_log_total,
    'expected all receipt API logs to be tagged ingest_type=receipt',
  );
  assert(
    persisted.api_log_key_prefix_count === persisted.api_log_total,
    'expected all org A receipt API logs to carry the org A POS key prefix',
  );
  assert(persisted.api_log_success_count >= 6, 'expected accepted receipt calls to be logged');
  assert(persisted.api_log_validation_error_count >= 10, 'expected validation rejections to be logged');
  assert(persisted.api_log_server_error_count >= 2, 'expected partial-write negative controls to be logged as server errors');
  assert(
    persisted.api_log_other_key_prefix_rows === 0,
    'expected org A API logs not to include org B POS key prefixes',
  );
  assert(
    persisted.other_org_api_log_validation_error_count >= 1,
    'expected org B cross-org identity rejection to be logged against org B',
  );

  await cleanupLocalDatabase();
  const cleanupState = await queryCleanupState();
  assert(
    Object.values(cleanupState).every((value) => Number(value) === 0),
    `expected local edge cleanup to remove all seeded rows, got ${JSON.stringify(cleanupState)}`,
  );
  seeded = false;

  console.log(
    JSON.stringify(
      {
        ok: true,
        functions_url: functionsUrl,
        db_container: dbContainer,
        organization_id: organizationId,
        sale_event_id: sale.receipt_event_id,
        sale_bill_id: sale.bill_id,
        duplicate_returned_same_event: duplicate.receipt_event_id === sale.receipt_event_id,
        partial_duplicate_incomplete_rejected: partialDuplicate.ok === false,
        bad_line_quantity_rejected: badLineQuantity.ok === false,
        post_event_insert_failure_cleanup_ok: Object.values(cleanupFailureResidue).every((value) => Number(value) === 0),
        idempotency_mismatch_rejected: idempotencyMismatch.ok === false,
        idempotency_tax_mismatch_rejected: idempotencyTaxMismatch.ok === false,
        idempotency_purchase_at_mismatch_rejected: idempotencyPurchaseAtMismatch.ok === false,
        idempotency_source_mismatch_rejected: idempotencySourceMismatch.ok === false,
        cross_org_identity_rejected: crossOrgIdentity.ok === false,
        reverse_cross_org_identity_rejected: reverseCrossOrgIdentity.ok === false,
        missing_merchant_rejected: missingMerchant.ok === false,
        missing_payment_reference_rejected: missingPaymentReference.ok === false,
        bad_payment_last4_rejected: badPaymentLast4.ok === false,
        missing_purchase_at_rejected: missingPurchaseAt.ok === false,
        bad_purchase_at_rejected: badPurchaseAt.ok === false,
        api_request_log_ok: persisted.api_log_total >= 20 &&
          persisted.api_log_post_count === persisted.api_log_total &&
          persisted.api_log_receipt_type_count === persisted.api_log_total &&
          persisted.api_log_key_prefix_count === persisted.api_log_total &&
          persisted.api_log_success_count >= 6 &&
          persisted.api_log_validation_error_count >= 10 &&
          persisted.api_log_server_error_count >= 2 &&
          persisted.api_log_other_key_prefix_rows === 0,
        raw_payload_identity_token_stripped: persisted.sale_raw_receipt_identity_token === null,
        missing_gst_rejected: missingTaxBreakdown.ok === false,
        missing_subtotal_rejected: missingSubtotal.ok === false,
        bad_tax_breakdown_rejected: badTaxBreakdown.ok === false,
        bad_line_totals_rejected: badLineTotals.ok === false,
        bad_line_gst_rejected: badLineGst.ok === false,
        refund_event_id: refund.receipt_event_id,
        refund_related_receipt_event_id: refund.related_receipt_event_id,
        refund_duplicate_returned_same_event: refundDuplicate.receipt_event_id === refund.receipt_event_id,
        refund_same_receipt_number_accepted: refundSameReceiptNumber.ok === true,
        void_event_id: voidReceipt.receipt_event_id,
        void_related_receipt_event_id: voidReceipt.related_receipt_event_id,
        void_duplicate_returned_same_event: voidDuplicate.receipt_event_id === voidReceipt.receipt_event_id,
        void_same_receipt_number_accepted: voidSameReceiptNumber.ok === true,
        pending_rejected: pending.ok === false,
        missing_tender_rejected: missingTender.ok === false,
        missing_original_reference_rejected: missingOriginalReference.ok === false,
        missing_void_original_reference_rejected: missingVoidOriginalReference.ok === false,
        unresolved_original_reference_rejected: unresolvedOriginalReference.ok === false,
        unresolved_void_original_reference_rejected: unresolvedVoidOriginalReference.ok === false,
        dispatch_processed: dispatch.processed,
        dispatch_results: dispatch.results,
        persisted,
        other_organization_id: otherOrganizationId,
        cleanup_ok: true,
        cleanup_no_leak: true,
        cleanup_state: cleanupState,
      },
      null,
      2,
    ),
  );
} finally {
  if (seeded) {
    await cleanupLocalDatabase().catch((err) => {
      console.error(
        JSON.stringify({
          ok: false,
          cleanup_ok: false,
          cleanup_error: err instanceof Error ? err.message : String(err),
          organization_id: organizationId,
        }),
      );
    });
  }
  await stopBundledLocalEdgeServer();
}

async function assertLocalEdgeReady() {
  let response;
  try {
    response = await fetch(`${functionsUrl}/receipt-webhook`, { method: 'OPTIONS' });
  } catch (err) {
    throw new Error(
      `receipt-webhook is not reachable at ${functionsUrl}. Start the local Supabase Edge Runtime or set LOOPLET_LOCAL_FUNCTIONS_URL. Detail: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (response.status === 404 || response.status === 503) {
    throw new Error(
      `receipt-webhook is not being served at ${functionsUrl} (HTTP ${response.status}). Start the Edge Runtime for this workspace, or set LOOPLET_LOCAL_FUNCTIONS_URL to the receipt test stack.`,
    );
  }
}

async function assertRequiredSchema() {
  const sql = `
with required_tables(name) as (
  values
    ('organizations'),
    ('api_keys'),
    ('api_request_log'),
    ('receipt_identities'),
    ('receipt_events'),
    ('receipt_event_line_items'),
    ('receipt_audit_packages'),
    ('receipt_sync_jobs'),
    ('bills')
),
required_columns(table_name, column_name) as (
  values
    ('receipt_events', 'idempotency_key'),
    ('receipt_events', 'event_type'),
    ('receipt_events', 'related_receipt_event_id'),
    ('receipt_events', 'purchase_at'),
    ('receipt_events', 'payment_reference'),
    ('receipt_events', 'terminal_id'),
    ('receipt_events', 'store_id'),
    ('receipt_sync_jobs', 'status'),
    ('receipt_sync_jobs', 'attempts'),
    ('api_request_log', 'endpoint'),
    ('api_request_log', 'method'),
    ('api_request_log', 'ingest_type'),
    ('api_request_log', 'status'),
    ('api_request_log', 'key_prefix')
),
missing_tables as (
  select name
  from required_tables
  where to_regclass('public.' || name) is null
),
missing_columns as (
  select table_name || '.' || column_name as name
  from required_columns rc
  where not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = rc.table_name
      and c.column_name = rc.column_name
  )
)
select json_build_object(
  'missing_tables', coalesce((select json_agg(name) from missing_tables), '[]'::json),
  'missing_columns', coalesce((select json_agg(name) from missing_columns), '[]'::json)
);
`;
  const output = await runPsql(sql);
  const status = parseJsonLine(output, 'required schema status');
  if (status.missing_tables.length || status.missing_columns.length) {
    throw new Error(
      `local database is missing receipt schema: ${JSON.stringify(status)}. Apply migrations through 0187_receipt_pos_reliability.sql before running pos:local-edge-trial.`,
    );
  }
}

async function seedLocalDatabase() {
  const sql = `
set session_replication_role = replica;

insert into public.organizations (id, name, organization_type)
values
  ('${organizationId}', 'Receipt Local Edge Trial', 'standard'),
  ('${otherOrganizationId}', 'Receipt Local Edge Trial Other Org', 'standard');

insert into public.api_keys (organization_id, name, key_prefix, hashed_key, scopes, rate_limit_per_min)
values (
  '${organizationId}',
  'Local POS receipt trial ${runId}',
  '${apiPrefix}',
  '${sha256(apiSecret)}',
  array['write:receipts'],
  120
),
(
  '${otherOrganizationId}',
  'Local POS receipt other-org trial ${runId}',
  '${otherApiPrefix}',
  '${sha256(otherApiSecret)}',
  array['write:receipts'],
  120
);

insert into public.receipt_identities (organization_id, label, channel, token_prefix, token_hash, status)
values (
  '${organizationId}',
  'Local POS trial identity ${runId}',
  'pos',
  '${receiptPrefix}',
  '${sha256(receiptSecret)}',
  'active'
),
(
  '${otherOrganizationId}',
  'Local POS other-org trial identity ${runId}',
  'pos',
  '${otherReceiptPrefix}',
  '${sha256(otherReceiptSecret)}',
  'active'
);

set session_replication_role = origin;
`;
  await runPsql(sql);
}

async function seedIncompleteReceiptEvent(samplePath, mutateBody) {
  const { body } = await buildReceiptRequestBody(samplePath, mutateBody);
  const payload = body.payload ?? {};
  const receipt = payload.receipt ?? {};
  const merchant = payload.merchant ?? {};
  const classification = payload.classification ?? {};
  const idempotencyKey = `explicit:${body.idempotency_key}`;
  const purchaseAt = new Date(receipt.purchase_at).toISOString();
  const rawPayload = JSON.parse(JSON.stringify(payload));

  const sql = `
with identity as (
  select id
  from public.receipt_identities
  where organization_id = ${sqlLiteral(organizationId)}::uuid
    and token_prefix = ${sqlLiteral(receiptPrefix)}
  limit 1
),
inserted as (
  insert into public.receipt_events (
    organization_id,
    receipt_identity_id,
    idempotency_key,
    event_type,
    source_channel,
    status,
    merchant_name,
    merchant_abn,
    merchant_external_id,
    receipt_number,
    purchase_at,
    location,
    subtotal_ex_gst_cents,
    gst_cents,
    total_inc_gst_cents,
    currency_code,
    payment_method,
    payment_last4,
    payment_reference,
    terminal_id,
    store_id,
    business_use,
    deductibility_status,
    job_reference_raw,
    raw_payload,
    classification
  )
  select
    ${sqlLiteral(organizationId)}::uuid,
    identity.id,
    ${sqlLiteral(idempotencyKey)},
    ${sqlLiteral(body.event_type ?? receipt.event_type ?? 'sale')},
    ${sqlLiteral(body.source_channel ?? 'pos')},
    'received',
    ${sqlLiteral(merchant.name)},
    ${sqlLiteral(merchant.abn)},
    ${sqlLiteral(merchant.external_id)},
    ${sqlLiteral(receipt.number)},
    ${sqlLiteral(purchaseAt)}::timestamptz,
    ${sqlJson(receipt.location ?? {})},
    ${Number(receipt.subtotal_ex_gst_cents)},
    ${Number(receipt.gst_cents)},
    ${Number(receipt.total_inc_gst_cents)},
    ${sqlLiteral(receipt.currency ?? 'AUD')},
    ${sqlLiteral(receipt.payment_method)},
    ${sqlLiteral(receipt.payment_last4)},
    ${sqlLiteral(receipt.payment_reference)},
    ${sqlLiteral(receipt.terminal_id)},
    ${sqlLiteral(receipt.store_id)},
    ${sqlLiteral(classification.business_use ?? 'review')},
    ${sqlLiteral(classification.deductibility ?? 'requires_review')},
    ${sqlLiteral(classification.job_reference)},
    ${sqlJson(rawPayload)},
    ${sqlJson({ ...classification, reason: 'seeded incomplete duplicate retry negative control' })}
  from identity
  returning id, idempotency_key
)
select row_to_json(inserted) from inserted;
`;
  return parseJsonLine(await runPsql(sql), 'seeded incomplete receipt event');
}

async function deleteReceiptEventByIdempotencyKey(idempotencyKey) {
  const sql = `
set session_replication_role = replica;

delete from public.receipt_sync_jobs
where organization_id = ${sqlLiteral(organizationId)}::uuid
  and receipt_event_id in (
    select id from public.receipt_events
    where organization_id = ${sqlLiteral(organizationId)}::uuid
      and idempotency_key = ${sqlLiteral(idempotencyKey)}
  );
delete from public.receipt_event_line_items
where organization_id = ${sqlLiteral(organizationId)}::uuid
  and receipt_event_id in (
    select id from public.receipt_events
    where organization_id = ${sqlLiteral(organizationId)}::uuid
      and idempotency_key = ${sqlLiteral(idempotencyKey)}
  );
delete from public.receipt_audit_packages
where organization_id = ${sqlLiteral(organizationId)}::uuid
  and receipt_event_id in (
    select id from public.receipt_events
    where organization_id = ${sqlLiteral(organizationId)}::uuid
      and idempotency_key = ${sqlLiteral(idempotencyKey)}
  );
delete from public.receipt_events
where organization_id = ${sqlLiteral(organizationId)}::uuid
  and idempotency_key = ${sqlLiteral(idempotencyKey)};

set session_replication_role = origin;
`;
  await runPsql(sql);
}

async function installAuditPackageFailureConstraint(receiptNumber) {
  const sql = `
alter table public.receipt_audit_packages
  drop constraint if exists receipt_audit_packages_cleanup_trial_block;
alter table public.receipt_audit_packages
  add constraint receipt_audit_packages_cleanup_trial_block
  check ((evidence #>> '{receipt,number}') is distinct from ${sqlLiteral(receiptNumber)});
`;
  await runPsql(sql);
}

async function dropAuditPackageFailureConstraint() {
  const sql = `
alter table public.receipt_audit_packages
  drop constraint if exists receipt_audit_packages_cleanup_trial_block;
`;
  await runPsql(sql);
}

async function cleanupLocalDatabase() {
  const sql = `
set session_replication_role = replica;

delete from public.api_request_log where organization_id = '${organizationId}';
delete from public.api_request_log where key_prefix = '${apiPrefix}';
delete from public.receipt_sync_jobs where organization_id = '${organizationId}';
delete from public.receipt_event_line_items where organization_id = '${organizationId}';
delete from public.receipt_audit_packages where organization_id = '${organizationId}';
delete from public.receipt_events where organization_id = '${organizationId}';
delete from public.bill_line_items where organization_id = '${organizationId}';
delete from public.bills where organization_id = '${organizationId}';
delete from public.receipt_identities where organization_id = '${organizationId}';
delete from public.api_keys where organization_id = '${organizationId}';
delete from public.api_request_log where organization_id = '${otherOrganizationId}';
delete from public.api_request_log where key_prefix = '${otherApiPrefix}';
delete from public.receipt_sync_jobs where organization_id = '${otherOrganizationId}';
delete from public.receipt_event_line_items where organization_id = '${otherOrganizationId}';
delete from public.receipt_audit_packages where organization_id = '${otherOrganizationId}';
delete from public.receipt_events where organization_id = '${otherOrganizationId}';
delete from public.bill_line_items where organization_id = '${otherOrganizationId}';
delete from public.bills where organization_id = '${otherOrganizationId}';
delete from public.receipt_identities where organization_id = '${otherOrganizationId}';
delete from public.api_keys where organization_id = '${otherOrganizationId}';
delete from public.organizations where id = '${organizationId}';
delete from public.organizations where id = '${otherOrganizationId}';

set session_replication_role = origin;
`;
  await runPsql(sql);
}

async function queryCleanupState() {
  const sql = `
with counts as (
  select
    (select count(*) from public.organizations where id in ('${organizationId}', '${otherOrganizationId}'))::int as organizations,
    (select count(*) from public.api_keys where organization_id in ('${organizationId}', '${otherOrganizationId}') or key_prefix in ('${apiPrefix}', '${otherApiPrefix}'))::int as api_keys,
    (select count(*) from public.receipt_identities where organization_id in ('${organizationId}', '${otherOrganizationId}') or token_prefix in ('${receiptPrefix}', '${otherReceiptPrefix}'))::int as receipt_identities,
    (select count(*) from public.api_request_log where organization_id in ('${organizationId}', '${otherOrganizationId}') or key_prefix in ('${apiPrefix}', '${otherApiPrefix}'))::int as api_request_log,
    (select count(*) from public.receipt_sync_jobs where organization_id in ('${organizationId}', '${otherOrganizationId}'))::int as receipt_sync_jobs,
    (select count(*) from public.receipt_event_line_items where organization_id in ('${organizationId}', '${otherOrganizationId}'))::int as receipt_event_line_items,
    (select count(*) from public.receipt_audit_packages where organization_id in ('${organizationId}', '${otherOrganizationId}'))::int as receipt_audit_packages,
    (select count(*) from public.receipt_events where organization_id in ('${organizationId}', '${otherOrganizationId}'))::int as receipt_events,
    (select count(*) from public.bill_line_items where organization_id in ('${organizationId}', '${otherOrganizationId}'))::int as bill_line_items,
    (select count(*) from public.bills where organization_id in ('${organizationId}', '${otherOrganizationId}'))::int as bills
)
select row_to_json(counts) from counts;
`;
  const output = await runPsql(sql);
  return parseJsonLine(output, 'cleanup state');
}

async function queryReceiptResidue(idempotencyKey, receiptNumber) {
  const sql = `
with matching_receipts as (
  select id
  from public.receipt_events
  where organization_id = ${sqlLiteral(organizationId)}::uuid
    and idempotency_key = ${sqlLiteral(idempotencyKey)}
),
counts as (
  select
    (select count(*) from matching_receipts)::int as receipt_events,
    (select count(*) from public.receipt_event_line_items where organization_id = ${sqlLiteral(organizationId)}::uuid and receipt_event_id in (select id from matching_receipts))::int as receipt_event_line_items,
    (select count(*) from public.receipt_audit_packages where organization_id = ${sqlLiteral(organizationId)}::uuid and receipt_event_id in (select id from matching_receipts))::int as receipt_audit_packages,
    (select count(*) from public.receipt_sync_jobs where organization_id = ${sqlLiteral(organizationId)}::uuid and receipt_event_id in (select id from matching_receipts))::int as receipt_sync_jobs,
    (select count(*) from public.bills where organization_id = ${sqlLiteral(organizationId)}::uuid and invoice_number = ${sqlLiteral(receiptNumber)})::int as bills,
    (select count(*) from public.bill_line_items where organization_id = ${sqlLiteral(organizationId)}::uuid and bill_id in (
      select id from public.bills where organization_id = ${sqlLiteral(organizationId)}::uuid and invoice_number = ${sqlLiteral(receiptNumber)}
    ))::int as bill_line_items
)
select row_to_json(counts) from counts;
`;
  return parseJsonLine(await runPsql(sql), 'receipt residue');
}

async function postReceipt(name, samplePath, expectedStatus, mutateBody = null, options = {}) {
  const { body, mutation } = await buildReceiptRequestBody(samplePath, mutateBody, options);
  const idempotencyHeader = mutation?.idempotencyHeader ?? body.idempotency_key;

  const response = await fetch(`${functionsUrl}/receipt-webhook`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiPrefix ?? apiPrefix}.${options.apiSecret ?? apiSecret}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyHeader,
    },
    body: JSON.stringify(body),
  });
  const responseBody = await response.json().catch(() => ({}));
  if (response.status !== expectedStatus) {
    throw new Error(
      `${name} expected HTTP ${expectedStatus}, got ${response.status}: ${JSON.stringify(responseBody)}`,
    );
  }
  return responseBody;
}

async function buildReceiptRequestBody(samplePath, mutateBody = null, options = {}) {
  const sample = JSON.parse(await readFile(samplePath, 'utf8'));
  const body = {
    ...sample,
    identity_token: `${options.identityPrefix ?? receiptPrefix}.${options.identitySecret ?? receiptSecret}`,
    sync_targets: sample.event_type === 'sale' ? ['xero', 'myob'] : [],
  };
  const mutation = mutateBody ? mutateBody(body) : null;
  return { body, mutation };
}

async function postDispatch() {
  const response = await fetch(`${functionsUrl}/receipt-sync-dispatch`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ organization_id: organizationId, limit: 10 }),
  });
  const responseBody = await response.json().catch(() => ({}));
  if (response.status !== 200) {
    throw new Error(
      `dispatch expected HTTP 200, got ${response.status}: ${JSON.stringify(responseBody)}`,
    );
  }
  return responseBody;
}

async function queryPersistedState() {
  const sql = `
with counts as (
  select
    (select count(*) from public.receipt_events where organization_id = '${organizationId}' and event_type = 'sale')::int as sale_events,
    (select count(*) from public.receipt_events where organization_id = '${otherOrganizationId}')::int as other_org_receipt_events,
    (select count(*) from public.receipt_events where organization_id = '${organizationId}' and event_type = 'refund')::int as refund_events,
    (select count(*) from public.receipt_events where organization_id = '${organizationId}' and event_type = 'void')::int as void_events,
    (select count(*) from public.bills where organization_id = '${organizationId}')::int as bills,
    (select count(*) from public.receipt_event_line_items where organization_id = '${organizationId}')::int as line_items,
    (select count(*) from public.receipt_audit_packages where organization_id = '${organizationId}')::int as audit_packages,
    (select payment_last4 from public.receipt_events where organization_id = '${organizationId}' and event_type = 'sale' limit 1) as sale_payment_last4,
    (select raw_payload #>> '{receipt,identity_token}' from public.receipt_events where organization_id = '${organizationId}' and event_type = 'sale' limit 1) as sale_raw_receipt_identity_token,
    (select purchase_at from public.receipt_events where organization_id = '${organizationId}' and event_type = 'sale' limit 1) as sale_purchase_at,
    coalesce((
      select sum(li.gst_cents) from public.receipt_event_line_items li
      join public.receipt_events re on re.id = li.receipt_event_id
      where li.organization_id = '${organizationId}' and re.event_type = 'sale'
    ), 0)::int as sale_line_gst_cents,
    coalesce((
      select sum(li.gst_cents) from public.receipt_event_line_items li
      join public.receipt_events re on re.id = li.receipt_event_id
      where li.organization_id = '${organizationId}' and re.event_type = 'refund'
    ), 0)::int as refund_line_gst_cents,
    coalesce((
      select sum(li.gst_cents) from public.receipt_event_line_items li
      join public.receipt_events re on re.id = li.receipt_event_id
      where li.organization_id = '${organizationId}' and re.event_type = 'void'
    ), 0)::int as void_line_gst_cents,
    (select count(*) from public.receipt_sync_jobs where organization_id = '${organizationId}' and status = 'skipped')::int as skipped_sync_jobs,
    (select count(*) from public.receipt_sync_jobs where organization_id = '${organizationId}' and status = 'failed')::int as failed_sync_jobs,
    (select count(*) from public.api_request_log where organization_id = '${organizationId}' and endpoint = 'receipt-webhook')::int as api_log_total,
    (select count(*) from public.api_request_log where organization_id = '${organizationId}' and endpoint = 'receipt-webhook' and method = 'POST')::int as api_log_post_count,
    (select count(*) from public.api_request_log where organization_id = '${organizationId}' and endpoint = 'receipt-webhook' and ingest_type = 'receipt')::int as api_log_receipt_type_count,
    (select count(*) from public.api_request_log where organization_id = '${organizationId}' and endpoint = 'receipt-webhook' and key_prefix = '${apiPrefix}')::int as api_log_key_prefix_count,
    (select count(*) from public.api_request_log where organization_id = '${organizationId}' and endpoint = 'receipt-webhook' and status = 200)::int as api_log_success_count,
    (select count(*) from public.api_request_log where organization_id = '${organizationId}' and endpoint = 'receipt-webhook' and status = 400)::int as api_log_validation_error_count,
    (select count(*) from public.api_request_log where organization_id = '${organizationId}' and endpoint = 'receipt-webhook' and status = 500)::int as api_log_server_error_count,
    (select count(*) from public.api_request_log where organization_id = '${organizationId}' and endpoint = 'receipt-webhook' and key_prefix = '${otherApiPrefix}')::int as api_log_other_key_prefix_rows,
    (select count(*) from public.api_request_log where organization_id = '${otherOrganizationId}' and endpoint = 'receipt-webhook' and key_prefix = '${otherApiPrefix}' and status = 400)::int as other_org_api_log_validation_error_count,
    exists (
      select 1 from public.receipt_events
      where organization_id = '${organizationId}' and event_type = 'refund' and related_receipt_event_id is not null
    ) as refund_linked,
    exists (
      select 1 from public.receipt_events
      where organization_id = '${organizationId}' and event_type = 'void' and related_receipt_event_id is not null
    ) as void_linked,
    (select count(*) from public.receipt_events where organization_id = '${organizationId}' and event_type = 'refund' and receipt_number = 'POS-2026-0001')::int as same_number_refund_events,
    (select count(*) from public.receipt_events where organization_id = '${organizationId}' and event_type = 'void' and receipt_number = 'POS-2026-0001')::int as same_number_void_events
)
select row_to_json(counts) from counts;
`;
  const output = await runPsql(sql);
  return parseJsonLine(output, 'persisted state');
}

async function runPsql(sql) {
  const child = spawn(
    'docker',
    [
      'exec',
      '-i',
      dbContainer,
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-tA',
    ],
    {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(sql);

  const code = await new Promise((resolve) => child.on('exit', resolve));
  if (code !== 0) {
    throw new Error(`psql failed with ${code}\nstdout=${stdout}\nstderr=${stderr}`);
  }
  return stdout;
}

async function detectDbContainer() {
  if (await containerExists(DEFAULT_DB_CONTAINER)) return DEFAULT_DB_CONTAINER;

  const output = await runProcess('docker', [
    'ps',
    '--filter',
    'label=com.supabase.cli.project',
    '--format',
    '{{.Names}}',
  ]);
  const dbContainers = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((name) => /^supabase_db_/.test(name));

  if (dbContainers.length === 1) return dbContainers[0];
  if (dbContainers.length > 1) {
    throw new Error(
      `multiple local Supabase DB containers found (${dbContainers.join(', ')}); set LOOPLET_LOCAL_DB_CONTAINER`,
    );
  }

  throw new Error(
    `no local Supabase DB container found; start Supabase locally or set LOOPLET_LOCAL_DB_CONTAINER`,
  );
}

async function detectSupabaseApiUrl(suffix) {
  const kongContainer = `supabase_kong_${suffix}`;
  if (!(await containerExists(kongContainer))) return DEFAULT_FUNCTIONS_URL.replace('/functions/v1', '');
  const output = await runProcess('docker', ['port', kongContainer, '8000/tcp']);
  const portLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.includes(':'));
  const port = portLine?.match(/:(\d+)$/)?.[1];
  return port ? `http://127.0.0.1:${port}` : DEFAULT_FUNCTIONS_URL.replace('/functions/v1', '');
}

async function detectServiceRoleKey(suffix) {
  const edgeContainer = `supabase_edge_runtime_${suffix}`;
  if (await containerExists(edgeContainer)) {
    const edgeKey = await readContainerEnv(edgeContainer, 'SUPABASE_SERVICE_ROLE_KEY');
    if (edgeKey) return edgeKey;
  }

  const statusKey = await readServiceRoleFromSupabaseStatus();
  if (statusKey) return statusKey;

  throw new Error(
    'LOOPLET_LOCAL_SERVICE_ROLE_KEY is required. Start a local Supabase Edge Runtime, use "supabase status --output env", or set LOOPLET_LOCAL_SERVICE_ROLE_KEY explicitly.',
  );
}

async function detectAnonKey(suffix) {
  const edgeContainer = `supabase_edge_runtime_${suffix}`;
  if (await containerExists(edgeContainer)) {
    const edgeKey = await readContainerEnv(edgeContainer, 'SUPABASE_ANON_KEY');
    if (edgeKey) return edgeKey;
  }

  const statusKey = await readAnonFromSupabaseStatus();
  if (statusKey) return statusKey;

  throw new Error(
    'LOOPLET_LOCAL_ANON_KEY is required. Start a local Supabase Edge Runtime, use "supabase status --output env", or set LOOPLET_LOCAL_ANON_KEY explicitly.',
  );
}

async function readServiceRoleFromSupabaseStatus() {
  try {
    const output = await runProcess('supabase', ['status', '--output', 'env']);
    const line = output
      .split(/\r?\n/)
      .find((candidate) => candidate.startsWith('SERVICE_ROLE_KEY='));
    return line?.slice('SERVICE_ROLE_KEY='.length).trim() || null;
  } catch {
    return null;
  }
}

async function readAnonFromSupabaseStatus() {
  try {
    const output = await runProcess('supabase', ['status', '--output', 'env']);
    const line = output
      .split(/\r?\n/)
      .find((candidate) => candidate.startsWith('ANON_KEY='));
    return line?.slice('ANON_KEY='.length).trim() || null;
  } catch {
    return null;
  }
}

async function readContainerEnv(container, key) {
  const output = await runProcess('docker', ['inspect', container, '--format', '{{json .Config.Env}}']);
  const values = JSON.parse(output);
  const entry = values.find((item) => item.startsWith(`${key}=`));
  return entry ? entry.slice(key.length + 1) : null;
}

async function startBundledLocalEdgeServer(apiUrl, serviceKey, anon) {
  const port = await findFreePort();
  const url = `http://127.0.0.1:${port}/functions/v1`;
  const child = spawn(
    'deno',
    [
      'run',
      '--allow-env',
      '--allow-net',
      '--allow-read',
      'examples/pos-bridge/local-edge-server.ts',
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        SUPABASE_URL: apiUrl,
        SUPABASE_ANON_KEY: anon,
        SUPABASE_SERVICE_ROLE_KEY: serviceKey,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  localEdgeServer = child;

  for (let i = 0; i < 50; i++) {
    if (child.exitCode != null) {
      throw new Error(`bundled local edge server exited early with ${child.exitCode}: ${stderr || stdout}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return url;
    } catch {
      // Keep waiting while Deno downloads/imports remote dependencies.
    }
    await delay(250);
  }

  throw new Error(`bundled local edge server did not become ready: ${stderr || stdout}`);
}

async function stopBundledLocalEdgeServer() {
  if (!localEdgeServer) return;
  if (localEdgeServer.exitCode == null) {
    localEdgeServer.kill();
    await Promise.race([
      new Promise((resolve) => localEdgeServer.once('exit', resolve)),
      delay(2000),
    ]);
  }
  localEdgeServer = null;
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(() => {
        if (!port) reject(new Error('could not allocate a local port'));
        else resolve(port);
      });
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanLocalSecret(value) {
  return value.trim().replace(/^"+|"+$/g, '');
}

async function containerExists(name) {
  const output = await runProcess('docker', ['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']);
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .includes(name);
}

async function runProcess(command, args) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const code = await new Promise((resolve) => child.on('exit', resolve));
  if (code !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with ${code}: ${stderr || stdout}`);
  }
  return stdout.trim();
}

function parseJsonLine(output, label) {
  const jsonLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('{'));
  if (!jsonLine) throw new Error(`could not read ${label} from psql output: ${output}`);
  return JSON.parse(jsonLine);
}

function sqlLiteral(value) {
  if (value == null) return 'null';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlJson(value) {
  return `${sqlLiteral(JSON.stringify(value ?? {}))}::jsonb`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
