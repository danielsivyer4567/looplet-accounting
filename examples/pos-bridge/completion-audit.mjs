#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const requiredLocalEdgeChecks = [
  'duplicate_returned_same_event',
  'partial_duplicate_incomplete_rejected',
  'bad_line_quantity_rejected',
  'post_event_insert_failure_cleanup_ok',
  'idempotency_mismatch_rejected',
  'idempotency_tax_mismatch_rejected',
  'idempotency_purchase_at_mismatch_rejected',
  'idempotency_source_mismatch_rejected',
  'cross_org_identity_rejected',
  'reverse_cross_org_identity_rejected',
  'missing_payment_reference_rejected',
  'bad_payment_last4_rejected',
  'missing_purchase_at_rejected',
  'bad_purchase_at_rejected',
  'api_request_log_ok',
  'raw_payload_identity_token_stripped',
  'refund_linked',
  'void_linked',
  'refund_same_receipt_number_accepted',
  'void_same_receipt_number_accepted',
  'cleanup_ok',
  'cleanup_no_leak',
];

async function main() {
  const args = process.argv.slice(2);
  const options = parseOptions(args);
  if (args.length > 0) throw new Error(usage());

  const local = options.skipLocal
    ? { skipped: true, ok: false, reason: 'local full-trial skipped' }
    : await loadOrRunLocalTrial(options.localJson);
  const localAssessment = assessLocalTrial(local);
  const bundle = hasBundleOptions(options)
    ? await runPilotBundle(options)
    : { provided: false, ok: false, failures: ['real merchant pilot bundle was not supplied'] };
  const productionReady = bundle.ok === true;
  const productionFailures = productionReady
    ? []
    : bundle.failures ?? ['real merchant pilot bundle has not passed'];
  const failures = [
    ...localAssessment.failures,
    ...(options.requireProduction ? productionFailures : []),
  ];

  const result = {
    ok: localAssessment.local_ready === true && (options.requireProduction ? productionReady : true),
    checked_at: new Date().toISOString(),
    local_ready: localAssessment.local_ready,
    production_ready: productionReady,
    require_production: options.requireProduction,
    summary: {
      local_full_trial_ok: local?.ok === true,
      local_edge: localAssessment.summary,
      pilot_bundle_ok: productionReady,
      pilot_bundle_provided: bundle.provided === true,
    },
    remaining: productionReady
      ? []
      : [
        'Run a real merchant/POS pilot against staging or pilot Looplet.',
        'Capture real sale/refund/void field samples with scanned identity_token.',
        'Run go-live.mjs, pilot-report.mjs, and pilot-bundle.mjs on those real artifacts.',
      ],
    failures,
  };

  await writeJsonOutput(result, options.output);
  if (!result.ok) process.exit(1);
}

function assessLocalTrial(local) {
  const failures = [];
  if (!local || local.ok !== true) {
    failures.push('local full POS trial must pass');
  }
  const localEdge = local?.local_edge ?? {};
  for (const key of requiredLocalEdgeChecks) {
    if (localEdge[key] !== true) failures.push(`local_edge.${key} must be true`);
  }
  if (Number(local?.isolated_supabase?.remaining_running_containers ?? 1) !== 0) {
    failures.push('isolated Supabase full-trial stack must leave zero running containers');
  }
  if (local?.isolated_supabase?.reset_to_latest_migration !== true) {
    failures.push('isolated Supabase full-trial reset must reach latest migration');
  }

  return {
    local_ready: failures.length === 0,
    failures,
    summary: {
      duplicate_retry: localEdge.duplicate_returned_same_event === true,
      partial_duplicate_guard: localEdge.partial_duplicate_incomplete_rejected === true,
      bad_line_quantity_rejected: localEdge.bad_line_quantity_rejected === true,
      cleanup_after_post_event_failure: localEdge.post_event_insert_failure_cleanup_ok === true,
      cross_org_isolation: localEdge.cross_org_identity_rejected === true &&
        localEdge.reverse_cross_org_identity_rejected === true &&
        Number(localEdge.other_org_receipt_events ?? 1) === 0,
      refund_void_linked: localEdge.refund_linked === true && localEdge.void_linked === true,
      api_logs: localEdge.api_request_log_ok === true,
      no_leak: localEdge.cleanup_no_leak === true,
    },
  };
}

async function loadOrRunLocalTrial(localJson) {
  if (localJson) return await readJson(localJson);
  return await runJson([join(scriptDir(), 'full-trial.mjs')]);
}

async function runPilotBundle(options) {
  const args = [
    join(scriptDir(), 'pilot-bundle.mjs'),
    '--evidence',
    options.evidence,
    '--site',
    options.site,
    '--fit',
    options.fit,
    '--sale',
    options.sale,
    '--refund',
    options.refund,
    '--void',
    options.void,
  ];
  if (options.reportJson) args.push('--report-json', options.reportJson);
  if (options.reportMarkdown) args.push('--report-markdown', options.reportMarkdown);
  const result = await runJson(args, { allowFailure: true });
  return {
    provided: true,
    ...result,
  };
}

function hasBundleOptions(options) {
  return Boolean(options.evidence || options.site || options.fit || options.sale || options.refund || options.void);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function runJson(args, options = {}) {
  const run = await runProcess(process.execPath, args);
  const parsed = parseJsonOutput(run.stdout || run.stderr);
  if (run.code !== 0 && options.allowFailure !== true) {
    throw new Error(`node ${args.join(' ')} exited ${run.code}\nstdout=${run.stdout}\nstderr=${run.stderr}`);
  }
  return parsed ?? {
    ok: false,
    exit_code: run.code,
    failures: [`command did not emit JSON: node ${args.join(' ')}`],
  };
}

function runProcess(command, args) {
  const child = spawn(command, args, {
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
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function parseJsonOutput(value) {
  const text = String(value ?? '').trim();
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

async function writeJsonOutput(result, output) {
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (output) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, json);
  }
  console.log(json.trimEnd());
}

function scriptDir() {
  return dirname(fileURLToPath(import.meta.url));
}

function parseOptions(args) {
  const options = {
    requireProduction: false,
    skipLocal: false,
  };
  while (args.length > 0) {
    const flag = args.shift();
    if (!flag?.startsWith('--')) break;
    if (flag === '--require-production') {
      options.requireProduction = true;
      continue;
    }
    if (flag === '--skip-local') {
      options.skipLocal = true;
      continue;
    }

    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error(usage());
    switch (flag) {
      case '--local-json':
        options.localJson = value;
        break;
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

  if (hasBundleOptions(options)) {
    const missing = ['evidence', 'site', 'fit', 'sale', 'refund', 'void'].filter((key) => !options[key]);
    if (missing.length > 0) throw new Error(`pilot bundle options missing: ${missing.join(', ')}`);
  }
  return options;
}

function usage() {
  return 'usage: node completion-audit.mjs [--local-json pos-full-trial.json] [--require-production] [--evidence pos-pilot-evidence.json --site pos-pilot-site.json --fit pos-integration-profile.json --sale field-sale.json --refund field-refund.json --void field-void.json [--report-json pos-pilot-report.json --report-markdown pos-pilot-report.md]] [--output completion-audit.json]';
}

await main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});
