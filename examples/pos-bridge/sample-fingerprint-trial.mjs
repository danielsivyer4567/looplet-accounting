#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

const rootDir = join('.claude', 'scratch', 'pos-sample-fingerprint-trial');
const sampleFile = join(rootDir, 'field-sale.json');

await rm(rootDir, { recursive: true, force: true });
await mkdir(rootDir, { recursive: true });

const sample = {
  event_type: 'sale',
  identity_token: 'rhp_trial.receiptsecret',
  source_channel: 'pos',
  payload: {
    merchant: { name: 'Fingerprint Pilot Pty Ltd' },
    receipt: {
      number: 'FIELD-FP-001',
      purchase_at: '2026-06-28T03:00:00.000Z',
      total_inc_gst_cents: 36000,
      identity_token: 'rhp_embedded.receiptsecret',
    },
    line_items: [
      { description: 'Timber', total_inc_gst_cents: 36000, gst_cents: 3273 },
    ],
    diagnostics: 'llp_trial.secret',
  },
};
await writeFile(sampleFile, `${JSON.stringify(sample, null, 2)}\n`, 'utf8');

const expectedHash = redactedSampleSha256(sample);
const matched = await run([
  'examples/pos-bridge/sample-fingerprint.mjs',
  sampleFile,
  '--expected',
  expectedHash,
]);
assert.equal(matched.code, 0, matched.stderr);
assert(!matched.stdout.includes('rhp_trial.receiptsecret'), 'stdout must not expose top-level identity token');
assert(!matched.stdout.includes('rhp_embedded.receiptsecret'), 'stdout must not expose embedded identity token');
assert(!matched.stdout.includes('llp_trial.secret'), 'stdout must not expose API key material');

const matchedJson = JSON.parse(matched.stdout);
assert.equal(matchedJson.ok, true);
assert.equal(matchedJson.samples[0].redacted_sample_sha256, expectedHash);
assert.equal(matchedJson.samples[0].matches_expected, true);
assert.equal(matchedJson.samples[0].line_count, 1);

const mismatch = await run([
  'examples/pos-bridge/sample-fingerprint.mjs',
  sampleFile,
  '--expected',
  '0'.repeat(64),
]);
assert.notEqual(mismatch.code, 0, 'mismatched expected hash should fail');
const mismatchJson = JSON.parse(mismatch.stdout);
assert.equal(mismatchJson.ok, false);
assert.equal(mismatchJson.samples[0].matches_expected, false);

console.log(JSON.stringify({
  ok: true,
  fingerprint_matches_expected: matchedJson.samples[0].matches_expected,
  mismatch_rejected: mismatchJson.ok === false,
  secrets_redacted: !matched.stdout.includes('rhp_trial.receiptsecret') &&
    !matched.stdout.includes('rhp_embedded.receiptsecret') &&
    !matched.stdout.includes('llp_trial.secret'),
  redacted_sample_sha256: expectedHash,
}, null, 2));

async function run(args) {
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
  return { code, stdout, stderr };
}

function redactedSampleSha256(receipt) {
  return createHash('sha256')
    .update(JSON.stringify(redactDeep(receipt)))
    .digest('hex');
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
