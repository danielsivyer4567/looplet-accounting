#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';

const rootDir = '.claude/scratch/pos-verify-pilot-evidence-trial';
const validEvidenceFile = join(rootDir, 'valid-evidence.json');
const missingPersistenceFile = join(rootDir, 'missing-persistence.json');
const missingSiteAndFieldFile = join(rootDir, 'missing-site-field.json');
const missingIntegrationFitFile = join(rootDir, 'missing-integration-fit.json');
const mismatchedIntegrationFitFile = join(rootDir, 'mismatched-integration-fit.json');
const crossMerchantIntegrationFitFile = join(rootDir, 'cross-merchant-integration-fit.json');
const missingTriggerFieldsFile = join(rootDir, 'missing-trigger-fields.json');
const mismatchedConnectorSourceFile = join(rootDir, 'mismatched-connector-source.json');
const mismatchedFieldCaptureFile = join(rootDir, 'mismatched-field-capture.json');
const bundledSampleFile = join(rootDir, 'bundled-sample.json');
const renamedBundledContentFile = join(rootDir, 'renamed-bundled-content.json');
const leakedSecretFile = join(rootDir, 'leaked-secret.json');
const refundAccountingFile = join(rootDir, 'refund-accounting.json');
const staleFieldSampleFile = join(rootDir, 'stale-field-sample.json');
const crossMerchantFieldSampleFile = join(rootDir, 'cross-merchant-field-sample.json');
const badRefundOriginalFile = join(rootDir, 'bad-refund-original.json');
const missingFingerprintFile = join(rootDir, 'missing-fingerprint.json');
const missingContentFingerprintFile = join(rootDir, 'missing-content-fingerprint.json');
const skippedNetworkReadinessFile = join(rootDir, 'skipped-network-readiness.json');
const missingBridgeFilesReadinessFile = join(rootDir, 'missing-bridge-files-readiness.json');
const missingManifestReadinessFile = join(rootDir, 'missing-manifest-readiness.json');
const missingSchedulerStatusFile = join(rootDir, 'missing-scheduler-status.json');
const missingLocalFileProtectionFile = join(rootDir, 'missing-local-file-protection.json');
const missingBridgeRetryDrillFile = join(rootDir, 'missing-bridge-retry-drill.json');
const weakBridgeRetryDrillFile = join(rootDir, 'weak-bridge-retry-drill.json');
const missingApiRequestLogFile = join(rootDir, 'missing-api-request-log.json');
const malformedApiRequestLogFile = join(rootDir, 'malformed-api-request-log.json');
const acceptedFieldMismatchFile = join(rootDir, 'accepted-field-mismatch.json');
const forgedNonSendingEvidenceFile = join(rootDir, 'forged-non-sending.json');
const missingCollectionMetadataFile = join(rootDir, 'missing-collection-metadata.json');
const reconciledEvidenceFile = join(rootDir, 'reconciled-evidence.json');
const fieldFileMismatchEvidenceFile = join(rootDir, 'field-file-mismatch-evidence.json');
const fieldSampleFiles = {
  sale: join(rootDir, 'field-sale.json'),
  refund: join(rootDir, 'field-refund.json'),
  void: join(rootDir, 'field-void.json'),
};
const validOrgId = '22222222-2222-4222-8222-222222222222';

await rm(rootDir, { recursive: true, force: true });
await mkdir(rootDir, { recursive: true });

const validEvidence = buildValidEvidence();
const fieldReceipts = {
  sale: await buildFieldReceipt('sale', 'examples/pos-bridge/sample-receipt.json'),
  refund: await buildFieldReceipt('refund', 'examples/pos-bridge/sample-refund.json'),
  void: await buildFieldReceipt('void', 'examples/pos-bridge/sample-void.json'),
};
for (const [eventType, receipt] of Object.entries(fieldReceipts)) {
  await writeFile(fieldSampleFiles[eventType], `${JSON.stringify(receipt, null, 2)}\n`);
}
const reconciledEvidence = buildEvidenceForFieldFiles(fieldReceipts);
const fieldFileMismatchEvidence = JSON.parse(JSON.stringify(reconciledEvidence));
fieldFileMismatchEvidence.field_samples.samples[0].merchant_name = 'Forged Merchant Pty Ltd';
await writeFile(validEvidenceFile, `${JSON.stringify(validEvidence, null, 2)}\n`);
await writeFile(reconciledEvidenceFile, `${JSON.stringify(reconciledEvidence, null, 2)}\n`);
await writeFile(fieldFileMismatchEvidenceFile, `${JSON.stringify(fieldFileMismatchEvidence, null, 2)}\n`);
await writeFile(
  missingPersistenceFile,
  `${JSON.stringify({
    ...validEvidence,
    acceptance: {
      ...validEvidence.acceptance,
      persistence: {
        ...validEvidence.acceptance.persistence,
        checked: false,
      },
    },
  }, null, 2)}\n`,
);
await writeFile(
  missingSiteAndFieldFile,
  `${JSON.stringify({
    ...validEvidence,
    site: { provided: false },
    field_samples: { provided: false, ok: false, samples: [] },
  }, null, 2)}\n`,
);
await writeFile(
  missingIntegrationFitFile,
  `${JSON.stringify({
    ...validEvidence,
    integration_fit: { provided: false },
  }, null, 2)}\n`,
);
const mismatchedIntegrationFitEvidence = JSON.parse(JSON.stringify(validEvidence));
mismatchedIntegrationFitEvidence.integration_fit.recommendation.connector_mode = 'direct_webhook';
mismatchedIntegrationFitEvidence.integration_fit.recommendation.receipt_source_format = 'direct_json_webhook';
await writeFile(mismatchedIntegrationFitFile, `${JSON.stringify(mismatchedIntegrationFitEvidence, null, 2)}\n`);
const crossMerchantIntegrationFitEvidence = JSON.parse(JSON.stringify(validEvidence));
crossMerchantIntegrationFitEvidence.integration_fit.business_name = 'Other Business Pty Ltd';
crossMerchantIntegrationFitEvidence.integration_fit.pos_vendor = 'Other POS';
crossMerchantIntegrationFitEvidence.integration_fit.pos_product = 'Other Back Office';
await writeFile(crossMerchantIntegrationFitFile, `${JSON.stringify(crossMerchantIntegrationFitEvidence, null, 2)}\n`);
const missingTriggerFieldsEvidence = JSON.parse(JSON.stringify(validEvidence));
delete missingTriggerFieldsEvidence.site.identity_capture_method;
delete missingTriggerFieldsEvidence.site.receipt_trigger;
delete missingTriggerFieldsEvidence.site.receipt_source_format;
delete missingTriggerFieldsEvidence.site.field_sample_capture_method;
await writeFile(missingTriggerFieldsFile, `${JSON.stringify(missingTriggerFieldsEvidence, null, 2)}\n`);
const mismatchedConnectorSourceEvidence = JSON.parse(JSON.stringify(validEvidence));
mismatchedConnectorSourceEvidence.site.connector_mode = 'direct_webhook';
mismatchedConnectorSourceEvidence.site.receipt_source_format = 'pos_csv_export';
mismatchedConnectorSourceEvidence.site.field_sample_capture_method = 'pos_native_csv_export';
await writeFile(mismatchedConnectorSourceFile, `${JSON.stringify(mismatchedConnectorSourceEvidence, null, 2)}\n`);
const mismatchedFieldCaptureEvidence = JSON.parse(JSON.stringify(validEvidence));
mismatchedFieldCaptureEvidence.site.field_sample_capture_method = 'pos_webhook_capture';
await writeFile(mismatchedFieldCaptureFile, `${JSON.stringify(mismatchedFieldCaptureEvidence, null, 2)}\n`);
await writeFile(
  bundledSampleFile,
  `${JSON.stringify({
    ...validEvidence,
    field_samples: {
      ...validEvidence.field_samples,
      ok: false,
      samples: validEvidence.field_samples.samples.map((sample, index) => ({
        ...sample,
        file: ['sample-receipt.json', 'sample-refund.json', 'sample-void.json'][index],
        bundled_sample: true,
      })),
    },
  }, null, 2)}\n`,
);
const renamedBundledContentEvidence = JSON.parse(JSON.stringify(validEvidence));
renamedBundledContentEvidence.field_samples.samples[0].bundled_sample = false;
renamedBundledContentEvidence.field_samples.samples[0].file = 'field-sale.json';
renamedBundledContentEvidence.field_samples.samples[0].content_sha256_without_identity =
  'c1f7ec8c3aa665899639046306ef3b78c7fa603e8751f5bf58d27a739978cc6c';
