#!/usr/bin/env node
import assert from 'node:assert/strict';
import { rm, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const rootDir = join('.claude', 'scratch', 'pos-field-sample-capture-trial');
const siteFile = join(rootDir, 'pos-pilot-site.json');
const rawDir = join(rootDir, 'raw');
const outputDir = join(rootDir, 'staged');
const saleFile = join(rawDir, 'raw-sale.json');
const refundFile = join(rawDir, 'raw-refund.json');
const voidFile = join(rawDir, 'raw-void.json');

await rm(rootDir, { recursive: true, force: true });
await mkdir(rawDir, { recursive: true });

await writeJson(siteFile, {
  merchant_name: 'Acme Pilot Store',
  pilot_window_start: '2026-06-28T01:00:00Z',
  pilot_window_end: '2026-06-28T02:00:00Z',
});

const sale = await loadSample('sample-receipt.json');
const refund = await loadSample('sample-refund.json');
const voided = await loadSample('sample-void.json');
mutateFieldSample(sale, 'sale', {
  number: 'ACME-SALE-001',
  externalEventId: 'acme-sale-evt-001',
  idempotencyKey: 'acme-sale-evt-001',
  purchaseAt: '2026-06-28T01:10:00Z',
  paymentReference: 'acme-payment-001',
});
mutateFieldSample(refund, 'refund', {
  number: 'ACME-REFUND-001',
  externalEventId: 'acme-refund-evt-001',
  idempotencyKey: 'acme-refund-evt-001',
  purchaseAt: '2026-06-28T01:20:00Z',
  paymentReference: 'acme-refund-001',
  originalReceiptNumber: 'ACME-SALE-001',
  originalExternalEventId: 'acme-sale-evt-001',
});
mutateFieldSample(voided, 'void', {
  number: 'ACME-VOID-001',
  externalEventId: 'acme-void-evt-001',
  idempotencyKey: 'acme-void-evt-001',
  purchaseAt: '2026-06-28T01:30:00Z',
  paymentReference: 'acme-void-001',
  originalReceiptNumber: 'ACME-SALE-001',
  originalExternalEventId: 'acme-sale-evt-001',
});

await writeJson(saleFile, sale);
await writeJson(refundFile, refund);
await writeJson(voidFile, voided);

const valid = await runCapture([
  '--site-file',
  siteFile,
  '--sale',
  saleFile,
  '--refund',
  refundFile,
  '--void',
  voidFile,
  '--output-dir',
  outputDir,
], 0);
assert.equal(valid.ok, true, 'valid raw field samples should stage');
assert.equal(valid.summary.all_contracts_ok, true, 'valid capture should prove all contracts');
assert.equal(valid.summary.all_identities_present, true, 'valid capture should prove identities');
assert.equal(valid.summary.all_within_pilot_window, true, 'valid capture should prove pilot window');
assert.equal(valid.summary.refund_void_link_sale, true, 'valid capture should prove refund/void link to sale');
assert.equal(valid.summary.no_bundled_samples, true, 'valid capture should reject bundled content');
assert.equal(valid.samples.sale.output_file.endsWith('field-sale.json'), true, 'sale output should use standard filename');
assert.equal(valid.samples.refund.output_file.endsWith('field-refund.json'), true, 'refund output should use standard filename');
assert.equal(valid.samples.void.output_file.endsWith('field-void.json'), true, 'void output should use standard filename');
assert.equal(JSON.stringify(valid).includes('rhp_field_capture.receiptsecret'), false, 'capture stdout must not leak receipt identity secret');
await assertExists(join(outputDir, 'field-sale.json'));
await assertExists(join(outputDir, 'field-refund.json'));
await assertExists(join(outputDir, 'field-void.json'));
await assertExists(join(outputDir, 'field-sample-capture.json'));

const noIdentity = structuredClone(sale);
delete noIdentity.payload.receipt.identity_token;
const noIdentityFile = join(rawDir, 'no-identity-sale.json');
const noIdentityOutputDir = join(rootDir, 'no-identity');
await writeJson(noIdentityFile, noIdentity);
const noIdentityResult = await runCapture([
  '--site-file',
  siteFile,
  '--sale',
  noIdentityFile,
  '--refund',
  refundFile,
  '--void',
  voidFile,
  '--output-dir',
  noIdentityOutputDir,
], 1);
assert.equal(noIdentityResult.samples.sale.identity_token_present, false, 'missing identity should be reported');
assert(
  noIdentityResult.failures.some((failure) => failure.includes('identity_token')),
  'missing identity should fail capture',
);
await assertMissing(join(noIdentityOutputDir, 'field-refund.json'));

const badRefund = structuredClone(refund);
badRefund.payload.receipt.original_receipt_number = 'OTHER-SALE';
badRefund.payload.receipt.original_external_event_id = 'other-sale-evt';
const badRefundFile = join(rawDir, 'bad-refund.json');
const badRefundOutputDir = join(rootDir, 'bad-refund');
await writeJson(badRefundFile, badRefund);
const badRefundResult = await runCapture([
  '--site-file',
  siteFile,
  '--sale',
  saleFile,
  '--refund',
  badRefundFile,
  '--void',
  voidFile,
  '--output-dir',
  badRefundOutputDir,
], 1);
assert.equal(badRefundResult.samples.refund.original_reference_matches_sale, false, 'bad refund should not link to sale');
assert(
  badRefundResult.failures.some((failure) => failure.includes('original sale reference')),
  'bad refund original reference should fail capture',
);
await assertMissing(join(badRefundOutputDir, 'field-sale.json'));

const bundledResult = await runCapture([
  '--site-file',
  siteFile,
  '--sale',
  'examples/pos-bridge/sample-receipt.json',
  '--refund',
  refundFile,
  '--void',
  voidFile,
  '--output-dir',
  join(rootDir, 'bundled'),
], 1);
assert.equal(bundledResult.samples.sale.bundled_sample, true, 'bundled sample should be detected');
assert(
  bundledResult.failures.some((failure) => failure.includes('bundled example sample')),
  'bundled sample should fail capture',
);

console.log(JSON.stringify({
  ok: true,
  valid_capture_ok: valid.ok,
  staged_sale_exists: true,
  identities_required: noIdentityResult.ok === false,
    bad_refund_original_rejected: badRefundResult.ok === false,
    bundled_sample_rejected: bundledResult.ok === false,
    failed_capture_is_all_or_nothing: noIdentityResult.samples.refund.copied === false &&
      badRefundResult.samples.sale.copied === false,
    secrets_redacted: !JSON.stringify(valid).includes('rhp_field_capture.receiptsecret'),
  }, null, 2));

async function runCapture(args, expectedCode) {
  const run = await runNode(['examples/pos-bridge/field-sample-capture.mjs', ...args]);
  assert.equal(run.code, expectedCode, `field-sample-capture exit ${run.code}; stdout=${run.stdout}; stderr=${run.stderr}`);
  return JSON.parse(run.stdout);
}

function runNode(args) {
  const child = spawn(process.execPath, args, {
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
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

async function loadSample(file) {
  return JSON.parse(await readFile(join('examples', 'pos-bridge', file), 'utf8'));
}

function mutateFieldSample(receipt, eventType, values) {
  receipt.event_type = eventType;
  receipt.idempotency_key = values.idempotencyKey;
  receipt.payload.merchant.name = 'Acme Pilot Store';
  receipt.payload.merchant.external_id = 'acme-store-001';
  receipt.payload.receipt.number = values.number;
  receipt.payload.receipt.event_type = eventType;
  receipt.payload.receipt.external_event_id = values.externalEventId;
  receipt.payload.receipt.purchase_at = values.purchaseAt;
  receipt.payload.receipt.payment_reference = values.paymentReference;
  receipt.payload.receipt.identity_token = 'rhp_field_capture.receiptsecret';
  receipt.payload.receipt.store_id = 'ACME-STORE-001';
  receipt.payload.receipt.terminal_id = 'ACME-TERM-01';
  if (values.originalReceiptNumber) receipt.payload.receipt.original_receipt_number = values.originalReceiptNumber;
  if (values.originalExternalEventId) receipt.payload.receipt.original_external_event_id = values.originalExternalEventId;
  for (const [index, line] of receipt.payload.line_items.entries()) {
    line.description = `Acme ${eventType} field line ${index + 1}`;
  }
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function assertExists(file) {
  await access(file);
}

async function assertMissing(file) {
  try {
    await access(file);
  } catch {
    return;
  }
  throw new Error(`expected missing file: ${file}`);
}
