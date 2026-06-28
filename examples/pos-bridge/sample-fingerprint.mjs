#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import process from 'node:process';

async function main() {
  const args = process.argv.slice(2);
  const expected = readOption(args, '--expected');
  if (args.length === 0) {
    throw new Error('usage: node sample-fingerprint.mjs <receipt.json> [more.json] [--expected <sha256-for-single-file>]');
  }
  if (expected && args.length !== 1) {
    throw new Error('--expected can only be used with one receipt file');
  }
  if (expected && !isSha256(expected)) {
    throw new Error('--expected must be a 64-character SHA-256 hex digest');
  }

  const samples = [];
  for (const file of args) {
    const receipt = JSON.parse(await readFile(file, 'utf8'));
    const payload = receipt.payload ?? receipt;
    const hash = redactedSampleSha256(receipt);
    samples.push({
      file,
      event_type: receipt.event_type ?? payload.receipt?.event_type ?? 'sale',
      receipt_number: payload.receipt?.number ?? null,
      merchant_name: payload.merchant?.name ?? null,
      purchase_at: payload.receipt?.purchase_at ?? null,
      total_inc_gst_cents: payload.receipt?.total_inc_gst_cents ?? null,
      line_count: Array.isArray(payload.line_items) ? payload.line_items.length : 0,
      redacted_sample_sha256: hash,
      matches_expected: expected ? hash === expected.toLowerCase() : null,
    });
  }

  const result = {
    ok: samples.every((sample) => sample.matches_expected !== false),
    checked_at: new Date().toISOString(),
    samples,
  };

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
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

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

await main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? redactSecrets(error.message) : redactSecrets(String(error)),
  }, null, 2));
  process.exit(1);
});
