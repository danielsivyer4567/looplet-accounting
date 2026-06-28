import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  receiptEventType,
  receiptSource,
  stableIdempotencyKey,
  validateReceiptContract,
} from './contract.mjs';

export const requiredFieldSampleEventTypes = ['sale', 'refund', 'void'];

const bundledSampleContentFingerprints = new Set([
  'c1f7ec8c3aa665899639046306ef3b78c7fa603e8751f5bf58d27a739978cc6c',
  '1f91db564f57ff0c7e756e48510b3aa72ef3bd6d5bcfc2f565eba40d40ed35fe',
  '1ded54d83ce273447eb15f7b1c91e6862cbb1ed43703a393d15e0ab66aab4195',
]);

export async function reconcileEvidenceFieldSamples(evidence, samplePaths) {
  const failures = [];
  if (evidence?.ok !== true) failures.push('pilot evidence ok must be true before reconciliation');
  if (evidence?.field_samples?.provided !== true) {
    failures.push('pilot evidence must include field POS samples');
  }
  if (!Array.isArray(evidence?.field_samples?.samples)) {
    failures.push('pilot evidence field_samples.samples must be an array');
  }

  const evidenceSamples = new Map(
    Array.isArray(evidence?.field_samples?.samples)
      ? evidence.field_samples.samples
          .filter((sample) => typeof sample?.event_type === 'string')
          .map((sample) => [sample.event_type, sample])
      : [],
  );
  const matches = {};
  for (const eventType of requiredFieldSampleEventTypes) {
    const match = await reconcileSample(eventType, samplePaths?.[eventType], evidenceSamples.get(eventType));
    matches[eventType] = match;
    failures.push(...match.failures.map((failure) => `${eventType}: ${failure}`));
  }

  return {
    ok: failures.length === 0,
    matches,
    failures,
  };
}

