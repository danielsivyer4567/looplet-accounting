#!/usr/bin/env node
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import {
  receiptEventType,
  receiptSource,
  stableIdempotencyKey,
  validateReceiptContract,
} from './contract.mjs';
import {
  containsUnredactedSecret,
  isBundledSampleContent,
  redactedSampleSha256,
  redactSecrets,
  sampleContentSha256WithoutIdentity,
} from './field-sample-reconciliation.mjs';

const standardFiles = {
  sale: 'field-sale.json',
  refund: 'field-refund.json',
  void: 'field-void.json',
};
const defaultSampleNames = new Set(['sample-receipt.json', 'sample-refund.json', 'sample-void.json']);

async function main() {
  const args = process.argv.slice(2);
  const siteFile = readOption(args, '--site-file');
  const outputDir = readOption(args, '--output-dir');
  const manifestFile = readOption(args, '--manifest');
  const samplePaths = {
    sale: readOption(args, '--sale'),
    refund: readOption(args, '--refund'),
    void: readOption(args, '--void'),
  };

  const failures = [];
  if (!siteFile) failures.push('--site-file is required');
  if (!outputDir) failures.push('--output-dir is required');
  for (const eventType of Object.keys(standardFiles)) {
    if (!samplePaths[eventType]) failures.push(`--${eventType} raw POS sample is required`);
  }
  if (args.length > 0) failures.push(`unsupported arguments: ${args.join(' ')}`);
  if (failures.length > 0) return finish({ ok: false, checked_at: new Date().toISOString(), failures });

  const site = await readJson(siteFile);
  const samples = {};
  for (const eventType of Object.keys(standardFiles)) {
    samples[eventType] = await inspectSample(eventType, samplePaths[eventType], site, outputDir);
  }
  applyRelationshipChecks(samples);

  const allSamplesOk = Object.values(samples).every((sample) => sample.ok === true);
  if (allSamplesOk) {
    await mkdir(outputDir, { recursive: true });
    for (const sample of Object.values(samples)) {
      await copyFile(sample.source_file, sample.output_file);
      sample.copied = true;
    }
  }

  const result = {
    ok: Object.values(samples).every((sample) => sample.ok === true && sample.copied === true),
    checked_at: new Date().toISOString(),
    site_file: basename(siteFile),
    output_dir: resolve(outputDir),
    manifest_file: resolve(manifestFile ?? join(outputDir, 'field-sample-capture.json')),
    summary: {
      merchant_name: site.merchant_name ?? null,
      staged_files: Object.fromEntries(
        Object.entries(samples).map(([eventType, sample]) => [eventType, sample.output_file]),
      ),
      all_contracts_ok: Object.values(samples).every((sample) => sample.contract_ok === true),
      all_identities_present: Object.values(samples).every((sample) => sample.identity_token_present === true),
      all_within_pilot_window: Object.values(samples).every((sample) => sample.within_pilot_window === true),
      all_match_site_merchant: Object.values(samples).every((sample) => sample.merchant_name_matches_site === true),
      refund_void_link_sale: samples.refund.original_reference_matches_sale === true &&
        samples.void.original_reference_matches_sale === true,
      no_bundled_samples: Object.values(samples).every((sample) => sample.bundled_sample !== true),
    },
    samples,
    failures: Object.entries(samples).flatMap(([eventType, sample]) =>
      sample.failures.map((failure) => `${eventType}: ${failure}`),
    ),
  };

  if (containsUnredactedSecret(JSON.stringify(result))) {
    result.ok = false;
    result.failures.push('capture manifest contains an unredacted Looplet secret');
  }

  await mkdir(outputDir, { recursive: true });
  await writeFile(result.manifest_file, `${JSON.stringify(result, null, 2)}\n`);
  finish(result);
}

