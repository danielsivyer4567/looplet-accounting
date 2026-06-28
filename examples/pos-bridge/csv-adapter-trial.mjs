#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { buildWebhookBody, validateReceiptContract } from './contract.mjs';

const rootDir = process.env.LOOPLET_CSV_ADAPTER_TRIAL_DIR || '.claude/scratch/pos-csv-adapter-trial';
const outputFile = join(rootDir, 'receipt.json');
const refundCsvFile = join(rootDir, 'refund.csv');
const refundOutputFile = join(rootDir, 'refund.json');
const voidCsvFile = join(rootDir, 'void.csv');
const voidOutputFile = join(rootDir, 'void.json');
const missingOriginalRefundCsvFile = join(rootDir, 'refund-missing-original.csv');
const mixedMetadataFile = join(rootDir, 'mixed-metadata.csv');

await rm(rootDir, { recursive: true, force: true });
await mkdir(rootDir, { recursive: true });

const valid = await runNode([
  'examples/pos-bridge/csv-adapter.mjs',
  'examples/pos-bridge/sample-pos-export.csv',
  '--out',
  outputFile,
], 0);
const receipt = JSON.parse(await readFile(outputFile, 'utf8'));
const errors = validateReceiptContract(receipt);
assert(errors.length === 0, `generated receipt contract errors: ${errors.join('; ')}`);
assert(receipt.idempotency_key === 'pos-csv-evt-100045', 'idempotency key mismatch');
assert(receipt.identity_token === 'rhp_csv.customersecret', 'identity token should be preserved from CSV');
assert(receipt.payload.receipt.number === 'POS-CSV-2026-0001', 'receipt number mismatch');
assert(receipt.payload.line_items.length === 2, 'line item count mismatch');
assert(receipt.payload.line_items.reduce((sum, line) => sum + line.total_inc_gst_cents, 0) === 36000, 'line totals mismatch');
assert(valid.stdout.includes('"ok": true'), 'valid adapter output should report ok');
const body = buildWebhookBody(receipt, { syncTargets: [] });
assert(body.identity_token === 'rhp_csv.customersecret', 'CSV identity token should be used by webhook body builder');

await writeFile(refundCsvFile, refundCsv());
await runNode([
  'examples/pos-bridge/csv-adapter.mjs',
  refundCsvFile,
  '--out',
  refundOutputFile,
], 0);
const refundReceipt = JSON.parse(await readFile(refundOutputFile, 'utf8'));
assert(validateReceiptContract(refundReceipt).length === 0, 'generated refund receipt should pass contract validation');
assert(refundReceipt.event_type === 'refund', 'refund event_type mismatch');
assert(refundReceipt.payload.receipt.original_receipt_number === 'POS-CSV-2026-0001', 'refund original receipt number mismatch');
assert(refundReceipt.payload.receipt.original_external_event_id === 'pos-csv-evt-100045', 'refund original external event id mismatch');
assert(buildWebhookBody(refundReceipt, { syncTargets: [] }).event_type === 'refund', 'refund webhook body event type mismatch');

await writeFile(voidCsvFile, voidCsv());
await runNode([
  'examples/pos-bridge/csv-adapter.mjs',
  voidCsvFile,
  '--out',
  voidOutputFile,
], 0);
const voidReceipt = JSON.parse(await readFile(voidOutputFile, 'utf8'));
assert(validateReceiptContract(voidReceipt).length === 0, 'generated void receipt should pass contract validation');
assert(voidReceipt.event_type === 'void', 'void event_type mismatch');
assert(voidReceipt.payload.receipt.original_receipt_number === 'POS-CSV-2026-0001', 'void original receipt number mismatch');
assert(voidReceipt.payload.receipt.total_inc_gst_cents === 0, 'void total should be zero');
assert(buildWebhookBody(voidReceipt, { syncTargets: [] }).event_type === 'void', 'void webhook body event type mismatch');

await writeFile(missingOriginalRefundCsvFile, refundCsv({ originalReceiptNumber: '', originalExternalEventId: '' }));
const missingOriginal = await runNode([
  'examples/pos-bridge/csv-adapter.mjs',
  missingOriginalRefundCsvFile,
], 1);
assert(
  missingOriginal.stderr.includes('original_receipt_number or original_external_event_id'),
  'refund CSV without an original sale reference should fail before send',
);

const fractionalReceiptTotal = structuredClone(receipt);
fractionalReceiptTotal.payload.receipt.total_inc_gst_cents = 36000.5;
const fractionalReceiptErrors = validateReceiptContract(fractionalReceiptTotal);
assert(
  fractionalReceiptErrors.some((error) => error.includes('total_inc_gst_cents')),
  'fractional receipt total cents should fail contract validation',
);

const fractionalLineGst = structuredClone(receipt);
fractionalLineGst.payload.line_items[0].gst_cents = 2727.5;
const fractionalLineErrors = validateReceiptContract(fractionalLineGst);
assert(
  fractionalLineErrors.some((error) => error.includes('gst_cents')),
  'fractional line GST cents should fail contract validation',
);

const validation = await runNode(['examples/pos-bridge/validate.mjs', outputFile], 0);
assert(validation.stdout.includes('"ok": true'), 'generated JSON should pass validate.mjs');

