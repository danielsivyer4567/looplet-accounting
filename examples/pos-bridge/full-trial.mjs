#!/usr/bin/env node
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

const projectId = 'receiptfulltrial';
const rootDir = join('.claude', 'scratch', 'receipt-full-trial');
const supabaseDir = join(rootDir, 'supabase');
const dbContainer = `supabase_db_${projectId}`;

const posTrials = [
  ['syntax:pilot-evidence', process.execPath, ['--check', 'examples/pos-bridge/pilot-evidence.mjs']],
  ['syntax:go-live', process.execPath, ['--check', 'examples/pos-bridge/go-live.mjs']],
  ['syntax:pilot-report', process.execPath, ['--check', 'examples/pos-bridge/pilot-report.mjs']],
  ['syntax:pilot-bundle', process.execPath, ['--check', 'examples/pos-bridge/pilot-bundle.mjs']],
  ['syntax:completion-audit', process.execPath, ['--check', 'examples/pos-bridge/completion-audit.mjs']],
  ['syntax:pilot-kit', process.execPath, ['--check', 'examples/pos-bridge/pilot-kit.mjs']],
  ['syntax:integration-fit', process.execPath, ['--check', 'examples/pos-bridge/integration-fit.mjs']],
  [
    'syntax:field-sample-reconciliation',
    process.execPath,
    ['--check', 'examples/pos-bridge/field-sample-reconciliation.mjs'],
  ],
  ['syntax:pilot-go-live-trial', process.execPath, ['--check', 'examples/pos-bridge/pilot-go-live-trial.mjs']],
  ['deno-check:receipt-webhook', 'deno', ['check', 'supabase/functions/receipt-webhook/index.ts']],
  ['deno-check:receipt-sync-dispatch', 'deno', ['check', 'supabase/functions/receipt-sync-dispatch/index.ts']],
  ['deno-test:pos-reliability', 'deno', ['test', 'supabase/functions/receipt-webhook/posReliability.test.ts']],
  [
    'validate',
    process.execPath,
    [
      'examples/pos-bridge/validate.mjs',
      'examples/pos-bridge/sample-receipt.json',
      'examples/pos-bridge/sample-refund.json',
      'examples/pos-bridge/sample-void.json',
    ],
  ],
  ['configure-env-trial', process.execPath, ['examples/pos-bridge/configure-env-trial.mjs']],
  ['integration-fit-trial', process.execPath, ['examples/pos-bridge/integration-fit-trial.mjs']],
  ['pilot-kit-trial', process.execPath, ['examples/pos-bridge/pilot-kit-trial.mjs']],
  ['csv-trial', process.execPath, ['examples/pos-bridge/csv-adapter-trial.mjs']],
  ['readiness-trial', process.execPath, ['examples/pos-bridge/readiness-trial.mjs']],
  ['credential-probe-trial', process.execPath, ['examples/pos-bridge/credential-probe-trial.mjs']],
  ['pilot-evidence-trial', process.execPath, ['examples/pos-bridge/pilot-evidence-trial.mjs']],
  ['verify-pilot-evidence-trial', process.execPath, ['examples/pos-bridge/verify-pilot-evidence-trial.mjs']],
  ['pilot-go-live-trial', process.execPath, ['examples/pos-bridge/pilot-go-live-trial.mjs']],
  ['pilot-report-trial', process.execPath, ['examples/pos-bridge/pilot-report-trial.mjs']],
  ['pilot-bundle-trial', process.execPath, ['examples/pos-bridge/pilot-bundle-trial.mjs']],
  ['completion-audit-trial', process.execPath, ['examples/pos-bridge/completion-audit-trial.mjs']],
  ['pilot-pass-trial', process.execPath, ['examples/pos-bridge/pilot-pass-trial.mjs']],
  ['sample-fingerprint-trial', process.execPath, ['examples/pos-bridge/sample-fingerprint-trial.mjs']],
  ['reconcile-pilot-evidence-trial', process.execPath, ['examples/pos-bridge/reconcile-pilot-evidence-trial.mjs']],
  ['status-trial', process.execPath, ['examples/pos-bridge/status-trial.mjs']],
  ['package-trial', 'powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'examples/pos-bridge/package-windows-bridge-trial.ps1']],
  ['install-trial', 'powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'examples/pos-bridge/install-windows-task-trial.ps1']],
  ['bridge-trial', process.execPath, ['examples/pos-bridge/trial.mjs']],
  ['watch-trial', process.execPath, ['examples/pos-bridge/watch-trial.mjs']],
  ['receipt-hub-visual-smoke', process.execPath, ['examples/pos-bridge/receipt-hub-visual-smoke.mjs']],
  ['acceptance-trial', process.execPath, ['examples/pos-bridge/acceptance-trial.mjs']],
];

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const startedAt = new Date();
  const trialResults = [];
  let isolatedSupabaseStarted = false;
  let stopResult = null;

  try {
    await prepareScratchSupabase();

    for (const [name, command, args] of posTrials) {
      const result = await runStep(name, command, args);
      trialResults.push(summarizeStep(result));
    }

    const start = await runStep('isolated-supabase-start', 'supabase', [
      'start',
      '--workdir',
      rootDir,
      '--ignore-health-check',
    ]);
    isolatedSupabaseStarted = true;

    const reset = await runStep('isolated-supabase-reset', 'supabase', [
      'db',
      'reset',
      '--workdir',
      rootDir,
      '--no-seed',
    ]);
    const resetToLatestMigration = `${reset.stdout}\n${reset.stderr}`.includes('0188_fix_organizations_audit_log.sql');
    if (!resetToLatestMigration) {
      throw new Error('isolated Supabase reset did not prove migration 0188_fix_organizations_audit_log.sql was applied');
    }

    const localEdge = await runStep('local-edge-trial', process.execPath, ['examples/pos-bridge/local-edge-trial.mjs'], {
      LOOPLET_LOCAL_DB_CONTAINER: dbContainer,
    });
    const localEdgeEvidence = parseJsonObject(localEdge.stdout);

    stopResult = await stopScratchSupabase();
    isolatedSupabaseStarted = false;
    const remainingScratchContainers = await dockerContainerCount(projectId);

    const result = {
      ok: true,
      started_at: startedAt.toISOString(),
      completed_at: new Date().toISOString(),
      scratch_project_id: projectId,
      scratch_workdir: rootDir,
      pos_trials: trialResults,
      isolated_supabase: {
        started: start.code === 0,
        reset_to_latest_migration: resetToLatestMigration,
        stopped: stopResult.code === 0,
        remaining_running_containers: remainingScratchContainers,
      },
      local_edge: summarizeLocalEdge(localEdgeEvidence),
    };
    await writeJsonOutput(result, options.output);
  } catch (error) {
    if (isolatedSupabaseStarted) {
      stopResult = await stopScratchSupabase().catch((stopError) => ({
        code: 1,
        error: stopError instanceof Error ? stopError.message : String(stopError),
      }));
    }
    const result = {
      ok: false,
      error: error instanceof Error ? redact(error.message) : redact(String(error)),
      stopped_scratch_supabase: stopResult?.code === 0,
    };
    await writeJsonOutput(result, options.output, { stderr: true });
    process.exit(1);
  }
}

function parseOptions(args) {
  const options = {};
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === '--output') {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error(usage());
      options.output = value;
      continue;
    }
    throw new Error(usage());
  }
  return options;
}

