#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

const rootDir = join('.claude', 'scratch', 'pos-reconcile-pilot-evidence-trial');
const evidenceFile = join(rootDir, 'pos-pilot-evidence.json');
const mismatchEvidenceFile = join(rootDir, 'mismatch-evidence.json');
const missingHashEvidenceFile = join(rootDir, 'missing-hash-evidence.json');
const missingContentHashEvidenceFile = join(rootDir, 'missing-content-hash-evidence.json');
const contentMismatchEvidenceFile = join(rootDir, 'content-mismatch-evidence.json');
const sampleFiles = {
  sale: join(rootDir, 'field-sale.json'),
  refund: join(rootDir, 'field-refund.json'),
  void: join(rootDir, 'field-void.json'),
};

await rm(rootDir, { recursive: true, force: true });
await mkdir(rootDir, { recursive: true });

const samples = {
  sale: buildReceipt('sale'),
  refund: buildReceipt('refund'),
  void: buildReceipt('void'),
};
for (const [eventType, receipt] of Object.entries(samples)) {
  await writeFile(sampleFiles[eventType], `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}

const evidence = buildEvidence(samples);
await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

const mismatchEvidence = JSON.parse(JSON.stringify(evidence));
mismatchEvidence.field_samples.samples[0].merchant_name = 'Wrong Merchant Pty Ltd';
await writeFile(mismatchEvidenceFile, `${JSON.stringify(mismatchEvidence, null, 2)}\n`, 'utf8');

const missingHashEvidence = JSON.parse(JSON.stringify(evidence));
delete missingHashEvidence.field_samples.samples[1].redacted_sample_sha256;
await writeFile(missingHashEvidenceFile, `${JSON.stringify(missingHashEvidence, null, 2)}\n`, 'utf8');

const missingContentHashEvidence = JSON.parse(JSON.stringify(evidence));
delete missingContentHashEvidence.field_samples.samples[1].content_sha256_without_identity;
await writeFile(missingContentHashEvidenceFile, `${JSON.stringify(missingContentHashEvidence, null, 2)}\n`, 'utf8');

const contentMismatchEvidence = JSON.parse(JSON.stringify(evidence));
contentMismatchEvidence.field_samples.samples[2].content_sha256_without_identity = '9'.repeat(64);
await writeFile(contentMismatchEvidenceFile, `${JSON.stringify(contentMismatchEvidence, null, 2)}\n`, 'utf8');

const valid = await runReconciler(evidenceFile, 0);
const validParsed = JSON.parse(valid.stdout);
assert.equal(validParsed.ok, true);
assert.equal(validParsed.matches.sale.ok, true);
assert.equal(validParsed.matches.refund.ok, true);
assert.equal(validParsed.matches.void.ok, true);
assert(!valid.stdout.includes('rhp_trial.receiptsecret'), 'valid reconciliation stdout must not expose receipt tokens');
assert(!valid.stdout.includes('llp_trial.secret'), 'valid reconciliation stdout must not expose API keys');

const mismatch = await runReconciler(mismatchEvidenceFile, 1);
const mismatchParsed = JSON.parse(mismatch.stdout);
assert.equal(mismatchParsed.ok, false);
assert(
  mismatchParsed.failures.some((failure) => failure.includes('sale: merchant_name mismatch')),
  'mismatched evidence must identify the sale metadata mismatch',
);

const missingHash = await runReconciler(missingHashEvidenceFile, 1);
const missingHashParsed = JSON.parse(missingHash.stdout);
assert.equal(missingHashParsed.ok, false);
assert(
  missingHashParsed.failures.some((failure) => failure.includes('refund: pilot evidence sample must include a valid redacted_sample_sha256')),
  'missing fingerprint must be rejected',
);

const missingContentHash = await runReconciler(missingContentHashEvidenceFile, 1);
const missingContentHashParsed = JSON.parse(missingContentHash.stdout);
assert.equal(missingContentHashParsed.ok, false);
assert(
  missingContentHashParsed.failures.some((failure) => failure.includes('refund: pilot evidence sample must include a valid content_sha256_without_identity')),
  'missing content fingerprint must be rejected',
);

const contentMismatch = await runReconciler(contentMismatchEvidenceFile, 1);
const contentMismatchParsed = JSON.parse(contentMismatch.stdout);
assert.equal(contentMismatchParsed.ok, false);
assert(
  contentMismatchParsed.failures.some((failure) => failure.includes('void: content_sha256_without_identity mismatch')),
  'content fingerprint mismatch must be rejected',
);

console.log(JSON.stringify({
  ok: true,
  valid_reconciled: validParsed.ok,
  mismatch_rejected: mismatchParsed.ok === false,
  missing_fingerprint_rejected: missingHashParsed.ok === false,
  missing_content_fingerprint_rejected: missingContentHashParsed.ok === false,
  content_fingerprint_mismatch_rejected: contentMismatchParsed.ok === false,
  sale_redacted_sample_sha256: validParsed.matches.sale.actual.redacted_sample_sha256,
  sale_content_sha256_without_identity: validParsed.matches.sale.actual.content_sha256_without_identity,
  evidence_file: evidenceFile,
}, null, 2));

async function runReconciler(file, expectedCode) {
  const child = spawn(process.execPath, [
    'examples/pos-bridge/reconcile-pilot-evidence.mjs',
    file,
    '--sale',
    sampleFiles.sale,
    '--refund',
    sampleFiles.refund,
    '--void',
    sampleFiles.void,
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
    throw new Error(`reconcile exited ${code}, expected ${expectedCode}\nstdout=${stdout}\nstderr=${stderr}`);
  }
  return { stdout, stderr };
}

function buildEvidence(receipts) {
  return {
    ok: true,
    field_samples: {
      provided: true,
      ok: true,
      samples: Object.entries(receipts).map(([eventType, receipt]) => {
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
          purchase_at: new Date(payload.receipt.purchase_at).toISOString(),
          total_inc_gst_cents: payload.receipt.total_inc_gst_cents,
          line_count: payload.line_items.length,
        };
      }),
    },
  };
}

function buildReceipt(eventType) {
  const receipt = {
    event_type: eventType,
    idempotency_key: `field-${eventType}-1`,
    identity_token: 'rhp_trial.receiptsecret',
    source_channel: 'pos',
    diagnostic: 'llp_trial.secret',
    payload: {
      merchant: {
        name: 'Reconcile Pilot Pty Ltd',
        external_id: 'STORE-REC',
      },
      receipt: {
        number: `REC-${eventType.toUpperCase()}-1`,
        event_type: eventType,
        external_event_id: `field-${eventType}-1`,
        purchase_at: {
          sale: '2026-06-28T03:00:00.000Z',
          refund: '2026-06-28T03:20:00.000Z',
          void: '2026-06-28T03:25:00.000Z',
        }[eventType],
        currency: 'AUD',
        subtotal_ex_gst_cents: eventType === 'void' ? 0 : 32727,
        gst_cents: eventType === 'void' ? 0 : 3273,
        total_inc_gst_cents: eventType === 'void' ? 0 : 36000,
        tender_status: {
          sale: 'completed',
          refund: 'refunded',
          void: 'voided',
        }[eventType],
        payment_method: 'card',
        payment_last4: '1234',
        payment_reference: `eftpos-${eventType}-777`,
        terminal_id: 'TERM-REC',
      },
      line_items: [
        {
          description: eventType === 'void' ? 'Sale voided before settlement' : 'Pilot field line',
          quantity: eventType === 'void' ? 0 : 1,
          unit_price_cents: eventType === 'void' ? 0 : 36000,
          total_inc_gst_cents: eventType === 'void' ? 0 : 36000,
          gst_cents: eventType === 'void' ? 0 : 3273,
        },
      ],
    },
  };

  if (eventType !== 'sale') {
    receipt.payload.receipt.original_receipt_number = 'REC-SALE-1';
    receipt.payload.receipt.original_external_event_id = 'field-sale-1';
  }
  return receipt;
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
  return value
    .replace(/llp_[^\s"',}]+/g, 'llp_[redacted]')
    .replace(/rhp_[^\s"',}]+/g, 'rhp_[redacted]');
}