await writeFile(renamedBundledContentFile, `${JSON.stringify(renamedBundledContentEvidence, null, 2)}\n`);
await writeFile(
  leakedSecretFile,
  `${JSON.stringify({
    ...validEvidence,
    credential_probe: {
      ...validEvidence.credential_probe,
      diagnostic_copy: 'llp_trial.secret rhp_trial.receiptsecret',
    },
  }, null, 2)}\n`,
);
const refundAccountingEvidence = JSON.parse(JSON.stringify(validEvidence));
refundAccountingEvidence.acceptance.checks.refund.bill_id = 'refund-bill-should-not-exist';
refundAccountingEvidence.acceptance.checks.refund.sync_jobs = [
  {
    id: 'refund-sync-should-not-exist',
    provider: 'xero',
    status: 'pending',
  },
];
refundAccountingEvidence.acceptance.persistence.sync_jobs.push({
  receipt_event_id: 'refund-event-1',
  provider: 'xero',
  status: 'pending',
  bill_id: 'refund-bill-should-not-exist',
});
await writeFile(refundAccountingFile, `${JSON.stringify(refundAccountingEvidence, null, 2)}\n`);
const staleFieldSampleEvidence = JSON.parse(JSON.stringify(validEvidence));
staleFieldSampleEvidence.field_samples.samples[0].purchase_at = '2026-06-28T05:00:00.000Z';
await writeFile(staleFieldSampleFile, `${JSON.stringify(staleFieldSampleEvidence, null, 2)}\n`);
const crossMerchantFieldSampleEvidence = JSON.parse(JSON.stringify(validEvidence));
crossMerchantFieldSampleEvidence.field_samples.samples[0].merchant_name = 'Other Store Pty Ltd';
crossMerchantFieldSampleEvidence.field_samples.samples[0].merchant_name_matches_site = false;
await writeFile(crossMerchantFieldSampleFile, `${JSON.stringify(crossMerchantFieldSampleEvidence, null, 2)}\n`);
const badRefundOriginalEvidence = JSON.parse(JSON.stringify(validEvidence));
const badRefundOriginalSample = badRefundOriginalEvidence.field_samples.samples.find((sample) => sample.event_type === 'refund');
badRefundOriginalSample.original_receipt_number = 'OTHER-SALE-1';
badRefundOriginalSample.original_external_event_id = 'other-sale-1';
badRefundOriginalSample.original_reference_matches_sale = false;
await writeFile(badRefundOriginalFile, `${JSON.stringify(badRefundOriginalEvidence, null, 2)}\n`);
const missingFingerprintEvidence = JSON.parse(JSON.stringify(validEvidence));
delete missingFingerprintEvidence.field_samples.samples[0].redacted_sample_sha256;
await writeFile(missingFingerprintFile, `${JSON.stringify(missingFingerprintEvidence, null, 2)}\n`);
const missingContentFingerprintEvidence = JSON.parse(JSON.stringify(validEvidence));
delete missingContentFingerprintEvidence.field_samples.samples[0].content_sha256_without_identity;
await writeFile(missingContentFingerprintFile, `${JSON.stringify(missingContentFingerprintEvidence, null, 2)}\n`);
const skippedNetworkReadinessEvidence = JSON.parse(JSON.stringify(validEvidence));
skippedNetworkReadinessEvidence.readiness.checks.network = {
  ok: true,
  skipped: true,
  reason: 'network check skipped',
};
await writeFile(skippedNetworkReadinessFile, `${JSON.stringify(skippedNetworkReadinessEvidence, null, 2)}\n`);
const missingBridgeFilesReadinessEvidence = JSON.parse(JSON.stringify(validEvidence));
missingBridgeFilesReadinessEvidence.readiness.checks.bridge_files = {
  ok: false,
  missing: ['bridge.mjs'],
};
await writeFile(missingBridgeFilesReadinessFile, `${JSON.stringify(missingBridgeFilesReadinessEvidence, null, 2)}\n`);
const missingManifestReadinessEvidence = JSON.parse(JSON.stringify(validEvidence));
missingManifestReadinessEvidence.readiness.checks.bridge_files.manifest = {
  present: false,
  ok: true,
  checked_files: 0,
  errors: [],
};
await writeFile(missingManifestReadinessFile, `${JSON.stringify(missingManifestReadinessEvidence, null, 2)}\n`);
const missingSchedulerStatusEvidence = JSON.parse(JSON.stringify(validEvidence));
missingSchedulerStatusEvidence.status.scheduler = {
  ok: true,
  configured: false,
  message: 'LOOPLET_BRIDGE_LOG_DIR is not configured',
};
await writeFile(missingSchedulerStatusFile, `${JSON.stringify(missingSchedulerStatusEvidence, null, 2)}\n`);
const missingLocalFileProtectionEvidence = JSON.parse(JSON.stringify(validEvidence));
delete missingLocalFileProtectionEvidence.status.local_file_protection;
await writeFile(missingLocalFileProtectionFile, `${JSON.stringify(missingLocalFileProtectionEvidence, null, 2)}\n`);
const missingBridgeRetryDrillEvidence = JSON.parse(JSON.stringify(validEvidence));
delete missingBridgeRetryDrillEvidence.bridge_retry_drill;
await writeFile(missingBridgeRetryDrillFile, `${JSON.stringify(missingBridgeRetryDrillEvidence, null, 2)}\n`);
const weakBridgeRetryDrillEvidence = JSON.parse(JSON.stringify(validEvidence));
weakBridgeRetryDrillEvidence.bridge_retry_drill = {
  ok: true,
  non_sending: true,
  failed_requests_seen: 0,
  queued_after_outage: false,
  queue_flushed_after_recovery: false,
  accepted_after_recovery: false,
  dead_letter_created: false,
  secrets_redacted: true,
};
await writeFile(weakBridgeRetryDrillFile, `${JSON.stringify(weakBridgeRetryDrillEvidence, null, 2)}\n`);
const missingApiRequestLogEvidence = JSON.parse(JSON.stringify(validEvidence));
delete missingApiRequestLogEvidence.acceptance.persistence.api_request_log;
await writeFile(missingApiRequestLogFile, `${JSON.stringify(missingApiRequestLogEvidence, null, 2)}\n`);
const malformedApiRequestLogEvidence = JSON.parse(JSON.stringify(validEvidence));
malformedApiRequestLogEvidence.acceptance.persistence.api_request_log.post_count = 0;
malformedApiRequestLogEvidence.acceptance.persistence.api_request_log.ingest_type_values = ['unknown'];
await writeFile(malformedApiRequestLogFile, `${JSON.stringify(malformedApiRequestLogEvidence, null, 2)}\n`);
const acceptedFieldMismatchEvidence = JSON.parse(JSON.stringify(validEvidence));
acceptedFieldMismatchEvidence.acceptance.persistence.receipt_events.refund_purchase_at = '2026-06-28T04:00:00.000Z';
acceptedFieldMismatchEvidence.acceptance.persistence.line_items.sale_total_inc_gst_cents = 35999;
acceptedFieldMismatchEvidence.acceptance.persistence.line_items.void_count = 2;
await writeFile(acceptedFieldMismatchFile, `${JSON.stringify(acceptedFieldMismatchEvidence, null, 2)}\n`);
const forgedNonSendingEvidence = JSON.parse(JSON.stringify(validEvidence));
forgedNonSendingEvidence.non_sending = true;
await writeFile(forgedNonSendingEvidenceFile, `${JSON.stringify(forgedNonSendingEvidence, null, 2)}\n`);
const missingCollectionMetadataEvidence = JSON.parse(JSON.stringify(validEvidence));
missingCollectionMetadataEvidence.collected_at = 'not-a-date';
missingCollectionMetadataEvidence.credential_probe_non_persistent = false;
await writeFile(missingCollectionMetadataFile, `${JSON.stringify(missingCollectionMetadataEvidence, null, 2)}\n`);