async function writeJsonOutput(result, output, options = {}) {
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (output) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, json);
  }
  if (options.stderr === true) {
    console.error(json.trimEnd());
  } else {
    console.log(json.trimEnd());
  }
}

function usage() {
  return 'usage: node full-trial.mjs [--output pos-full-trial.json]';
}

async function prepareScratchSupabase() {
  await stopExistingScratchIfPresent();
  await rm(rootDir, { recursive: true, force: true });
  await mkdir(rootDir, { recursive: true });
  await runStep('scratch-supabase-init', 'supabase', ['init', '--workdir', rootDir, '--force']);
  await patchSupabaseConfig();
  await rm(join(supabaseDir, 'migrations'), { recursive: true, force: true });
  await rm(join(supabaseDir, 'functions'), { recursive: true, force: true });
  await cp('supabase/migrations', join(supabaseDir, 'migrations'), { recursive: true });
  await cp('supabase/functions', join(supabaseDir, 'functions'), { recursive: true });
}

async function stopExistingScratchIfPresent() {
  const configPath = join(supabaseDir, 'config.toml');
  try {
    await readFile(configPath, 'utf8');
  } catch {
    return;
  }
  await runStep('scratch-supabase-stop-existing', 'supabase', ['stop', '--workdir', rootDir], {}, { allowFailure: true });
}

async function patchSupabaseConfig() {
  const configPath = join(supabaseDir, 'config.toml');
  const config = await readFile(configPath, 'utf8');
  const patched = patchTomlPorts(config)
    .replace(/^project_id = ".*"$/m, `project_id = "${projectId}"`);
  await writeFile(configPath, `${patched.trimEnd()}\n${functionConfigBlock()}\n`);
}

function patchTomlPorts(config) {
  const ports = {
    api: '55421',
    db: '55422',
    'db.pooler': '55429',
    studio: '55423',
    inbucket: '55424',
    analytics: '55427',
  };
  let section = '';
  return config.split(/\r?\n/).map((line) => {
    const header = line.match(/^\[([^\]]+)]$/);
    if (header) {
      section = header[1];
      return line;
    }
    if (section === 'db' && /^shadow_port\s*=/.test(line)) return 'shadow_port = 55420';
    if (section === 'edge_runtime' && /^inspector_port\s*=/.test(line)) return 'inspector_port = 55483';
    if (Object.prototype.hasOwnProperty.call(ports, section) && /^port\s*=/.test(line)) {
      return `port = ${ports[section]}`;
    }
    return line;
  }).join('\n');
}

