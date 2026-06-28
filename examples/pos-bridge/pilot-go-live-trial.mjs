#!/usr/bin/env node
import { createServer } from 'node:http';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

const rootDir = process.env.LOOPLET_PILOT_GO_LIVE_TRIAL_DIR || '.claude/scratch/pos-pilot-go-live-trial';
const packageOutDir = join(rootDir, 'package-out');
const packageExtractDir = join(rootDir, 'package-extract');
const packageName = 'looplet-pos-bridge-pilot-trial';
const expandedPackageRoot = join(packageExtractDir, packageName);
const installedBridgeRoot = join(rootDir, 'installed-bridge');
const envFile = join(rootDir, 'pilot.env');
const liveGuardEnvFile = join(rootDir, 'pilot-live-guard.env');
const siteFile = join(rootDir, 'pilot-site.json');
const fitProfileFile = join(rootDir, 'pos-integration-profile.json');
const invalidSiteFile = join(rootDir, 'pilot-site-invalid.json');
const mismatchedSiteFile = join(rootDir, 'pilot-site-mismatched-source.json');
const preflightEvidenceFile = join(rootDir, 'pos-pilot-preflight.json');
const evidenceFile = join(rootDir, 'pos-pilot-evidence.json');
const reportFile = join(rootDir, 'pos-pilot-report.json');
const reportMarkdownFile = join(rootDir, 'pos-pilot-report.md');
const inboxDir = join(rootDir, 'inbox');
const logDir = join(installedBridgeRoot, 'logs');
const trialOrgId = '11111111-1111-4111-8111-111111111111';
const fieldSaleFile = join(rootDir, 'field-sale.json');
const fieldRefundFile = join(rootDir, 'field-refund.json');
const fieldVoidFile = join(rootDir, 'field-void.json');
const staleFieldSaleFile = join(rootDir, 'field-sale-stale.json');
const crossMerchantFieldSaleFile = join(rootDir, 'field-sale-cross-merchant.json');
const badRefundOriginalFile = join(rootDir, 'field-refund-bad-original.json');
const seen = new Map();
const receiptEvents = [];
const receiptEventLineItems = [];
const receiptAuditPackages = [];
const receiptSyncJobs = [];
const apiRequestLogs = [];
let saleEventId = null;
let saleReceiptNumber = null;
let saleOriginalExternalEventId = null;
let credentialProbeSeen = false;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');

  if (req.method === 'OPTIONS' && url.pathname === '/functions/v1/receipt-webhook') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST,OPTIONS',
      'access-control-allow-headers': 'authorization,content-type,idempotency-key',
    });
    res.end();
    return;
  }

  if (url.pathname.startsWith('/rest/v1/')) {
    handleRestRead(req, res, url);
    return;
  }

  if (url.pathname !== '/functions/v1/receipt-webhook') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
    return;
  }

  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => handleReceiptPost(req, res, body));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