const valid = await runVerifier(validEvidenceFile, 0);
const reconciled = await runVerifier(reconciledEvidenceFile, 0, fieldSampleFiles);
const fieldFileMismatch = await runVerifier(fieldFileMismatchEvidenceFile, 1, fieldSampleFiles);
const missingFieldFiles = await runVerifier(reconciledEvidenceFile, 1, false);
const missingPersistence = await runVerifier(missingPersistenceFile, 1);
const missingSiteAndField = await runVerifier(missingSiteAndFieldFile, 1);
const missingIntegrationFit = await runVerifier(missingIntegrationFitFile, 1);
const mismatchedIntegrationFit = await runVerifier(mismatchedIntegrationFitFile, 1);
const crossMerchantIntegrationFit = await runVerifier(crossMerchantIntegrationFitFile, 1);
const missingTriggerFields = await runVerifier(missingTriggerFieldsFile, 1);
const mismatchedConnectorSource = await runVerifier(mismatchedConnectorSourceFile, 1);
const mismatchedFieldCapture = await runVerifier(mismatchedFieldCaptureFile, 1);
const bundledSample = await runVerifier(bundledSampleFile, 1);
const renamedBundledContent = await runVerifier(renamedBundledContentFile, 1);
const leakedSecret = await runVerifier(leakedSecretFile, 1);
const refundAccounting = await runVerifier(refundAccountingFile, 1);
const staleFieldSample = await runVerifier(staleFieldSampleFile, 1);
const crossMerchantFieldSample = await runVerifier(crossMerchantFieldSampleFile, 1);
const badRefundOriginal = await runVerifier(badRefundOriginalFile, 1);
const missingFingerprint = await runVerifier(missingFingerprintFile, 1);
const missingContentFingerprint = await runVerifier(missingContentFingerprintFile, 1);
const skippedNetworkReadiness = await runVerifier(skippedNetworkReadinessFile, 1);
const missingBridgeFilesReadiness = await runVerifier(missingBridgeFilesReadinessFile, 1);
const missingManifestReadiness = await runVerifier(missingManifestReadinessFile, 1);
const missingSchedulerStatus = await runVerifier(missingSchedulerStatusFile, 1);
const missingLocalFileProtection = await runVerifier(missingLocalFileProtectionFile, 1);
const missingBridgeRetryDrill = await runVerifier(missingBridgeRetryDrillFile, 1);
const weakBridgeRetryDrill = await runVerifier(weakBridgeRetryDrillFile, 1);
const missingApiRequestLog = await runVerifier(missingApiRequestLogFile, 1);
const malformedApiRequestLog = await runVerifier(malformedApiRequestLogFile, 1);
const acceptedFieldMismatch = await runVerifier(acceptedFieldMismatchFile, 1);
const forgedNonSending = await runVerifier(forgedNonSendingEvidenceFile, 1);
const missingCollectionMetadata = await runVerifier(missingCollectionMetadataFile, 1);

