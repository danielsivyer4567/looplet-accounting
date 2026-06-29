#!/usr/bin/env node
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

const rootDir = process.env.LOOPLET_ACCEPTANCE_TRIAL_DIR || '.claude/scratch/pos-acceptance-trial';
const envFile = join(rootDir, 'acceptance.env');
const noFallbackEnvFile = join(rootDir, 'acceptance-no-fallback.env');
const liveGuardEnvFile = join(rootDir, 'live-guard.env');
const evidenceFile = join(rootDir, 'evidence.json');
const noFallbackEvidenceFile = join(rootDir, 'evidence-no-fallback.json');
const scannedSaleFile = join(rootDir, 'field-sale-scanned.json');
const scannedRefundFile = join(rootDir, 'field-refund-scanned.json');
const scannedVoidFile = join(rootDir, 'field-void-scanned.json');
const seen = new Map();
const receiptEvents = [];
const receiptEventLineItems = [];
const receiptAuditPackages = [];
const receiptSyncJobs = [];
const apiRequestLogs = [];
let saleEventId = null;
let saleReceiptNumber = null;
let saleOriginalExternalEventId = null;
let invalidApiRejected = false;
let invalidIdentityRejected = false;
let pendingRejected = false;
let badLineTotalsRejected = false;
let badLineGstRejected = false;
let idempotencyMismatchRejected = false;
let idempotencyTaxMismatchRejected = false;
let idempotencyPurchaseAtMismatchRejected = false;
let idempotencySourceMismatchRejected = false;
let missingMerchantRejected = false;
let missingPaymentReferenceRejected = false;
let badPaymentLast4Rejected = false;
let missingPurchaseAtRejected = false;
let badPurchaseAtRejected = false;
let missingTaxBreakdownRejectedCount = 0;
let badTaxBreakdownRejected = false;
let missingOriginalReferenceRejected = false;
let unresolvedOriginalReferenceRejectedCount = 0;