try {
  await rm(rootDir, { recursive: true, force: true });
  await mkdir(inboxDir, { recursive: true });
  const packageRun = await runPowerShell([
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'examples/pos-bridge/package-windows-bridge.ps1',
    '-OutputDir',
    packageOutDir,
    '-PackageName',
    packageName,
  ], 0);
  const packageResult = JSON.parse(packageRun.stdout);
  await mkdir(expandedPackageRoot, { recursive: true });
  await runPowerShell([
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    '& { param($Zip, $Destination) Expand-Archive -LiteralPath $Zip -DestinationPath $Destination -Force }',
    packageResult.zip_path,
    expandedPackageRoot,
  ], 0);
  await runPowerShell([
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    join(expandedPackageRoot, 'install-windows-task.ps1'),
    '-Apply',
    '-NoRegister',
    '-InstallRoot',
    installedBridgeRoot,
    '-EnvFile',
    envFile,
    '-InboxDir',
    inboxDir,
    '-NodePath',
    process.execPath,
  ], 0);
  await writeSchedulerLog(logDir, { timestamp: new Date(), exitCode: 0, processed: 0 });
  await writeFieldSample(fieldSaleFile, 'examples/pos-bridge/sample-receipt.json');
  await writeFieldSample(fieldRefundFile, 'examples/pos-bridge/sample-refund.json');
  await writeFieldSample(fieldVoidFile, 'examples/pos-bridge/sample-void.json');
  await writeFieldSample(crossMerchantFieldSaleFile, 'examples/pos-bridge/sample-receipt.json', null, 'Other Store Pty Ltd');
  await writeFieldSample(
    badRefundOriginalFile,
    'examples/pos-bridge/sample-refund.json',
    null,
    'Acme Field Trade Supplies',
    'OTHER-SALE-PILOT-001',
    'other-sale-evt-pilotgolive001',
  );
  await writeFile(envFile, [
    `LOOPLET_RECEIPT_WEBHOOK_URL=http://127.0.0.1:${port}/functions/v1/receipt-webhook`,
    'LOOPLET_POS_API_KEY=llp_trial.secret',
    'LOOPLET_RECEIPT_IDENTITY_TOKEN=rhp_trial.receiptsecret',
    'LOOPLET_SYNC_TARGETS=xero',
    `LOOPLET_BRIDGE_QUEUE_FILE=${join(rootDir, 'queue.jsonl')}`,
    `LOOPLET_BRIDGE_DEAD_LETTER_FILE=${join(rootDir, 'dead.jsonl')}`,
    `LOOPLET_BRIDGE_INBOX_DIR=${inboxDir}`,
    `LOOPLET_BRIDGE_LOG_DIR=${logDir}`,
    `LOOPLET_READINESS_SAMPLE=${join(process.cwd(), installedBridgeRoot, 'sample-receipt.json')}`,
    'LOOPLET_ACCEPTANCE_CONFIRM_LIVE=1',
    'LOOPLET_ACCEPTANCE_RUN_ID=pilotgolive001',
    `LOOPLET_ACCEPTANCE_EVIDENCE_FILE=${join(rootDir, 'acceptance-only.json')}`,
    `LOOPLET_ACCEPTANCE_SUPABASE_URL=http://127.0.0.1:${port}`,
    'LOOPLET_ACCEPTANCE_SERVICE_ROLE_KEY=service_role_trial',
    `LOOPLET_ACCEPTANCE_ORG_ID=${trialOrgId}`,
    '',
  ].join('\n'));
  await writeFile(liveGuardEnvFile, [
    'LOOPLET_RECEIPT_WEBHOOK_URL=https://pos-live-guard.example.test/functions/v1/receipt-webhook',
    'LOOPLET_POS_API_KEY=llp_trial.secret',
    'LOOPLET_RECEIPT_IDENTITY_TOKEN=rhp_trial.receiptsecret',
    'LOOPLET_SYNC_TARGETS=xero',
    `LOOPLET_BRIDGE_QUEUE_FILE=${join(rootDir, 'live-guard-queue.jsonl')}`,
    `LOOPLET_BRIDGE_DEAD_LETTER_FILE=${join(rootDir, 'live-guard-dead.jsonl')}`,
    `LOOPLET_BRIDGE_INBOX_DIR=${inboxDir}`,
    `LOOPLET_BRIDGE_LOG_DIR=${logDir}`,
    `LOOPLET_READINESS_SAMPLE=${join(process.cwd(), installedBridgeRoot, 'sample-receipt.json')}`,
    'LOOPLET_READINESS_SKIP_NETWORK=1',
    'LOOPLET_ACCEPTANCE_RUN_ID=pilotgoliveguard001',
    `LOOPLET_ACCEPTANCE_EVIDENCE_FILE=${join(rootDir, 'live-guard-acceptance-only.json')}`,
    'LOOPLET_ACCEPTANCE_SUPABASE_URL=https://pos-live-guard.example.test',
    'LOOPLET_ACCEPTANCE_SERVICE_ROLE_KEY=service_role_trial',
    `LOOPLET_ACCEPTANCE_ORG_ID=${trialOrgId}`,
    '',
  ].join('\n'));
  const siteManifest = {
    business_name: 'Acme Pilot Trade Pty Ltd',
    merchant_name: 'Acme Field Trade Supplies',
    pilot_id: 'pilotgolive001',
    pilot_window_start: '2026-06-28T13:00:00+10:00',
    pilot_window_end: '2026-06-28T13:40:00+10:00',
    pos_vendor: 'Acme Field POS',
    pos_product: 'Looplet POS bridge fixture',
    pos_version: 'trial',
    connector_mode: 'bridge_watch_folder',
    identity_capture_method: 'barcode_scan',
    receipt_trigger: 'pos_completed_tender',
    receipt_source_format: 'pos_json_export',
    field_sample_capture_method: 'pos_native_json_export',
    integration_owner: 'Looplet test harness',
    install_machine_id: 'LOCAL-TRIAL',
    operator_name: 'Alex Pilot',
    operator_role: 'Test operator',
    looplet_organization_id: trialOrgId,
  };
  const fitProfile = {
    business_name: siteManifest.business_name,
    pos_vendor: siteManifest.pos_vendor,
    pos_product: siteManifest.pos_product,
    capabilities: {
      identity_capture_methods: [siteManifest.identity_capture_method],
      receipt_triggers: [siteManifest.receipt_trigger],
      json_export: true,
      itemised_lines: true,
      gst_breakdown: true,
      integer_cents: true,
      stable_event_id: true,
      payment_reference: true,
      refund_void_events: true,
      refund_void_original_reference: true,
      eftpos_only: false,
      bridge_machine: {
        available: true,
        node20_or_plugin_runtime: true,
        outbound_https: true,
        protected_secret_store: true,
      },
    },
  };
  await writeFile(siteFile, `${JSON.stringify(siteManifest, null, 2)}\n`);
  await writeFile(fitProfileFile, `${JSON.stringify(fitProfile, null, 2)}\n`);
  await writeFile(invalidSiteFile, `${JSON.stringify({
    ...siteManifest,
    business_name: 'Example Merchant Pty Ltd',
  }, null, 2)}\n`);
  await writeFile(mismatchedSiteFile, `${JSON.stringify({
    ...siteManifest,
    connector_mode: 'direct_webhook',
    receipt_source_format: 'pos_csv_export',
    field_sample_capture_method: 'pos_native_csv_export',
  }, null, 2)}\n`);

  const receiptEventsBeforeGoLivePreflight = receiptEvents.length;
  const goLivePreflightRun = await runNode([
    join(installedBridgeRoot, 'go-live.mjs'),
    '--preflight-only',
    '--env-file',
    envFile,
    '--site-file',
    siteFile,
    '--fit-profile',
    fitProfileFile,
    '--sale',
    fieldSaleFile,
    '--refund',
    fieldRefundFile,
    '--void',
    fieldVoidFile,
    '--output',
    preflightEvidenceFile,
  ], 0, staleLoopletEnv());
  const goLivePreflight = JSON.parse(goLivePreflightRun.stdout);
  const preflightEvidence = JSON.parse(await readFile(preflightEvidenceFile, 'utf8'));
  assert(goLivePreflight.ok === true, 'go-live preflight should pass with valid field files');
  assert(goLivePreflight.preflight_only === true, 'go-live preflight should report preflight_only');
  assert(goLivePreflight.summary.non_sending === true, 'go-live preflight should be non-sending');
  assert(goLivePreflight.summary.acceptance_skipped === true, 'go-live preflight should skip acceptance');
  assert(goLivePreflight.commands.verify_pilot_evidence.skipped === true, 'go-live preflight should skip strict evidence verifier');
  assert(preflightEvidence.non_sending === true, 'preflight evidence should be non-sending');
  assert(preflightEvidence.acceptance.skipped === true, 'preflight evidence should skip acceptance');
  assert(
    receiptEvents.length === receiptEventsBeforeGoLivePreflight,
    'go-live preflight must not persist acceptance receipts',
  );

  const goLiveRun = await runNode([
    join(installedBridgeRoot, 'go-live.mjs'),
    '--env-file',
    envFile,
    '--site-file',
    siteFile,
    '--fit-profile',
    fitProfileFile,
    '--sale',
    fieldSaleFile,
    '--refund',
    fieldRefundFile,
    '--void',
    fieldVoidFile,
    '--output',
    evidenceFile,
  ], 0, staleLoopletEnv());
  const goLive = JSON.parse(goLiveRun.stdout);
  const evidence = JSON.parse(await readFile(evidenceFile, 'utf8'));
  const verify = goLive.verifier;
  assert(goLive.ok === true, 'go-live runner should pass');
  assert(goLive.summary.acceptance_ok === true, 'go-live runner should prove acceptance');
  assert(goLive.summary.integration_fit_ok === true, 'go-live runner should prove integration fit');
  assert(goLive.summary.verifier_ok === true, 'go-live runner should prove verifier');
  assert(goLive.summary.verifier_integration_fit_ok === true, 'go-live verifier should prove integration fit');
  assert(goLive.summary.field_file_reconciliation_ok === true, 'go-live runner should prove field-file reconciliation');
  assert(goLive.summary.local_file_protection_ok === true, 'go-live runner should prove local bridge file protection');
  assert(goLive.summary.local_file_protection_checked_count > 0, 'go-live runner should count protected local files');
  assert(evidence.ok === true, 'pilot evidence should be ok');
  assert(evidence.readiness.ok === true, 'readiness should pass');
  assert(evidence.site.provided === true, 'site manifest should be included');
  assert(evidence.site.ok === true, 'site manifest should pass preflight validation');
  assert(evidence.integration_fit.provided === true, 'integration fit profile should be included');
  assert(evidence.integration_fit.ok === true, 'integration fit profile should pass');
  assert(evidence.integration_fit.recommendation.connector_mode === 'bridge_watch_folder', 'integration fit should recommend bridge watch folder');
  assert(evidence.field_samples.ok === true, 'field POS samples should pass');
  assert(evidence.status.scheduler.configured === true, 'status should include configured scheduler logs');
  assert(evidence.status.scheduler.ok === true, 'status scheduler should be healthy');
  assert(evidence.status.local_file_protection.ok === true, 'status should prove local file protection');
  assert(evidence.status.local_file_protection.checked_count > 0, 'status should check protected local files');
  assert(evidence.credential_probe.ok === true, 'credential probe should pass');
  assert(evidence.credential_probe.receipt_persisted === false, 'credential probe must not persist');
  assert(evidence.bridge_retry_drill.ok === true, 'bridge retry drill should pass');
  assert(evidence.bridge_retry_drill.queued_after_outage === true, 'bridge retry drill should prove outage queueing');
  assert(evidence.bridge_retry_drill.queue_flushed_after_recovery === true, 'bridge retry drill should prove recovery flush');
  assert(evidence.acceptance.ok === true, 'acceptance should pass');
  assert(evidence.acceptance.persistence.checked === true, 'acceptance persistence should be checked');
  assert(credentialProbeSeen === true, 'fake endpoint did not receive the credential probe');

  assert(verify.ok === true, 'verifier should accept go-live evidence');
  assert(verify.summary.field_file_reconciliation_requested === true, 'verifier should run field-file reconciliation');
  assert(verify.summary.field_file_reconciliation_ok === true, 'verifier should prove field-file reconciliation');
  assert(verify.field_file_reconciliation.matches.sale.ok === true, 'verifier should match sale field file');
  assert(verify.field_file_reconciliation.matches.refund.ok === true, 'verifier should match refund field file');
  assert(verify.field_file_reconciliation.matches.void.ok === true, 'verifier should match void field file');
  assert(verify.summary.readiness_bridge_files_ok === true, 'verifier summary should prove bridge files ready');
  assert(verify.summary.integration_fit_ok === true, 'verifier summary should prove integration fit');
  assert(verify.summary.integration_fit_matches_site === true, 'verifier summary should prove integration fit matches site');
  assert(verify.summary.integration_fit_identity_matches_site === true, 'verifier summary should prove integration fit business/POS identity matches site');
  assert(verify.summary.readiness_manifest_ok === true, 'verifier summary should prove installed manifest readiness');
  assert(verify.summary.readiness_network_ok === true, 'verifier summary should prove network readiness');
  assert(verify.summary.bridge_scheduler_ok === true, 'verifier summary should prove local bridge scheduler readiness');
  assert(verify.summary.local_file_protection_ok === true, 'verifier summary should prove local file protection');
  assert(verify.summary.local_file_protection_checked_count > 0, 'verifier summary should count protected local files');
  assert(verify.summary.bridge_retry_drill_ok === true, 'verifier summary should prove bridge retry drill readiness');
  assert(verify.summary.duplicate_same_event === true, 'verifier summary should prove duplicate idempotency');
  assert(verify.summary.idempotency_tax_mismatch_rejected === true, 'verifier summary should prove idempotency tax mismatch rejection');
  assert(verify.summary.idempotency_purchase_at_mismatch_rejected === true, 'verifier summary should prove idempotency purchase_at mismatch rejection');
  assert(verify.summary.site_manifest_ok === true, 'verifier summary should prove site manifest');
  assert(verify.summary.identity_capture_method === 'barcode_scan', 'verifier summary should include identity capture method');
  assert(verify.summary.receipt_trigger === 'pos_completed_tender', 'verifier summary should include receipt trigger');
  assert(verify.summary.receipt_source_format === 'pos_json_export', 'verifier summary should include receipt source format');
  assert(verify.summary.field_sample_capture_method === 'pos_native_json_export', 'verifier summary should include field sample capture method');
  assert(verify.summary.field_samples_ok === true, 'verifier summary should prove field samples');
  assert(verify.summary.field_samples_match_site_merchant === true, 'verifier summary should prove field samples match the site merchant');
  assert(verify.summary.field_samples_refund_void_link_sale === true, 'verifier summary should prove refund/void field samples link to the sale sample');
  assert(verify.summary.field_samples_within_pilot_window === true, 'verifier summary should prove field samples are inside the pilot window');
  assert(verify.summary.refund_linked === true, 'verifier summary should prove refund link');
  assert(verify.summary.refund_duplicate_same_event === true, 'verifier summary should prove refund duplicate idempotency');
  assert(verify.summary.void_linked === true, 'verifier summary should prove void link');
  assert(verify.summary.void_duplicate_same_event === true, 'verifier summary should prove void duplicate idempotency');
  assert(verify.summary.missing_payment_reference_rejected === true, 'verifier summary should prove missing payment reference rejection');
  assert(verify.summary.bad_payment_last4_rejected === true, 'verifier summary should prove full-card payment_last4 rejection');
  assert(verify.summary.missing_purchase_at_rejected === true, 'verifier summary should prove missing purchase_at rejection');
  assert(verify.summary.bad_purchase_at_rejected === true, 'verifier summary should prove bad purchase_at rejection');
  assert(verify.summary.api_request_log_ok === true, 'verifier summary should prove receipt-webhook API request logs');

  const reportRun = await runNode([
    join(installedBridgeRoot, 'pilot-report.mjs'),
    evidenceFile,
    '--output',
    reportFile,
    '--markdown',
    reportMarkdownFile,
  ], 0);
  const report = JSON.parse(reportRun.stdout);
  const writtenReport = JSON.parse(await readFile(reportFile, 'utf8'));
  const reportMarkdown = await readFile(reportMarkdownFile, 'utf8');
  assert(report.ok === true, 'pilot report should accept generated go-live evidence');
  assert(report.verdict === 'go-live-evidence-ready', 'pilot report should mark evidence ready');
  assert(report.api_request_log.key_prefix_matches === true, 'pilot report should prove API log key prefix');
  assert(report.field_samples.sale_refund_void_present === true, 'pilot report should prove sale/refund/void field samples');
  assert(writtenReport.ok === true, 'written pilot report should be ok');
  assert(reportMarkdown.includes('Verdict: go-live-evidence-ready'), 'pilot report markdown should include verdict');
  assert(!reportRun.stdout.includes('llp_trial.secret'), 'pilot report stdout must redact API key');
  assert(!reportRun.stdout.includes('rhp_trial.receiptsecret'), 'pilot report stdout must redact receipt token');
  assert(!reportMarkdown.includes('llp_trial.secret'), 'pilot report markdown must redact API key');
  assert(!reportMarkdown.includes('rhp_trial.receiptsecret'), 'pilot report markdown must redact receipt token');

  assert(!goLiveRun.stdout.includes('llp_trial.secret'), 'go-live stdout must redact API key');
  assert(!goLiveRun.stdout.includes('rhp_trial.receiptsecret'), 'go-live stdout must redact receipt token');
  assert(!JSON.stringify(evidence).includes('llp_trial.secret'), 'pilot evidence file must redact API key');
  assert(!JSON.stringify(evidence).includes('rhp_trial.receiptsecret'), 'pilot evidence file must redact receipt token');

  const receiptEventsBeforeMissingGoLiveArg = receiptEvents.length;
  const missingGoLiveArgRun = await runNode([
    join(installedBridgeRoot, 'go-live.mjs'),
    '--env-file',
    envFile,
    '--site-file',
    siteFile,
    '--fit-profile',
    fitProfileFile,
    '--sale',
    fieldSaleFile,
    '--refund',
    fieldRefundFile,
    '--output',
    join(rootDir, 'missing-void-go-live-evidence.json'),
  ], 1);
  const missingGoLiveArg = JSON.parse(missingGoLiveArgRun.stdout);
  assert(missingGoLiveArg.ok === false, 'go-live runner should reject missing field-file arguments');
  assert(
    missingGoLiveArg.failures.some((failure) => String(failure).includes('--void field sample is required')),
    'go-live runner should explain missing void field sample',
  );
  assert(
    receiptEvents.length === receiptEventsBeforeMissingGoLiveArg,
    'go-live missing-argument failure must not persist acceptance receipts',
  );

  await writeFieldSample(staleFieldSaleFile, 'examples/pos-bridge/sample-receipt.json', '2026-06-28T05:00:00.000Z');
  const receiptEventsBeforeStalePreflight = receiptEvents.length;
  const staleRun = await runNode([
    join(installedBridgeRoot, 'pilot-evidence.mjs'),
    '--env-file',
    envFile,
    '--site-file',
    siteFile,
    '--fit-profile',
    fitProfileFile,
    '--sale',
    staleFieldSaleFile,
    '--refund',
    fieldRefundFile,
    '--void',
    fieldVoidFile,
    '--acceptance',
  ], 1);
  const staleEvidence = JSON.parse(staleRun.stdout);
  const staleSale = staleEvidence.field_samples.samples.find((sample) => sample.event_type === 'sale');
  assert(staleEvidence.ok === false, 'stale field sample evidence should fail');
  assert(staleEvidence.field_samples.ok === false, 'stale field sample set should fail');
  assert(staleSale.ok === false, 'stale sale sample should fail');
  assert(staleSale.within_pilot_window === false, 'stale sale sample should be marked outside the pilot window');
  assert(
    staleSale.errors.includes('field POS sale sample purchase_at must fall within the pilot window'),
    'stale sale sample should explain the pilot-window failure',
  );
  assert(staleEvidence.acceptance.skipped === true, 'stale field sample must skip acceptance');
  assert(
    String(staleEvidence.acceptance.reason).includes('preflight validation'),
    'stale acceptance skip should explain preflight validation',
  );
  assert(
    receiptEvents.length === receiptEventsBeforeStalePreflight,
    'stale field sample preflight must not persist acceptance receipts',
  );

  const receiptEventsBeforeCrossMerchantPreflight = receiptEvents.length;
  const crossMerchantFieldRun = await runNode([
    join(installedBridgeRoot, 'pilot-evidence.mjs'),
    '--env-file',
    envFile,
    '--site-file',
    siteFile,
    '--fit-profile',
    fitProfileFile,
    '--sale',
    crossMerchantFieldSaleFile,
    '--refund',
    fieldRefundFile,
    '--void',
    fieldVoidFile,
    '--acceptance',
  ], 1);
  const crossMerchantFieldEvidence = JSON.parse(crossMerchantFieldRun.stdout);
  const crossMerchantSale = crossMerchantFieldEvidence.field_samples.samples.find((sample) => sample.event_type === 'sale');
  assert(crossMerchantFieldEvidence.ok === false, 'cross-merchant field sample evidence should fail');
  assert(crossMerchantFieldEvidence.field_samples.ok === false, 'cross-merchant field sample set should fail');
  assert(crossMerchantSale.merchant_name_matches_site === false, 'cross-merchant sale sample should not match the site merchant');
  assert(
    crossMerchantSale.errors.includes('field POS sale sample merchant.name must match the site manifest merchant_name'),
    'cross-merchant sale sample should explain the site merchant mismatch',
  );
  assert(crossMerchantFieldEvidence.acceptance.skipped === true, 'cross-merchant field sample must skip acceptance');
  assert(
    receiptEvents.length === receiptEventsBeforeCrossMerchantPreflight,
    'cross-merchant field sample preflight must not persist acceptance receipts',
  );

  const receiptEventsBeforeBadRefundOriginalPreflight = receiptEvents.length;
  const badRefundOriginalRun = await runNode([
    join(installedBridgeRoot, 'pilot-evidence.mjs'),
    '--env-file',
    envFile,
    '--site-file',
    siteFile,
    '--fit-profile',
    fitProfileFile,
    '--sale',
    fieldSaleFile,
    '--refund',
    badRefundOriginalFile,
    '--void',
    fieldVoidFile,
    '--acceptance',
  ], 1);
  const badRefundOriginalEvidence = JSON.parse(badRefundOriginalRun.stdout);
  const badRefund = badRefundOriginalEvidence.field_samples.samples.find((sample) => sample.event_type === 'refund');
  assert(badRefundOriginalEvidence.ok === false, 'bad refund original reference evidence should fail');
  assert(badRefundOriginalEvidence.field_samples.ok === false, 'bad refund original reference sample set should fail');
  assert(badRefund.original_reference_matches_sale === false, 'bad refund sample should not link to the sale sample');
  assert(
    badRefund.errors.includes('field POS refund sample original reference must match the sale field sample'),
    'bad refund sample should explain the sale-link failure',
  );
  assert(badRefundOriginalEvidence.acceptance.skipped === true, 'bad refund original reference must skip acceptance');
  assert(
    receiptEvents.length === receiptEventsBeforeBadRefundOriginalPreflight,
    'bad refund original reference preflight must not persist acceptance receipts',
  );

  const receiptEventsBeforeInvalidSitePreflight = receiptEvents.length;
  const invalidSiteRun = await runNode([
    join(installedBridgeRoot, 'pilot-evidence.mjs'),
    '--env-file',
    envFile,
    '--site-file',
    invalidSiteFile,
    '--fit-profile',
    fitProfileFile,
    '--sale',
    fieldSaleFile,
    '--refund',
    fieldRefundFile,
    '--void',
    fieldVoidFile,
    '--acceptance',
  ], 1);
  const invalidSiteEvidence = JSON.parse(invalidSiteRun.stdout);
  assert(invalidSiteEvidence.ok === false, 'invalid site manifest evidence should fail');
  assert(invalidSiteEvidence.site.ok === false, 'invalid site manifest should fail preflight');
  assert(
    invalidSiteEvidence.site.errors.some((error) => String(error).includes('business_name')),
    'invalid site manifest should explain the business_name failure',
  );
  assert(invalidSiteEvidence.acceptance.skipped === true, 'invalid site manifest must skip acceptance');
  assert(
    String(invalidSiteEvidence.acceptance.reason).includes('preflight validation'),
    'invalid site acceptance skip should explain preflight validation',
  );
  assert(
    receiptEvents.length === receiptEventsBeforeInvalidSitePreflight,
    'invalid site preflight must not persist acceptance receipts',
  );

  const receiptEventsBeforeMismatchedSitePreflight = receiptEvents.length;
  const mismatchedSiteRun = await runNode([
    join(installedBridgeRoot, 'pilot-evidence.mjs'),
    '--env-file',
    envFile,
    '--site-file',
    mismatchedSiteFile,
    '--fit-profile',
    fitProfileFile,
    '--sale',
    fieldSaleFile,
    '--refund',
    fieldRefundFile,
    '--void',
    fieldVoidFile,
    '--acceptance',
  ], 1);
  const mismatchedSiteEvidence = JSON.parse(mismatchedSiteRun.stdout);
  assert(mismatchedSiteEvidence.ok === false, 'mismatched connector/source site evidence should fail');
  assert(mismatchedSiteEvidence.site.ok === false, 'mismatched connector/source site should fail preflight');
  assert(
    mismatchedSiteEvidence.site.errors.some((error) => String(error).includes('not compatible with receipt_source_format')),
    'mismatched connector/source site should explain the compatibility failure',
  );
  assert(mismatchedSiteEvidence.acceptance.skipped === true, 'mismatched connector/source site must skip acceptance');
  assert(
    receiptEvents.length === receiptEventsBeforeMismatchedSitePreflight,
    'mismatched connector/source preflight must not persist acceptance receipts',
  );

  const receiptEventsBeforeMismatchedGoLive = receiptEvents.length;
  const mismatchedGoLiveRun = await runNode([
    join(installedBridgeRoot, 'go-live.mjs'),
    '--env-file',
    envFile,
    '--site-file',
    mismatchedSiteFile,
    '--fit-profile',
    fitProfileFile,
    '--sale',
    fieldSaleFile,
    '--refund',
    fieldRefundFile,
    '--void',
    fieldVoidFile,
    '--output',
    join(rootDir, 'mismatched-go-live-evidence.json'),
  ], 1);
  const mismatchedGoLive = JSON.parse(mismatchedGoLiveRun.stdout);
  assert(mismatchedGoLive.ok === false, 'go-live runner should fail mismatched connector/source site');
  assert(mismatchedGoLive.commands.pilot_evidence.ok === false, 'go-live runner should expose failed pilot evidence command');
  assert(mismatchedGoLive.commands.verify_pilot_evidence.skipped === true, 'go-live runner should skip verifier after failed evidence collection');
  assert(
    receiptEvents.length === receiptEventsBeforeMismatchedGoLive,
    'go-live mismatched connector/source failure must not persist acceptance receipts',
  );

  const receiptEventsBeforeLiveGuard = receiptEvents.length;
  const liveGuardRun = await runNode([
    join(installedBridgeRoot, 'go-live.mjs'),
    '--env-file',
    liveGuardEnvFile,
    '--site-file',
    siteFile,
    '--fit-profile',
    fitProfileFile,
    '--sale',
    fieldSaleFile,
    '--refund',
    fieldRefundFile,
    '--void',
    fieldVoidFile,
    '--output',
    join(rootDir, 'live-guard-go-live-evidence.json'),
  ], 1);
  const liveGuardGoLive = JSON.parse(liveGuardRun.stdout);
  assert(liveGuardGoLive.ok === false, 'go-live runner should fail non-local acceptance without explicit confirmation');
  assert(liveGuardGoLive.commands.pilot_evidence.ok === false, 'go-live runner should expose failed live-guard evidence command');
  assert(liveGuardGoLive.commands.verify_pilot_evidence.skipped === true, 'go-live runner should skip verifier after live-guard failure');
  assert(
    JSON.stringify(liveGuardGoLive).includes('LOOPLET_ACCEPTANCE_CONFIRM_LIVE=1'),
    'go-live live guard should explain the missing LOOPLET_ACCEPTANCE_CONFIRM_LIVE=1 safety confirmation',
  );
  assert(
    receiptEvents.length === receiptEventsBeforeLiveGuard,
    'go-live live-guard failure must not persist acceptance receipts',
  );

  console.log(JSON.stringify({
    ok: true,
    evidence_file: evidenceFile,
    readiness_ok: evidence.readiness.ok,
    credential_probe_ok: evidence.credential_probe.ok,
    acceptance_ok: evidence.acceptance.ok,
    pilot_report_ok: report.ok,
    go_live_ok: goLive.ok,
    verifier_ok: verify.ok,
    integration_fit_ok: verify.summary.integration_fit_ok,
    integration_fit_matches_site: verify.summary.integration_fit_matches_site,
    integration_fit_identity_matches_site: verify.summary.integration_fit_identity_matches_site,
    readiness_bridge_files_ok: verify.summary.readiness_bridge_files_ok,
    readiness_manifest_ok: verify.summary.readiness_manifest_ok,
    readiness_network_ok: verify.summary.readiness_network_ok,
    bridge_scheduler_ok: verify.summary.bridge_scheduler_ok,
    local_file_protection_ok: verify.summary.local_file_protection_ok,
    local_file_protection_checked_count: verify.summary.local_file_protection_checked_count,
    bridge_retry_drill_ok: verify.summary.bridge_retry_drill_ok,
    site_manifest_ok: verify.summary.site_manifest_ok,
    identity_capture_method: verify.summary.identity_capture_method,
    receipt_trigger: verify.summary.receipt_trigger,
    receipt_source_format: verify.summary.receipt_source_format,
    field_sample_capture_method: verify.summary.field_sample_capture_method,
    field_samples_ok: verify.summary.field_samples_ok,
    field_samples_match_site_merchant: verify.summary.field_samples_match_site_merchant,
    field_samples_refund_void_link_sale: verify.summary.field_samples_refund_void_link_sale,
    field_samples_within_pilot_window: verify.summary.field_samples_within_pilot_window,
    field_file_reconciliation_ok: verify.summary.field_file_reconciliation_ok,
    duplicate_same_event: verify.summary.duplicate_same_event,
    idempotency_tax_mismatch_rejected: verify.summary.idempotency_tax_mismatch_rejected,
    idempotency_purchase_at_mismatch_rejected: verify.summary.idempotency_purchase_at_mismatch_rejected,
    refund_linked: verify.summary.refund_linked,
    refund_duplicate_same_event: verify.summary.refund_duplicate_same_event,
    void_linked: verify.summary.void_linked,
    void_duplicate_same_event: verify.summary.void_duplicate_same_event,
    missing_payment_reference_rejected: verify.summary.missing_payment_reference_rejected,
    bad_payment_last4_rejected: verify.summary.bad_payment_last4_rejected,
    missing_purchase_at_rejected: verify.summary.missing_purchase_at_rejected,
    bad_purchase_at_rejected: verify.summary.bad_purchase_at_rejected,
    api_request_log_ok: verify.summary.api_request_log_ok,
    go_live_preflight_ok: goLivePreflight.ok,
    go_live_preflight_non_sending: goLivePreflight.summary.non_sending,
    pilot_report_api_log_key_prefix_matches: report.api_request_log.key_prefix_matches,
    pilot_report_markdown_written: reportMarkdown.includes('Verdict: go-live-evidence-ready'),
    persistence_checked: verify.summary.persistence_checked,
    secrets_redacted: true,
    stale_field_sample_rejected_before_acceptance: true,
    cross_merchant_field_sample_rejected_before_acceptance: true,
    bad_refund_original_rejected_before_acceptance: true,
    invalid_site_rejected_before_acceptance: true,
    mismatched_connector_source_rejected_before_acceptance: true,
    go_live_missing_field_arg_rejected_before_acceptance: true,
    go_live_mismatched_connector_source_rejected_before_acceptance: true,
    go_live_non_local_requires_confirmation: true,
    go_live_env_file_overrode_stale_environment: true,
  }, null, 2));
} finally {
  server.close();
}

