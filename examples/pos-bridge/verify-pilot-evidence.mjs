#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import {
  containsUnredactedSecret,
  reconcileEvidenceFieldSamples,
  redactSecrets,
  requiredFieldSampleEventTypes,
} from './field-sample-reconciliation.mjs';

const bundledSampleContentFingerprints = new Set([
  'c1f7ec8c3aa665899639046306ef3b78c7fa603e8751f5bf58d27a739978cc6c',
  '1f91db564f57ff0c7e756e48510b3aa72ef3bd6d5bcfc2f565eba40d40ed35fe',
  '1ded54d83ce273447eb15f7b1c91e6862cbb1ed43703a393d15e0ab66aab4195',
]);
const allowedIdentityCaptureMethods = new Set([
  'barcode_scan',
  'qr_scan',
  'nfc_pass',
  'pos_customer_account',
  'middleware_mapping',
  'manual_pilot_scan',
]);
const allowedReceiptTriggers = new Set([
  'pos_completed_tender',
  'pos_receipt_finalized',
  'pos_export_completed',
  'middleware_completed_tender',
]);
const allowedReceiptSourceFormats = new Set([
  'direct_json_webhook',
  'pos_json_export',
  'pos_csv_export',
  'vendor_api_poll',
  'custom_middleware',
]);
const allowedFieldSampleCaptureMethods = new Set([
  'pos_webhook_capture',
  'pos_native_json_export',
  'pos_native_csv_export',
  'pos_vendor_api_pull',
  'middleware_capture',
]);
const sourceFormatsByConnectorMode = {
  direct_webhook: new Set(['direct_json_webhook']),
  bridge_watch_folder: new Set(['pos_json_export']),
  bridge_csv_export: new Set(['pos_csv_export']),
  custom_middleware: new Set(['vendor_api_poll', 'custom_middleware', 'direct_json_webhook']),
};
const captureMethodsBySourceFormat = {
  direct_json_webhook: new Set(['pos_webhook_capture']),
  pos_json_export: new Set(['pos_native_json_export']),
  pos_csv_export: new Set(['pos_native_csv_export']),
  vendor_api_poll: new Set(['pos_vendor_api_pull']),
  custom_middleware: new Set(['middleware_capture']),
};