const server = createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/rest/v1/')) {
    handleRestRead(req, res, url);
    return;
  }

  res.once('finish', () => {
    recordReceiptApiRequest(req, res.statusCode);
  });

  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    if (req.headers.authorization !== 'Bearer llp_trial.secret') {
      invalidApiRejected = true;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid_api_key' }));
      return;
    }

    try {
      const parsed = JSON.parse(body);
      assert(req.method === 'POST', 'method must be POST');
      if (req.headers['idempotency-key'] !== parsed.idempotency_key) {
        idempotencySourceMismatchRejected = true;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Idempotency-Key header must match body idempotency_key' }));
        return;
      }
      if (parsed.identity_token !== 'rhp_trial.receiptsecret') {
        invalidIdentityRejected = true;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'receipt identity not found or inactive' }));
        return;
      }

      const merchantName = parsed.payload?.merchant?.name;
      if (typeof merchantName !== 'string' || merchantName.trim().length < 2) {
        missingMerchantRejected = true;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'merchant.name required for POS receipt ingestion' }));
        return;
      }

      if (!parsed.payload.receipt.payment_reference) {
        missingPaymentReferenceRejected = true;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'receipt.payment_reference required for POS receipt ingestion' }));
        return;
      }

      const purchaseAt = parsed.payload.receipt.purchase_at;
      if (typeof purchaseAt !== 'string' || purchaseAt.trim().length === 0) {
        missingPurchaseAtRejected = true;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'receipt.purchase_at required for POS receipt ingestion' }));
        return;
      }
      if (Number.isNaN(new Date(purchaseAt).getTime())) {
        badPurchaseAtRejected = true;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'receipt.purchase_at must be a valid date-time' }));
        return;
      }
      parsed.payload.receipt.purchase_at = new Date(purchaseAt).toISOString();

      if (String(parsed.payload.receipt.payment_last4 ?? '').replace(/\D/g, '').length > 4) {
        badPaymentLast4Rejected = true;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'receipt.payment_last4 must not contain a full card number' }));
        return;
      }

      if (!parsed.payload.receipt.tender_status || parsed.payload.receipt.tender_status === 'pending') {
        pendingRejected = true;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'receipt tender_status must be final' }));
        return;
      }

      const lineTotal = parsed.payload.line_items.reduce((sum, line) => sum + line.total_inc_gst_cents, 0);
      if (lineTotal !== parsed.payload.receipt.total_inc_gst_cents) {
        badLineTotalsRejected = true;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'line_items total must match receipt.total_inc_gst_cents' }));
        return;
      }

      const gst = parsed.payload.receipt.gst_cents;
      const subtotal = parsed.payload.receipt.subtotal_ex_gst_cents;
      if (gst == null || subtotal == null) {
        missingTaxBreakdownRejectedCount += 1;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'receipt.gst_cents and receipt.subtotal_ex_gst_cents required for POS receipt ingestion' }));
        return;
      }
      if (gst != null && subtotal != null && Math.abs(Number(gst) + Number(subtotal) - parsed.payload.receipt.total_inc_gst_cents) > 1) {
        badTaxBreakdownRejected = true;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'receipt subtotal + GST must match receipt.total_inc_gst_cents' }));
        return;
      }
      const lineGst = parsed.payload.line_items.reduce((sum, line) => sum + Number(line.gst_cents ?? 0), 0);
      if (lineGst !== parsed.payload.receipt.gst_cents) {
        badLineGstRejected = true;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'line_items GST total must match receipt.gst_cents' }));
        return;
      }

      if (
        parsed.event_type !== 'sale' &&
        !parsed.payload.receipt.original_receipt_number &&
        !parsed.payload.receipt.original_external_event_id
      ) {
        missingOriginalReferenceRejected = true;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'refund/void receipts require original_receipt_number or original_external_event_id' }));
        return;
      }

      if (parsed.event_type !== 'sale') {
        const originalReceiptNumber = parsed.payload.receipt.original_receipt_number;
        const originalExternalEventId = parsed.payload.receipt.original_external_event_id;
        if (originalReceiptNumber !== saleReceiptNumber && originalExternalEventId !== saleOriginalExternalEventId) {
          unresolvedOriginalReferenceRejectedCount += 1;
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'refund/void receipts must reference an existing original sale receipt' }));
          return;
        }
      }

      const prior = seen.get(parsed.idempotency_key);
      if (prior) {
        if (
          prior.receipt_number !== parsed.payload.receipt.number ||
          prior.subtotal_ex_gst_cents !== parsed.payload.receipt.subtotal_ex_gst_cents ||
          prior.gst_cents !== parsed.payload.receipt.gst_cents ||
          prior.total_inc_gst_cents !== parsed.payload.receipt.total_inc_gst_cents ||
          prior.purchase_at !== parsed.payload.receipt.purchase_at ||
          prior.payment_reference !== parsed.payload.receipt.payment_reference
        ) {
          let mismatchError = 'idempotency key reused with different receipt payload fields';
          if (
            prior.receipt_number === parsed.payload.receipt.number &&
            prior.total_inc_gst_cents === parsed.payload.receipt.total_inc_gst_cents &&
            (
              prior.subtotal_ex_gst_cents !== parsed.payload.receipt.subtotal_ex_gst_cents ||
              prior.gst_cents !== parsed.payload.receipt.gst_cents
            )
          ) {
            idempotencyTaxMismatchRejected = true;
            mismatchError = 'idempotency key reused with different receipt payload fields: receipt.subtotal_ex_gst_cents, receipt.gst_cents';
          } else if (
            prior.receipt_number === parsed.payload.receipt.number &&
            prior.total_inc_gst_cents === parsed.payload.receipt.total_inc_gst_cents &&
            prior.subtotal_ex_gst_cents === parsed.payload.receipt.subtotal_ex_gst_cents &&
            prior.gst_cents === parsed.payload.receipt.gst_cents &&
            prior.purchase_at !== parsed.payload.receipt.purchase_at
          ) {
            idempotencyPurchaseAtMismatchRejected = true;
            mismatchError = 'idempotency key reused with different receipt payload fields: receipt.purchase_at';
          } else {
            idempotencyMismatchRejected = true;
          }
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            ok: false,
            error: mismatchError,
          }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          duplicate: true,
          event_type: prior.event_type,
          receipt_event_id: prior.receipt_event_id,
          related_receipt_event_id: prior.related_receipt_event_id,
          bill_id: prior.bill_id,
          sync_jobs: prior.sync_jobs,
        }));
        return;
      }

      const receiptEventId = `accept-${parsed.event_type}-${seen.size + 1}`;
      const organizationId = 'org-trial';
      const result = {
        ok: true,
        duplicate: false,
        event_type: parsed.event_type,
        receipt_event_id: receiptEventId,
        related_receipt_event_id: parsed.event_type === 'sale' ? null : saleEventId,
        bill_id: null,
        receipt_number: parsed.payload.receipt.number,
        purchase_at: parsed.payload.receipt.purchase_at,
        subtotal_ex_gst_cents: parsed.payload.receipt.subtotal_ex_gst_cents,
        gst_cents: parsed.payload.receipt.gst_cents,
        total_inc_gst_cents: parsed.payload.receipt.total_inc_gst_cents,
        payment_reference: parsed.payload.receipt.payment_reference,
        payment_last4: parsed.payload.receipt.payment_last4,
        sync_jobs: parsed.event_type === 'sale'
          ? [{ id: `sync-${seen.size + 1}`, provider: 'xero', status: 'skipped' }]
          : [],
      };
      if (parsed.event_type === 'sale') {
        saleEventId = receiptEventId;
        saleReceiptNumber = parsed.payload.receipt.number;
        saleOriginalExternalEventId = parsed.payload.receipt.external_event_id;
      }
      assert(parsed.event_type === 'sale' || parsed.payload.receipt.original_external_event_id, 'non-sale receipt missing original_external_event_id');
      seen.set(parsed.idempotency_key, result);
      receiptEvents.push({
        id: receiptEventId,
        organization_id: organizationId,
        event_type: parsed.event_type,
        idempotency_key: storedExplicitIdempotencyKey(parsed.idempotency_key),
        related_receipt_event_id: result.related_receipt_event_id,
        receipt_number: parsed.payload.receipt.number,
        purchase_at: parsed.payload.receipt.purchase_at,
        total_inc_gst_cents: parsed.payload.receipt.total_inc_gst_cents,
        status: parsed.event_type === 'sale' ? 'personal' : parsed.event_type === 'void' ? 'voided' : 'refunded',
        business_use: parsed.payload.classification?.business_use ?? 'review',
        deductibility_status: parsed.payload.classification?.deductibility ?? 'requires_review',
        bill_id: result.bill_id,
        payment_reference: parsed.payload.receipt.payment_reference,
        payment_last4: parsed.payload.receipt.payment_last4,
        terminal_id: parsed.payload.receipt.terminal_id,
        store_id: parsed.payload.receipt.store_id,
      });
      for (const line of parsed.payload.line_items) {
        receiptEventLineItems.push({
          receipt_event_id: receiptEventId,
          total_inc_gst_cents: line.total_inc_gst_cents,
          gst_cents: line.gst_cents,
        });
      }
      receiptAuditPackages.push({
        id: `audit-${seen.size}`,
        receipt_event_id: receiptEventId,
        bill_id: result.bill_id,
        gst_status: 'supplied',
        deductibility_status: parsed.payload.classification?.deductibility ?? 'requires_review',
      });
      for (const job of result.sync_jobs) {
        receiptSyncJobs.push({
          ...job,
          receipt_event_id: receiptEventId,
          bill_id: result.bill_id,
        });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: error.message }));
    }
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

