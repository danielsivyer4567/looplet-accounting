#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import process from 'node:process';
import { containsUnredactedSecret } from './field-sample-reconciliation.mjs';

async function main() {
  const args = process.argv.slice(2);
  const options = parseOptions(args);
  if (args.length > 0 || !options.evidence || !options.site || !options.fit || !options.sale || !options.refund || !options.void) {
    throw new Error(usage());
  }

  const failures = [];
  const [evidence, site, fitProfile] = await Promise.all([
    readJson(options.evidence, 'evidence', failures),
    readJson(options.site, 'site manifest', failures),
    readJson(options.fit, 'integration fit profile', failures),
  ]);
  const fit = await runJson(['integration-fit.mjs', options.fit]);
  if (fit.exit_code !== 0 || fit.ok !== true) {
    failures.push('archived integration fit profile must pass integration-fit.mjs');
  }

  const verifier = await runJson([
    'verify-pilot-evidence.mjs',
    options.evidence,
    '--sale',
    options.sale,
    '--refund',
    options.refund,
    '--void',
    options.void,
  ]);
  if (verifier.exit_code !== 0 || verifier.ok !== true) {
    failures.push('strict evidence verifier must pass with sale/refund/void field files');
  }

  const report = options.reportJson
    ? await readJson(options.reportJson, 'pilot report JSON', failures)
    : await runJson(['pilot-report.mjs', options.evidence]);
  if (!options.reportJson && (report.exit_code !== 0 || report.ok !== true)) {
    failures.push('pilot report generation must pass');
  }
  if (options.reportJson && report?.ok !== true) {
    failures.push('pilot report JSON must have ok=true');
  }

  const markdownText = options.reportMarkdown
    ? await readText(options.reportMarkdown, 'pilot report markdown', failures)
    : null;
  if (markdownText && !markdownText.includes('Verdict: go-live-evidence-ready')) {
    failures.push('pilot report markdown must include the go-live-evidence-ready verdict');
  }
  if (options.reportJson) await assertNoSecrets(options.reportJson, 'pilot report JSON', failures);
  if (options.reportMarkdown) await assertNoSecrets(options.reportMarkdown, 'pilot report markdown', failures);

  compareBundleIdentity({ evidence, site, fit, fitProfile, report, verifier, failures });

  const result = {
    ok: failures.length === 0,
    checked_at: new Date().toISOString(),
    files: {
      evidence: options.evidence,
      site: options.site,
      fit: options.fit,
      sale: options.sale,
      refund: options.refund,
      void: options.void,
      report_json: options.reportJson ?? null,
      report_markdown: options.reportMarkdown ?? null,
    },
    summary: {
      verifier_ok: verifier.ok === true,
      field_file_reconciliation_ok: verifier.summary?.field_file_reconciliation_ok === true,
      fit_profile_readable: Boolean(fitProfile),
      integration_fit_ok: fit.ok === true,
      report_ok: report?.ok === true,
      report_verdict: report?.verdict ?? null,
      connector_mode: evidence?.site?.connector_mode ?? site?.connector_mode ?? null,
      receipt_source_format: evidence?.site?.receipt_source_format ?? site?.receipt_source_format ?? null,
      field_sample_capture_method: evidence?.site?.field_sample_capture_method ?? site?.field_sample_capture_method ?? null,
      sale_refund_void_present: verifier.summary?.field_samples_ok === true &&
        verifier.summary?.field_samples_refund_void_link_sale === true,
      api_request_log_ok: verifier.summary?.api_request_log_ok === true,
      persistence_checked: verifier.summary?.persistence_checked === true,
      reports_redacted: reportsRedacted(options, markdownText),
    },
    failures,
  };
  await writeJsonOutput(result, options.output);
  if (!result.ok) process.exit(1);
}

