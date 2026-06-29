#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';
import { containsUnredactedSecret, redactSecrets } from './field-sample-reconciliation.mjs';

async function main() {
  const args = process.argv.slice(2);
  const evidenceFile = args.shift();
  if (!evidenceFile) throw new Error(usage());
  const outputFile = readOption(args, '--output');
  const markdownFile = readOption(args, '--markdown');
  if (args.length > 0) throw new Error(usage());

  const evidenceText = await readFile(evidenceFile, 'utf8');
  const evidence = JSON.parse(evidenceText);
  const report = buildReport(evidence, evidenceFile, evidenceText);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (containsUnredactedSecret(json)) {
    throw new Error('internal error: pilot report would expose an unredacted Looplet secret');
  }

  if (outputFile) {
    await mkdir(dirname(outputFile), { recursive: true });
    await writeFile(outputFile, json);
  }
  if (markdownFile) {
    const markdown = buildMarkdown(report);
    if (containsUnredactedSecret(markdown)) {
      throw new Error('internal error: pilot report markdown would expose an unredacted Looplet secret');
    }
    await mkdir(dirname(markdownFile), { recursive: true });
    await writeFile(markdownFile, markdown);
  }

  console.log(json.trimEnd());
  if (!report.ok) process.exit(1);
}

function buildReport(evidence, evidenceFile, evidenceText) {
  const failures = [];
  const check = (condition, message) => {
    if (!condition) failures.push(message);
  };
  const site = evidence?.site ?? {};
  const acceptance = evidence?.acceptance ?? {};
  const checks = acceptance.checks ?? {};
  const persistence = acceptance.persistence ?? {};
  const apiLog = persistence.api_request_log ?? {};
  const localBridge = ['bridge_watch_folder', 'bridge_csv_export'].includes(site.connector_mode);

  check(!containsUnredactedSecret(evidenceText), 'evidence file contains unredacted Looplet secrets');
  check(evidence?.ok === true, 'pilot evidence ok must be true');
  check(evidence?.non_sending === false, 'go-live report requires receipt-sending acceptance evidence');
  check(site?.provided === true && site?.ok === true, 'site manifest must be present and valid');
  check(evidence?.integration_fit?.ok === true, 'integration fit must pass');
  check(evidence?.readiness?.ok === true, 'readiness must pass');
  check(evidence?.status?.ok === true, 'bridge status must be clean');
  check(evidence?.field_samples?.ok === true, 'field sale/refund/void samples must pass');
  check(acceptance?.ok === true && acceptance?.skipped !== true, 'acceptance run must pass and must not be skipped');
  check(evidence?.credential_probe?.ok === true, 'credential probe must prove API key/scope before persistence');
  check(evidence?.credential_probe?.receipt_persisted === false, 'credential probe must not persist a receipt');
  if (localBridge) {
    check(evidence?.status?.scheduler?.ok === true, 'local bridge scheduled-task status must be healthy');
    check(evidence?.status?.local_file_protection?.ok === true, 'local bridge file protection must pass');
    check(evidence?.bridge_retry_drill?.ok === true, 'local bridge retry drill must pass');
  }
  check(apiRequestLogReady(apiLog), 'receipt-webhook API request log proof must be present');
  check(persistence?.checked === true, 'persistence readback must be checked');
  check(persistence?.receipt_events?.rejected_negative_controls === 0, 'negative controls must not persist receipts');

  const sale = checks.sale ?? {};
  const refund = checks.refund ?? {};
  const refundDuplicate = checks.refund_duplicate ?? {};
  const voidReceipt = checks.void ?? {};
  const voidDuplicate = checks.void_duplicate ?? {};
  check(Boolean(sale.receipt_event_id), 'sale acceptance must create a receipt_event_id');
  check(checks.duplicate?.receipt_event_id === sale.receipt_event_id, 'duplicate sale retry must return same event');
  check(refund.related_receipt_event_id === sale.receipt_event_id, 'refund must link to sale event');
  check(refundDuplicate.receipt_event_id === refund.receipt_event_id, 'refund duplicate retry must return same event');
  check(voidReceipt.related_receipt_event_id === sale.receipt_event_id, 'void must link to sale event');
  check(voidDuplicate.receipt_event_id === voidReceipt.receipt_event_id, 'void duplicate retry must return same event');

  return redactDeep({
    ok: failures.length === 0,
    generated_at: new Date().toISOString(),
    evidence_file: evidenceFile,
    verdict: failures.length === 0 ? 'go-live-evidence-ready' : 'not-go-live-ready',
    failures,
    pilot: {
      business_name: site.business_name ?? null,
      merchant_name: site.merchant_name ?? null,
      pilot_id: site.pilot_id ?? null,
      pilot_window_start: site.pilot_window_start ?? null,
      pilot_window_end: site.pilot_window_end ?? null,
      organization_id: site.looplet_organization_id ?? persistence.organization_id ?? null,
      collected_at: evidence?.collected_at ?? null,
    },
    connector: {
      pos_vendor: site.pos_vendor ?? null,
      pos_product: site.pos_product ?? null,
      pos_version: site.pos_version ?? null,
      connector_mode: site.connector_mode ?? null,
      identity_capture_method: site.identity_capture_method ?? null,
      receipt_trigger: site.receipt_trigger ?? null,
      receipt_source_format: site.receipt_source_format ?? null,
      field_sample_capture_method: site.field_sample_capture_method ?? null,
      integration_fit_ok: evidence?.integration_fit?.ok === true,
    },
    local_bridge: localBridge
      ? {
          scheduler_ok: evidence?.status?.scheduler?.ok === true,
          scheduler_last_run_at: evidence?.status?.scheduler?.last_run_at ?? null,
          scheduler_last_exit_code: evidence?.status?.scheduler?.last_exit_code ?? null,
          local_file_protection_ok: evidence?.status?.local_file_protection?.ok === true,
          local_file_protection_checked_count: Number(evidence?.status?.local_file_protection?.checked_count ?? 0),
          retry_drill_ok: evidence?.bridge_retry_drill?.ok === true,
          queued_after_outage: evidence?.bridge_retry_drill?.queued_after_outage === true,
          queue_flushed_after_recovery: evidence?.bridge_retry_drill?.queue_flushed_after_recovery === true,
        }
      : { required: false },
    field_samples: summarizeFieldSamples(evidence?.field_samples),
    acceptance: {
      ok: acceptance?.ok === true,
      persistence_checked: persistence?.checked === true,
      duplicate_sale_retry_same_event: checks.duplicate?.receipt_event_id === sale.receipt_event_id,
      refund_linked_to_sale: refund.related_receipt_event_id === sale.receipt_event_id,
      refund_duplicate_same_event: refundDuplicate.receipt_event_id === refund.receipt_event_id,
      void_linked_to_sale: voidReceipt.related_receipt_event_id === sale.receipt_event_id,
      void_duplicate_same_event: voidDuplicate.receipt_event_id === voidReceipt.receipt_event_id,
      idempotency_mismatch_rejected: checks.idempotency_mismatch_rejection?.status === 400,
      idempotency_tax_mismatch_rejected: checks.idempotency_tax_mismatch_rejection?.status === 400,
      idempotency_purchase_at_mismatch_rejected: checks.idempotency_purchase_at_mismatch_rejection?.status === 400,
      idempotency_source_mismatch_rejected: checks.idempotency_source_mismatch_rejection?.status === 400,
      missing_payment_reference_rejected: checks.missing_payment_reference_rejection?.status === 400,
      bad_payment_last4_rejected: checks.bad_payment_last4_rejection?.status === 400,
      missing_purchase_at_rejected: checks.missing_purchase_at_rejection?.status === 400,
      bad_purchase_at_rejected: checks.bad_purchase_at_rejection?.status === 400,
      rejected_negative_controls: persistence?.receipt_events?.rejected_negative_controls ?? null,
    },
    api_request_log: {
      ok: apiRequestLogReady(apiLog),
      total: apiLog.total ?? null,
      post_count: apiLog.post_count ?? null,
      success_count: apiLog.success_count ?? null,
      validation_error_count: apiLog.validation_error_count ?? null,
      key_prefix_matches: apiLog.key_prefix_matches === true,
      ingest_type_values: Array.isArray(apiLog.ingest_type_values) ? apiLog.ingest_type_values : [],
    },
  });
}