async function main() {
  const args = process.argv.slice(2);
  const file = args.shift();
  if (!file) throw new Error(usage());
  const fieldSampleMode = readFieldSampleOptions(args);
  if (args.length > 0) throw new Error(usage());

  const text = await readFile(file, 'utf8');
  const evidence = JSON.parse(text);
  const failures = validateEvidence(evidence, text);
  failures.push(...fieldSampleMode.failures);
  const fieldSampleReconciliation = fieldSampleMode.samplePaths
    ? await reconcileEvidenceFieldSamples(evidence, fieldSampleMode.samplePaths)
    : null;
  if (fieldSampleReconciliation) {
    failures.push(
      ...fieldSampleReconciliation.failures.map((failure) => `field file reconciliation: ${failure}`),
    );
  } else if (!fieldSampleMode.evidenceOnly && fieldSampleMode.failures.length === 0) {
    failures.push(
      'field-file reconciliation is required for go-live verification: pass --sale, --refund, and --void field sample files',
    );
  }
  const summary = summarizeEvidence(evidence);
  summary.field_file_reconciliation_ok = fieldSampleReconciliation?.ok ?? null;
  summary.field_file_reconciliation_requested = Boolean(fieldSampleReconciliation);
  summary.field_file_reconciliation_required = !fieldSampleMode.evidenceOnly;
  summary.verification_mode = fieldSampleReconciliation
    ? 'field-files'
    : fieldSampleMode.evidenceOnly
      ? 'evidence-only'
      : 'missing-field-files';
  const result = {
    ok: failures.length === 0,
    file,
    checked_at: new Date().toISOString(),
    summary,
    field_file_reconciliation: fieldSampleReconciliation
      ? {
          ok: fieldSampleReconciliation.ok,
          matches: fieldSampleReconciliation.matches,
          failures: fieldSampleReconciliation.failures,
        }
      : { requested: false },
    failures,
  };

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

function readFieldSampleOptions(args) {
  const evidenceOnlyIndex = args.indexOf('--evidence-only');
  const evidenceOnly = evidenceOnlyIndex !== -1;
  if (evidenceOnly) args.splice(evidenceOnlyIndex, 1);
  const samplePaths = Object.fromEntries(
    requiredFieldSampleEventTypes.map((eventType) => [eventType, readOption(args, `--${eventType}`)]),
  );
  const provided = Object.values(samplePaths).filter(Boolean).length;
  const failures = [];
  if (evidenceOnly && provided > 0) {
    failures.push('--evidence-only cannot be combined with --sale/--refund/--void field files');
  }
  if (!evidenceOnly && provided > 0 && provided !== requiredFieldSampleEventTypes.length) {
    failures.push('field-file reconciliation requires all of --sale, --refund, and --void');
  }
  return {
    evidenceOnly,
    samplePaths: provided === requiredFieldSampleEventTypes.length && failures.length === 0 ? samplePaths : null,
    failures,
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

function usage() {
  return 'usage: node verify-pilot-evidence.mjs <pos-pilot-evidence.json> --sale <field-sale.json> --refund <field-refund.json> --void <field-void.json>\n' +
    'diagnostic only: node verify-pilot-evidence.mjs <pos-pilot-evidence.json> --evidence-only';
}

function validateEvidence(evidence, text) {
  const failures = [];
  const check = (condition, message) => {
    if (!condition) failures.push(message);
  };

  check(evidence && typeof evidence === 'object', 'evidence must be a JSON object');
  if (!evidence || typeof evidence !== 'object') return failures;

  check(evidence.ok === true, 'pilot evidence ok must be true');
  check(isIsoLikeDate(evidence.collected_at), 'pilot evidence collected_at must be a parseable timestamp');
  check(evidence.non_sending === false, 'go-live evidence must be collected from a receipt-sending acceptance run');
  check(
    evidence.credential_probe_non_persistent === true,
    'go-live evidence must include a non-persistent credential probe',
  );
  validateSiteManifest(evidence.site, failures);
  validateIntegrationFit(evidence.integration_fit, evidence.site, failures);
  validateReadiness(evidence.readiness, evidence.site, failures);
  validateBridgeStatus(evidence.status, evidence.site, failures);
  validateBridgeRetryDrill(evidence.bridge_retry_drill, evidence.site, failures);

  const credentialProbe = evidence.credential_probe;
  check(credentialProbe?.ok === true, 'credential probe must pass');
  check(credentialProbe?.api_key_valid === true, 'credential probe must prove the POS API key is valid');
  check(
    credentialProbe?.write_receipts_scope === true,
    'credential probe must prove write:receipts scope',
  );
  check(credentialProbe?.receipt_persisted === false, 'credential probe must not persist a receipt');

  check(Array.isArray(evidence.samples), 'sample contract evidence must be an array');
  if (Array.isArray(evidence.samples)) {
    check(evidence.samples.length >= 3, 'sample contract evidence must include sale/refund/void samples');
    check(evidence.samples.every((sample) => sample.ok === true), 'all sample contracts must pass');
    const eventTypes = new Set(evidence.samples.map((sample) => sample.event_type));
    for (const eventType of ['sale', 'refund', 'void']) {
      check(eventTypes.has(eventType), `sample contracts must include ${eventType}`);
    }
  }
  validateFieldSamples(evidence.field_samples, evidence.site, failures);

  const acceptance = evidence.acceptance;
  check(acceptance?.ok === true, 'acceptance must pass and must not be skipped');
  check(acceptance?.skipped !== true, 'acceptance must not be skipped for go-live evidence');
  const checks = acceptance?.checks ?? {};
  const sale = checks.sale;
  const duplicate = checks.duplicate;
  const refund = checks.refund;
  const refundDuplicate = checks.refund_duplicate;
  const voidReceipt = checks.void;
  const voidDuplicate = checks.void_duplicate;

  check(sale?.ok === true, 'acceptance sale must be accepted');
  check(sale?.duplicate === false, 'first acceptance sale must not be a duplicate');
  check(sale?.event_type === 'sale', 'acceptance sale response must be event_type=sale');
  check(Boolean(sale?.receipt_event_id), 'acceptance sale must return receipt_event_id');
  check(duplicate?.ok === true, 'duplicate retry must be accepted');
  check(duplicate?.duplicate === true, 'duplicate retry must be marked duplicate');
  check(
    Boolean(sale?.receipt_event_id) && duplicate?.receipt_event_id === sale.receipt_event_id,
    'duplicate retry must return the same receipt_event_id as the sale',
  );
  check(refund?.ok === true, 'refund must be accepted');
  check(refund?.event_type === 'refund', 'refund response must be event_type=refund');
  check(
    Boolean(sale?.receipt_event_id) && refund?.related_receipt_event_id === sale.receipt_event_id,
    'refund must link to the sale receipt_event_id',
  );
  check(refund?.bill_id == null, 'refund must not create a positive bill');
  check(
    Array.isArray(refund?.sync_jobs) && refund.sync_jobs.length === 0,
    'refund must not create accounting sync jobs',
  );
  check(refundDuplicate?.ok === true, 'refund duplicate retry must be accepted');
  check(refundDuplicate?.duplicate === true, 'refund duplicate retry must be marked duplicate');
  check(
    Boolean(refund?.receipt_event_id) && refundDuplicate?.receipt_event_id === refund.receipt_event_id,
    'refund duplicate retry must return the same receipt_event_id as the refund',
  );
  check(voidReceipt?.ok === true, 'void must be accepted');
  check(voidReceipt?.event_type === 'void', 'void response must be event_type=void');
  check(
    Boolean(sale?.receipt_event_id) && voidReceipt?.related_receipt_event_id === sale.receipt_event_id,
    'void must link to the sale receipt_event_id',
  );
  check(voidReceipt?.bill_id == null, 'void must not create a positive bill');
  check(
    Array.isArray(voidReceipt?.sync_jobs) && voidReceipt.sync_jobs.length === 0,
    'void must not create accounting sync jobs',
  );
  check(voidDuplicate?.ok === true, 'void duplicate retry must be accepted');
  check(voidDuplicate?.duplicate === true, 'void duplicate retry must be marked duplicate');
  check(
    Boolean(voidReceipt?.receipt_event_id) && voidDuplicate?.receipt_event_id === voidReceipt.receipt_event_id,
    'void duplicate retry must return the same receipt_event_id as the void',
  );

  check(checks.pending_rejection?.status === 400, 'pending tender negative control must return 400');
  check(checks.bad_line_totals_rejection?.status === 400, 'bad line totals negative control must return 400');
  check(checks.bad_line_gst_rejection?.status === 400, 'bad line GST negative control must return 400');
  check(
    checks.idempotency_mismatch_rejection?.status === 400,
    'idempotency mismatch negative control must return 400',
  );
  check(
    checks.idempotency_tax_mismatch_rejection?.status === 400,
    'idempotency tax mismatch negative control must return 400',
  );
  check(
    checks.idempotency_purchase_at_mismatch_rejection?.status === 400,
    'idempotency purchase_at mismatch negative control must return 400',
  );
  check(
    checks.idempotency_source_mismatch_rejection?.status === 400,
    'idempotency source mismatch negative control must return 400',
  );
  check(checks.missing_merchant_rejection?.status === 400, 'missing merchant negative control must return 400');
  check(
    checks.missing_payment_reference_rejection?.status === 400,
    'missing payment reference negative control must return 400',
  );
  check(
    checks.bad_payment_last4_rejection?.status === 400,
    'full-card payment_last4 negative control must return 400',
  );
  check(
    checks.missing_purchase_at_rejection?.status === 400,
    'missing purchase_at negative control must return 400',
  );
  check(
    checks.bad_purchase_at_rejection?.status === 400,
    'bad purchase_at negative control must return 400',
  );
  check(
    checks.missing_gst_rejection?.status === 400,
    'missing GST negative control must return 400',
  );
  check(
    checks.missing_subtotal_rejection?.status === 400,
    'missing subtotal negative control must return 400',
  );
  check(
    checks.bad_tax_breakdown_rejection?.status === 400,
    'bad GST/subtotal negative control must return 400',
  );
  check(checks.missing_tender_rejection?.status === 400, 'missing tender negative control must return 400');
  check(
    checks.missing_original_reference_rejection?.status === 400,
    'missing original reference negative control must return 400',
  );
  check(
    checks.missing_void_original_reference_rejection?.status === 400,
    'missing void original reference negative control must return 400',
  );
  check(
    checks.unresolved_original_reference_rejection?.status === 400,
    'unresolved original reference negative control must return 400',
  );
  check(
    checks.unresolved_void_original_reference_rejection?.status === 400,
    'unresolved void original reference negative control must return 400',
  );
  check(checks.invalid_api_key_rejection?.status === 401, 'invalid API key negative control must return 401');
  check(checks.invalid_identity_rejection?.status === 400, 'invalid identity negative control must return 400');

  const persistence = acceptance?.persistence;
  check(persistence?.checked === true, 'acceptance persistence readback must be checked');
  check(
    persistence?.receipt_events?.sale_idempotency_rows === 1,
    'persistence must prove exactly one sale idempotency row',
  );
  check(
    persistence?.receipt_events?.refund_idempotency_rows === 1,
    'persistence must prove exactly one refund idempotency row',
  );
  check(
    persistence?.receipt_events?.void_idempotency_rows === 1,
    'persistence must prove exactly one void idempotency row',
  );
  const persistedSaleLast4 = persistence?.receipt_events?.sale_payment_last4;
  check(
    persistedSaleLast4 == null || /^\d{4}$/.test(String(persistedSaleLast4)),
    'persistence sale_payment_last4 must be empty or exactly four digits',
  );
  check(
    typeof persistence?.receipt_events?.sale_purchase_at === 'string' &&
      !Number.isNaN(new Date(persistence.receipt_events.sale_purchase_at).getTime()),
    'persistence sale_purchase_at must be a valid stored receipt timestamp',
  );
  check(
    persistence?.receipt_events?.rejected_negative_controls === 0,
    'persistence must prove rejected negative controls did not persist',
  );
  check(Number(persistence?.line_items?.sale_count ?? 0) > 0, 'persistence must include sale line item rows');
  check(
    Number(persistence?.line_items?.sale_total_inc_gst_cents ?? 0) > 0,
    'persistence must include sale line item total',
  );
  check(
    Number(persistence?.line_items?.sale_gst_cents ?? 0) > 0,
    'persistence must include sale line item GST total',
  );
  check(Number(persistence?.line_items?.refund_count ?? 0) > 0, 'persistence must include refund line item rows');
  check(
    Number(persistence?.line_items?.refund_total_inc_gst_cents ?? 0) > 0,
    'persistence must include refund line item total',
  );
  check(
    Number(persistence?.line_items?.refund_gst_cents ?? 0) > 0,
    'persistence must include refund line item GST total',
  );
  check(Number(persistence?.line_items?.void_count ?? 0) > 0, 'persistence must include void line item rows');
  check(
    Number(persistence?.line_items?.void_total_inc_gst_cents ?? -1) === 0,
    'persistence must include zero total for the void line item',
  );
  check(
    Number(persistence?.line_items?.void_gst_cents ?? -1) === 0,
    'persistence must include zero GST for the void line item',
  );
  check(persistence?.audit_packages?.sale_count === 1, 'persistence must prove one sale audit package');
  check(persistence?.audit_packages?.refund_count === 1, 'persistence must prove one refund audit package');
  check(persistence?.audit_packages?.void_count === 1, 'persistence must prove one void audit package');
  validateAcceptedFieldSampleReadback(evidence.field_samples, persistence, failures);
  const apiLog = persistence?.api_request_log;
  check(Number(apiLog?.total ?? 0) >= 10, 'persistence must prove receipt-webhook API request log rows');
  check(Number(apiLog?.post_count ?? 0) >= 10, 'persistence must prove receipt-webhook POST log rows');
  check(Number(apiLog?.success_count ?? 0) >= 6, 'persistence must prove successful webhook calls were logged');
  check(Number(apiLog?.validation_error_count ?? 0) >= 10, 'persistence must prove validation rejections were logged');
  check(apiLog?.key_prefix_matches === true, 'persistence must prove API logs match the POS key prefix');
  check(
    Array.isArray(apiLog?.ingest_type_values) &&
      apiLog.ingest_type_values.length === 1 &&
      apiLog.ingest_type_values[0] === 'receipt',
    'persistence must prove API logs are tagged ingest_type=receipt',
  );
  check(Array.isArray(persistence?.sync_jobs), 'persistence must include sync job readback');
  if (Array.isArray(persistence?.sync_jobs)) {
    check(
      !persistence.sync_jobs.some((job) => job?.receipt_event_id === refund?.receipt_event_id),
      'persistence must prove refund did not create accounting sync jobs',
    );
    check(
      !persistence.sync_jobs.some((job) => job?.receipt_event_id === voidReceipt?.receipt_event_id),
      'persistence must prove void did not create accounting sync jobs',
    );
  }
  if (typeof evidence.site?.looplet_organization_id === 'string' && persistence?.organization_id) {
    check(
      persistence.organization_id === evidence.site.looplet_organization_id,
      'persistence organization_id must match the site manifest looplet_organization_id',
    );
  }

  check(!containsUnredactedSecret(text), 'evidence file must not contain unredacted Looplet secrets');

  return failures;
}

function validateAcceptedFieldSampleReadback(fieldSamples, persistence, failures) {
  if (!Array.isArray(fieldSamples?.samples) || !persistence) return;
  const check = (condition, message) => {
    if (!condition) failures.push(message);
  };

  for (const eventType of ['sale', 'refund', 'void']) {
    const sample = fieldSamples.samples.find((row) => row?.event_type === eventType);
    if (!sample) continue;

    const persistedPurchaseAt = persistence.receipt_events?.[`${eventType}_purchase_at`];
    check(
      toIsoDate(persistedPurchaseAt) === toIsoDate(sample.purchase_at),
      `persistence ${eventType} purchase_at must match the field POS sample`,
    );
    check(
      Number(persistence.line_items?.[`${eventType}_total_inc_gst_cents`] ?? Number.NaN) ===
        Number(sample.total_inc_gst_cents),
      `persistence ${eventType} total must match the field POS sample`,
    );
    check(
      Number(persistence.line_items?.[`${eventType}_count`] ?? Number.NaN) === Number(sample.line_count),
      `persistence ${eventType} line count must match the field POS sample`,
    );
  }
}

function validateReadiness(readiness, site, failures) {
  const check = (condition, message) => {
    if (!condition) failures.push(message);
  };
  const checks = readiness?.checks ?? {};

  check(readiness?.ok === true, 'readiness must pass');
  check(checks.node?.ok === true, 'readiness node check must pass');
  check(checks.config?.ok === true, 'readiness config check must pass');
  check(checks.bridge_files?.ok === true, 'readiness bridge file completeness check must pass');
  check(
    !Array.isArray(checks.bridge_files?.missing) || checks.bridge_files.missing.length === 0,
    'readiness bridge file completeness check must report no missing files',
  );
  if (requiresLocalBridgeManifest(site)) {
    const manifest = checks.bridge_files?.manifest;
    check(manifest?.present === true, 'local bridge readiness must include installed MANIFEST.json');
    check(manifest?.ok === true, 'local bridge readiness must verify installed package manifest hashes');
    check(Number(manifest?.checked_files ?? 0) > 0, 'local bridge readiness manifest must verify installed files');
    check(
      !Array.isArray(manifest?.errors) || manifest.errors.length === 0,
      'local bridge readiness manifest must report no errors',
    );
  }
  check(checks.inbox?.ok === true, 'readiness inbox write check must pass');
  check(checks.contract?.ok === true, 'readiness sample contract check must pass');
  check(checks.network?.ok === true, 'readiness network check must pass');
  check(checks.network?.skipped !== true, 'readiness network check must not be skipped for go-live evidence');
  check(checks.network?.reachable !== false, 'readiness network check must prove the endpoint is reachable');
}

function validateIntegrationFit(integrationFit, site, failures) {
  const check = (condition, message) => {
    if (!condition) failures.push(message);
  };

  check(integrationFit?.provided === true, 'integration fit profile must be supplied for go-live evidence');
  check(integrationFit?.ok === true, 'integration fit check must pass');
  check(Array.isArray(integrationFit?.blockers) && integrationFit.blockers.length === 0, 'integration fit must report no blockers');
  const recommendation = integrationFit?.recommendation;
  check(Boolean(recommendation), 'integration fit must include a recommendation');
  if (!recommendation || !site) return;

  check(
    sameText(integrationFit.business_name, site.business_name),
    'integration fit business_name must match the site manifest',
  );
  check(
    sameText(integrationFit.pos_vendor, site.pos_vendor),
    'integration fit pos_vendor must match the site manifest',
  );
  if (hasText(site.pos_product) || hasText(integrationFit.pos_product)) {
    check(
      sameText(integrationFit.pos_product, site.pos_product),
      'integration fit pos_product must match the site manifest when provided',
    );
  }
  check(
    recommendation.connector_mode === site.connector_mode,
    'integration fit connector_mode must match the site manifest',
  );
  check(
    recommendation.identity_capture_method === site.identity_capture_method,
    'integration fit identity_capture_method must match the site manifest',
  );
  check(
    recommendation.receipt_trigger === site.receipt_trigger,
    'integration fit receipt_trigger must match the site manifest',
  );
  check(
    recommendation.receipt_source_format === site.receipt_source_format,
    'integration fit receipt_source_format must match the site manifest',
  );
  check(
    recommendation.field_sample_capture_method === site.field_sample_capture_method,
    'integration fit field_sample_capture_method must match the site manifest',
  );
}

function validateBridgeStatus(status, site, failures) {
  const check = (condition, message) => {
    if (!condition) failures.push(message);
  };

  check(status?.ok === true, 'bridge status must be clean');
  check(
    !Array.isArray(status?.attention_required) || status.attention_required.length === 0,
    'bridge status must not require operator attention',
  );

  if (requiresLocalBridgeScheduler(site)) {
    check(status?.scheduler?.configured === true, 'local bridge status must include configured scheduled-task logs');
    check(status?.scheduler?.ok === true, 'local bridge scheduled-task status must be healthy');
    check(Boolean(status?.scheduler?.last_run_at), 'local bridge scheduled-task status must include last_run_at');
    check(status?.scheduler?.last_exit_code === 0, 'local bridge scheduled-task last exit code must be 0');
    check(
      status?.local_file_protection?.ok === true,
      'local bridge status must prove env/log/state/archive files are filesystem-protected',
    );
    check(
      Number(status?.local_file_protection?.checked_count ?? 0) > 0,
      'local bridge status must check at least one filesystem-protected local file',
    );
  }
}

function validateSiteManifest(site, failures) {
  const check = (condition, message) => {
    if (!condition) failures.push(message);
  };
  const requiredText = [
    'business_name',
    'merchant_name',
    'pilot_id',
    'pilot_window_start',
    'pilot_window_end',
    'pos_vendor',
    'connector_mode',
    'identity_capture_method',
    'receipt_trigger',
    'receipt_source_format',
    'field_sample_capture_method',
    'integration_owner',
    'install_machine_id',
    'operator_name',
    'operator_role',
    'looplet_organization_id',
  ];

  check(site?.provided === true, 'site manifest must be supplied for go-live evidence');
  if (!site || typeof site !== 'object') return;

  for (const field of requiredText) {
    check(typeof site[field] === 'string' && site[field].trim().length >= 2, `site manifest ${field} is required`);
  }
  check(!looksLikePlaceholder(site.business_name), 'site manifest business_name must not be an example placeholder');
  check(!looksLikePlaceholder(site.merchant_name), 'site manifest merchant_name must not be an example placeholder');
  check(!looksLikePlaceholder(site.pos_vendor), 'site manifest pos_vendor must not be an example placeholder');
  check(!looksLikePlaceholder(site.operator_name), 'site manifest operator_name must not be an example placeholder');
  check(!looksLikePlaceholder(site.pilot_id), 'site manifest pilot_id must not be an example placeholder');
  check(isUuid(site.looplet_organization_id), 'site manifest looplet_organization_id must be a UUID');
  check(
    site.looplet_organization_id !== '00000000-0000-0000-0000-000000000000',
    'site manifest looplet_organization_id must not be the placeholder UUID',
  );
  check(isIsoLikeDate(site.pilot_window_start), 'site manifest pilot_window_start must be a parseable date/time');
  check(isIsoLikeDate(site.pilot_window_end), 'site manifest pilot_window_end must be a parseable date/time');
  if (isIsoLikeDate(site.pilot_window_start) && isIsoLikeDate(site.pilot_window_end)) {
    check(
      new Date(site.pilot_window_end).getTime() > new Date(site.pilot_window_start).getTime(),
      'site manifest pilot_window_end must be after pilot_window_start',
    );
  }
  check(
    ['direct_webhook', 'bridge_watch_folder', 'bridge_csv_export', 'custom_middleware'].includes(site.connector_mode),
    'site manifest connector_mode must be direct_webhook, bridge_watch_folder, bridge_csv_export, or custom_middleware',
  );
  check(
    allowedIdentityCaptureMethods.has(site.identity_capture_method),
    'site manifest identity_capture_method must be barcode_scan, qr_scan, nfc_pass, pos_customer_account, middleware_mapping, or manual_pilot_scan',
  );
  check(
    allowedReceiptTriggers.has(site.receipt_trigger),
    'site manifest receipt_trigger must be pos_completed_tender, pos_receipt_finalized, pos_export_completed, or middleware_completed_tender',
  );
  check(
    allowedReceiptSourceFormats.has(site.receipt_source_format),
    'site manifest receipt_source_format must be direct_json_webhook, pos_json_export, pos_csv_export, vendor_api_poll, or custom_middleware',
  );
  check(
    allowedFieldSampleCaptureMethods.has(site.field_sample_capture_method),
    'site manifest field_sample_capture_method must be pos_webhook_capture, pos_native_json_export, pos_native_csv_export, pos_vendor_api_pull, or middleware_capture',
  );
  const sourceFormats = sourceFormatsByConnectorMode[site.connector_mode];
  check(
    Boolean(sourceFormats?.has(site.receipt_source_format)),
    `site manifest connector_mode ${site.connector_mode} is not compatible with receipt_source_format ${site.receipt_source_format ?? '<missing>'}`,
  );
  const captureMethods = captureMethodsBySourceFormat[site.receipt_source_format];
  check(
    Boolean(captureMethods?.has(site.field_sample_capture_method)),
    `site manifest receipt_source_format ${site.receipt_source_format ?? '<missing>'} is not compatible with field_sample_capture_method ${site.field_sample_capture_method ?? '<missing>'}`,
  );
}

function requiresLocalBridgeScheduler(site) {
  return ['bridge_watch_folder', 'bridge_csv_export'].includes(site?.connector_mode);
}

function validateBridgeRetryDrill(drill, site, failures) {
  const check = (condition, message) => {
    if (!condition) failures.push(message);
  };

  if (!requiresLocalBridgeRetryDrill(site)) return;

  check(drill?.ok === true, 'local bridge retry drill must pass');
  check(drill?.non_sending === true, 'local bridge retry drill must be non-sending');
  check(Number(drill?.failed_requests_seen ?? 0) >= 2, 'local bridge retry drill must prove transient retry attempts');
  check(drill?.queued_after_outage === true, 'local bridge retry drill must prove receipts queue during outage');
  check(drill?.queue_flushed_after_recovery === true, 'local bridge retry drill must prove queue flush after recovery');
  check(drill?.accepted_after_recovery === true, 'local bridge retry drill must prove queued receipt sends after recovery');
  check(drill?.dead_letter_created === false, 'local bridge retry drill must not dead-letter a transient outage receipt');
  check(drill?.secrets_redacted === true, 'local bridge retry drill output must redact secrets');
}

function requiresLocalBridgeRetryDrill(site) {
  return ['bridge_watch_folder', 'bridge_csv_export'].includes(site?.connector_mode);
}

function requiresLocalBridgeManifest(site) {
  return ['bridge_watch_folder', 'bridge_csv_export'].includes(site?.connector_mode);
}

function validateFieldSamples(fieldSamples, site, failures) {
  const check = (condition, message) => {
    if (!condition) failures.push(message);
  };

  check(fieldSamples?.provided === true, 'field POS sale/refund/void samples must be supplied for go-live evidence');
  check(fieldSamples?.ok === true, 'field POS samples must all pass contract validation');
  check(Array.isArray(fieldSamples?.samples), 'field POS samples must include a samples array');
  if (!Array.isArray(fieldSamples?.samples)) return;

  const eventTypes = new Set(fieldSamples.samples.map((sample) => sample.event_type));
  const saleSample = fieldSamples.samples.find((row) => row.event_type === 'sale');
  for (const eventType of ['sale', 'refund', 'void']) {
    check(eventTypes.has(eventType), `field POS samples must include ${eventType}`);
    const sample = fieldSamples.samples.find((row) => row.event_type === eventType);
    check(sample?.ok === true, `field POS ${eventType} sample must pass`);
    check(sample?.bundled_sample !== true, `field POS ${eventType} sample must not be a bundled example sample`);
    check(
      !bundledSampleContentFingerprints.has(String(sample?.content_sha256_without_identity ?? '')),
      `field POS ${eventType} sample must not match bundled sample content`,
    );
    check(
      ['receipt', 'payload.receipt', 'payload.customer'].includes(sample?.identity_token_source),
      `field POS ${eventType} sample must include a scanned Looplet identity token`,
    );
    check(
      isSha256(sample?.redacted_sample_sha256),
      `field POS ${eventType} sample must include a redacted sample SHA-256 fingerprint`,
    );
    check(
      isSha256(sample?.content_sha256_without_identity),
      `field POS ${eventType} sample must include an identity-stripped content SHA-256 fingerprint`,
    );
    check(Boolean(sample?.idempotency_key), `field POS ${eventType} sample must include a stable idempotency key`);
    check(
      sameText(sample?.merchant_name, site?.merchant_name),
      `field POS ${eventType} sample merchant_name must match the site manifest merchant_name`,
    );
    check(Boolean(sample?.receipt_number), `field POS ${eventType} sample must include a receipt number`);
    if (eventType === 'sale') {
      check(Boolean(sample?.external_event_id), 'field POS sale sample must include an external_event_id');
    } else {
      const receiptMatches = sameText(sample?.original_receipt_number, saleSample?.receipt_number);
      const externalEventMatches = sameText(sample?.original_external_event_id, saleSample?.external_event_id);
      check(
        receiptMatches || externalEventMatches,
        `field POS ${eventType} sample original reference must match the sale field sample`,
      );
      check(
        sample?.original_reference_matches_sale === true,
        `field POS ${eventType} sample must be marked as linked to the sale field sample`,
      );
    }
    check(isIsoLikeDate(sample?.purchase_at), `field POS ${eventType} sample must include a parseable purchase_at`);
    if (isIsoLikeDate(sample?.purchase_at) && isIsoLikeDate(site?.pilot_window_start) && isIsoLikeDate(site?.pilot_window_end)) {
      const purchaseAt = new Date(sample.purchase_at).getTime();
      const windowStart = new Date(site.pilot_window_start).getTime();
      const windowEnd = new Date(site.pilot_window_end).getTime();
      check(
        purchaseAt >= windowStart && purchaseAt <= windowEnd,
        `field POS ${eventType} sample purchase_at must fall within the pilot window`,
      );
    }
    check(Number(sample?.line_count ?? 0) > 0, `field POS ${eventType} sample must include itemised lines`);
  }
}

function looksLikePlaceholder(value) {
  if (typeof value !== 'string') return true;
  const normal = value.trim().toLowerCase();
  return !normal ||
    normal.includes('example') ||
    normal.includes('installer name') ||
    normal === 'todo' ||
    normal === 'tbd' ||
    normal === '<replace>';
}

function isUuid(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function isIsoLikeDate(value) {
  return typeof value === 'string' && Number.isFinite(new Date(value).getTime());
}

function toIsoDate(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function summarizeEvidence(evidence) {
  const acceptance = evidence?.acceptance ?? {};
  const checks = acceptance.checks ?? {};
  const persistence = acceptance.persistence ?? {};
  return {
    readiness_ok: evidence?.readiness?.ok === true,
    integration_fit_ok: evidence?.integration_fit?.ok === true,
    integration_fit_connector_mode: evidence?.integration_fit?.recommendation?.connector_mode ?? null,
    integration_fit_matches_site: integrationFitMatchesSite(evidence?.integration_fit, evidence?.site),
    integration_fit_identity_matches_site: integrationFitIdentityMatchesSite(evidence?.integration_fit, evidence?.site),
    readiness_bridge_files_ok: evidence?.readiness?.checks?.bridge_files?.ok === true,
    readiness_manifest_ok: requiresLocalBridgeManifest(evidence?.site)
      ? evidence?.readiness?.checks?.bridge_files?.manifest?.present === true &&
        evidence.readiness.checks.bridge_files.manifest.ok === true
      : null,
    readiness_network_ok: evidence?.readiness?.checks?.network?.ok === true &&
      evidence.readiness.checks.network.skipped !== true,
    site_manifest_ok: evidence?.site?.provided === true,
    field_samples_ok: evidence?.field_samples?.ok === true,
    field_samples_match_site_merchant: fieldSamplesMatchSiteMerchant(evidence?.field_samples, evidence?.site),
    field_samples_refund_void_link_sale: fieldSamplesRefundVoidLinkSale(evidence?.field_samples),
    field_samples_within_pilot_window: fieldSamplesInPilotWindow(evidence?.field_samples, evidence?.site),
    pilot_id: evidence?.site?.pilot_id ?? null,
    connector_mode: evidence?.site?.connector_mode ?? null,
    identity_capture_method: evidence?.site?.identity_capture_method ?? null,
    receipt_trigger: evidence?.site?.receipt_trigger ?? null,
    receipt_source_format: evidence?.site?.receipt_source_format ?? null,
    field_sample_capture_method: evidence?.site?.field_sample_capture_method ?? null,
    field_sample_fingerprints: Array.isArray(evidence?.field_samples?.samples)
      ? Object.fromEntries(
          evidence.field_samples.samples
            .filter((sample) => typeof sample?.event_type === 'string')
            .map((sample) => [sample.event_type, sample.redacted_sample_sha256 ?? null]),
        )
      : {},
    status_ok: evidence?.status?.ok === true,
    bridge_scheduler_ok: requiresLocalBridgeScheduler(evidence?.site)
      ? evidence?.status?.scheduler?.configured === true &&
        evidence.status.scheduler.ok === true &&
        evidence.status.scheduler.last_exit_code === 0
      : null,
    local_file_protection_ok: requiresLocalBridgeScheduler(evidence?.site)
      ? evidence?.status?.local_file_protection?.ok === true
      : null,
    local_file_protection_checked_count: requiresLocalBridgeScheduler(evidence?.site)
      ? Number(evidence?.status?.local_file_protection?.checked_count ?? 0)
      : null,
    bridge_retry_drill_ok: requiresLocalBridgeRetryDrill(evidence?.site)
      ? evidence?.bridge_retry_drill?.ok === true &&
        Number(evidence.bridge_retry_drill.failed_requests_seen ?? 0) >= 2 &&
        evidence.bridge_retry_drill.queued_after_outage === true &&
        evidence.bridge_retry_drill.queue_flushed_after_recovery === true &&
        evidence.bridge_retry_drill.accepted_after_recovery === true
      : null,
    credential_probe_ok: evidence?.credential_probe?.ok === true,
    acceptance_ok: acceptance.ok === true,
    persistence_checked: persistence.checked === true,
    sale_event_id: checks.sale?.receipt_event_id ?? null,
    duplicate_same_event: Boolean(checks.sale?.receipt_event_id) &&
      checks.duplicate?.receipt_event_id === checks.sale.receipt_event_id,
    refund_linked: Boolean(checks.sale?.receipt_event_id) &&
      checks.refund?.related_receipt_event_id === checks.sale.receipt_event_id,
    refund_duplicate_same_event: Boolean(checks.refund?.receipt_event_id) &&
      checks.refund_duplicate?.receipt_event_id === checks.refund.receipt_event_id,
    void_linked: Boolean(checks.sale?.receipt_event_id) &&
      checks.void?.related_receipt_event_id === checks.sale.receipt_event_id,
    void_duplicate_same_event: Boolean(checks.void?.receipt_event_id) &&
      checks.void_duplicate?.receipt_event_id === checks.void.receipt_event_id,
    idempotency_tax_mismatch_rejected: checks.idempotency_tax_mismatch_rejection?.status === 400,
    idempotency_purchase_at_mismatch_rejected: checks.idempotency_purchase_at_mismatch_rejection?.status === 400,
    missing_payment_reference_rejected: checks.missing_payment_reference_rejection?.status === 400,
    bad_payment_last4_rejected: checks.bad_payment_last4_rejection?.status === 400,
    missing_purchase_at_rejected: checks.missing_purchase_at_rejection?.status === 400,
    bad_purchase_at_rejected: checks.bad_purchase_at_rejection?.status === 400,
    rejected_negative_controls: persistence.receipt_events?.rejected_negative_controls ?? null,
    api_request_log_ok: apiRequestLogReady(persistence.api_request_log),
  };
}

function integrationFitMatchesSite(integrationFit, site) {
  const recommendation = integrationFit?.recommendation;
  return integrationFit?.ok === true &&
    integrationFitIdentityMatchesSite(integrationFit, site) &&
    recommendation?.connector_mode === site?.connector_mode &&
    recommendation?.identity_capture_method === site?.identity_capture_method &&
    recommendation?.receipt_trigger === site?.receipt_trigger &&
    recommendation?.receipt_source_format === site?.receipt_source_format &&
    recommendation?.field_sample_capture_method === site?.field_sample_capture_method;
}

function integrationFitIdentityMatchesSite(integrationFit, site) {
  if (!integrationFit || !site) return false;
  if (!sameText(integrationFit.business_name, site.business_name)) return false;
  if (!sameText(integrationFit.pos_vendor, site.pos_vendor)) return false;
  if (hasText(integrationFit.pos_product) || hasText(site.pos_product)) {
    return sameText(integrationFit.pos_product, site.pos_product);
  }
  return true;
}

function sameText(left, right) {
  return hasText(left) && hasText(right) && normalizeText(left) === normalizeText(right);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeText(value) {
  return String(value).trim().replace(/\s+/g, ' ').toLowerCase();
}

function apiRequestLogReady(apiLog) {
  return Number(apiLog?.total ?? 0) >= 10 &&
    Number(apiLog?.post_count ?? 0) >= 10 &&
    Number(apiLog?.success_count ?? 0) >= 6 &&
    Number(apiLog?.validation_error_count ?? 0) >= 10 &&
    apiLog?.key_prefix_matches === true &&
    Array.isArray(apiLog?.ingest_type_values) &&
    apiLog.ingest_type_values.length === 1 &&
    apiLog.ingest_type_values[0] === 'receipt';
}

function fieldSamplesInPilotWindow(fieldSamples, site) {
  if (!Array.isArray(fieldSamples?.samples)) return false;
  if (!isIsoLikeDate(site?.pilot_window_start) || !isIsoLikeDate(site?.pilot_window_end)) return false;
  const windowStart = new Date(site.pilot_window_start).getTime();
  const windowEnd = new Date(site.pilot_window_end).getTime();
  return ['sale', 'refund', 'void'].every((eventType) => {
    const sample = fieldSamples.samples.find((row) => row.event_type === eventType);
    if (!isIsoLikeDate(sample?.purchase_at)) return false;
    const purchaseAt = new Date(sample.purchase_at).getTime();
    return purchaseAt >= windowStart && purchaseAt <= windowEnd;
  });
}

function fieldSamplesMatchSiteMerchant(fieldSamples, site) {
  if (!Array.isArray(fieldSamples?.samples) || !hasText(site?.merchant_name)) return false;
  return ['sale', 'refund', 'void'].every((eventType) => {
    const sample = fieldSamples.samples.find((row) => row.event_type === eventType);
    return sameText(sample?.merchant_name, site.merchant_name);
  });
}

function fieldSamplesRefundVoidLinkSale(fieldSamples) {
  if (!Array.isArray(fieldSamples?.samples)) return false;
  const sale = fieldSamples.samples.find((row) => row.event_type === 'sale');
  if (!sale?.receipt_number && !sale?.external_event_id) return false;
  return ['refund', 'void'].every((eventType) => {
    const sample = fieldSamples.samples.find((row) => row.event_type === eventType);
    const receiptMatches = sameText(sample?.original_receipt_number, sale.receipt_number);
    const externalEventMatches = sameText(sample?.original_external_event_id, sale.external_event_id);
    return (receiptMatches || externalEventMatches) && sample?.original_reference_matches_sale === true;
  });
}

await main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? redactSecrets(error.message) : redactSecrets(String(error)),
  }, null, 2));
  process.exit(1);
});
