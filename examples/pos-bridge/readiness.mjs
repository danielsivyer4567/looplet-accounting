#!/usr/bin/env node
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import process from 'node:process';
import { buildWebhookBody, validateReceiptContract } from './contract.mjs';

const defaultSample = new URL('sample-receipt.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:\/)/, '$1');
const requiredBridgeFiles = [
  'README.md',
  'MERCHANT_INTEGRATION_DESIGN.md',
  'PILOT_CHECKLIST.md',
  '.env.example',
  'bridge.mjs',
  'bridge-retry-drill.mjs',
  'integration-fit.mjs',
  'pilot-kit.mjs',
  'contract.mjs',
  'run-watch-once.ps1',
  'configure-env.mjs',
  'validate.mjs',
  'csv-adapter.mjs',
  'status.mjs',
  'pilot-pass.mjs',
  'sample-fingerprint.mjs',
  'field-sample-capture.mjs',
  'field-sample-reconciliation.mjs',
  'reconcile-pilot-evidence.mjs',
  'credential-probe.mjs',
  'pilot-evidence.mjs',
  'verify-pilot-evidence.mjs',
  'go-live.mjs',
  'pilot-report.mjs',
  'pilot-bundle.mjs',
  'completion-audit.mjs',
  'full-trial-manifest.mjs',
  'acceptance.mjs',
  'sample-receipt.json',
  'sample-refund.json',
  'sample-void.json',
  'sample-invalid-pending.json',
  'integration-fit.example.json',
  'pilot-site.example.json',
  'sample-pos-export.csv',
  'sample-pos-export-bad-lines.csv',
];

async function main() {
  const args = process.argv.slice(2);
  await loadEnvFileArg(args);
  const samplePath = readOption(args, '--sample') ?? process.env.LOOPLET_READINESS_SAMPLE ?? defaultSample;
  const skipNetwork = args.includes('--skip-network') || process.env.LOOPLET_READINESS_SKIP_NETWORK === '1';
  const config = readConfig();

  const checks = {
    node: checkNodeRuntime(),
    config: checkConfig(config),
    bridge_files: await checkBridgeFiles(),
    inbox: await checkInbox(config.inboxDir),
    contract: await checkContract(samplePath, config),
    network: skipNetwork
      ? { ok: true, skipped: true, reason: 'network check skipped' }
      : await checkNetwork(config.webhookUrl),
  };
  const ok = Object.values(checks).every((check) => check.ok);
  const result = { ok, checks };
  console.log(JSON.stringify(result, null, 2));
  if (!ok) process.exit(1);
}

async function checkBridgeFiles() {
  const baseDir = scriptDir();
  const present = [];
  const missing = [];
  for (const file of requiredBridgeFiles) {
    try {
      const fileStat = await stat(join(baseDir, file));
      present.push({ file, bytes: fileStat.size });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        missing.push(file);
        continue;
      }
      throw error;
    }
  }
  const manifest = await checkPackageManifest(baseDir);

  return {
    ok: missing.length === 0 && manifest.ok,
    directory: baseDir,
    required_count: requiredBridgeFiles.length,
    present_count: present.length,
    missing,
    files: present,
    manifest,
  };
}

