#!/usr/bin/env node
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

const goLiveRoot = process.env.LOOPLET_PILOT_BUNDLE_GO_LIVE_TRIAL_DIR ||
  join('.claude', 'scratch', 'pos-pilot-bundle-go-live-trial');
const evidenceFile = join(goLiveRoot, 'pos-pilot-evidence.json');
const siteFile = join(goLiveRoot, 'pilot-site.json');
const fitFile = join(goLiveRoot, 'pos-integration-profile.json');
const saleFile = join(goLiveRoot, 'field-sale.json');
const refundFile = join(goLiveRoot, 'field-refund.json');
const voidFile = join(goLiveRoot, 'field-void.json');
const reportFile = join(goLiveRoot, 'pos-pilot-report.json');
const reportMarkdownFile = join(goLiveRoot, 'pos-pilot-report.md');
const bundleOutputFile = join(goLiveRoot, 'pos-pilot-bundle.json');
const badSiteFile = join(goLiveRoot, 'bundle-bad-site.json');
const leakedReportMarkdownFile = join(goLiveRoot, 'bundle-leaked-report.md');

async function main() {
  await runNode(['examples/pos-bridge/pilot-go-live-trial.mjs'], 0, {
    LOOPLET_PILOT_GO_LIVE_TRIAL_DIR: goLiveRoot,
  });

  const validBundle = await runBundle([
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
    bundleOutputFile,
  ], 0);
  assert(validBundle.ok === true, 'valid bundle should pass');
  assert(validBundle.summary.verifier_ok === true, 'valid bundle should prove strict verifier');
  assert(validBundle.summary.field_file_reconciliation_ok === true, 'valid bundle should prove field reconciliation');
  assert(validBundle.summary.report_ok === true, 'valid bundle should prove report');
  assert(validBundle.summary.api_request_log_ok === true, 'valid bundle should prove API request log');
  const bundleOutput = JSON.parse(await readFile(bundleOutputFile, 'utf8'));
  assert(bundleOutput.ok === true, 'valid bundle should write output JSON');

  const site = JSON.parse(await readFile(siteFile, 'utf8'));
  await writeFile(badSiteFile, `${JSON.stringify({ ...site, merchant_name: 'Wrong Merchant' }, null, 2)}\n`);
  const mismatchedSite = await runBundle([
    '--evidence',
    evidenceFile,
    '--site',
    badSiteFile,
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
  ], 1);
  assert(mismatchedSite.ok === false, 'mismatched site archive should fail');
  assert(
    mismatchedSite.failures.some((failure) => failure.includes('merchant_name')),
    'mismatched site failure should name merchant mismatch',
  );

  await copyFile(reportMarkdownFile, leakedReportMarkdownFile);
  await writeFile(leakedReportMarkdownFile, `${await readFile(reportMarkdownFile, 'utf8')}\nllp_trial.secret\n`);
  const leakedReport = await runBundle([
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
    leakedReportMarkdownFile,
  ], 1);
  assert(leakedReport.ok === false, 'leaked report should fail');
  assert(
    leakedReport.failures.some((failure) => failure.includes('unredacted Looplet secrets')),
    'leaked report failure should name secret leak',
  );

  console.log(JSON.stringify({
    ok: true,
    valid_bundle_passed: validBundle.ok === true,
    verifier_ok: validBundle.summary.verifier_ok,
    field_file_reconciliation_ok: validBundle.summary.field_file_reconciliation_ok,
    report_ok: validBundle.summary.report_ok,
    api_request_log_ok: validBundle.summary.api_request_log_ok,
    bundle_output_written: bundleOutput.ok === true,
    mismatched_site_rejected: mismatchedSite.ok === false,
    leaked_report_rejected: leakedReport.ok === false,
  }, null, 2));
}

async function runBundle(args, expectedCode) {
  const run = await runNode(['examples/pos-bridge/pilot-bundle.mjs', ...args], expectedCode);
  return JSON.parse(run.stdout || run.stderr);
}

async function runNode(args, expectedCode, env = {}) {
  const result = await run(process.execPath, args, env);
  if (result.code !== expectedCode) {
    throw new Error(`node ${args.join(' ')} exited ${result.code}, expected ${expectedCode}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return result;
}

function run(command, args, env = {}) {
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
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
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