async function reconcileSample(eventType, file, evidenceSample) {
  const failures = [];
  if (!file) failures.push(`missing --${eventType} field sample file`);
  if (!evidenceSample) failures.push('missing field sample in pilot evidence');
  if (evidenceSample?.ok !== true) failures.push('pilot evidence sample must have ok=true');
  if (evidenceSample?.bundled_sample === true) failures.push('pilot evidence sample must not be a bundled example');
  if (!isSha256(evidenceSample?.redacted_sample_sha256)) {
    failures.push('pilot evidence sample must include a valid redacted_sample_sha256');
  }
  if (!isSha256(evidenceSample?.content_sha256_without_identity)) {
    failures.push('pilot evidence sample must include a valid content_sha256_without_identity');
  }

  const actual = {
    file: file ?? null,
    event_type: null,
    source_channel: null,
    idempotency_key: null,
    merchant_name: null,
    receipt_number: null,
    external_event_id: null,
    original_receipt_number: null,
    original_external_event_id: null,
    purchase_at: null,
    total_inc_gst_cents: null,
    line_count: null,
    redacted_sample_sha256: null,
    content_sha256_without_identity: null,
  };

  if (!file) return buildMatch(eventType, evidenceSample, actual, failures);

  let receipt = null;
  let payload = null;
  try {
    receipt = JSON.parse(await readFile(file, 'utf8'));
    payload = receipt.payload ?? receipt;
  } catch (error) {
    failures.push(`could not read field sample: ${error instanceof Error ? error.message : String(error)}`);
    return buildMatch(eventType, evidenceSample, actual, failures);
  }

  const contractErrors = validateReceiptContract(receipt);
  failures.push(...contractErrors.map((error) => `field sample contract invalid: ${error}`));

  try {
    actual.event_type = receiptEventType(receipt, payload);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  try {
    actual.source_channel = receiptSource(receipt.source_channel ?? 'pos');
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  try {
    actual.idempotency_key = stableIdempotencyKey(receipt, payload, actual.event_type ?? eventType);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  actual.merchant_name = payload?.merchant?.name ?? null;
  actual.receipt_number = payload?.receipt?.number ?? null;
  actual.external_event_id = payload?.receipt?.external_event_id ?? null;
  actual.original_receipt_number = payload?.receipt?.original_receipt_number ?? null;
  actual.original_external_event_id = payload?.receipt?.original_external_event_id ?? null;
  actual.purchase_at = normalizeDateTime(payload?.receipt?.purchase_at);
  actual.total_inc_gst_cents = payload?.receipt?.total_inc_gst_cents ?? null;
  actual.line_count = Array.isArray(payload?.line_items) ? payload.line_items.length : 0;
  actual.redacted_sample_sha256 = redactedSampleSha256(receipt);
  actual.content_sha256_without_identity = sampleContentSha256WithoutIdentity(receipt);

  if (actual.event_type !== eventType) failures.push(`expected ${eventType} field sample, got ${actual.event_type}`);
  if (bundledSampleContentFingerprints.has(actual.content_sha256_without_identity)) {
    failures.push('field sample content matches a bundled example sample');
  }
  compareField(failures, 'redacted_sample_sha256', evidenceSample?.redacted_sample_sha256, actual.redacted_sample_sha256);
  compareField(
    failures,
    'content_sha256_without_identity',
    evidenceSample?.content_sha256_without_identity,
    actual.content_sha256_without_identity,
  );
  compareField(failures, 'source_channel', evidenceSample?.source_channel, actual.source_channel);
  compareField(failures, 'idempotency_key', evidenceSample?.idempotency_key, actual.idempotency_key);
  compareField(failures, 'merchant_name', evidenceSample?.merchant_name, actual.merchant_name);
  compareField(failures, 'receipt_number', evidenceSample?.receipt_number, actual.receipt_number);
  compareField(failures, 'external_event_id', evidenceSample?.external_event_id, actual.external_event_id);
  compareField(failures, 'original_receipt_number', evidenceSample?.original_receipt_number, actual.original_receipt_number);
  compareField(failures, 'original_external_event_id', evidenceSample?.original_external_event_id, actual.original_external_event_id);
  compareField(failures, 'purchase_at', evidenceSample?.purchase_at, actual.purchase_at);
  compareField(failures, 'total_inc_gst_cents', evidenceSample?.total_inc_gst_cents, actual.total_inc_gst_cents);
  compareField(failures, 'line_count', evidenceSample?.line_count, actual.line_count);

  return buildMatch(eventType, evidenceSample, actual, failures);
}

function buildMatch(eventType, evidenceSample, actual, failures) {
  return {
    ok: failures.length === 0,
    event_type: eventType,
    evidence: {
      file: evidenceSample?.file ?? null,
      source_channel: evidenceSample?.source_channel ?? null,
      idempotency_key: evidenceSample?.idempotency_key ?? null,
      merchant_name: evidenceSample?.merchant_name ?? null,
      receipt_number: evidenceSample?.receipt_number ?? null,
      external_event_id: evidenceSample?.external_event_id ?? null,
      original_receipt_number: evidenceSample?.original_receipt_number ?? null,
      original_external_event_id: evidenceSample?.original_external_event_id ?? null,
      purchase_at: evidenceSample?.purchase_at ?? null,
      total_inc_gst_cents: evidenceSample?.total_inc_gst_cents ?? null,
      line_count: evidenceSample?.line_count ?? null,
      redacted_sample_sha256: evidenceSample?.redacted_sample_sha256 ?? null,
      content_sha256_without_identity: evidenceSample?.content_sha256_without_identity ?? null,
    },
    actual,
    failures,
  };
}

function compareField(failures, name, expected, actual) {
  if (expected == null) return;
  if (expected !== actual) failures.push(`${name} mismatch`);
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

export function redactSecrets(value) {
  return String(value)
    .replace(/llp_[^\s"',}]+/g, 'llp_[redacted]')
    .replace(/rhp_[^\s"',}]+/g, 'rhp_[redacted]');
}

export function containsUnredactedSecret(text) {
  return /llp_(?!\[redacted\])[^"\s',}]+\.[^"\s',}]+/.test(text) ||
    /rhp_(?!\[redacted\])[^"\s',}]+\.[^"\s',}]+/.test(text);
}

function normalizeDateTime(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}