const invalid = await runNode([
  'examples/pos-bridge/csv-adapter.mjs',
  'examples/pos-bridge/sample-pos-export-bad-lines.csv',
], 1);
assert(invalid.stderr.includes('line_items totals must match receipt total'), 'bad CSV should fail line-total validation');

await writeFile(mixedMetadataFile, mixedReceiptMetadataCsv());
const mixed = await runNode([
  'examples/pos-bridge/csv-adapter.mjs',
  mixedMetadataFile,
], 1);
assert(
  mixed.stderr.includes('total_inc_gst_cents') && mixed.stderr.includes('expected'),
  'mixed receipt metadata should fail before a receipt is generated',
);

console.log(JSON.stringify({
  ok: true,
  generated_receipt: outputFile,
  receipt_number: receipt.payload.receipt.number,
  idempotency_key: receipt.idempotency_key,
  identity_token_preserved: receipt.identity_token === 'rhp_csv.customersecret',
  line_count: receipt.payload.line_items.length,
  line_total_inc_gst_cents: receipt.payload.line_items.reduce((sum, line) => sum + line.total_inc_gst_cents, 0),
  refund_csv_ok: refundReceipt.event_type === 'refund',
  void_csv_ok: voidReceipt.event_type === 'void',
  bad_lines_rejected: true,
  fractional_cents_rejected: true,
  missing_original_reference_rejected: true,
  mixed_metadata_rejected: true,
}, null, 2));

async function runNode(args, expectedCode) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
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
    throw new Error(`${args.join(' ')} exited ${code}, expected ${expectedCode}\nstdout=${stdout}\nstderr=${stderr}`);
  }
  return { stdout, stderr };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function mixedReceiptMetadataCsv() {
  return [
    csvHeader(),
    'sale,pos-mixed-001,rhp_csv.customersecret,pos,Bunnings Trade,12123456789,store-017,POS-MIXED-001,pos-mixed-001,,,2026-06-28T04:00:00Z,AUD,32727,3273,36000,completed,card,1234,eftpos-auth-mixed-001,TERM-04,STORE-017,business,deductible,JOB-1042,materials,xero,Timber,2,15000,30000,2727',
    'sale,pos-mixed-001,rhp_csv.customersecret,pos,Bunnings Trade,12123456789,store-017,POS-MIXED-001,pos-mixed-001,,,2026-06-28T04:00:00Z,AUD,32727,3273,37000,completed,card,1234,eftpos-auth-mixed-001,TERM-04,STORE-017,business,deductible,JOB-1042,materials,xero,Fasteners,1,6000,6000,546',
    '',
  ].join('\n');
}

function refundCsv({
  originalReceiptNumber = 'POS-CSV-2026-0001',
  originalExternalEventId = 'pos-csv-evt-100045',
} = {}) {
  return [
    csvHeader(),
    [
      'refund',
      'pos-csv-refund-100046',
      'rhp_csv.customersecret',
      'pos',
      'Bunnings Trade',
      '12123456789',
      'store-017',
      'POS-CSV-REFUND-0001',
      'pos-csv-refund-100046',
      originalReceiptNumber,
      originalExternalEventId,
      '2026-06-28T04:20:00Z',
      'AUD',
      '5455',
      '545',
      '6000',
      'refunded',
      'card',
      '1234',
      'eftpos-refund-csv-777334',
      'TERM-04',
      'STORE-017',
      'business',
      'deductible',
      'JOB-1042',
      'materials',
      'xero',
      'Returned fasteners',
      '1',
      '6000',
      '6000',
      '545',
    ].join(','),
    '',
  ].join('\n');
}

function voidCsv() {
  return [
    csvHeader(),
    [
      'void',
      'pos-csv-void-100047',
      'rhp_csv.customersecret',
      'pos',
      'Bunnings Trade',
      '12123456789',
      'store-017',
      'POS-CSV-VOID-0001',
      'pos-csv-void-100047',
      'POS-CSV-2026-0001',
      'pos-csv-evt-100045',
      '2026-06-28T04:25:00Z',
      'AUD',
      '0',
      '0',
      '0',
      'voided',
      'card',
      '1234',
      'eftpos-void-csv-777335',
      'TERM-04',
      'STORE-017',
      'business',
      'deductible',
      'JOB-1042',
      'materials',
      'xero',
      'Voided receipt',
      '1',
      '0',
      '0',
      '0',
    ].join(','),
    '',
  ].join('\n');
}

function csvHeader() {
  return [
    'event_type',
    'idempotency_key',
    'identity_token',
    'source_channel',
    'merchant_name',
    'merchant_abn',
    'merchant_external_id',
    'receipt_number',
    'external_event_id',
    'original_receipt_number',
    'original_external_event_id',
    'purchase_at',
    'currency',
    'subtotal_ex_gst_cents',
    'gst_cents',
    'total_inc_gst_cents',
    'tender_status',
    'payment_method',
    'payment_last4',
    'payment_reference',
    'terminal_id',
    'store_id',
    'business_use',
    'deductibility',
    'job_reference',
    'category',
    'sync_targets',
    'line_description',
    'quantity',
    'unit_price_cents',
    'line_total_inc_gst_cents',
    'line_gst_cents',
  ].join(',');
}