const validParsed = JSON.parse(valid.stdout);
const reconciledParsed = JSON.parse(reconciled.stdout);
const fieldFileMismatchParsed = JSON.parse(fieldFileMismatch.stdout);
const missingFieldFilesParsed = JSON.parse(missingFieldFiles.stdout);
const missingParsed = JSON.parse(missingPersistence.stdout);
const missingSiteParsed = JSON.parse(missingSiteAndField.stdout);
const missingIntegrationFitParsed = JSON.parse(missingIntegrationFit.stdout);
const mismatchedIntegrationFitParsed = JSON.parse(mismatchedIntegrationFit.stdout);
const crossMerchantIntegrationFitParsed = JSON.parse(crossMerchantIntegrationFit.stdout);
const missingTriggerFieldsParsed = JSON.parse(missingTriggerFields.stdout);
const mismatchedConnectorSourceParsed = JSON.parse(mismatchedConnectorSource.stdout);
const mismatchedFieldCaptureParsed = JSON.parse(mismatchedFieldCapture.stdout);
const bundledSampleParsed = JSON.parse(bundledSample.stdout);
const renamedBundledContentParsed = JSON.parse(renamedBundledContent.stdout);
const leakedParsed = JSON.parse(leakedSecret.stdout);
const refundAccountingParsed = JSON.parse(refundAccounting.stdout);
const staleFieldSampleParsed = JSON.parse(staleFieldSample.stdout);
const crossMerchantFieldSampleParsed = JSON.parse(crossMerchantFieldSample.stdout);
const badRefundOriginalParsed = JSON.parse(badRefundOriginal.stdout);
const missingFingerprintParsed = JSON.parse(missingFingerprint.stdout);
const missingContentFingerprintParsed = JSON.parse(missingContentFingerprint.stdout);
const skippedNetworkReadinessParsed = JSON.parse(skippedNetworkReadiness.stdout);
const missingBridgeFilesReadinessParsed = JSON.parse(missingBridgeFilesReadiness.stdout);
const missingManifestReadinessParsed = JSON.parse(missingManifestReadiness.stdout);
const missingSchedulerStatusParsed = JSON.parse(missingSchedulerStatus.stdout);
const missingLocalFileProtectionParsed = JSON.parse(missingLocalFileProtection.stdout);
const missingBridgeRetryDrillParsed = JSON.parse(missingBridgeRetryDrill.stdout);
const weakBridgeRetryDrillParsed = JSON.parse(weakBridgeRetryDrill.stdout);
const missingApiRequestLogParsed = JSON.parse(missingApiRequestLog.stdout);
const malformedApiRequestLogParsed = JSON.parse(malformedApiRequestLog.stdout);
const acceptedFieldMismatchParsed = JSON.parse(acceptedFieldMismatch.stdout);
const forgedNonSendingParsed = JSON.parse(forgedNonSending.stdout);
const missingCollectionMetadataParsed = JSON.parse(missingCollectionMetadata.stdout);

