#!/usr/bin/env node
import { createServer } from 'node:http';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import process from 'node:process';
import { buildWebhookBody, validateReceiptContract } from './contract.mjs';

const queueFile = process.env.LOOPLET_BRIDGE_TRIAL_QUEUE_FILE || '.claude/scratch/pos-bridge-trial-queue.jsonl';
const envFile = process.env.LOOPLET_BRIDGE_TRIAL_ENV_FILE || '.claude/scratch/pos-bridge-trial.env';
const received = [];
let mode = 'success';
let failedRequests = 0;

const server = createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    if (mode === 'fail') {
      failedRequests += 1;
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'temporary_outage' }));
      return;
    }

    try {
      const parsed = JSON.parse(body);
      assert(req.method === 'POST', 'method must be POST');
      assert(req.headers.authorization === 'Bearer llp_trial.secret', 'Authorization header mismatch');
      assert(req.headers['idempotency-key'] === parsed.idempotency_key, 'Idempotency-Key mismatch');
      assert(parsed.identity_token === 'rhp_trial.receiptsecret', 'identity token mismatch');
      assert(['sale', 'refund', 'void'].includes(parsed.event_type), 'event_type missing');
      assert(parsed.payload.receipt.event_type === parsed.event_type, 'payload event_type mismatch');
      assert(parsed.payload.receipt.tender_status, 'tender_status missing');
      assert(parsed.payload.receipt.payment_reference, 'payment_reference missing');
      assert(parsed.payload.receipt.purchase_at, 'purchase_at missing');
      const lineTotal = parsed.payload.line_items.reduce((sum, line) => sum + line.total_inc_gst_cents, 0);
      assert(lineTotal === parsed.payload.receipt.total_inc_gst_cents, 'line totals do not match receipt total');
      received.push(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        duplicate: false,
        event_type: parsed.event_type,
        receipt_event_id: `trial-${parsed.event_type}-${received.length}`,
      }));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: error.message }));
    }
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