try {
  await rm(rootDir, { recursive: true, force: true });
  await mkdir(rootDir, { recursive: true });
  await writeFile(envFile, [
    `LOOPLET_RECEIPT_WEBHOOK_URL=http://127.0.0.1:${port}/functions/v1/receipt-webhook`,
    'LOOPLET_POS_API_KEY=llp_trial.secret',
    'LOOPLET_RECEIPT_IDENTITY_TOKEN=rhp_trial.receiptsecret',
    'LOOPLET_ACCEPTANCE_RUN_ID=trial001',
    `LOOPLET_ACCEPTANCE_EVIDENCE_FILE=${evidenceFile}`,
    `LOOPLET_ACCEPTANCE_SUPABASE_URL=http://127.0.0.1:${port}`,
    'LOOPLET_ACCEPTANCE_SERVICE_ROLE_KEY=service_role_trial',
    'LOOPLET_ACCEPTANCE_ORG_ID=org-trial',
    '',
  ].join('\n'));

  const run = await runAcceptance(envFile, 0);
  const evidence = JSON.parse(await readFile(evidenceFile, 'utf8'));
  assert(evidence.ok === true, 'evidence should be ok');
  assert(evidence.checks.sale.ok === true, 'sale check missing');
  assert(evidence.checks.duplicate.duplicate === true, 'duplicate check missing');
  assert(evidence.checks.idempotency_mismatch_rejection.status === 400, 'idempotency mismatch rejection missing');
  assert(evidence.checks.idempotency_tax_mismatch_rejection.status === 400, 'idempotency tax mismatch rejection missing');
  assert(evidence.checks.idempotency_purchase_at_mismatch_rejection.status === 400, 'idempotency purchase_at mismatch rejection missing');
  assert(evidence.checks.idempotency_source_mismatch_rejection.status === 400, 'idempotency source mismatch rejection missing');
  assert(evidence.checks.missing_merchant_rejection.status === 400, 'missing merchant rejection missing');
  assert(evidence.checks.missing_payment_reference_rejection.status === 400, 'missing payment reference rejection missing');
  assert(evidence.checks.bad_payment_last4_rejection.status === 400, 'bad payment last4 rejection missing');
  assert(evidence.checks.missing_purchase_at_rejection.status === 400, 'missing purchase_at rejection missing');
  assert(evidence.checks.bad_purchase_at_rejection.status === 400, 'bad purchase_at rejection missing');
  assert(evidence.checks.missing_gst_rejection.status === 400, 'missing GST rejection missing');
  assert(evidence.checks.missing_subtotal_rejection.status === 400, 'missing subtotal rejection missing');
  assert(evidence.checks.bad_tax_breakdown_rejection.status === 400, 'bad tax breakdown rejection missing');
  assert(evidence.checks.refund.related_receipt_event_id === evidence.checks.sale.receipt_event_id, 'refund link missing');
  assert(evidence.checks.refund_duplicate.duplicate === true, 'refund duplicate check missing');
  assert(evidence.checks.refund_duplicate.receipt_event_id === evidence.checks.refund.receipt_event_id, 'refund duplicate should return same event');
  assert(evidence.checks.void.related_receipt_event_id === evidence.checks.sale.receipt_event_id, 'void link missing');
  assert(evidence.checks.void.sync_jobs.length === 0, 'void should not create sync jobs');
  assert(evidence.checks.void_duplicate.duplicate === true, 'void duplicate check missing');
  assert(evidence.checks.void_duplicate.receipt_event_id === evidence.checks.void.receipt_event_id, 'void duplicate should return same event');
  assert(evidence.checks.pending_rejection.status === 400, 'pending rejection missing');
  assert(evidence.checks.bad_line_totals_rejection.status === 400, 'bad line totals rejection missing');
  assert(evidence.checks.bad_line_gst_rejection.status === 400, 'bad line GST rejection missing');
  assert(evidence.checks.missing_tender_rejection.status === 400, 'missing tender rejection missing');
  assert(evidence.checks.missing_original_reference_rejection.status === 400, 'missing original reference rejection missing');
  assert(evidence.checks.missing_void_original_reference_rejection.status === 400, 'missing void original reference rejection missing');
  assert(evidence.checks.unresolved_original_reference_rejection.status === 400, 'unresolved original reference rejection missing');
  assert(evidence.checks.unresolved_void_original_reference_rejection.status === 400, 'unresolved void original reference rejection missing');
  assert(evidence.checks.invalid_api_key_rejection.status === 401, 'invalid API key rejection missing');
  assert(evidence.checks.invalid_identity_rejection.status === 400, 'invalid identity rejection missing');
  assert(evidence.persistence.checked === true, 'persistence verification should run');
  assert(evidence.persistence.receipt_events.sale_idempotency_rows === 1, 'persistence should prove exactly one sale idempotency row');
  assert(evidence.persistence.receipt_events.refund_idempotency_rows === 1, 'persistence should prove exactly one refund idempotency row');
  assert(evidence.persistence.receipt_events.void_idempotency_rows === 1, 'persistence should prove exactly one void idempotency row');
  assert(evidence.persistence.receipt_events.rejected_negative_controls === 0, 'negative controls should not persist');
  assert(evidence.persistence.line_items.sale_total_inc_gst_cents === 36000, 'sale line item readback total mismatch');
  assert(evidence.persistence.line_items.sale_gst_cents === 3273, 'sale line item readback GST mismatch');
  assert(evidence.persistence.line_items.refund_gst_cents === 545, 'refund line item readback GST mismatch');
  assert(evidence.persistence.line_items.void_gst_cents === 0, 'void line item readback GST mismatch');
  assert(evidence.persistence.audit_packages.sale_count === 1, 'sale audit readback missing');
  assert(evidence.persistence.audit_packages.refund_count === 1, 'refund audit readback missing');
  assert(evidence.persistence.audit_packages.void_count === 1, 'void audit readback missing');
  assert(evidence.persistence.api_request_log.total >= 10, 'API request log readback missing');
  assert(evidence.persistence.api_request_log.post_count >= 10, 'API request log POST readback missing');
  assert(evidence.persistence.api_request_log.success_count >= 6, 'API request log success readback missing');
  assert(evidence.persistence.api_request_log.validation_error_count >= 10, 'API request log validation rejection readback missing');
  assert(evidence.persistence.api_request_log.key_prefix_matches === true, 'API request log key prefix mismatch');
  assert(invalidApiRejected === true, 'fake endpoint did not see invalid API key request');
  assert(invalidIdentityRejected === true, 'fake endpoint did not see invalid identity request');
  assert(pendingRejected === true, 'fake endpoint did not see pending rejection');
  assert(badLineTotalsRejected === true, 'fake endpoint did not see bad line totals rejection');
  assert(badLineGstRejected === true, 'fake endpoint did not see bad line GST rejection');
  assert(idempotencyMismatchRejected === true, 'fake endpoint did not see idempotency mismatch rejection');
  assert(idempotencyPurchaseAtMismatchRejected === true, 'fake endpoint did not see idempotency purchase_at mismatch rejection');
  assert(idempotencySourceMismatchRejected === true, 'fake endpoint did not see idempotency source mismatch rejection');
  assert(missingMerchantRejected === true, 'fake endpoint did not see missing merchant rejection');
  assert(missingPurchaseAtRejected === true, 'fake endpoint did not see missing purchase_at rejection');
  assert(badPurchaseAtRejected === true, 'fake endpoint did not see bad purchase_at rejection');
  assert(missingTaxBreakdownRejectedCount === 2, 'fake endpoint did not see both missing tax-field rejections');
  assert(badTaxBreakdownRejected === true, 'fake endpoint did not see bad tax breakdown rejection');
  assert(missingOriginalReferenceRejected === true, 'fake endpoint did not see missing original reference rejection');
  assert(unresolvedOriginalReferenceRejectedCount === 2, 'fake endpoint did not see both unresolved original reference rejections');

  await writeScannedSample(scannedSaleFile, 'examples/pos-bridge/sample-receipt.json');
  await writeScannedSample(scannedRefundFile, 'examples/pos-bridge/sample-refund.json');
  await writeScannedSample(scannedVoidFile, 'examples/pos-bridge/sample-void.json');
  await writeFile(noFallbackEnvFile, [
    `LOOPLET_RECEIPT_WEBHOOK_URL=http://127.0.0.1:${port}/functions/v1/receipt-webhook`,
    'LOOPLET_POS_API_KEY=llp_trial.secret',
    'LOOPLET_ACCEPTANCE_RUN_ID=trialscan',
    `LOOPLET_ACCEPTANCE_EVIDENCE_FILE=${noFallbackEvidenceFile}`,
    `LOOPLET_ACCEPTANCE_SUPABASE_URL=http://127.0.0.1:${port}`,
    'LOOPLET_ACCEPTANCE_SERVICE_ROLE_KEY=service_role_trial',
    'LOOPLET_ACCEPTANCE_ORG_ID=org-trial',
    '',
  ].join('\n'));
  const noFallbackRun = await runAcceptance(noFallbackEnvFile, 0, [
    '--sale', scannedSaleFile,
    '--refund', scannedRefundFile,
    '--void', scannedVoidFile,
  ]);
  const noFallbackEvidence = JSON.parse(await readFile(noFallbackEvidenceFile, 'utf8'));
  assert(noFallbackEvidence.ok === true, 'acceptance should pass with scanned receipt identities and no fallback env token');
  assert(noFallbackRun.stdout.includes('"ok": true'), 'no-fallback acceptance stdout should be ok');
  assert(
    noFallbackEvidence.checks.sale.receipt_event_id === noFallbackEvidence.checks.duplicate.receipt_event_id,
    'no-fallback duplicate should return the same sale receipt_event_id',
  );
  assert(
    noFallbackEvidence.checks.pending_rejection.status === 400,
    'no-fallback pending negative control should still reach tender validation',
  );

  await writeFile(liveGuardEnvFile, [
    'LOOPLET_RECEIPT_WEBHOOK_URL=https://example.supabase.co/functions/v1/receipt-webhook',
    'LOOPLET_POS_API_KEY=llp_trial.secret',
    'LOOPLET_RECEIPT_IDENTITY_TOKEN=rhp_trial.receiptsecret',
    '',
  ].join('\n'));
  const liveGuard = await runAcceptance(liveGuardEnvFile, 1);
  assert(liveGuard.stderr.includes('LOOPLET_ACCEPTANCE_CONFIRM_LIVE=1'), 'non-local safety guard did not fire');

  console.log(JSON.stringify({
    ok: true,
    stdout_ok: run.stdout.includes('"ok": true'),
    sale_event_id: evidence.checks.sale.receipt_event_id,
    duplicate_same_event: evidence.checks.duplicate.receipt_event_id === evidence.checks.sale.receipt_event_id,
    idempotency_mismatch_rejected: evidence.checks.idempotency_mismatch_rejection.status === 400,
    idempotency_tax_mismatch_rejected: evidence.checks.idempotency_tax_mismatch_rejection.status === 400,
    idempotency_purchase_at_mismatch_rejected: evidence.checks.idempotency_purchase_at_mismatch_rejection.status === 400,
    idempotency_source_mismatch_rejected: evidence.checks.idempotency_source_mismatch_rejection.status === 400,
    missing_merchant_rejected: evidence.checks.missing_merchant_rejection.status === 400,
    missing_payment_reference_rejected: evidence.checks.missing_payment_reference_rejection.status === 400,
    bad_payment_last4_rejected: evidence.checks.bad_payment_last4_rejection.status === 400,
    missing_purchase_at_rejected: evidence.checks.missing_purchase_at_rejection.status === 400,
    bad_purchase_at_rejected: evidence.checks.bad_purchase_at_rejection.status === 400,
    missing_gst_rejected: evidence.checks.missing_gst_rejection.status === 400,
    missing_subtotal_rejected: evidence.checks.missing_subtotal_rejection.status === 400,
    bad_tax_breakdown_rejected: evidence.checks.bad_tax_breakdown_rejection.status === 400,
    refund_linked: evidence.checks.refund.related_receipt_event_id === evidence.checks.sale.receipt_event_id,
    refund_duplicate_same_event: evidence.checks.refund_duplicate.receipt_event_id === evidence.checks.refund.receipt_event_id,
    void_linked: evidence.checks.void.related_receipt_event_id === evidence.checks.sale.receipt_event_id,
    void_duplicate_same_event: evidence.checks.void_duplicate.receipt_event_id === evidence.checks.void.receipt_event_id,
    pending_rejected: evidence.checks.pending_rejection.status === 400,
    bad_line_totals_rejected: evidence.checks.bad_line_totals_rejection.status === 400,
    bad_line_gst_rejected: evidence.checks.bad_line_gst_rejection.status === 400,
    missing_tender_rejected: evidence.checks.missing_tender_rejection.status === 400,
    missing_original_reference_rejected: evidence.checks.missing_original_reference_rejection.status === 400,
    missing_void_original_reference_rejected: evidence.checks.missing_void_original_reference_rejection.status === 400,
    unresolved_original_reference_rejected: evidence.checks.unresolved_original_reference_rejection.status === 400,
    unresolved_void_original_reference_rejected: evidence.checks.unresolved_void_original_reference_rejection.status === 400,
    invalid_api_key_rejected: evidence.checks.invalid_api_key_rejection.status === 401,
    invalid_identity_rejected: evidence.checks.invalid_identity_rejection.status === 400,
    fake_endpoint_rejected_idempotency_tax_mismatch: idempotencyTaxMismatchRejected,
    fake_endpoint_rejected_idempotency_purchase_at_mismatch: idempotencyPurchaseAtMismatchRejected,
    fake_endpoint_rejected_missing_payment_reference: missingPaymentReferenceRejected,
    fake_endpoint_rejected_bad_payment_last4: badPaymentLast4Rejected,
    fake_endpoint_rejected_missing_purchase_at: missingPurchaseAtRejected,
    fake_endpoint_rejected_bad_purchase_at: badPurchaseAtRejected,
    persistence_checked: evidence.persistence.checked === true,
    negative_controls_not_persisted: evidence.persistence.receipt_events.rejected_negative_controls === 0,
    api_request_log_ok: evidence.persistence.api_request_log.total >= 10 &&
      evidence.persistence.api_request_log.success_count >= 6 &&
      evidence.persistence.api_request_log.validation_error_count >= 10 &&
      evidence.persistence.api_request_log.key_prefix_matches === true,
    scanned_identity_without_fallback_env_passed: noFallbackEvidence.ok === true,
    no_fallback_duplicate_same_event: noFallbackEvidence.checks.duplicate.receipt_event_id === noFallbackEvidence.checks.sale.receipt_event_id,
    no_fallback_pending_rejected: noFallbackEvidence.checks.pending_rejection.status === 400,
    non_local_requires_confirmation: true,
  }, null, 2));
} finally {
  server.close();
}