assert(validParsed.ok === true, 'valid evidence should pass');
assert(validParsed.summary.field_file_reconciliation_requested === false, 'plain verifier should show no field-file reconciliation request');
assert(validParsed.summary.field_file_reconciliation_required === false, 'plain verifier should be explicit evidence-only diagnostics');
assert(validParsed.summary.verification_mode === 'evidence-only', 'plain verifier should label evidence-only diagnostics');
assert(validParsed.summary.readiness_bridge_files_ok === true, 'valid summary should show bridge files ready');
assert(validParsed.summary.integration_fit_ok === true, 'valid summary should show integration fit');
assert(validParsed.summary.integration_fit_matches_site === true, 'valid summary should show integration fit matches site');
assert(validParsed.summary.integration_fit_identity_matches_site === true, 'valid summary should show integration fit business/POS identity matches site');
assert(validParsed.summary.readiness_manifest_ok === true, 'valid summary should show installed manifest ready');
assert(validParsed.summary.readiness_network_ok === true, 'valid summary should show readiness network probe');
assert(validParsed.summary.bridge_scheduler_ok === true, 'valid summary should show local bridge scheduler ready');
assert(validParsed.summary.local_file_protection_ok === true, 'valid summary should show local bridge file protection ready');
assert(validParsed.summary.local_file_protection_checked_count === 5, 'valid summary should show local bridge protection checked files');
assert(validParsed.summary.bridge_retry_drill_ok === true, 'valid summary should show local bridge retry drill ready');
assert(validParsed.summary.site_manifest_ok === true, 'valid summary should show site manifest');
assert(validParsed.summary.identity_capture_method === 'barcode_scan', 'valid summary should show identity capture method');
assert(validParsed.summary.receipt_trigger === 'pos_completed_tender', 'valid summary should show receipt trigger');
assert(validParsed.summary.receipt_source_format === 'pos_json_export', 'valid summary should show receipt source format');
assert(validParsed.summary.field_sample_capture_method === 'pos_native_json_export', 'valid summary should show field sample capture method');
assert(validParsed.summary.field_samples_ok === true, 'valid summary should show field samples');
assert(validParsed.summary.field_samples_match_site_merchant === true, 'valid summary should show field samples match the site merchant');
assert(validParsed.summary.field_samples_refund_void_link_sale === true, 'valid summary should show refund and void field samples link to the sale sample');
assert(validParsed.summary.field_samples_within_pilot_window === true, 'valid summary should show field samples inside the pilot window');
assert(validParsed.summary.field_sample_fingerprints.sale === fieldSampleHash('sale'), 'valid summary should include field sample fingerprints');
assert(validParsed.summary.persistence_checked === true, 'valid summary should show persistence checked');
assert(validParsed.summary.api_request_log_ok === true, 'valid summary should show API request logs ready');
assert(validParsed.summary.duplicate_same_event === true, 'valid summary should show duplicate same event');
assert(validParsed.summary.idempotency_purchase_at_mismatch_rejected === true, 'valid summary should show purchase_at mismatch rejection');
assert(validParsed.summary.missing_purchase_at_rejected === true, 'valid summary should show missing purchase_at rejection');
assert(validParsed.summary.bad_purchase_at_rejected === true, 'valid summary should show bad purchase_at rejection');
assert(validParsed.summary.refund_linked === true, 'valid summary should show refund linked');
assert(validParsed.summary.refund_duplicate_same_event === true, 'valid summary should show refund duplicate same event');
assert(validParsed.summary.void_linked === true, 'valid summary should show void linked');
assert(validParsed.summary.void_duplicate_same_event === true, 'valid summary should show void duplicate same event');
assert(reconciledParsed.ok === true, 'field-file verifier should pass when evidence matches local files');
assert(reconciledParsed.summary.field_file_reconciliation_requested === true, 'field-file verifier should show reconciliation request');
assert(reconciledParsed.summary.field_file_reconciliation_ok === true, 'field-file verifier should prove reconciliation succeeded');
assert(reconciledParsed.summary.field_file_reconciliation_required === true, 'field-file verifier should show go-live reconciliation requirement');
assert(reconciledParsed.summary.verification_mode === 'field-files', 'field-file verifier should label field-file mode');
assert(reconciledParsed.field_file_reconciliation.matches.sale.ok === true, 'field-file verifier should match sale file');
assert(reconciledParsed.field_file_reconciliation.matches.refund.ok === true, 'field-file verifier should match refund file');
assert(reconciledParsed.field_file_reconciliation.matches.void.ok === true, 'field-file verifier should match void file');
assert(!reconciled.stdout.includes('rhp_trial.receiptsecret'), 'field-file verifier stdout must not expose receipt tokens');
assert(!reconciled.stdout.includes('llp_trial.secret'), 'field-file verifier stdout must not expose API keys');
assert(
  fieldFileMismatchParsed.failures.some((failure) => failure.includes('field file reconciliation: sale: merchant_name mismatch')),
  'field-file verifier should reject evidence that no longer matches the captured sale file',
);
assert(
  missingFieldFilesParsed.failures.some((failure) => failure.includes('field-file reconciliation is required')),
  'verifier should reject missing field files by default',
);
assert(
  missingParsed.failures.some((failure) => failure.includes('persistence readback')),
  'missing persistence evidence should fail with persistence readback reason',
);
assert(
  missingSiteParsed.failures.some((failure) => failure.includes('site manifest')),
  'missing site evidence should fail with site manifest reason',
);
assert(
  missingSiteParsed.failures.some((failure) => failure.includes('field POS')),
  'missing field sample evidence should fail with field sample reason',
);
assert(
  missingIntegrationFitParsed.failures.some((failure) => failure.includes('integration fit profile must be supplied')),
  'missing integration fit evidence should fail with integration-fit reason',
);
assert(
  mismatchedIntegrationFitParsed.failures.some((failure) => failure.includes('integration fit connector_mode must match')),
  'mismatched integration fit evidence should fail with connector-mode reason',
);
assert(
  crossMerchantIntegrationFitParsed.failures.some((failure) => failure.includes('integration fit business_name must match')) &&
    crossMerchantIntegrationFitParsed.failures.some((failure) => failure.includes('integration fit pos_vendor must match')) &&
    crossMerchantIntegrationFitParsed.failures.some((failure) => failure.includes('integration fit pos_product must match')),
  'cross-merchant integration fit evidence should fail with business, vendor, and product reasons',
);
assert(
  missingTriggerFieldsParsed.failures.some((failure) => failure.includes('identity_capture_method')) &&
    missingTriggerFieldsParsed.failures.some((failure) => failure.includes('receipt_trigger')) &&
    missingTriggerFieldsParsed.failures.some((failure) => failure.includes('receipt_source_format')) &&
    missingTriggerFieldsParsed.failures.some((failure) => failure.includes('field_sample_capture_method')),
  'missing trigger/capture evidence should fail with identity capture, receipt trigger, source format, and sample capture reasons',
);
assert(
  mismatchedConnectorSourceParsed.failures.some((failure) => failure.includes('not compatible with receipt_source_format')),
  'mismatched connector/source evidence should fail with compatibility reason',
);
assert(
  mismatchedFieldCaptureParsed.failures.some((failure) => failure.includes('field_sample_capture_method')),
  'mismatched field capture evidence should fail with capture/source compatibility reason',
);
assert(
  bundledSampleParsed.failures.some((failure) => failure.includes('bundled example sample')),
  'bundled sample evidence should fail with bundled sample reason',
);
assert(
  renamedBundledContentParsed.failures.some((failure) => failure.includes('bundled sample content')),
  'renamed bundled sample content evidence should fail with bundled sample content reason',
);
assert(
  leakedParsed.failures.some((failure) => failure.includes('unredacted Looplet secrets')),
  'leaked secret evidence should fail with secret reason',
);
assert(
  refundAccountingParsed.failures.some((failure) => failure.includes('refund must not create')),
  'refund accounting evidence should fail with evidence-only refund reason',
);
assert(
  staleFieldSampleParsed.failures.some((failure) => failure.includes('purchase_at must fall within the pilot window')),
  'stale field sample evidence should fail with pilot-window reason',
);
assert(
  crossMerchantFieldSampleParsed.failures.some((failure) => failure.includes('sample merchant_name must match the site manifest merchant_name')),
  'cross-merchant field sample evidence should fail with site merchant reason',
);
assert(
  badRefundOriginalParsed.failures.some((failure) => failure.includes('refund sample original reference must match the sale field sample')),
  'bad refund original reference evidence should fail with sale-link reason',
);
assert(
  missingFingerprintParsed.failures.some((failure) => failure.includes('SHA-256 fingerprint')),
  'missing fingerprint evidence should fail with fingerprint reason',
);
assert(
  missingContentFingerprintParsed.failures.some((failure) => failure.includes('identity-stripped content SHA-256 fingerprint')),
  'missing content fingerprint evidence should fail with content fingerprint reason',
);
assert(
  skippedNetworkReadinessParsed.failures.some((failure) => failure.includes('network check must not be skipped')),
  'skipped network readiness evidence should fail with network-skipped reason',
);
assert(
  missingBridgeFilesReadinessParsed.failures.some((failure) => failure.includes('bridge file completeness')),
  'missing bridge files readiness evidence should fail with bridge file completeness reason',
);
assert(
  missingManifestReadinessParsed.failures.some((failure) => failure.includes('installed MANIFEST.json')),
  'missing manifest readiness evidence should fail with installed manifest reason',
);
assert(
  missingSchedulerStatusParsed.failures.some((failure) => failure.includes('scheduled-task logs')),
  'missing scheduler status evidence should fail with scheduled-task logs reason',
);
assert(
  missingLocalFileProtectionParsed.failures.some((failure) => failure.includes('filesystem-protected')),
  'missing local file protection evidence should fail with filesystem protection reason',
);
assert(
  missingBridgeRetryDrillParsed.failures.some((failure) => failure.includes('retry drill')),
  'missing bridge retry drill evidence should fail with retry drill reason',
);
assert(
  weakBridgeRetryDrillParsed.failures.some((failure) => failure.includes('transient retry attempts')) &&
    weakBridgeRetryDrillParsed.failures.some((failure) => failure.includes('queue during outage')),
  'weak bridge retry drill evidence should fail with retry and queue reasons',
);
assert(
  missingApiRequestLogParsed.failures.some((failure) => failure.includes('API request log')),
  'missing API request log evidence should fail with API log reason',
);
assert(
  malformedApiRequestLogParsed.failures.some((failure) => failure.includes('POST log rows')) &&
    malformedApiRequestLogParsed.failures.some((failure) => failure.includes('ingest_type=receipt')),
  'malformed API request log evidence should fail with POST and ingest_type reasons',
);
assert(
  acceptedFieldMismatchParsed.failures.some((failure) => failure.includes('refund purchase_at must match')) &&
    acceptedFieldMismatchParsed.failures.some((failure) => failure.includes('sale total must match')) &&
    acceptedFieldMismatchParsed.failures.some((failure) => failure.includes('void line count must match')),
  'accepted receipt readback must be tied to the field POS sample facts',
);
assert(
  forgedNonSendingParsed.failures.some((failure) => failure.includes('receipt-sending acceptance run')),
  'forged non-sending evidence should fail with sending-mode reason',
);
assert(
  missingCollectionMetadataParsed.failures.some((failure) => failure.includes('collected_at')) &&
    missingCollectionMetadataParsed.failures.some((failure) => failure.includes('non-persistent credential probe')),
  'missing collection metadata should fail with timestamp and credential-probe reasons',
);