async function checkPackageManifest(baseDir) {
  const manifestPath = join(baseDir, 'MANIFEST.json');
  let manifest;
  try {
    manifest = JSON.parse(stripUtf8Bom(await readFile(manifestPath, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        present: false,
        ok: true,
        checked_files: 0,
        errors: [],
      };
    }
    return {
      present: true,
      ok: false,
      checked_files: 0,
      errors: [`MANIFEST.json could not be read: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const errors = [];
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (!Array.isArray(manifest.files)) errors.push('MANIFEST.json files must be an array');
  const manifestPaths = new Set(files.map((entry) => entry?.path).filter((value) => typeof value === 'string'));
  for (const requiredFile of requiredBridgeFiles) {
    if (!manifestPaths.has(requiredFile)) errors.push(`manifest missing required file: ${requiredFile}`);
  }

  let checkedFiles = 0;
  for (const entry of files) {
    const relativePath = typeof entry?.path === 'string' ? entry.path : '';
    if (!relativePath || relativePath.includes('..') || /[\\/]MANIFEST\.json$/i.test(relativePath)) {
      errors.push(`invalid manifest path: ${relativePath || '<missing>'}`);
      continue;
    }
    const expectedHash = typeof entry.sha256 === 'string' ? entry.sha256.toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(expectedHash)) {
      errors.push(`invalid manifest sha256 for ${relativePath}`);
      continue;
    }
    try {
      const filePath = join(baseDir, relativePath);
      const fileStat = await stat(filePath);
      const actualHash = await sha256File(filePath);
      checkedFiles += 1;
      if (Number(entry.bytes) !== fileStat.size) errors.push(`manifest bytes mismatch: ${relativePath}`);
      if (actualHash !== expectedHash) errors.push(`manifest hash mismatch: ${relativePath}`);
    } catch (error) {
      errors.push(`manifest file missing or unreadable: ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    present: true,
    ok: errors.length === 0 && checkedFiles > 0,
    checked_files: checkedFiles,
    errors,
  };
}

async function sha256File(path) {
  const data = await readFile(path);
  return createHash('sha256').update(data).digest('hex');
}

function stripUtf8Bom(value) {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function checkNodeRuntime() {
  const major = Number(process.versions.node.split('.')[0]);
  return {
    ok: Number.isInteger(major) && major >= 20,
    version: process.version,
    required: '>=20',
  };
}

function checkConfig(config) {
  const errors = [];
  let webhook;
  try {
    webhook = new URL(config.webhookUrl);
  } catch {
    errors.push('LOOPLET_RECEIPT_WEBHOOK_URL must be a valid URL');
  }

  const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
  if (webhook) {
    if (webhook.protocol !== 'https:' && !localHosts.has(webhook.hostname)) {
      errors.push('LOOPLET_RECEIPT_WEBHOOK_URL must use https for non-local endpoints');
    }
    if (!webhook.pathname.endsWith('/functions/v1/receipt-webhook')) {
      errors.push('LOOPLET_RECEIPT_WEBHOOK_URL must point to /functions/v1/receipt-webhook');
    }
  }
  if (!/^llp_[^.]+\..+/.test(config.apiKey)) errors.push('LOOPLET_POS_API_KEY must look like llp_<prefix>.<secret>');
  if (config.identityToken && !/^rhp_[^.]+\..+/.test(config.identityToken)) {
    errors.push('LOOPLET_RECEIPT_IDENTITY_TOKEN must look like rhp_<prefix>.<secret> when configured');
  }
  if (config.queueFile === config.deadLetterFile) {
    errors.push('LOOPLET_BRIDGE_QUEUE_FILE and LOOPLET_BRIDGE_DEAD_LETTER_FILE must be different');
  }
  if (!isNonNegativeInteger(config.minFileAgeMs)) {
    errors.push('LOOPLET_BRIDGE_MIN_FILE_AGE_MS must be a non-negative integer');
  }
  if (!isPositiveInteger(config.staleAfterMinutes)) {
    errors.push('LOOPLET_BRIDGE_STALE_AFTER_MINUTES must be a positive integer');
  }

  return {
    ok: errors.length === 0,
    webhook_host: webhook?.host ?? null,
    webhook_path: webhook?.pathname ?? null,
    api_key_shape: config.apiKey.startsWith('llp_') ? 'llp_*' : 'invalid',
    identity_token_fallback_shape: config.identityToken
      ? config.identityToken.startsWith('rhp_') ? 'rhp_*' : 'invalid'
      : null,
    sync_targets: config.syncTargets,
    min_file_age_ms: config.minFileAgeMs,
    log_dir_configured: Boolean(config.logDir),
    stale_after_minutes: config.staleAfterMinutes,
    errors,
  };
}

async function checkInbox(inboxDir) {
  const dirs = ['', 'processing', 'sent', 'queued', 'rejected'];
  for (const dir of dirs) await mkdir(join(inboxDir, dir), { recursive: true });
  const probe = join(inboxDir, `.looplet-readiness-${process.pid}.tmp`);
  await writeFile(probe, 'ok\n');
  await unlink(probe);
  return {
    ok: true,
    inbox_dir: inboxDir,
    writable: true,
    subdirs: dirs.slice(1),
  };
}

async function checkContract(samplePath, config) {
  const sample = JSON.parse(await readFile(samplePath, 'utf8'));
  const errors = validateReceiptContract(sample);
  let body = null;
  const buildErrors = [];
  if (errors.length === 0) {
    try {
      body = buildWebhookBody(sample, config);
    } catch (error) {
      buildErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const allErrors = [...errors, ...buildErrors];
  return {
    ok: allErrors.length === 0,
    sample: samplePath,
    event_type: body?.event_type ?? null,
    source_channel: body?.source_channel ?? null,
    idempotency_key: body?.idempotency_key ?? null,
    identity_token_source: sample.identity_token
      ? 'receipt'
      : sample.payload?.receipt?.identity_token
        ? 'payload.receipt'
        : sample.payload?.customer?.looplet_identity_token
          ? 'payload.customer'
          : config.identityToken
            ? 'env_fallback'
            : null,
    line_count: Array.isArray(body?.payload?.line_items) ? body.payload.line_items.length : 0,
    errors: allErrors,
  };
}

async function checkNetwork(webhookUrl) {
  try {
    const response = await fetch(webhookUrl, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://looplet.local',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key',
      },
    });
    return {
      ok: response.status >= 200 && response.status < 500,
      method: 'OPTIONS',
      status: response.status,
      reachable: true,
    };
  } catch (error) {
    return {
      ok: false,
      method: 'OPTIONS',
      status: 0,
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function readConfig() {
  return {
    webhookUrl: requiredEnv('LOOPLET_RECEIPT_WEBHOOK_URL'),
    apiKey: requiredEnv('LOOPLET_POS_API_KEY'),
    identityToken: process.env.LOOPLET_RECEIPT_IDENTITY_TOKEN || null,
    syncTargets: (process.env.LOOPLET_SYNC_TARGETS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    queueFile: process.env.LOOPLET_BRIDGE_QUEUE_FILE || '.looplet-pos-queue.jsonl',
    deadLetterFile: process.env.LOOPLET_BRIDGE_DEAD_LETTER_FILE || '.looplet-pos-dead.jsonl',
    inboxDir: process.env.LOOPLET_BRIDGE_INBOX_DIR || 'receipts-inbox',
    logDir: process.env.LOOPLET_BRIDGE_LOG_DIR || '',
    staleAfterMinutes: process.env.LOOPLET_BRIDGE_STALE_AFTER_MINUTES || '10',
    minFileAgeMs: process.env.LOOPLET_BRIDGE_MIN_FILE_AGE_MS || '1000',
  };
}

function isNonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0;
}

function isPositiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1;
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

async function loadEnvFileArg(args) {
  const index = args.indexOf('--env-file');
  if (index === -1) return;
  const file = args[index + 1];
  if (!file) throw new Error('--env-file requires a path');
  await loadEnvFile(file);
  args.splice(index, 2);
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

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function scriptDir() {
  return new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:\/)/, '$1');
}

await main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});
