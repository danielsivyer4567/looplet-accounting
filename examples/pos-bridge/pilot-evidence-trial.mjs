#!/usr/bin/env node
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';

const rootDir = '.claude/scratch/pos-pilot-evidence-trial';
const envFile = join(rootDir, 'pilot.env');
const evidenceFile = join(rootDir, 'evidence.json');
const preflightEvidenceFile = join(rootDir, 'preflight-evidence.json');
const badSiteEvidenceFile = join(rootDir, 'bad-site-evidence.json');
const badFitEvidenceFile = join(rootDir, 'bad-fit-evidence.json');
const badFieldEvidenceFile = join(rootDir, 'bad-field-evidence.json');
const crossMerchantEvidenceFile = join(rootDir, 'cross-merchant-field-evidence.json');
const inboxDir = join(rootDir, 'inbox');
const siteFile = join(rootDir, 'pos-pilot-site.json');
const badSiteFile = join(rootDir, 'pos-pilot-site-placeholder.json');
const fitProfileFile = join(rootDir, 'pos-integration-fit.json');
const badFitProfileFile = join(rootDir, 'pos-integration-fit-eftpos-only.json');
const fieldSaleFile = join(rootDir, 'field-sale.json');
const fieldRefundFile = join(rootDir, 'field-refund.json');
const fieldVoidFile = join(rootDir, 'field-void.json');
const staleFieldSaleFile = join(rootDir, 'field-sale-stale.json');
const crossMerchantSaleFile = join(rootDir, 'field-sale-cross-merchant.json');
const badRefundOriginalFile = join(rootDir, 'field-refund-bad-original.json');
const trialOrgId = '22222222-2222-4222-8222-222222222222';