console.log(JSON.stringify({
  ok: true,
  valid_passed: validParsed.ok,
  missing_persistence_rejected: missingParsed.ok === false,
  missing_site_field_rejected: missingSiteParsed.ok === false,
  missing_integration_fit_rejected: missingIntegrationFitParsed.ok === false,
  mismatched_integration_fit_rejected: mismatchedIntegrationFitParsed.ok === false,
  cross_merchant_integration_fit_rejected: crossMerchantIntegrationFitParsed.ok === false,
  missing_trigger_fields_rejected: missingTriggerFieldsParsed.ok === false,
  mismatched_connector_source_rejected: mismatchedConnectorSourceParsed.ok === false,
  mismatched_field_capture_rejected: mismatchedFieldCaptureParsed.ok === false,
  bundled_sample_rejected: bundledSampleParsed.ok === false,
  renamed_bundled_content_rejected: renamedBundledContentParsed.ok === false,
  leaked_secret_rejected: leakedParsed.ok === false,
  refund_accounting_rejected: refundAccountingParsed.ok === false,
  stale_field_sample_rejected: staleFieldSampleParsed.ok === false,
  cross_merchant_field_sample_rejected: crossMerchantFieldSampleParsed.ok === false,
  bad_refund_original_rejected: badRefundOriginalParsed.ok === false,
  missing_fingerprint_rejected: missingFingerprintParsed.ok === false,
  missing_content_fingerprint_rejected: missingContentFingerprintParsed.ok === false,
  skipped_network_readiness_rejected: skippedNetworkReadinessParsed.ok === false,
  missing_bridge_files_readiness_rejected: missingBridgeFilesReadinessParsed.ok === false,
  missing_manifest_readiness_rejected: missingManifestReadinessParsed.ok === false,
  missing_scheduler_status_rejected: missingSchedulerStatusParsed.ok === false,
  missing_local_file_protection_rejected: missingLocalFileProtectionParsed.ok === false,
  missing_bridge_retry_drill_rejected: missingBridgeRetryDrillParsed.ok === false,
  weak_bridge_retry_drill_rejected: weakBridgeRetryDrillParsed.ok === false,
  missing_api_request_log_rejected: missingApiRequestLogParsed.ok === false,
  malformed_api_request_log_rejected: malformedApiRequestLogParsed.ok === false,
  accepted_field_mismatch_rejected: acceptedFieldMismatchParsed.ok === false,
  forged_non_sending_rejected: forgedNonSendingParsed.ok === false,
  missing_collection_metadata_rejected: missingCollectionMetadataParsed.ok === false,
  field_file_reconciliation_passed: reconciledParsed.summary.field_file_reconciliation_ok === true,
  field_file_mismatch_rejected: fieldFileMismatchParsed.ok === false,
  missing_field_files_rejected_by_default: missingFieldFilesParsed.ok === false,
  evidence_file: validEvidenceFile,
}, null, 2));

async function runVerifier(file, expectedCode, fieldFiles = null) {
  const args = ['examples/pos-bridge/verify-pilot-evidence.mjs', file];
  if (fieldFiles === false) {
    // Exercise the go-live default: field files are required unless --evidence-only is explicit.
  } else if (fieldFiles) {
    args.push('--sale', fieldFiles.sale, '--refund', fieldFiles.refund, '--void', fieldFiles.void);
  } else {
    args.push('--evidence-only');
  }
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
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
    throw new Error(`verify-pilot-evidence exited ${code}, expected ${expectedCode}\nstdout=${stdout}\nstderr=${stderr}`);
  }
  return { stdout, stderr };
}

async function buildFieldReceipt(eventType, sourceFile) {
  const receipt = JSON.parse(await readFile(sourceFile, 'utf8'));
  const eventCode = eventType.toUpperCase();
  receipt.event_type = eventType;
  receipt.idempotency_key = `field-${eventType}-1`;
  receipt.identity_token = 'rhp_trial.receiptsecret';
  receipt.source_channel = 'pos';
  receipt.payload.merchant.name = 'Valid Merchant';
  receipt.payload.merchant.external_id = 'valid-store-1';
  receipt.payload.receipt.number = `FIELD-${eventCode}-1`;
  receipt.payload.receipt.event_type = eventType;
  receipt.payload.receipt.external_event_id = `field-${eventType}-1`;
  receipt.payload.receipt.purchase_at = {
    sale: '2026-06-28T03:00:00.000Z',
    refund: '2026-06-28T03:20:00.000Z',
    void: '2026-06-28T03:25:00.000Z',
  }[eventType];
  receipt.payload.receipt.payment_reference = `field-${eventType}-payment-1`;
  receipt.payload.receipt.terminal_id = 'FIELD-TERM-1';
  receipt.payload.receipt.store_id = 'FIELD-STORE-1';
  if (eventType !== 'sale') {
    receipt.payload.receipt.original_receipt_number = 'FIELD-SALE-1';
    receipt.payload.receipt.original_external_event_id = 'field-sale-1';
  }
  return receipt;
}