function summarizeFieldSamples(fieldSamples) {
  const samples = Array.isArray(fieldSamples?.samples) ? fieldSamples.samples : [];
  return {
    ok: fieldSamples?.ok === true,
    count: samples.length,
    sale_refund_void_present: ['sale', 'refund', 'void'].every((eventType) =>
      samples.some((sample) => sample?.event_type === eventType && sample?.ok === true),
    ),
    samples: samples.map((sample) => ({
      event_type: sample?.event_type ?? null,
      file: sample?.file ?? null,
      merchant_name: sample?.merchant_name ?? null,
      receipt_number: sample?.receipt_number ?? null,
      external_event_id: sample?.external_event_id ?? null,
      original_receipt_number: sample?.original_receipt_number ?? null,
      original_external_event_id: sample?.original_external_event_id ?? null,
      identity_token_source: sample?.identity_token_source ?? null,
      redacted_sample_sha256: sample?.redacted_sample_sha256 ?? null,
      content_sha256_without_identity: sample?.content_sha256_without_identity ?? null,
      purchase_at: sample?.purchase_at ?? null,
      line_count: sample?.line_count ?? null,
      total_inc_gst_cents: sample?.total_inc_gst_cents ?? null,
      merchant_name_matches_site: sample?.merchant_name_matches_site ?? null,
      within_pilot_window: sample?.within_pilot_window ?? null,
      original_reference_matches_sale: sample?.original_reference_matches_sale ?? null,
      bundled_sample: sample?.bundled_sample === true,
    })),
  };
}