async function writeFieldSample(
  targetFile,
  sourceFile,
  purchaseAt = null,
  merchantName = 'Acme Field Trade Supplies',
  originalReceiptNumber = 'FIELD-SALE-PILOT-001',
  originalExternalEventId = 'field-sale-evt-pilotgolive001',
) {
  const receipt = JSON.parse(await readFile(sourceFile, 'utf8'));
  const eventType = receipt.event_type ?? receipt.payload?.receipt?.event_type ?? 'sale';
  const eventCode = {
    sale: 'SALE',
    refund: 'REFUND',
    void: 'VOID',
  }[eventType] ?? String(eventType).toUpperCase();
  const externalEventId = `field-${eventType}-evt-pilotgolive001`;

  receipt.idempotency_key = externalEventId;
  receipt.identity_token = 'rhp_trial.receiptsecret';
  receipt.payload.merchant.name = merchantName;
  receipt.payload.merchant.external_id = 'acme-field-store-017';
  receipt.payload.receipt.number = `FIELD-${eventCode}-PILOT-001`;
  receipt.payload.receipt.external_event_id = externalEventId;
  receipt.payload.receipt.payment_reference = `field-${eventType}-payment-pilotgolive001`;
  receipt.payload.receipt.terminal_id = 'FIELD-TERM-04';
  receipt.payload.receipt.store_id = 'FIELD-STORE-017';
  receipt.payload.receipt.location = {
    store: 'Acme Field Trade Desk',
    suburb: 'Southport',
  };
  if (eventType !== 'sale') {
    receipt.payload.receipt.original_receipt_number = originalReceiptNumber;
    receipt.payload.receipt.original_external_event_id = originalExternalEventId;
  }
  if (purchaseAt) receipt.payload.receipt.purchase_at = purchaseAt;
  await writeFile(targetFile, `${JSON.stringify(receipt, null, 2)}\n`);
}

