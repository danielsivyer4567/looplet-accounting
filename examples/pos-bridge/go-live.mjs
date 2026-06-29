#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import process from 'node:process';

async function main() {
  const args = process.argv.slice(2);
  const envFile = readOption(args, '--env-file');
  if (envFile) await loadEnvFile(envFile);
  const runId = readOption(args, '--run-id');
  if (runId) process.env.LOOPLET_ACCEPTANCE_RUN_ID = runId;
  const siteFile = readOption(args, '--site-file');
  const fitProfile = readOption(args, '--fit-profile');
  const outputFile = readOption(args, '--output') ?? process.env.LOOPLET_PILOT_EVIDENCE_FILE ?? null;
  const preflightOnly = args.includes('--preflight-only');
  removeFlag(args, '--preflight-only');
  const fieldSamples = {
    sale: readOption(args, '--sale'),
    refund: readOption(args, '--refund'),
    void: readOption(args, '--void'),
  };

  const failures = [];
  if (!siteFile) failures.push('--site-file is required');
  if (!fitProfile) failures.push('--fit-profile is required');
  if (!outputFile) failures.push('--output is required, or set LOOPLET_PILOT_EVIDENCE_FILE');
  for (const eventType of ['sale', 'refund', 'void']) {
    if (!fieldSamples[eventType]) failures.push(`--${eventType} field sample is required`);
  }
  if (args.length > 0) failures.push(`unsupported arguments: ${args.join(' ')}`);
  if (failures.length > 0) return finish({
    ok: false,
    checked_at: new Date().toISOString(),
    failures,
  });

  const commonFieldArgs = [
    '--sale',
    fieldSamples.sale,
    '--refund',
    fieldSamples.refund,
    '--void',
    fieldSamples.void,
  ];
  const pilotEvidence = await runJsonCommand('pilot_evidence', [
    'pilot-evidence.mjs',
    ...(envFile ? ['--env-file', envFile] : []),
    '--site-file',
    siteFile,
    '--fit-profile',
    fitProfile,
    ...commonFieldArgs,
    ...(preflightOnly ? [] : ['--acceptance']),
    '--output',
    outputFile,
  ]);

  const verifier = preflightOnly
    ? {
        command: 'verify_pilot_evidence',
        skipped: true,
        ok: true,
        reason: 'preflight-only mode validates install, fit, site manifest, and field files without acceptance sends',
      }
    : pilotEvidence.exit_code === 0 && pilotEvidence.ok === true
    ? await runJsonCommand('verify_pilot_evidence', [
        'verify-pilot-evidence.mjs',
        outputFile,
        ...commonFieldArgs,
      ])
    : {
        command: 'verify_pilot_evidence',
        skipped: true,
        ok: false,
        reason: 'pilot evidence collection failed',
      };

  const result = redactDeep({
    ok: pilotEvidence.ok === true &&
      pilotEvidence.exit_code === 0 &&
      (preflightOnly
        ? pilotEvidence.non_sending === true && pilotEvidence.acceptance?.skipped === true
        : verifier.ok === true && verifier.exit_code === 0),
    checked_at: new Date().toISOString(),
    preflight_only: preflightOnly,
    evidence_file: outputFile,
    run_id: process.env.LOOPLET_ACCEPTANCE_RUN_ID ?? null,
    commands: {
      pilot_evidence: {
        ok: pilotEvidence.ok === true,
        exit_code: pilotEvidence.exit_code,
      },
      verify_pilot_evidence: {
        ok: verifier.ok === true,
        exit_code: verifier.exit_code ?? null,
        skipped: verifier.skipped === true,
      },
    },
    summary: {
      readiness_ok: pilotEvidence.readiness?.ok === true,
      integration_fit_ok: pilotEvidence.integration_fit?.ok === true,
      credential_probe_ok: pilotEvidence.credential_probe?.ok === true,
      non_sending: pilotEvidence.non_sending === true,
      field_samples_ok: pilotEvidence.field_samples?.ok === true,
      bridge_retry_drill_ok: pilotEvidence.bridge_retry_drill?.skipped === true ||
        pilotEvidence.bridge_retry_drill?.ok === true,
      acceptance_ok: pilotEvidence.acceptance?.ok === true,
      acceptance_skipped: pilotEvidence.acceptance?.skipped === true,
      verifier_ok: verifier.ok === true,
      verifier_integration_fit_ok: verifier.summary?.integration_fit_ok === true,
      field_file_reconciliation_ok: verifier.summary?.field_file_reconciliation_ok === true,
      field_file_reconciliation_required: verifier.summary?.field_file_reconciliation_required === true,
      local_file_protection_ok: verifier.summary?.local_file_protection_ok === true,
      local_file_protection_checked_count: verifier.summary?.local_file_protection_checked_count ?? null,
      duplicate_same_event: verifier.summary?.duplicate_same_event === true,
      refund_linked: verifier.summary?.refund_linked === true,
      void_linked: verifier.summary?.void_linked === true,
      api_request_log_ok: verifier.summary?.api_request_log_ok === true,
      persistence_checked: verifier.summary?.persistence_checked === true,
    },
    evidence: pilotEvidence,
    verifier,
    failures: [
      ...(pilotEvidence.ok === true ? [] : [`pilot evidence failed: ${pilotEvidence.error ?? 'see evidence details'}`]),
      ...(preflightOnly && pilotEvidence.non_sending !== true ? ['preflight-only evidence must be non-sending'] : []),
      ...(preflightOnly && pilotEvidence.acceptance?.skipped !== true ? ['preflight-only evidence must skip acceptance'] : []),
      ...(!preflightOnly && verifier.ok !== true
        ? [`verifier failed: ${verifier.error ?? verifier.reason ?? 'see verifier details'}`]
        : []),
    ],
  });

  finish(result);
}

function finish(result) {
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

async function runJsonCommand(name, commandArgs) {
  const child = spawn(process.execPath, commandArgs.map(resolveLocal), {
    cwd: process.cwd(),
    env: process.env,
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
  const parsed = parseJsonOutput(stdout);
  return {
    command: name,
    exit_code: code,
    ...(parsed ?? { ok: false, error: redactSecrets(stderr.trim() || stdout.trim() || `${name} did not emit JSON`) }),
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
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function removeFlag(args, name) {
  const index = args.indexOf(name);
  if (index !== -1) args.splice(index, 1);
}

async function loadEnvFile(file) {
  const content = await readFile(file, 'utf8');
  for (const [lineNumber, rawLine] of content.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equalsAt = line.indexOf('=');
    if (equalsAt <= 0) throw new Error(`${file}:${lineNumber + 1} must be KEY=value`);
    const key = line.slice(0, equalsAt).trim();
    const value = unquoteEnvValue(line.slice(equalsAt + 1).trim());
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`${file}:${lineNumber + 1} has invalid env key ${key}`);
    process.env[key] = value;
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function redactDeep(value) {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactDeep(entry)]));
  }
  return value;
}

function redactSecrets(value) {
  return String(value)
    .replace(/llp_[^\s"',}]+/g, 'llp_[redacted]')
    .replace(/rhp_[^\s"',}]+/g, 'rhp_[redacted]');
}

function resolveLocal(value) {
  if (value.endsWith('.mjs')) return `${scriptDir()}${value}`;
  return value;
}

function scriptDir() {
  return new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:\/)/, '$1');
}

await main().catch((error) => {
  finish({
    ok: false,
    checked_at: new Date().toISOString(),
    error: error instanceof Error ? redactSecrets(error.message) : redactSecrets(String(error)),
  });
});