async function writeScannedSample(outputFile, sampleFile) {
  const receipt = JSON.parse(await readFile(sampleFile, 'utf8'));
  receipt.identity_token = 'rhp_trial.receiptsecret';
  await writeFile(outputFile, JSON.stringify(receipt, null, 2));
}

async function runAcceptance(file, expectedCode, extraArgs = []) {
  const child = spawn(process.execPath, ['examples/pos-bridge/acceptance.mjs', '--env-file', file, ...extraArgs], {
    cwd: process.cwd(),
    env: acceptanceEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
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
  if (code !== expectedCode) {
    throw new Error(`acceptance exited ${code}, expected ${expectedCode}\nstdout=${stdout}\nstderr=${stderr}`);
  }
  return { stdout, stderr };
}

function acceptanceEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('LOOPLET_')) delete env[key];
  }
  return env;
}

function recordReceiptApiRequest(req, status) {
  const authHeader = String(req.headers.authorization ?? '');
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : '';
  const keyPrefix = bearer ? bearer.split('.')[0] : null;
  apiRequestLogs.push({
    organization_id: keyPrefix === 'llp_trial' ? 'org-trial' : null,
    endpoint: 'receipt-webhook',
    method: req.method,
    ingest_type: 'receipt',
    status,
    key_prefix: keyPrefix,
  });
}