function handleReceiptPost(req, res, body) {
  res.once('finish', () => {
    recordReceiptApiRequest(req, res.statusCode);
  });

  if (req.headers.authorization !== 'Bearer llp_trial.secret') {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'invalid_api_key' }));
    return;
  }

  try {
    const parsed = JSON.parse(body);
    assert(req.method === 'POST', 'method must be POST');
    if (req.headers['idempotency-key'] !== parsed.idempotency_key) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Idempotency-Key header must match body idempotency_key' }));
      return;
    }

    if (parsed.identity_token !== 'rhp_trial.receiptsecret') {
      credentialProbeSeen ||= parsed.identity_token === 'rhp_probe.invalid';
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'receipt identity not found or inactive' }));
      return;
    }

    const merchantName = parsed.payload?.merchant?.name;
    if (typeof merchantName !== 'string' || merchantName.trim().length < 2) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'merchant.name required for POS receipt ingestion' }));
      return;
    }

    if (!parsed.payload.receipt.payment_reference) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'receipt.payment_reference required for POS receipt ingestion' }));
      return;
    }

    const purchaseAt = parsed.payload.receipt.purchase_at;
    if (typeof purchaseAt !== 'string' || purchaseAt.trim().length === 0) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'receipt.purchase_at required for POS receipt ingestion' }));
      return;
    }
    if (Number.isNaN(new Date(purchaseAt).getTime())) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'receipt.purchase_at must be a valid date-time' }));
      return;
    }
    parsed.payload.receipt.purchase_at = new Date(purchaseAt).toISOString();

    if (String(parsed.payload.receipt.payment_last4 ?? '').replace(/\D/g, '').length > 4) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'receipt.payment_last4 must not contain a full card number' }));
      return;
    }

    if (!parsed.payload.receipt.tender_status || parsed.payload.receipt.tender_status === 'pending') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'receipt tender_status must be final' }));
      return;
    }

    const lineTotal = parsed.payload.line_items.reduce((sum, line) => sum + line.total_inc_gst_cents, 0);
    if (lineTotal !== parsed.payload.receipt.total_inc_gst_cents) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'line_items total must match receipt.total_inc_gst_cents' }));
      return;
    }

    const gst = parsed.payload.receipt.gst_cents;
    const subtotal = parsed.payload.receipt.subtotal_ex_gst_cents;
    if (gst == null || subtotal == null) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'receipt.gst_cents and receipt.subtotal_ex_gst_cents required for POS receipt ingestion' }));
      return;
    }
    if (gst != null && subtotal != null && Math.abs(Number(gst) + Number(subtotal) - parsed.payload.receipt.total_inc_gst_cents) > 1) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'receipt subtotal + GST must match receipt.total_inc_gst_cents' }));
      return;
    }
    const lineGst = parsed.payload.line_items.reduce((sum, line) => sum + Number(line.gst_cents ?? 0), 0);
    if (lineGst !== parsed.payload.receipt.gst_cents) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'line_items GST total must match receipt.gst_cents' }));
      return;
    }

    if (
      parsed.event_type !== 'sale' &&
      !parsed.payload.receipt.original_receipt_number &&
      !parsed.payload.receipt.original_external_event_id
    ) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'refund/void receipts require original_receipt_number or original_external_event_id' }));
      return;
    }

    if (parsed.event_type !== 'sale') {
      const originalReceiptNumber = parsed.payload.receipt.original_receipt_number;
      const originalExternalEventId = parsed.payload.receipt.original_external_event_id;
      if (originalReceiptNumber !== saleReceiptNumber && originalExternalEventId !== saleOriginalExternalEventId) {
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
        const taxMismatch = prior.receipt_number === parsed.payload.receipt.number &&
          prior.total_inc_gst_cents === parsed.payload.receipt.total_inc_gst_cents &&
          (
            prior.subtotal_ex_gst_cents !== parsed.payload.receipt.subtotal_ex_gst_cents ||
            prior.gst_cents !== parsed.payload.receipt.gst_cents
          );
        const purchaseAtMismatch = prior.receipt_number === parsed.payload.receipt.number &&
          prior.total_inc_gst_cents === parsed.payload.receipt.total_inc_gst_cents &&
          prior.subtotal_ex_gst_cents === parsed.payload.receipt.subtotal_ex_gst_cents &&
          prior.gst_cents === parsed.payload.receipt.gst_cents &&
          prior.purchase_at !== parsed.payload.receipt.purchase_at;
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: taxMismatch
            ? 'idempotency key reused with different receipt payload fields: receipt.subtotal_ex_gst_cents, receipt.gst_cents'
            : purchaseAtMismatch
              ? 'idempotency key reused with different receipt payload fields: receipt.purchase_at'
            : 'idempotency key reused with different receipt payload fields',
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

    const receiptEventId = `pilot-${parsed.event_type}-${seen.size + 1}`;
    const result = {
      ok: true,
      duplicate: false,
      event_type: parsed.event_type,
      receipt_event_id: receiptEventId,
      related_receipt_event_id: parsed.event_type === 'sale' ? null : saleEventId,
      bill_id: parsed.event_type === 'sale' ? `bill-${seen.size + 1}` : null,
      receipt_number: parsed.payload.receipt.number,
      purchase_at: parsed.payload.receipt.purchase_at,
      subtotal_ex_gst_cents: parsed.payload.receipt.subtotal_ex_gst_cents,
      gst_cents: parsed.payload.receipt.gst_cents,
      total_inc_gst_cents: parsed.payload.receipt.total_inc_gst_cents,
      payment_reference: parsed.payload.receipt.payment_reference,
      payment_last4: parsed.payload.receipt.payment_last4,
      sync_jobs: parsed.event_type === 'sale'
        ? [{ id: `sync-${seen.size + 1}`, provider: 'xero', status: 'pending' }]
        : [],
    };
    if (parsed.event_type === 'sale') {
      saleEventId = receiptEventId;
      saleReceiptNumber = parsed.payload.receipt.number;
      saleOriginalExternalEventId = parsed.payload.receipt.external_event_id;
    }
    seen.set(parsed.idempotency_key, result);
    persistAcceptedReceipt(parsed, result);

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  }
}