async function inspectSample(eventType, file, site, outputDir) {
  const sourceFile = resolve(file);
  const outputFile = resolve(join(outputDir, standardFiles[eventType]));
  const failures = [];
  let receipt = null;
  let payload = null;
  try {
    receipt = await readJson(sourceFile);
    payload = receipt.payload ?? receipt;
  } catch (error) {
    return buildSampleResult(eventType, sourceFile, outputFile, failures, {
      parse_error: error instanceof Error ? redactSecrets(error.message) : redactSecrets(String(error)),
    });
  }

  const contractFailures = validateReceiptContract(receipt);
  failures.push(...contractFailures.map((failure) => `contract invalid: ${failure}`));

  let actualEventType = null;
  try {
    actualEventType = receiptEventType(receipt, payload);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  if (actualEventType !== eventType) failures.push(`expected ${eventType} sample, got ${actualEventType ?? '<unknown>'}`);

  let sourceChannel = null;
  try {
    sourceChannel = receiptSource(receipt.source_channel ?? 'pos');
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  let idempotencyKey = null;
  try {
    idempotencyKey = stableIdempotencyKey(receipt, payload, actualEventType ?? eventType);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  const identityTokenPresent = hasReceiptIdentity(receipt, payload);
  if (!identityTokenPresent) failures.push('field sample must include the customer-scanned identity_token');

  const merchantName = payload?.merchant?.name ?? null;
  const merchantNameMatchesSite = sameText(merchantName, site?.merchant_name);
  if (merchantNameMatchesSite !== true) failures.push('merchant.name must match site manifest merchant_name');

  const purchaseAt = normalizeDateTime(payload?.receipt?.purchase_at);
  const withinPilotWindow = isWithinPilotWindow(purchaseAt, site?.pilot_window_start, site?.pilot_window_end);
  if (withinPilotWindow !== true) failures.push('purchase_at must fall within the site pilot window');

  const bundledSample = defaultSampleNames.has(basename(sourceFile)) || isBundledSampleContent(receipt);
  if (bundledSample) failures.push('field sample must not be a bundled example sample');

  return buildSampleResult(eventType, sourceFile, outputFile, failures, {
    contract_ok: contractFailures.length === 0,
    source_channel: sourceChannel,
    event_type: actualEventType,
    identity_token_present: identityTokenPresent,
    idempotency_key: idempotencyKey,
    merchant_name: merchantName,
    merchant_name_matches_site: merchantNameMatchesSite,
    receipt_number: payload?.receipt?.number ?? null,
    external_event_id: payload?.receipt?.external_event_id ?? null,
    original_receipt_number: payload?.receipt?.original_receipt_number ?? null,
    original_external_event_id: payload?.receipt?.original_external_event_id ?? null,
    original_reference_matches_sale: eventType === 'sale' ? null : false,
    purchase_at: purchaseAt,
    within_pilot_window: withinPilotWindow,
    total_inc_gst_cents: payload?.receipt?.total_inc_gst_cents ?? null,
    line_count: Array.isArray(payload?.line_items) ? payload.line_items.length : 0,
    redacted_sample_sha256: redactedSampleSha256(receipt),
    content_sha256_without_identity: sampleContentSha256WithoutIdentity(receipt),
    bundled_sample: bundledSample,
  });
}

function applyRelationshipChecks(samples) {
  const sale = samples.sale;
  for (const eventType of ['refund', 'void']) {
    const sample = samples[eventType];
    const matchesReceipt = hasText(sample.original_receipt_number) &&
      hasText(sale.receipt_number) &&
      normalizeText(sample.original_receipt_number) === normalizeText(sale.receipt_number);
    const matchesExternalEvent = hasText(sample.original_external_event_id) &&
      hasText(sale.external_event_id) &&
      normalizeText(sample.original_external_event_id) === normalizeText(sale.external_event_id);
    const matchesIdempotency = hasText(sample.original_external_event_id) &&
      hasText(sale.idempotency_key) &&
      normalizeText(sample.original_external_event_id) === normalizeText(sale.idempotency_key);
    sample.original_reference_matches_sale = matchesReceipt || matchesExternalEvent || matchesIdempotency;
    if (sample.original_reference_matches_sale !== true) {
      sample.failures.push('original sale reference must match the captured sale sample');
    }
    sample.ok = sample.failures.length === 0;
  }
  samples.sale.ok = samples.sale.failures.length === 0;
}

function buildSampleResult(eventType, sourceFile, outputFile, failures, fields = {}) {
  return {
    ok: failures.length === 0,
    copied: false,
    source_file: sourceFile,
    output_file: outputFile,
    event_type: eventType,
    contract_ok: false,
    identity_token_present: false,
    merchant_name_matches_site: false,
    within_pilot_window: false,
    bundled_sample: false,
    failures,
    ...fields,
  };
}

async function readJson(file) {
  return JSON.parse(await readFile(resolve(file), 'utf8'));
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function finish(result) {
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

function hasReceiptIdentity(receipt, payload) {
  return isReceiptIdentity(receipt?.identity_token) ||
    isReceiptIdentity(payload?.receipt?.identity_token) ||
    isReceiptIdentity(payload?.customer?.looplet_identity_token);
}

function isReceiptIdentity(value) {
  return typeof value === 'string' && /^rhp_[^.]+\.[^\s"',}]+$/.test(value.trim());
}

function sameText(a, b) {
  return hasText(a) && hasText(b) && normalizeText(a) === normalizeText(b);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeText(value) {
  return String(value).trim().toLowerCase();
}

function normalizeDateTime(value) {
  if (!hasText(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isWithinPilotWindow(purchaseAt, start, end) {
  if (!purchaseAt || !hasText(start) || !hasText(end)) return false;
  const value = new Date(purchaseAt).getTime();
  const lower = new Date(start).getTime();
  const upper = new Date(end).getTime();
  if ([value, lower, upper].some((time) => Number.isNaN(time))) return false;
  return value >= lower && value <= upper;
}

await main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? redactSecrets(error.message) : redactSecrets(String(error)),
  }, null, 2));
  process.exit(1);
});