function functionConfigBlock() {
  return `
[functions.receipt-webhook]
verify_jwt = false

[functions.receipt-sync-dispatch]
verify_jwt = false
`;
}

async function stopScratchSupabase() {
  return await runStep('isolated-supabase-stop', 'supabase', ['stop', '--workdir', rootDir], {}, { allowFailure: true });
}

async function dockerContainerCount(project) {
  const result = await runStep('scratch-container-count', 'docker', [
    'ps',
    '--filter',
    `label=com.supabase.cli.project=${project}`,
    '--format',
    '{{.Names}}',
  ], {}, { allowFailure: true });
  return result.stdout.split(/\r?\n/).filter((line) => line.trim()).length;
}

async function runStep(name, command, args, env = {}, options = {}) {
  const started = Date.now();
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

  const code = await new Promise((resolve) => child.on('exit', resolve));
  const result = {
    name,
    command,
    args,
    code,
    stdout,
    stderr,
    duration_ms: Date.now() - started,
  };
  if (code !== 0 && options.allowFailure !== true) {
    throw new Error(`${name} failed with exit ${code}\nstdout=${redact(tail(stdout))}\nstderr=${redact(tail(stderr))}`);
  }
  return result;
}

function summarizeStep(result) {
  return {
    name: result.name,
    ok: result.code === 0,
    duration_ms: result.duration_ms,
  };
}

function summarizeLocalEdge(evidence) {
  return {
    ok: evidence?.ok === true,
    db_container: evidence?.db_container ?? dbContainer,
    duplicate_returned_same_event: evidence?.duplicate_returned_same_event === true,
    partial_duplicate_incomplete_rejected: evidence?.partial_duplicate_incomplete_rejected === true,
    bad_line_quantity_rejected: evidence?.bad_line_quantity_rejected === true,
    post_event_insert_failure_cleanup_ok: evidence?.post_event_insert_failure_cleanup_ok === true,
    idempotency_mismatch_rejected: evidence?.idempotency_mismatch_rejected === true,
    idempotency_tax_mismatch_rejected: evidence?.idempotency_tax_mismatch_rejected === true,
    idempotency_purchase_at_mismatch_rejected: evidence?.idempotency_purchase_at_mismatch_rejected === true,
    idempotency_source_mismatch_rejected: evidence?.idempotency_source_mismatch_rejected === true,
    cross_org_identity_rejected: evidence?.cross_org_identity_rejected === true,
    reverse_cross_org_identity_rejected: evidence?.reverse_cross_org_identity_rejected === true,
    missing_payment_reference_rejected: evidence?.missing_payment_reference_rejected === true,
    bad_payment_last4_rejected: evidence?.bad_payment_last4_rejected === true,
    missing_purchase_at_rejected: evidence?.missing_purchase_at_rejected === true,
    bad_purchase_at_rejected: evidence?.bad_purchase_at_rejected === true,
    api_request_log_ok: evidence?.api_request_log_ok === true,
    raw_payload_identity_token_stripped: evidence?.raw_payload_identity_token_stripped === true,
    refund_linked: evidence?.persisted?.refund_linked === true,
    void_linked: evidence?.persisted?.void_linked === true,
    refund_same_receipt_number_accepted: evidence?.refund_same_receipt_number_accepted === true,
    void_same_receipt_number_accepted: evidence?.void_same_receipt_number_accepted === true,
    sale_events: evidence?.persisted?.sale_events ?? 0,
    other_org_receipt_events: evidence?.persisted?.other_org_receipt_events ?? null,
    refund_events: evidence?.persisted?.refund_events ?? 0,
    void_events: evidence?.persisted?.void_events ?? 0,
    bills: evidence?.persisted?.bills ?? 0,
    audit_packages: evidence?.persisted?.audit_packages ?? 0,
    cleanup_ok: evidence?.cleanup_ok === true,
    cleanup_no_leak: evidence?.cleanup_no_leak === true,
  };
}

function parseJsonObject(stdout) {
  const text = stdout.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return JSON.parse(text.slice(start, end + 1));
}

function tail(value) {
  const lines = String(value).split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - 30)).join('\n');
}

function redact(value) {
  return String(value)
    .replace(/llp_[^\s"',}]+/g, 'llp_[redacted]')
    .replace(/rhp_[^\s"',}]+/g, 'rhp_[redacted]')
    .replace(/sb_secret_[^\s"',}]+/g, 'sb_secret_[redacted]')
    .replace(/sb_publishable_[^\s"',}]+/g, 'sb_publishable_[redacted]')
    .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, 'jwt_[redacted]');
}

await main();