function recordReceiptApiRequest(req, status) {
  const authHeader = String(req.headers.authorization ?? '');
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7) : '';
  const keyPrefix = bearer ? bearer.split('.')[0] : null;
  apiRequestLogs.push({
    organization_id: keyPrefix === 'llp_trial' ? trialOrgId : null,
    endpoint: 'receipt-webhook',
    method: req.method,
    ingest_type: 'receipt',
    status,
    key_prefix: keyPrefix,
  });
}

function persistAcceptedReceipt(parsed, result) {
  receiptEvents.push({
    id: result.receipt_event_id,
    organization_id: trialOrgId,
    event_type: parsed.event_type,
    idempotency_key: `explicit:${parsed.idempotency_key}`,
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
      receipt_event_id: result.receipt_event_id,
      total_inc_gst_cents: line.total_inc_gst_cents,
      gst_cents: line.gst_cents,
    });
  }

  receiptAuditPackages.push({
    id: `audit-${receiptAuditPackages.length + 1}`,
    receipt_event_id: result.receipt_event_id,
    bill_id: result.bill_id,
    gst_status: 'supplied',
    deductibility_status: parsed.payload.classification?.deductibility ?? 'requires_review',
  });

  for (const job of result.sync_jobs) {
    receiptSyncJobs.push({
      ...job,
      receipt_event_id: result.receipt_event_id,
      bill_id: result.bill_id,
    });
  }
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
  const rowsByTable = {
    receipt_events: receiptEvents,
    receipt_event_line_items: receiptEventLineItems,
    receipt_audit_packages: receiptAuditPackages,
    receipt_sync_jobs: receiptSyncJobs,
    api_request_log: apiRequestLogs,
  };
  const rows = rowsByTable[table];
  if (!rows) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'unknown_table' }));
    return;
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(applyFilters(rows, url.searchParams)));
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