try {
  await unlink(queueFile).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  await mkdir(dirname(envFile), { recursive: true });
  await writeFile(envFile, [
    `LOOPLET_RECEIPT_WEBHOOK_URL=http://127.0.0.1:${port}/functions/v1/receipt-webhook`,
    'LOOPLET_POS_API_KEY=llp_trial.secret',
    'LOOPLET_RECEIPT_IDENTITY_TOKEN=rhp_trial.receiptsecret',
    'LOOPLET_SYNC_TARGETS=xero,myob',
    `LOOPLET_BRIDGE_QUEUE_FILE=${queueFile}`,
    'LOOPLET_BRIDGE_MAX_ATTEMPTS=2',
    'LOOPLET_BRIDGE_RETRY_BASE_MS=10',
    '',
  ].join('\n'));

  await runNode([
    'examples/pos-bridge/validate.mjs',
    'examples/pos-bridge/sample-receipt.json',
    'examples/pos-bridge/sample-refund.json',
    'examples/pos-bridge/sample-void.json',
  ], 0);
  const invalidValidation = await runNode([
    'examples/pos-bridge/validate.mjs',
    'examples/pos-bridge/sample-invalid-pending.json',
  ], 1);
  assert(invalidValidation.stderr.includes('tender_status must be final'), 'pending tender validation did not fail correctly');

  const sampleReceipt = JSON.parse(await readFile('examples/pos-bridge/sample-receipt.json', 'utf8'));
  const normalizedBody = buildWebhookBody(sampleReceipt, {
    identityToken: 'rhp_trial.receiptsecret',
    syncTargets: [],
  });
  assert(normalizedBody.payload.receipt.purchase_at === '2026-06-28T03:00:00.000Z', 'purchase_at should normalize to ISO date-time');

  const scannedIdentityReceipt = clone(sampleReceipt);
  delete scannedIdentityReceipt.identity_token;
  scannedIdentityReceipt.payload.receipt.identity_token = 'rhp_scanned.customersecret';
  const scannedIdentityBody = buildWebhookBody(scannedIdentityReceipt, {
    syncTargets: [],
  });
  assert(scannedIdentityBody.identity_token === 'rhp_scanned.customersecret', 'scanned per-receipt identity token should be used');
  assert(!('identity_token' in scannedIdentityBody.payload.receipt), 'scanned identity token should be stripped from receipt payload before send');

  const maskedReceipt = clone(sampleReceipt);
  maskedReceipt.payload.receipt.payment_last4 = '**** **** **** 1234';
  const maskedBody = buildWebhookBody(maskedReceipt, {
    identityToken: 'rhp_trial.receiptsecret',
    syncTargets: [],
  });
  assert(maskedBody.payload.receipt.payment_last4 === '1234', 'masked payment_last4 should normalize to final four digits');

  const fullPanReceipt = clone(sampleReceipt);
  fullPanReceipt.payload.receipt.payment_last4 = '4111111111111234';
  const panErrors = validateReceiptContract(fullPanReceipt);
  assert(
    panErrors.some((error) => error.includes('payment_last4') && error.includes('full card number')),
    'full card number in payment_last4 should fail bridge contract validation',
  );

  const missingPurchaseAtReceipt = clone(sampleReceipt);
  delete missingPurchaseAtReceipt.payload.receipt.purchase_at;
  const missingPurchaseAtErrors = validateReceiptContract(missingPurchaseAtReceipt);
  assert(
    missingPurchaseAtErrors.some((error) => error.includes('purchase_at') && error.includes('required')),
    'missing purchase_at should fail bridge contract validation',
  );

  const badPurchaseAtReceipt = clone(sampleReceipt);
  badPurchaseAtReceipt.payload.receipt.purchase_at = 'not-a-date';
  const badPurchaseAtErrors = validateReceiptContract(badPurchaseAtReceipt);
  assert(
    badPurchaseAtErrors.some((error) => error.includes('purchase_at') && error.includes('valid date-time')),
    'invalid purchase_at should fail bridge contract validation',
  );

  const badLineQuantityReceipt = clone(sampleReceipt);
  badLineQuantityReceipt.payload.line_items[0].quantity = 1_000_000_000_000;
  const badLineQuantityErrors = validateReceiptContract(badLineQuantityReceipt);
  assert(
    badLineQuantityErrors.some((error) => error.includes('quantity')),
    'oversized line quantity should fail bridge contract validation before send',
  );

  await runBridge(['examples/pos-bridge/sample-receipt.json'], 0);
  await runBridge(['examples/pos-bridge/sample-refund.json'], 0);
  await runBridge(['examples/pos-bridge/sample-void.json'], 0);

  assert(received[0].event_type === 'sale', 'sale event was not sent first');
  assert(received[1].event_type === 'refund', 'refund event was not sent second');
  assert(received[2].event_type === 'void', 'void event was not sent third');
  assert(received[1].payload.receipt.original_receipt_number === 'POS-2026-0001', 'refund original receipt missing');
  assert(received[2].payload.receipt.original_receipt_number === 'POS-2026-0001', 'void original receipt missing');

  await runBridgeWithEnvFile(['examples/pos-bridge/sample-receipt.json'], 0);
  assert(
    received[3].event_type === 'sale',
    '--env-file should override stale inherited LOOPLET_* environment values',
  );

  mode = 'fail';
  await runBridge(['examples/pos-bridge/sample-receipt.json'], 1);
  assert(failedRequests >= 2, 'transient retry was not attempted');
  await stat(queueFile);

  mode = 'success';
  await runBridge(['--flush'], 0);
  const queueStillExists = await stat(queueFile).then(() => true).catch((error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
  assert(!queueStillExists, 'queue file should be removed after successful flush');

  console.log(JSON.stringify({
    ok: true,
    sale_event: received[0].event_type,
    refund_event: received[1].event_type,
    void_event: received[2].event_type,
    purchase_at_normalized: true,
    scanned_identity_token_used: true,
    scanned_identity_token_stripped_from_payload: true,
    missing_purchase_at_rejected_before_send: true,
    bad_purchase_at_rejected_before_send: true,
    bad_line_quantity_rejected_before_send: true,
    masked_payment_last4_normalized: true,
    full_pan_rejected_before_send: true,
    env_file_overrode_stale_environment: true,
    retry_attempts_seen: failedRequests,
    flushed_event: received[4].event_type,
  }, null, 2));
} finally {
  server.close();
}

async function runNode(args, expectedCode) {
  return await runProcess(args, expectedCode, {
    ...process.env,
  });
}

async function runBridge(args, expectedCode) {
  return await runProcess(['examples/pos-bridge/bridge.mjs', ...args], expectedCode, {
    ...process.env,
    LOOPLET_RECEIPT_WEBHOOK_URL: `http://127.0.0.1:${port}/functions/v1/receipt-webhook`,
    LOOPLET_POS_API_KEY: 'llp_trial.secret',
    LOOPLET_RECEIPT_IDENTITY_TOKEN: 'rhp_trial.receiptsecret',
    LOOPLET_SYNC_TARGETS: 'xero,myob',
    LOOPLET_BRIDGE_QUEUE_FILE: queueFile,
    LOOPLET_BRIDGE_MAX_ATTEMPTS: '2',
    LOOPLET_BRIDGE_RETRY_BASE_MS: '10',
  });
}

async function runBridgeWithEnvFile(args, expectedCode) {
  return await runProcess(['examples/pos-bridge/bridge.mjs', '--env-file', envFile, ...args], expectedCode, {
    ...process.env,
    LOOPLET_RECEIPT_WEBHOOK_URL: 'http://127.0.0.1:1/functions/v1/receipt-webhook',
    LOOPLET_POS_API_KEY: 'llp_stale.wrong',
    LOOPLET_RECEIPT_IDENTITY_TOKEN: 'rhp_stale.wrong',
    LOOPLET_SYNC_TARGETS: 'stale',
    LOOPLET_BRIDGE_QUEUE_FILE: `${queueFile}.stale`,
    LOOPLET_BRIDGE_MAX_ATTEMPTS: '1',
    LOOPLET_BRIDGE_RETRY_BASE_MS: '1',
  });
}

async function runProcess(args, expectedCode, env) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env,
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
