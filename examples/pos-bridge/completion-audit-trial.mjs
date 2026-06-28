#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

const rootDir = join('.claude', 'scratch', 'pos-completion-audit-trial');
const goLiveRoot = process.env.LOOPLET_COMPLETION_AUDIT_GO_LIVE_TRIAL_DIR ||
  join('.claude', 'scratch', 'pos-completion-audit-go-live-trial');
const localOkFile = join(rootDir, 'local-ok.json');
const localWeakFile = join(rootDir, 'local-weak.json');
const localOnlyOutputFile = join(rootDir, 'local-only-audit.json');
const productionOutputFile = join(rootDir, 'production-audit.json');
const evidenceFile = join(goLiveRoot, 'pos-pilot-evidence.json');
const siteFile = join(goLiveRoot, 'pilot-site.json');
const fitFile = join(goLiveRoot, 'pos-integration-profile.json');
const saleFile = join(goLiveRoot, 'field-sale.json');
const refundFile = join(goLiveRoot, 'field-refund.json');
const voidFile = join(goLiveRoot, 'field-void.json');
const reportFile = join(goLiveRoot, 'pos-pilot-report.json');
const reportMarkdownFile = join(goLiveRoot, 'pos-pilot-report.md');

async function main() {
  await mkdir(rootDir, { recursive: true });
  await writeFile(localOkFile, `${JSON.stringify(localTrial({}), null, 2)}\n`);
  await writeFile(localWeakFile, `${JSON.stringify(localTrial({ bad_line_quantity_rejected: false }), null, 2)}\n`);

  const localOnly = await runAudit(['--local-json', localOkFile, '--output', localOnlyOutputFile], 0);
  assert(localOnly.ok === true, 'local-only audit should pass when local proof is complete');
  assert(localOnly.local_ready === true, 'local-only audit should report local_ready');
  assert(localOnly.production_ready === false, 'local-only audit should not report production ready');
  assert(localOnly.remaining.length === 3, 'local-only audit should name remaining pilot work');
  assert(localOnly.failures.length === 0, 'local-only audit should not list missing pilot bundle as a failure');
  const localOnlyOutput = JSON.parse(await readFile(localOnlyOutputFile, 'utf8'));
  assert(localOnlyOutput.ok === true, 'local-only audit should write output JSON');
  assert(localOnlyOutput.failures.length === 0, 'local-only output JSON should keep failures empty');

  const requireProduction = await runAudit(['--local-json', localOkFile, '--require-production'], 1);
  assert(requireProduction.local_ready === true, 'require-production audit should keep local readiness');
  assert(requireProduction.production_ready === false, 'require-production audit should fail production readiness without bundle');
  assert(
    requireProduction.failures.some((failure) => failure.includes('pilot bundle was not supplied')),
    'require-production audit should name the missing pilot bundle',
  );

  const weakLocal = await runAudit(['--local-json', localWeakFile], 1);
  assert(weakLocal.local_ready === false, 'weak local proof should fail local readiness');
  assert(
    weakLocal.failures.some((failure) => failure.includes('bad_line_quantity_rejected')),
    'weak local proof should name the missing bad-line-quantity proof',
  );

  await runNode(['examples/pos-bridge/pilot-go-live-trial.mjs'], 0, {
    LOOPLET_PILOT_GO_LIVE_TRIAL_DIR: goLiveRoot,
  });
  const productionReady = await runAudit([
    '--local-json',
    localOkFile,
    '--require-production',
    '--evidence',
    evidenceFile,
    '--site',
    siteFile,
    '--fit',
    fitFile,
    '--sale',
    saleFile,
    '--refund',
    refundFile,
    '--void',
    voidFile,
    '--report-json',
    reportFile,
    '--report-markdown',
    reportMarkdownFile,
    '--output',
    productionOutputFile,
  ], 0);
  assert(productionReady.ok === true, 'complete synthetic bundle should pass production audit');
  assert(productionReady.local_ready === true, 'complete synthetic bundle should keep local readiness');
  assert(productionReady.production_ready === true, 'complete synthetic bundle should report production readiness');
  assert(productionReady.remaining.length === 0, 'complete synthetic bundle should leave no remaining audit work');
  assert(productionReady.summary.pilot_bundle_ok === true, 'complete synthetic bundle should prove pilot bundle');
  const productionOutput = JSON.parse(await readFile(productionOutputFile, 'utf8'));
  assert(productionOutput.production_ready === true, 'production audit should write output JSON');

  console.log(JSON.stringify({
    ok: true,
    local_only_passed: localOnly.ok === true,
    local_only_production_ready_false: localOnly.production_ready === false,
    local_only_failures_empty: localOnly.failures.length === 0,
    local_only_output_written: localOnlyOutput.ok === true,
    require_production_rejected_without_bundle: requireProduction.ok === false,
    weak_local_rejected: weakLocal.ok === false,
    synthetic_production_bundle_passed: productionReady.production_ready === true,
    synthetic_production_output_written: productionOutput.production_ready === true,
  }, null, 2));
}

async function runAudit(args, expectedCode) {
  const result = await runNode(['examples/pos-bridge/completion-audit.mjs', ...args], expectedCode);
  return JSON.parse(result.stdout || result.stderr);
}

async function runNode(args, expectedCode, env = {}) {
  const result = await runProcess(process.execPath, args, env);
  if (result.code !== expectedCode) {
    throw new Error(`node ${args.join(' ')} exited ${result.code}, expected ${expectedCode}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return result;
}

function runProcess(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function localTrial(overrides) {
  return {
    ok: true,
    isolated_supabase: {
      reset_to_latest_migration: true,
      remaining_running_containers: 0,
    },
    local_edge: {
      duplicate_returned_same_event: true,
      partial_duplicate_incomplete_rejected: true,
      bad_line_quantity_rejected: true,
      post_event_insert_failure_cleanup_ok: true,
      idempotency_mismatch_rejected: true,
      idempotency_tax_mismatch_rejected: true,
      idempotency_purchase_at_mismatch_rejected: true,
      idempotency_source_mismatch_rejected: true,
      cross_org_identity_rejected: true,
      reverse_cross_org_identity_rejected: true,
      missing_payment_reference_rejected: true,
      bad_payment_last4_rejected: true,
      missing_purchase_at_rejected: true,
      bad_purchase_at_rejected: true,
      api_request_log_ok: true,
      raw_payload_identity_token_stripped: true,
      refund_linked: true,
      void_linked: true,
      refund_same_receipt_number_accepted: true,
      void_same_receipt_number_accepted: true,
      other_org_receipt_events: 0,
      cleanup_ok: true,
      cleanup_no_leak: true,
      ...overrides,
    },
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

await main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});