function handleRestRead(req, res, url) {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'method_not_allowed' }));
    return;
  }
  if (req.headers.authorization !== 'Bearer service_role_trial') {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'invalid_service_role' }));
    return;
  }

  const table = url.pathname.replace('/rest/v1/', '');
  let rows;
  if (table === 'receipt_events') rows = receiptEvents;
  else if (table === 'receipt_event_line_items') rows = receiptEventLineItems;
  else if (table === 'receipt_audit_packages') rows = receiptAuditPackages;
  else if (table === 'receipt_sync_jobs') rows = receiptSyncJobs;
  else if (table === 'api_request_log') rows = apiRequestLogs;
  else {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'unknown_table' }));
    return;
  }

  const filtered = applyFilters(rows, url.searchParams);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(filtered));
}

function applyFilters(rows, searchParams) {
  let result = rows;
  for (const [key, value] of searchParams.entries()) {
    if (key === 'select') continue;
    if (value.startsWith('in.(') && value.endsWith(')')) {
      const values = value.slice(4, -1).split(',').filter(Boolean);
      result = result.filter((row) => values.includes(String(row[key])));
    } else if (value.startsWith('eq.')) {
      const expected = value.slice(3);
      result = result.filter((row) => String(row[key]) === expected);
    }
  }
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function storedExplicitIdempotencyKey(value) {
  return `explicit:${value}`;
}
