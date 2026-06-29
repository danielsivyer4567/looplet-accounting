#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { stableIdempotencyKey, receiptEventType, receiptSource, validateReceiptContract } from './contract.mjs';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node validate.mjs <receipt.json> [more.json]');
  process.exit(2);
}

let failed = false;
for (const file of files) {
  const receipt = JSON.parse(await readFile(file, 'utf8'));
  const payload = receipt.payload ?? receipt;
  const errors = validateReceiptContract(receipt);
  if (errors.length > 0) {
    failed = true;
    console.error(JSON.stringify({ file, ok: false, errors }, null, 2));
    continue;
  }

  const event_type = receiptEventType(receipt, payload);
  const source_channel = receiptSource(receipt.source_channel ?? 'pos');
  const idempotency_key = stableIdempotencyKey(receipt, payload, event_type);
  console.log(JSON.stringify({
    file,
    ok: true,
    source_channel,
    event_type,
    idempotency_key,
    receipt_number: payload.receipt?.number ?? null,
    total_inc_gst_cents: payload.receipt?.total_inc_gst_cents ?? null,
    line_count: Array.isArray(payload.line_items) ? payload.line_items.length : 0,
  }, null, 2));
}

if (failed) process.exit(1);