function buildEvidenceForFieldFiles(receipts) {
  const evidence = buildValidEvidence();
  evidence.field_samples.samples = Object.entries(receipts).map(([eventType, receipt]) => {
    const payload = receipt.payload;
    return {
      file: `field-${eventType}.json`,
      ok: true,
      bundled_sample: false,
      source_channel: receipt.source_channel,
      event_type: eventType,
      identity_token_source: 'receipt',
      redacted_sample_sha256: redactedSampleSha256(receipt),
      content_sha256_without_identity: sampleContentSha256WithoutIdentity(receipt),
      idempotency_key: receipt.idempotency_key,
      merchant_name: payload.merchant.name,
      receipt_number: payload.receipt.number,
      external_event_id: payload.receipt.external_event_id ?? null,
      original_receipt_number: payload.receipt.original_receipt_number ?? null,
      original_external_event_id: payload.receipt.original_external_event_id ?? null,
      original_reference_matches_sale: eventType === 'sale'
        ? null
        : (
            payload.receipt.original_receipt_number === receipts.sale.payload.receipt.number ||
            payload.receipt.original_external_event_id === receipts.sale.payload.receipt.external_event_id
          ),
      purchase_at: new Date(payload.receipt.purchase_at).toISOString(),
      total_inc_gst_cents: payload.receipt.total_inc_gst_cents,
      line_count: payload.line_items.length,
    };
  });
  return evidence;
}

function redactedSampleSha256(receipt) {
  return createHash('sha256')
    .update(JSON.stringify(redactDeep(receipt)))
    .digest('hex');
}

function sampleContentSha256WithoutIdentity(receipt) {
  return createHash('sha256')
    .update(JSON.stringify(stripReceiptIdentities(receipt)))
    .digest('hex');
}

function stripReceiptIdentities(value) {
  const cloned = JSON.parse(JSON.stringify(value));
  delete cloned.identity_token;
  if (cloned.payload?.receipt && typeof cloned.payload.receipt === 'object') {
    delete cloned.payload.receipt.identity_token;
  }
  if (cloned.payload?.customer && typeof cloned.payload.customer === 'object') {
    delete cloned.payload.customer.looplet_identity_token;
  }
  return redactDeep(cloned);
}

function redactDeep(value) {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactDeep(entry)]));
  }
  return value;
}