function compareBundleIdentity({ evidence, site, fit, fitProfile, report, verifier, failures }) {
  if (!evidence || !site || !fitProfile) return;
  checkSame(evidence.site?.business_name, site.business_name, 'evidence site business_name must match archived site manifest', failures);
  checkSame(evidence.site?.merchant_name, site.merchant_name, 'evidence site merchant_name must match archived site manifest', failures);
  checkSame(evidence.site?.pilot_id, site.pilot_id, 'evidence site pilot_id must match archived site manifest', failures);
  checkSame(evidence.site?.looplet_organization_id, site.looplet_organization_id, 'evidence site organization id must match archived site manifest', failures);
  checkSame(evidence.integration_fit?.recommendation?.connector_mode, site.connector_mode, 'integration fit connector mode must match archived site manifest', failures);
  checkSame(evidence.integration_fit?.recommendation?.receipt_source_format, site.receipt_source_format, 'integration fit receipt source format must match archived site manifest', failures);
  checkSame(evidence.integration_fit?.recommendation?.field_sample_capture_method, site.field_sample_capture_method, 'integration fit field capture method must match archived site manifest', failures);
  checkSame(fit.recommendation?.connector_mode, site.connector_mode, 'archived fit connector mode must match archived site manifest', failures);
  checkSame(fit.recommendation?.receipt_source_format, site.receipt_source_format, 'archived fit receipt source format must match archived site manifest', failures);
  checkSame(fit.recommendation?.field_sample_capture_method, site.field_sample_capture_method, 'archived fit field capture method must match archived site manifest', failures);
  checkSame(report?.pilot?.pilot_id, site.pilot_id, 'pilot report pilot_id must match archived site manifest', failures);
  if (verifier.summary?.verification_mode !== 'field-files') {
    failures.push('strict verifier must run in field-files mode, not evidence-only mode');
  }
}

function checkSame(actual, expected, message, failures) {
  if (actual == null || expected == null || String(actual).trim() !== String(expected).trim()) {
    failures.push(message);
  }
}

function reportsRedacted(options, markdownText) {
  return Boolean(options.reportJson || options.reportMarkdown) &&
    (!markdownText || !containsUnredactedSecret(markdownText));
}

async function readJson(file, label, failures) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    failures.push(`${label} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function readText(file, label, failures) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    failures.push(`${label} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function assertNoSecrets(file, label, failures) {
  const text = await readText(file, label, failures);
  if (text && containsUnredactedSecret(text)) failures.push(`${label} must not contain unredacted Looplet secrets`);
}

function parseOptions(args) {
  const options = {};
  while (args.length > 0) {
    const flag = args.shift();
    if (!flag?.startsWith('--')) break;
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error(usage());
    switch (flag) {
      case '--evidence':
        options.evidence = value;
        break;
      case '--site':
        options.site = value;
        break;
      case '--fit':
        options.fit = value;
        break;
      case '--sale':
        options.sale = value;
        break;
      case '--refund':
        options.refund = value;
        break;
      case '--void':
        options.void = value;
        break;
      case '--report-json':
        options.reportJson = value;
        break;
      case '--report-markdown':
        options.reportMarkdown = value;
        break;
      case '--output':
        options.output = value;
        break;
      default:
        throw new Error(usage());
    }
  }
  return options;
}

async function runJson(commandArgs) {
  const child = spawn(process.execPath, commandArgs.map(resolveLocal), {
    cwd: process.cwd(),
    env: process.env,
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
  const exitCode = await new Promise((resolve) => child.on('exit', resolve));
  const parsed = parseJsonOutput(stdout);
  return {
    exit_code: exitCode,
    ...(parsed ?? { ok: false, error: stderr.trim() || stdout.trim() || 'command did not emit JSON' }),
  };
}

function parseJsonOutput(stdout) {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    return JSON.parse(text.slice(start, end + 1));
  }
}

function resolveLocal(value) {
  if (value.endsWith('.mjs')) return `${scriptDir()}${value}`;
  return value;
}

function scriptDir() {
  return new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:\/)/, '$1');
}

async function writeJsonOutput(result, output) {
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (output) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, json);
  }
  console.log(json.trimEnd());
}

function usage() {
  return 'usage: node pilot-bundle.mjs --evidence pos-pilot-evidence.json --site pos-pilot-site.json --fit pos-integration-profile.json --sale field-sale.json --refund field-refund.json --void field-void.json [--report-json pos-pilot-report.json --report-markdown pos-pilot-report.md] [--output pos-pilot-bundle.json]';
}

await main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});