await rm(rootDir, { recursive: true, force: true });
await mkdir(inboxDir, { recursive: true });
await writeFile(envFile, [
  'LOOPLET_RECEIPT_WEBHOOK_URL=http://127.0.0.1:55321/functions/v1/receipt-webhook',
  'LOOPLET_POS_API_KEY=llp_trial.secret',
  'LOOPLET_RECEIPT_IDENTITY_TOKEN=rhp_trial.receiptsecret',
  'LOOPLET_SYNC_TARGETS=xero,myob',
  `LOOPLET_BRIDGE_QUEUE_FILE=${join(rootDir, 'queue.jsonl')}`,
  `LOOPLET_BRIDGE_DEAD_LETTER_FILE=${join(rootDir, 'dead.jsonl')}`,
  `LOOPLET_BRIDGE_INBOX_DIR=${inboxDir}`,
  `LOOPLET_READINESS_SAMPLE=${join(process.cwd(), 'examples/pos-bridge/sample-receipt.json')}`,
  'LOOPLET_READINESS_SKIP_NETWORK=1',
  '',
].join('\n'));
await protectFile(envFile);
const siteManifest = {
  business_name: 'Acme Pilot Trade Pty Ltd',
  merchant_name: 'Acme Field Trade Supplies',
  pilot_id: 'pilotpreflight001',
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
  install_machine_id: 'LOCAL-PREFLIGHT-TRIAL',
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
await writeFile(badSiteFile, `${JSON.stringify({
  ...siteManifest,
  business_name: 'Example Merchant Pty Ltd',
}, null, 2)}\n`);
await writeFile(fitProfileFile, `${JSON.stringify(fitProfile, null, 2)}\n`);
await writeFile(badFitProfileFile, `${JSON.stringify({
  business_name: siteManifest.business_name,
  pos_vendor: siteManifest.pos_vendor,
  capabilities: {
    eftpos_only: true,
    itemised_lines: false,
    gst_breakdown: false,
    integer_cents: true,
    stable_event_id: false,
    payment_reference: false,
    refund_void_events: false,
    refund_void_original_reference: false,
  },
}, null, 2)}\n`);
await writeFieldSample(fieldSaleFile, 'examples/pos-bridge/sample-receipt.json');
await writeFieldSample(fieldRefundFile, 'examples/pos-bridge/sample-refund.json');
await writeFieldSample(fieldVoidFile, 'examples/pos-bridge/sample-void.json');
await writeFieldSample(staleFieldSaleFile, 'examples/pos-bridge/sample-receipt.json', '2026-06-28T05:00:00.000Z');
await writeFieldSample(crossMerchantSaleFile, 'examples/pos-bridge/sample-receipt.json', null, 'Other Store Pty Ltd');
await writeFieldSample(
  badRefundOriginalFile,
  'examples/pos-bridge/sample-refund.json',
  null,
  siteManifest.merchant_name,
  'OTHER-SALE-001',
  'other-sale-evt-001',
);

const run = await runPilotEvidence(envFile, evidenceFile);
const emitted = JSON.parse(run.stdout);
const written = JSON.parse(await readFile(evidenceFile, 'utf8'));

assert(emitted.ok === true, 'pilot evidence should be ok');
assert(written.ok === true, 'written evidence should be ok');
assert(emitted.non_sending === true, 'default pilot evidence should not send receipts');
assert(emitted.readiness.ok === true, 'readiness evidence missing');
assert(emitted.status.ok === true, 'status evidence missing');
assert(emitted.status.local_file_protection.ok === true, 'status evidence should prove local file protection');
assert(emitted.status.local_file_protection.checked_count > 0, 'status evidence should count protected local files');
assert(emitted.site.provided === false, 'preflight pilot evidence should not require a site manifest');
assert(emitted.credential_probe.skipped === true, 'credential probe should skip when network is skipped');
assert(
  emitted.credential_probe_non_persistent === false,
  'credential probe should not be marked sent when skipped',
);
assert(emitted.samples.length === 3, 'sample validation count mismatch');
assert(emitted.samples.every((sample) => sample.ok === true), 'all sample contracts should validate');
assert(emitted.field_samples.provided === false, 'preflight pilot evidence should not require field POS samples');
assert(emitted.acceptance.skipped === true, 'acceptance should be skipped unless requested');
assert(!run.stdout.includes('llp_trial.secret'), 'pilot evidence must not print POS API key');
assert(!run.stdout.includes('rhp_trial.receiptsecret'), 'pilot evidence must not print receipt identity token');
assert(!JSON.stringify(written).includes('llp_trial.secret'), 'written evidence must not contain POS API key');
assert(!JSON.stringify(written).includes('rhp_trial.receiptsecret'), 'written evidence must not contain receipt identity token');

const preflightRun = await runPilotEvidence(envFile, preflightEvidenceFile, [
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
]);
const preflight = JSON.parse(preflightRun.stdout);
assert(preflight.ok === true, 'valid non-sending preflight evidence should pass');
assert(preflight.non_sending === true, 'valid preflight must not run acceptance');
assert(preflight.site.ok === true, 'valid preflight should prove site manifest');
assert(preflight.integration_fit.ok === true, 'valid preflight should prove integration fit');
assert(preflight.field_samples.ok === true, 'valid preflight should prove field samples');
assert(preflight.bridge_retry_drill.ok === true, 'valid bridge preflight should prove retry drill');
assert(preflight.acceptance.skipped === true, 'valid preflight should skip acceptance without --acceptance');

const badSiteRun = await runPilotEvidence(envFile, badSiteEvidenceFile, [
  '--site-file',
  badSiteFile,
  '--fit-profile',
  fitProfileFile,
  '--sale',
  fieldSaleFile,
  '--refund',
  fieldRefundFile,
  '--void',
  fieldVoidFile,
], 1);
const badSite = JSON.parse(badSiteRun.stdout);
assert(badSite.ok === false, 'supplied bad site manifest should fail non-sending evidence');
assert(badSite.site.ok === false, 'bad site manifest should be marked failed');
assert(
  badSite.site.errors.some((error) => String(error).includes('business_name')),
  'bad site manifest should explain the business_name failure',
);
assert(badSite.acceptance.skipped === true, 'bad site preflight should not send acceptance receipts');

const badFitRun = await runPilotEvidence(envFile, badFitEvidenceFile, [
  '--site-file',
  siteFile,
  '--fit-profile',
  badFitProfileFile,
  '--sale',
  fieldSaleFile,
  '--refund',
  fieldRefundFile,
  '--void',
  fieldVoidFile,
], 1);
const badFit = JSON.parse(badFitRun.stdout);
assert(badFit.ok === false, 'supplied EFTPOS-only fit profile should fail non-sending evidence');
assert(badFit.integration_fit.ok === false, 'bad fit profile should be marked failed');
assert(
  badFit.integration_fit.blockers.some((blocker) => String(blocker).includes('EFTPOS-only')),
  'bad fit profile should explain why EFTPOS-only data is not enough',
);
assert(badFit.acceptance.skipped === true, 'bad fit preflight should not send acceptance receipts');

const badFieldRun = await runPilotEvidence(envFile, badFieldEvidenceFile, [
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
], 1);
const badField = JSON.parse(badFieldRun.stdout);
const staleSale = badField.field_samples.samples.find((sample) => sample.event_type === 'sale');
assert(badField.ok === false, 'supplied stale field sample should fail non-sending evidence');
assert(badField.field_samples.ok === false, 'bad field sample set should be marked failed');
assert(staleSale.within_pilot_window === false, 'stale sale sample should be outside the pilot window');
assert(
  staleSale.errors.includes('field POS sale sample purchase_at must fall within the pilot window'),
  'stale field sample should explain the pilot-window failure',
);
assert(badField.acceptance.skipped === true, 'bad field preflight should not send acceptance receipts');

const crossMerchantRun = await runPilotEvidence(envFile, crossMerchantEvidenceFile, [
  '--site-file',
  siteFile,
  '--fit-profile',
  fitProfileFile,
  '--sale',
  crossMerchantSaleFile,
  '--refund',
  fieldRefundFile,
  '--void',
  fieldVoidFile,
], 1);
const crossMerchant = JSON.parse(crossMerchantRun.stdout);
const crossMerchantSale = crossMerchant.field_samples.samples.find((sample) => sample.event_type === 'sale');
assert(crossMerchant.ok === false, 'cross-merchant field sample should fail non-sending evidence');
assert(crossMerchant.field_samples.ok === false, 'cross-merchant field sample set should be marked failed');
assert(crossMerchantSale.merchant_name_matches_site === false, 'cross-merchant sale should be marked as not matching the site merchant');
assert(
  crossMerchantSale.errors.includes('field POS sale sample merchant.name must match the site manifest merchant_name'),
  'cross-merchant field sample should explain the site merchant mismatch',
);
assert(crossMerchant.acceptance.skipped === true, 'cross-merchant preflight should not send acceptance receipts');

const badRefundOriginalRun = await runPilotEvidence(envFile, join(rootDir, 'bad-refund-original-evidence.json'), [
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
], 1);
const badRefundOriginal = JSON.parse(badRefundOriginalRun.stdout);
const badRefund = badRefundOriginal.field_samples.samples.find((sample) => sample.event_type === 'refund');
assert(badRefundOriginal.ok === false, 'bad refund original reference should fail non-sending evidence');
assert(badRefundOriginal.field_samples.ok === false, 'bad refund original sample set should be marked failed');
assert(badRefund.original_reference_matches_sale === false, 'bad refund should be marked as not linking to the sale sample');
assert(
  badRefund.errors.includes('field POS refund sample original reference must match the sale field sample'),
  'bad refund original reference should explain the sale-link failure',
);
assert(badRefundOriginal.acceptance.skipped === true, 'bad refund original preflight should not send acceptance receipts');

console.log(JSON.stringify({
  ok: true,
  evidence_file: evidenceFile,
  preflight_evidence_file: preflightEvidenceFile,
  readiness_ok: emitted.readiness.ok,
  status_ok: emitted.status.ok,
  local_file_protection_ok: emitted.status.local_file_protection.ok,
  local_file_protection_checked_count: emitted.status.local_file_protection.checked_count,
  credential_probe_skipped: emitted.credential_probe.skipped,
  sample_count: emitted.samples.length,
  acceptance_skipped: emitted.acceptance.skipped,
  non_sending: emitted.non_sending,
  supplied_artifacts_preflight_ok: preflight.ok,
  bad_site_rejected_without_acceptance: badSite.ok === false,
  bad_fit_rejected_without_acceptance: badFit.ok === false,
  bad_field_sample_rejected_without_acceptance: badField.ok === false,
  cross_merchant_field_sample_rejected_without_acceptance: crossMerchant.ok === false,
  bad_refund_original_rejected_without_acceptance: badRefundOriginal.ok === false,
  secrets_redacted: true,
}, null, 2));

async function runPilotEvidence(file, output, extraArgs = [], expectedCode = 0) {
  const child = spawn(process.execPath, [
    'examples/pos-bridge/pilot-evidence.mjs',
    '--env-file',
    file,
    '--output',
    output,
    '--skip-network',
    ...extraArgs,
  ], {
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
    throw new Error(`pilot evidence exited ${code}, expected ${expectedCode}\nstdout=${stdout}\nstderr=${stderr}`);
  }
  return { stdout, stderr };
}

async function writeFieldSample(
  targetFile,
  sourceFile,
  purchaseAt = null,
  merchantName = siteManifest.merchant_name,
  originalReceiptNumber = 'PREFLIGHT-SALE-001',
  originalExternalEventId = 'preflight-sale-evt-001',
) {
  const receipt = JSON.parse(await readFile(sourceFile, 'utf8'));
  const eventType = receipt.event_type ?? receipt.payload?.receipt?.event_type ?? 'sale';
  const eventCode = {
    sale: 'SALE',
    refund: 'REFUND',
    void: 'VOID',
  }[eventType] ?? String(eventType).toUpperCase();
  const externalEventId = `preflight-${eventType}-evt-001`;

  receipt.idempotency_key = externalEventId;
  receipt.identity_token = 'rhp_trial.receiptsecret';
  receipt.payload.merchant.name = merchantName;
  receipt.payload.merchant.external_id = 'acme-preflight-store-017';
  receipt.payload.receipt.number = `PREFLIGHT-${eventCode}-001`;
  receipt.payload.receipt.external_event_id = externalEventId;
  receipt.payload.receipt.payment_reference = `preflight-${eventType}-payment-001`;
  receipt.payload.receipt.terminal_id = 'PREFLIGHT-TERM-04';
  receipt.payload.receipt.store_id = 'PREFLIGHT-STORE-017';
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
  const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    cwd: process.cwd(),
    env: { ...process.env, LOOPLET_PROTECTED_FILE: file },
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
  if (code !== 0) {
    throw new Error(`protectFile exited ${code}\nstdout=${stdout}\nstderr=${stderr}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