function redactSecrets(value) {
  return String(value)
    .replace(/llp_[^\s"',}]+/g, 'llp_[redacted]')
    .replace(/rhp_[^\s"',}]+/g, 'rhp_[redacted]');
}

function buildValidEvidence() {
  return {
    ok: true,
    collected_at: new Date().toISOString(),
    node_version: process.version,
    env_file_used: true,
    non_sending: false,
    credential_probe_non_persistent: true,
    site: {
      provided: true,
      business_name: 'Valid Pilot Pty Ltd',
      merchant_name: 'Valid Merchant',
      pilot_id: 'valid-pilot-001',
      pilot_window_start: '2026-06-28T13:00:00+10:00',
      pilot_window_end: '2026-06-28T13:40:00+10:00',
      pos_vendor: 'Looplet trial POS',
      pos_product: 'Looplet POS bridge fixture',
      pos_version: 'trial',
      connector_mode: 'bridge_watch_folder',
      identity_capture_method: 'barcode_scan',
      receipt_trigger: 'pos_completed_tender',
      receipt_source_format: 'pos_json_export',
      field_sample_capture_method: 'pos_native_json_export',
      integration_owner: 'Looplet test harness',
      install_machine_id: 'LOCAL-TRIAL',
      operator_name: 'Looplet Trial',
      operator_role: 'Test operator',
      looplet_organization_id: validOrgId,
    },
    integration_fit: {
      provided: true,
      command: 'integration_fit',
      exit_code: 0,
      ok: true,
      business_name: 'Valid Pilot Pty Ltd',
      pos_vendor: 'Looplet trial POS',
      pos_product: 'Looplet POS bridge fixture',
      recommendation: {
        connector_mode: 'bridge_watch_folder',
        identity_capture_method: 'barcode_scan',
        receipt_trigger: 'pos_completed_tender',
        receipt_source_format: 'pos_json_export',
        field_sample_capture_method: 'pos_native_json_export',
        reason: 'POS can export completed JSON receipts and the business can run the Looplet bridge',
      },
      blockers: [],
      warnings: ['This fit check is not go-live evidence; still run go-live.mjs with real POS sale/refund/void field samples'],
    },
    readiness: {
      ok: true,
      checks: {
        node: { ok: true },
        config: { ok: true },
        bridge_files: {
          ok: true,
          missing: [],
          manifest: {
            present: true,
            ok: true,
            checked_files: 26,
            errors: [],
          },
        },
        inbox: { ok: true },
        contract: { ok: true },
        network: { ok: true, reachable: true },
      },
    },
    status: {
      ok: true,
      attention_required: [],
      scheduler: {
        ok: true,
        configured: true,
        last_run_at: '2026-06-28T03:00:00.000Z',
        last_exit_code: 0,
        message: 'scheduled task logs are current',
      },
      local_file_protection: {
        ok: true,
        platform: process.platform,
        checked_count: 5,
        failure_count: 0,
        files: [
          { file: 'looplet-pos.env', ok: true },
          { file: 'retry-queue.ndjson', ok: true },
          { file: 'dead-letter.ndjson', ok: true },
          { file: 'looplet-pos-bridge.log', ok: true },
          { file: 'field-sale.json', ok: true },
        ],
      },
    },
    credential_probe: {
      ok: true,
      status: 400,
      api_key_valid: true,
      write_receipts_scope: true,
      receipt_persisted: false,
      expected_rejection: 'invalid_probe_identity',
    },
    bridge_retry_drill: {
      ok: true,
      non_sending: true,
      failed_requests_seen: 2,
      queued_after_outage: true,
      queue_flushed_after_recovery: true,
      accepted_after_recovery: true,
      dead_letter_created: false,
      secrets_redacted: true,
    },
    samples: [
      { ok: true, event_type: 'sale', line_count: 2 },
      { ok: true, event_type: 'refund', line_count: 1 },
      { ok: true, event_type: 'void', line_count: 1 },
    ],
    field_samples: {
      provided: true,
      ok: true,
      samples: [
        {
          file: 'field-sale.json',
          ok: true,
          bundled_sample: false,
          source_channel: 'pos',
          event_type: 'sale',
          identity_token_source: 'receipt',
          redacted_sample_sha256: fieldSampleHash('sale'),
          content_sha256_without_identity: '1'.repeat(64),
          idempotency_key: 'field-sale-1',
          merchant_name: 'Valid Merchant',
          receipt_number: 'FIELD-SALE-1',
          external_event_id: 'field-sale-1',
          original_receipt_number: null,
          original_external_event_id: null,
          original_reference_matches_sale: null,
          purchase_at: '2026-06-28T03:00:00.000Z',
          total_inc_gst_cents: 36000,
          line_count: 2,
        },
        {
          file: 'field-refund.json',
          ok: true,
          bundled_sample: false,
          source_channel: 'pos',
          event_type: 'refund',
          identity_token_source: 'receipt',
          redacted_sample_sha256: fieldSampleHash('refund'),
          content_sha256_without_identity: '2'.repeat(64),
          idempotency_key: 'field-refund-1',
          merchant_name: 'Valid Merchant',
          receipt_number: 'FIELD-REFUND-1',
          external_event_id: 'field-refund-1',
          original_receipt_number: 'FIELD-SALE-1',
          original_external_event_id: 'field-sale-1',
          original_reference_matches_sale: true,
          purchase_at: '2026-06-28T03:20:00.000Z',
          total_inc_gst_cents: 6000,
          line_count: 1,
        },
        {
          file: 'field-void.json',
          ok: true,
          bundled_sample: false,
          source_channel: 'pos',
          event_type: 'void',
          identity_token_source: 'receipt',
          redacted_sample_sha256: fieldSampleHash('void'),
          content_sha256_without_identity: '3'.repeat(64),
          idempotency_key: 'field-void-1',
          merchant_name: 'Valid Merchant',
          receipt_number: 'FIELD-VOID-1',
          external_event_id: 'field-void-1',
          original_receipt_number: 'FIELD-SALE-1',
          original_external_event_id: 'field-sale-1',
          original_reference_matches_sale: true,
          purchase_at: '2026-06-28T03:25:00.000Z',
          total_inc_gst_cents: 0,
          line_count: 1,
        },
      ],
    },
    acceptance: {
      command: 'acceptance',
      exit_code: 0,
      ok: true,
      run_id: 'trial001',
      webhook_url: 'https://example.supabase.co/functions/v1/receipt-webhook',
      checks: {
        sale: {
          ok: true,
          status: 200,
          duplicate: false,
          event_type: 'sale',
          receipt_event_id: 'sale-event-1',
          related_receipt_event_id: null,
          bill_id: 'bill-1',
        },
        duplicate: {
          ok: true,
          status: 200,
          duplicate: true,
          event_type: 'sale',
          receipt_event_id: 'sale-event-1',
          related_receipt_event_id: null,
          bill_id: 'bill-1',
        },
        refund: {
          ok: true,
          status: 200,
          duplicate: false,
          event_type: 'refund',
          receipt_event_id: 'refund-event-1',
          related_receipt_event_id: 'sale-event-1',
          bill_id: null,
          sync_jobs: [],
        },
        refund_duplicate: {
          ok: true,
          status: 200,
          duplicate: true,
          event_type: 'refund',
          receipt_event_id: 'refund-event-1',
          related_receipt_event_id: 'sale-event-1',
          bill_id: null,
          sync_jobs: [],
        },
        void: {
          ok: true,
          status: 200,
          duplicate: false,
          event_type: 'void',
          receipt_event_id: 'void-event-1',
          related_receipt_event_id: 'sale-event-1',
          bill_id: null,
          sync_jobs: [],
        },
        void_duplicate: {
          ok: true,
          status: 200,
          duplicate: true,
          event_type: 'void',
          receipt_event_id: 'void-event-1',
          related_receipt_event_id: 'sale-event-1',
          bill_id: null,
          sync_jobs: [],
        },
        idempotency_mismatch_rejection: { ok: false, status: 400 },
        idempotency_tax_mismatch_rejection: { ok: false, status: 400 },
        idempotency_purchase_at_mismatch_rejection: { ok: false, status: 400 },
        idempotency_source_mismatch_rejection: { ok: false, status: 400 },
        missing_merchant_rejection: { ok: false, status: 400 },
        missing_payment_reference_rejection: { ok: false, status: 400 },
        bad_payment_last4_rejection: { ok: false, status: 400 },
        missing_purchase_at_rejection: { ok: false, status: 400 },
        bad_purchase_at_rejection: { ok: false, status: 400 },
        missing_gst_rejection: { ok: false, status: 400 },
        missing_subtotal_rejection: { ok: false, status: 400 },
        bad_tax_breakdown_rejection: { ok: false, status: 400 },
        pending_rejection: { ok: false, status: 400 },
        bad_line_totals_rejection: { ok: false, status: 400 },
        bad_line_gst_rejection: { ok: false, status: 400 },
        missing_tender_rejection: { ok: false, status: 400 },
        missing_original_reference_rejection: { ok: false, status: 400 },
        missing_void_original_reference_rejection: { ok: false, status: 400 },
        unresolved_original_reference_rejection: { ok: false, status: 400 },
        unresolved_void_original_reference_rejection: { ok: false, status: 400 },
        invalid_api_key_rejection: { ok: false, status: 401 },
        invalid_identity_rejection: { ok: false, status: 400 },
      },
      persistence: {
        checked: true,
        supabase_url: 'https://example.supabase.co',
        organization_id: validOrgId,
        receipt_events: {
          sale: 'sale-event-1',
          refund: 'refund-event-1',
          void: 'void-event-1',
          sale_payment_last4: '1234',
          sale_receipt_number: 'FIELD-SALE-1',
          sale_purchase_at: '2026-06-28T03:00:00.000Z',
          refund_receipt_number: 'FIELD-REFUND-1',
          refund_purchase_at: '2026-06-28T03:20:00.000Z',
          void_receipt_number: 'FIELD-VOID-1',
          void_purchase_at: '2026-06-28T03:25:00.000Z',
          rejected_negative_controls: 0,
          sale_idempotency_rows: 1,
          refund_idempotency_rows: 1,
          void_idempotency_rows: 1,
        },
        line_items: {
          sale_count: 2,
          sale_total_inc_gst_cents: 36000,
          sale_gst_cents: 3273,
          refund_count: 1,
          refund_total_inc_gst_cents: 6000,
          refund_gst_cents: 545,
          void_count: 1,
          void_total_inc_gst_cents: 0,
          void_gst_cents: 0,
        },
        audit_packages: {
          sale_count: 1,
          refund_count: 1,
          void_count: 1,
        },
        api_request_log: {
          total: 24,
          post_count: 24,
          success_count: 6,
          validation_error_count: 17,
          unauthorized_count: 0,
          status_counts: { '200': 6, '400': 17, '401': 1 },
          ingest_type_values: ['receipt'],
          key_prefix_matches: true,
        },
        sync_jobs: [
          {
            receipt_event_id: 'sale-event-1',
            provider: 'xero',
            status: 'pending',
            bill_id: 'bill-1',
          },
        ],
      },
    },
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fieldSampleHash(eventType) {
  return {
    sale: 'a'.repeat(64),
    refund: 'b'.repeat(64),
    void: 'c'.repeat(64),
  }[eventType];
}
