#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';

const rootDir = '.claude/scratch/pos-pilot-report-trial';
const validEvidenceFile = join(rootDir, 'valid-evidence.json');
const diagnosticEvidenceFile = join(rootDir, 'diagnostic-evidence.json');
const leakedEvidenceFile = join(rootDir, 'leaked-evidence.json');
const wrongApiLogFile = join(rootDir, 'wrong-api-log.json');
const reportFile = join(rootDir, 'pilot-report.json');
const markdownFile = join(rootDir, 'pilot-report.md');

await rm(rootDir, { recursive: true, force: true });
await mkdir(rootDir, { recursive: true });

const validEvidence = buildValidEvidence();
await writeFile(validEvidenceFile, `${JSON.stringify(validEvidence, null, 2)}\n`);
await writeFile(diagnosticEvidenceFile, `${JSON.stringify({
  ...validEvidence,
  ok: false,
  non_sending: true,
  acceptance: { skipped: true, reason: 'acceptance not requested' },
}, null, 2)}\n`);
await writeFile(leakedEvidenceFile, `${JSON.stringify({
  ...validEvidence,
  support_notes: 'operator accidentally pasted llp_trial.secret and rhp_trial.receiptsecret',
}, null, 2)}\n`);
const wrongApiLogEvidence = JSON.parse(JSON.stringify(validEvidence));
wrongApiLogEvidence.acceptance.persistence.api_request_log.key_prefix_matches = false;
await writeFile(wrongApiLogFile, `${JSON.stringify(wrongApiLogEvidence, null, 2)}\n`);

const valid = await runReport(validEvidenceFile, 0, ['--output', reportFile, '--markdown', markdownFile]);
const diagnostic = await runReport(diagnosticEvidenceFile, 1);
const leaked = await runReport(leakedEvidenceFile, 1);
const wrongApiLog = await runReport(wrongApiLogFile, 1);
const parsed = JSON.parse(valid.stdout);
const written = JSON.parse(await readFile(reportFile, 'utf8'));
const markdown = await readFile(markdownFile, 'utf8');
const diagnosticParsed = JSON.parse(diagnostic.stdout);
const leakedParsed = JSON.parse(leaked.stdout);
const wrongApiLogParsed = JSON.parse(wrongApiLog.stdout);

assert(parsed.ok === true, 'valid report should pass');
assert(parsed.verdict === 'go-live-evidence-ready', 'valid report should mark evidence ready');
assert(parsed.connector.field_sample_capture_method === 'pos_native_json_export', 'report should include field sample capture method');
assert(parsed.field_samples.sale_refund_void_present === true, 'report should prove sale/refund/void field samples');
assert(parsed.acceptance.duplicate_sale_retry_same_event === true, 'report should prove duplicate idempotency');
assert(parsed.acceptance.refund_linked_to_sale === true, 'report should prove refund link');
assert(parsed.acceptance.void_linked_to_sale === true, 'report should prove void link');
assert(parsed.api_request_log.ok === true, 'report should prove API request log');
assert(parsed.api_request_log.key_prefix_matches === true, 'report should prove API log key prefix match');
assert(written.ok === true, 'written report should pass');
assert(markdown.includes('Verdict: go-live-evidence-ready'), 'markdown report should include verdict');
assert(!valid.stdout.includes('llp_trial.secret'), 'report stdout must not expose API key');
assert(!valid.stdout.includes('rhp_trial.receiptsecret'), 'report stdout must not expose receipt identity');
assert(!markdown.includes('llp_trial.secret'), 'markdown report must not expose API key');
assert(!markdown.includes('rhp_trial.receiptsecret'), 'markdown report must not expose receipt identity');
assert(diagnosticParsed.ok === false, 'diagnostic evidence should fail report');
assert(
  diagnosticParsed.failures.some((failure) => failure.includes('receipt-sending acceptance')),
  'diagnostic evidence should fail with receipt-sending reason',
);
assert(leakedParsed.ok === false, 'leaked evidence should fail report');
assert(
  leakedParsed.failures.some((failure) => failure.includes('unredacted Looplet secrets')),
  'leaked evidence should fail with secret reason',
);
assert(!leaked.stdout.includes('llp_trial.secret'), 'leaked report stdout must redact API key');
assert(!leaked.stdout.includes('rhp_trial.receiptsecret'), 'leaked report stdout must redact receipt token');
assert(wrongApiLogParsed.ok === false, 'wrong API log key prefix should fail report');
assert(
  wrongApiLogParsed.failures.some((failure) => failure.includes('API request log proof')),
  'wrong API log key prefix should fail with API log proof reason',
);

console.log(JSON.stringify({
  ok: true,
  valid_report_passed: parsed.ok === true,
  diagnostic_evidence_rejected: diagnosticParsed.ok === false,
  leaked_secret_rejected: leakedParsed.ok === false,
  wrong_api_log_rejected: wrongApiLogParsed.ok === false,
  report_file: reportFile,
  markdown_file: markdownFile,
  secrets_redacted: true,
}, null, 2));