function apiRequestLogReady(apiLog) {
  return Number(apiLog?.total ?? 0) >= 10 &&
    Number(apiLog?.post_count ?? 0) >= 10 &&
    Number(apiLog?.success_count ?? 0) >= 6 &&
    Number(apiLog?.validation_error_count ?? 0) >= 10 &&
    apiLog?.key_prefix_matches === true &&
    Array.isArray(apiLog?.ingest_type_values) &&
    apiLog.ingest_type_values.length === 1 &&
    apiLog.ingest_type_values[0] === 'receipt';
}

function buildMarkdown(report) {
  const lines = [
    '# Looplet POS Pilot Evidence Report',
    '',
    `Verdict: ${report.verdict}`,
    `Generated: ${report.generated_at}`,
    `Pilot: ${report.pilot.business_name ?? 'unknown'} / ${report.pilot.pilot_id ?? 'unknown'}`,
    `Connector: ${report.connector.connector_mode ?? 'unknown'} (${report.connector.receipt_source_format ?? 'unknown'})`,
    `Field capture: ${report.connector.field_sample_capture_method ?? 'unknown'}`,
    '',
    '## Controls',
    '',
    `- Acceptance: ${yesNo(report.acceptance.ok)}`,
    `- Persistence readback: ${yesNo(report.acceptance.persistence_checked)}`,
    `- API request log: ${yesNo(report.api_request_log.ok)}`,
    `- Duplicate sale retry: ${yesNo(report.acceptance.duplicate_sale_retry_same_event)}`,
    `- Refund linked to sale: ${yesNo(report.acceptance.refund_linked_to_sale)}`,
    `- Void linked to sale: ${yesNo(report.acceptance.void_linked_to_sale)}`,
    `- Negative controls persisted: ${report.acceptance.rejected_negative_controls ?? 'unknown'}`,
    '',
    '## Field Samples',
    '',
    ...report.field_samples.samples.map((sample) =>
      `- ${sample.event_type}: ${sample.file}; receipt ${sample.receipt_number}; fingerprint ${sample.redacted_sample_sha256}`,
    ),
  ];

  if (report.failures.length > 0) {
    lines.push('', '## Failures', '', ...report.failures.map((failure) => `- ${failure}`));
  }
  return `${lines.join('\n')}\n`;
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function yesNo(value) {
  return value === true ? 'yes' : 'no';
}

function redactDeep(value) {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactDeep(entry)]));
  }
  return value;
}

function usage() {
  return 'Usage: node pilot-report.mjs <pos-pilot-evidence.json> [--output report.json] [--markdown report.md]';
}

await main();