async function runNode(args, expectedCode, extraEnv = {}) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...cleanLoopletEnv(), ...extraEnv },
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
    throw new Error(`${args[0]} exited ${code}, expected ${expectedCode}\nstdout=${stdout}\nstderr=${stderr}`);
  }
  return { stdout, stderr };
}

async function runPowerShell(args, expectedCode, extraEnv = {}) {
  const child = spawn('powershell', args, {
    cwd: process.cwd(),
    env: { ...cleanLoopletEnv(), ...extraEnv },
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
    throw new Error(`powershell ${args.join(' ')} exited ${code}, expected ${expectedCode}\nstdout=${stdout}\nstderr=${stderr}`);
  }
  return { stdout, stderr };
}

async function writeSchedulerLog(dir, options) {
  await mkdir(dir, { recursive: true });
  const iso = options.timestamp.toISOString();
  const day = iso.slice(0, 10);
  await writeFile(join(dir, `bridge-${day}.log`), [
    `${iso} watch_once_start bridge=bridge.mjs inbox=${inboxDir}`,
    `${iso} watch_once_processed ${options.processed}`,
    `${iso} watch_once_end exit_code=${options.exitCode}`,
    '',
  ].join('\n'));
  await protectFile(join(dir, `bridge-${day}.log`));
}

async function protectFile(file) {
  if (process.platform !== 'win32') {
    await chmod(file, 0o600);
    return;
  }

  const script = `
$ErrorActionPreference = 'Stop'
$path = (Resolve-Path -LiteralPath $env:LOOPLET_PROTECTED_FILE).Path
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$administrators = ([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')).Translate([System.Security.Principal.NTAccount]).Value
$system = ([System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')).Translate([System.Security.Principal.NTAccount]).Value
$principals = @($currentUser, $administrators, $system) | Select-Object -Unique
$security = [System.Security.AccessControl.FileSecurity]::new()
foreach ($principal in $principals) {
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $principal,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.InheritanceFlags]::None,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  $security.AddAccessRule($rule)
}
$security.SetAccessRuleProtection($true, $false)
[System.IO.File]::SetAccessControl($path, $security)
`;
  await runPowerShell(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], 0, {
    LOOPLET_PROTECTED_FILE: file,
  });
}

function cleanLoopletEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('LOOPLET_')) delete env[key];
  }
  return env;
}

function staleLoopletEnv() {
  return {
    LOOPLET_RECEIPT_WEBHOOK_URL: 'https://stale-pos.example.test/functions/v1/receipt-webhook',
    LOOPLET_POS_API_KEY: 'llp_stale.wrong',
    LOOPLET_RECEIPT_IDENTITY_TOKEN: 'rhp_stale.wrong',
    LOOPLET_SYNC_TARGETS: 'stale',
    LOOPLET_BRIDGE_QUEUE_FILE: 'stale-queue.jsonl',
    LOOPLET_BRIDGE_DEAD_LETTER_FILE: 'stale-dead.jsonl',
    LOOPLET_BRIDGE_INBOX_DIR: 'stale-inbox',
    LOOPLET_BRIDGE_LOG_DIR: 'stale-logs',
    LOOPLET_ACCEPTANCE_CONFIRM_LIVE: '0',
    LOOPLET_ACCEPTANCE_RUN_ID: 'stale-run',
    LOOPLET_ACCEPTANCE_SUPABASE_URL: 'https://stale-pos.example.test',
    LOOPLET_ACCEPTANCE_SERVICE_ROLE_KEY: 'stale-service-role',
    LOOPLET_ACCEPTANCE_ORG_ID: '99999999-9999-4999-8999-999999999999',
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