function buildValidEvidence() {
  return {
    ok: true,
    collected_at: '2026-06-28T03:20:00.000Z',
    non_sending: false,
    site: {
      provided: true,
      ok: true,
      business_name: 'Valid Pilot Pty Ltd',
      merchant_name: 'Valid Merchant',
      pilot_id: 'valid-pilot-001',
      pilot_window_start: '2026-06-28T13:00:00+10:00',
      pilot_window_end: '2026-06-28T13:40:00+10:00',
      pos_vendor: 'Looplet trial POS',
      pos_product: 'Looplet POS bridge fixture',
      pos_version: 'trial',
      connector_mode: 'bridge_watch_folder',
      identity_capture_method: 'barcode_scan',
      receipt_trigger: 'pos_completed_tender',
      receipt_source_format: 'pos_json_export',
      field_sample_capture_method: 'pos_native_json_export',
      looplet_organization_id: '22222222-2222-4222-8222-222222222222',
    },
    integration_fit: {
      ok: true,
      recommendation: {
        connector_mode: 'bridge_watch_folder',
        identity_capture_method: 'barcode_scan',
        receipt_trigger: 'pos_completed_tender',
        receipt_source_format: 'pos_json_export',
        field_sample_capture_method: 'pos_native_json_export',
      },
    },
    readiness: { ok: true },
    status: {
      ok: true,
      scheduler: {
        ok: true,
        configured: true,
        last_run_at: '2026-06-28T03:18:00.000Z',
        last_exit_code: 0,
      },
      local_file_protection: {
        ok: true,
        checked_count: 4,
      },
    },
    credential_probe: {
      ok: true,
      receipt_persisted: false,
    },
    bridge_retry_drill: {
      ok: true,
      queued_after_outage: true,
      queue_flushed_after_recovery: true,
    },
    field_samples: {
      ok: true,
      samples: [
        fieldSample('sale', 'FIELD-SALE-1', 'field-sale-1'),
        fieldSample('refund', 'FIELD-REFUND-1', 'field-refund-1', 'FIELD-SALE-1', 'field-sale-1'),
        fieldSample('void', 'FIELD-VOID-1', 'field-void-1', 'FIELD-SALE-1', 'field-sale-1'),
      ],
    },
    acceptance: {
      ok: true,
      checks: {
        sale: { receipt_event_id: 'sale-event-1' },
        duplicate: { receipt_event_id: 'sale-event-1' },
        refund: { receipt_event_id: 'refund-event-1', related_receipt_event_id: 'sale-event-1' },
        refund_duplicate: { receipt_event_id: 'refund-event-1' },
        void: { receipt_event_id: 'void-event-1', related_receipt_event_id: 'sale-event-1' },
        void_duplicate: { receipt_event_id: 'void-event-1' },
        idempotency_mismatch_rejection: { status: 400 },
        idempotency_tax_mismatch_rejection: { status: 400 },
        idempotency_purchase_at_mismatch_rejection: { status: 400 },
        idempotency_source_mismatch_rejection: { status: 400 },
        missing_payment_reference_rejection: { status: 400 },
        bad_payment_last4_rejection: { status: 400 },
        missing_purchase_at_rejection: { status: 400 },
        bad_purchase_at_rejection: { status: 400 },
      },
      persistence: {
        checked: true,
        organization_id: '22222222-2222-4222-8222-222222222222',
        receipt_events: {
          rejected_negative_controls: 0,
        },
        api_request_log: {
          total: 18,
          post_count: 18,
          success_count: 6,
          validation_error_count: 12,
          key_prefix_matches: true,
          ingest_type_values: ['receipt'],
        },
      },
    },
  };
}

function fieldSample(eventType, receiptNumber, externalEventId, originalReceiptNumber = null, originalExternalEventId = null) {
  return {
    ok: true,
    event_type: eventType,
    file: `field-${eventType}.json`,
    merchant_name: 'Valid Merchant',
    merchant_name_matches_site: true,
    receipt_number: receiptNumber,
    external_event_id: externalEventId,
    original_receipt_number: originalReceiptNumber,
    original_external_event_id: originalExternalEventId,
    original_reference_matches_sale: eventType === 'sale' ? null : true,
    identity_token_source: 'receipt',
    redacted_sample_sha256: 'a'.repeat(64),
    content_sha256_without_identity: 'b'.repeat(64),
    purchase_at: '2026-06-28T03:15:00.000Z',
    within_pilot_window: true,
    line_count: 1,
    total_inc_gst_cents: eventType === 'sale' ? 36000 : eventType === 'refund' ? 6000 : 0,
    bundled_sample: false,
  };
}

async function runReport(file, expectedCode, extraArgs = []) {
  const child = spawn(process.execPath, ['examples/pos-bridge/pilot-report.mjs', file, ...extraArgs], {
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
    throw new Error(`pilot-report exited ${code}, expected ${expectedCode}\nstdout=${stdout}\nstderr=${stderr}`);
  }
  return { stdout, stderr };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
