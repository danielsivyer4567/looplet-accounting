#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';
import { validateReceiptContract } from './contract.mjs';

async function main() {
  const args = process.argv.slice(2);
  const input = args[0];
  if (!input) throw new Error('usage: node csv-adapter.mjs <pos-export.csv> [--out receipt.json]');
  const output = readOption(args, '--out');
  const rows = parseCsv(await readFile(input, 'utf8'));
  const receipt = receiptFromRows(rows, input);
  const errors = validateReceiptContract(receipt);
  if (errors.length > 0) {
    throw new Error(`CSV export does not satisfy Looplet receipt contract: ${errors.join('; ')}`);
  }

  const json = `${JSON.stringify(receipt, null, 2)}\n`;
  if (output) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, json);
    console.log(JSON.stringify({
      ok: true,
      input,
      output,
      receipt_number: receipt.payload.receipt.number,
      idempotency_key: receipt.idempotency_key,
      event_type: receipt.event_type,
      line_count: receipt.payload.line_items.length,
      total_inc_gst_cents: receipt.payload.receipt.total_inc_gst_cents,
    }, null, 2));
  } else {
    process.stdout.write(json);
  }
}

function receiptFromRows(rows, input) {
  if (rows.length === 0) throw new Error(`${input} contains no data rows`);
  const first = rows[0];
  const receiptNumber = required(first, 'receipt_number');
  for (const [index, row] of rows.entries()) {
    const current = required(row, 'receipt_number');
    if (current !== receiptNumber) {
      throw new Error(`${input} row ${index + 2} has receipt_number ${current}; one CSV file must contain one receipt`);
    }
  }
  assertConsistentReceiptFields(rows, input);

  const eventType = text(first.event_type) || 'sale';
  const receipt = {
    event_type: eventType,
    idempotency_key: text(first.idempotency_key) || text(first.external_event_id) || `${eventType}:${receiptNumber}`,
    identity_token: text(first.identity_token) || undefined,
    source_channel: text(first.source_channel) || 'pos',
    payload: {
      merchant: {
        name: required(first, 'merchant_name'),
        abn: text(first.merchant_abn) || undefined,
        external_id: text(first.merchant_external_id) || undefined,
      },
      receipt: {
        number: receiptNumber,
        event_type: eventType,
        external_event_id: text(first.external_event_id) || text(first.idempotency_key) || `${eventType}:${receiptNumber}`,
        original_receipt_number: text(first.original_receipt_number) || undefined,
        original_external_event_id: text(first.original_external_event_id) || undefined,
        purchase_at: required(first, 'purchase_at'),
        currency: text(first.currency) || 'AUD',
        subtotal_ex_gst_cents: cents(first.subtotal_ex_gst_cents, 'subtotal_ex_gst_cents'),
        gst_cents: cents(first.gst_cents, 'gst_cents'),
        total_inc_gst_cents: cents(first.total_inc_gst_cents, 'total_inc_gst_cents'),
        tender_status: required(first, 'tender_status'),
        payment_method: text(first.payment_method) || undefined,
        payment_last4: text(first.payment_last4) || undefined,
        payment_reference: required(first, 'payment_reference'),
        terminal_id: text(first.terminal_id) || undefined,
        store_id: text(first.store_id) || undefined,
      },
      classification: {
        business_use: text(first.business_use) || 'review',
        deductibility: text(first.deductibility) || 'requires_review',
        job_reference: text(first.job_reference) || undefined,
        category: text(first.category) || undefined,
        sync_targets: list(first.sync_targets),
      },
      line_items: rows.map((row, index) => ({
        description: required(row, 'line_description'),
        quantity: number(row.quantity || '1', `row ${index + 2} quantity`),
        unit_price_cents: cents(row.unit_price_cents, `row ${index + 2} unit_price_cents`),
        total_inc_gst_cents: cents(row.line_total_inc_gst_cents, `row ${index + 2} line_total_inc_gst_cents`),
        gst_cents: cents(row.line_gst_cents || '0', `row ${index + 2} line_gst_cents`),
      })),
    },
  };

  pruneUndefined(receipt);
  return receipt;
}

function assertConsistentReceiptFields(rows, input) {
  const receiptLevelFields = [
    'event_type',
    'idempotency_key',
    'identity_token',
    'source_channel',
    'merchant_name',
    'merchant_abn',
    'merchant_external_id',
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
  ];

  const first = rows[0];
  for (const field of receiptLevelFields) {
    const expected = normalizedField(first[field]);
    for (const [index, row] of rows.entries()) {
      const actual = normalizedField(row[field]);
      if (actual !== expected) {
        throw new Error(
          `${input} row ${index + 2} has ${field} ${displayValue(actual)}; expected ${displayValue(expected)} for receipt ${required(first, 'receipt_number')}`,
        );
      }
    }
  }
}

function parseCsv(content) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i];
    const next = content[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  row.push(field);
  rows.push(row);

  const nonEmptyRows = rows.filter((candidate) => candidate.some((value) => value.trim() !== ''));
  if (nonEmptyRows.length < 2) return [];
  const headers = nonEmptyRows[0].map((header) => header.trim());
  return nonEmptyRows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ''])));
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function required(row, key) {
  const value = text(row[key]);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizedField(value) {
  return text(value) ?? '';
}

function displayValue(value) {
  return value ? JSON.stringify(value) : '<blank>';
}

function number(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be numeric`);
  return parsed;
}

function cents(value, label) {
  const parsed = number(value, label);
  if (!Number.isInteger(parsed)) throw new Error(`${label} must be whole cents`);
  return parsed;
}

function list(value) {
  return text(value)?.split('|').map((item) => item.trim()).filter(Boolean) ?? undefined;
}

function pruneUndefined(value) {
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (value[key] === undefined || (Array.isArray(value[key]) && value[key].length === 0)) {
      delete value[key];
    } else {
      pruneUndefined(value[key]);
    }
  }
}

await main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});
