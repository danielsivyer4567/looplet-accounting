#!/usr/bin/env node
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

async function main() {
  const args = process.argv.slice(2);
  const force = removeFlag(args, '--force');
  const output = readOption(args, '--output') ?? process.env.LOOPLET_BRIDGE_ENV_FILE ?? 'pos-bridge.env';
  const webhookUrl = readOption(args, '--webhook-url') ?? process.env.LOOPLET_RECEIPT_WEBHOOK_URL;
  const config = {
    webhookUrl,
    apiKey: readOption(args, '--api-key') ?? process.env.LOOPLET_POS_API_KEY,
    identityToken: readOption(args, '--identity-token') ?? process.env.LOOPLET_RECEIPT_IDENTITY_TOKEN,
    syncTargets: readOption(args, '--sync-targets') ?? process.env.LOOPLET_SYNC_TARGETS ?? 'xero,myob',
    queueFile: readOption(args, '--queue-file') ?? process.env.LOOPLET_BRIDGE_QUEUE_FILE ?? '.looplet-pos-queue.jsonl',
    deadLetterFile: readOption(args, '--dead-letter-file') ??
      process.env.LOOPLET_BRIDGE_DEAD_LETTER_FILE ??
      '.looplet-pos-dead.jsonl',
    inboxDir: readOption(args, '--inbox-dir') ?? process.env.LOOPLET_BRIDGE_INBOX_DIR ?? 'receipts-inbox',
    logDir: readOption(args, '--log-dir') ?? process.env.LOOPLET_BRIDGE_LOG_DIR ?? 'logs',
    staleAfterMinutes: readOption(args, '--stale-after-minutes') ??
      process.env.LOOPLET_BRIDGE_STALE_AFTER_MINUTES ??
      '10',
    minFileAgeMs: readOption(args, '--min-file-age-ms') ?? process.env.LOOPLET_BRIDGE_MIN_FILE_AGE_MS ?? '1000',
    readinessSample: readOption(args, '--readiness-sample') ??
      process.env.LOOPLET_READINESS_SAMPLE ??
      'sample-receipt.json',
    acceptanceSupabaseUrl: readOption(args, '--acceptance-supabase-url') ??
      process.env.LOOPLET_ACCEPTANCE_SUPABASE_URL ??
      inferSupabaseUrl(webhookUrl),
    acceptanceOrgId: readOption(args, '--acceptance-org-id') ?? process.env.LOOPLET_ACCEPTANCE_ORG_ID ?? '',
  };

  if (args.length > 0) throw new Error(`unsupported arguments: ${args.join(' ')}`);
  const errors = validateConfig(config);
  if (errors.length > 0) {
    console.error(JSON.stringify({ ok: false, errors }, null, 2));
    process.exit(1);
  }

  const outputExisted = await exists(output);
  if (!force && outputExisted) {
    console.error(JSON.stringify({
      ok: false,
      error: `${output} already exists; rerun with --force to replace it`,
    }, null, 2));
    process.exit(1);
  }

  await mkdir(dirname(output), { recursive: true });
  const tempOutput = `${output}.${process.pid}.${Date.now()}.tmp`;
  let secretFileProtection = null;
  try {
    await writeFile(tempOutput, envContent(config));
    secretFileProtection = await protectSecretFile(tempOutput);
    await rename(tempOutput, output);
  } catch (error) {
    await rm(tempOutput, { force: true }).catch(() => {});
    throw error;
  }
  console.log(JSON.stringify({
    ok: true,
    output,
    replaced_existing: outputExisted,
    secret_file_protected: secretFileProtection.ok,
    secret_file_protection: secretFileProtection,
    webhook_host: new URL(config.webhookUrl).host,
    api_key_shape: redactToken(config.apiKey),
    identity_token_shape: redactToken(config.identityToken),
    sync_targets: config.syncTargets.split(',').map((value) => value.trim()).filter(Boolean),
    inbox_dir: config.inboxDir,
    log_dir: config.logDir,
    next_steps: [
      `node readiness.mjs --env-file ${output}`,
      `node credential-probe.mjs --env-file ${output}`,
      `node status.mjs --env-file ${output}`,
      `node go-live.mjs --env-file ${output} --site-file pos-pilot-site.json --fit-profile pos-integration-profile.json --sale field-sale.json --refund field-refund.json --void field-void.json --output pos-pilot-evidence.json`,
    ],
  }, null, 2));
}

function validateConfig(config) {
  const errors = [];
  let webhook = null;
  try {
    webhook = new URL(config.webhookUrl ?? '');
  } catch {
    errors.push('webhook URL must be valid');
  }
  if (webhook) {
    const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
    if (webhook.protocol !== 'https:' && !localHosts.has(webhook.hostname)) {
      errors.push('webhook URL must use https unless it is localhost');
    }
    if (!webhook.pathname.endsWith('/functions/v1/receipt-webhook')) {
      errors.push('webhook URL must end with /functions/v1/receipt-webhook');
    }
  }
  if (!/^llp_[^.]+\..+/.test(config.apiKey ?? '')) {
    errors.push('api key must look like llp_<prefix>.<secret>');
  }
  if (!/^rhp_[^.]+\..+/.test(config.identityToken ?? '')) {
    errors.push('receipt identity token must look like rhp_<prefix>.<secret>');
  }
  if ((config.queueFile ?? '') === (config.deadLetterFile ?? '')) {
    errors.push('queue file and dead-letter file must be different');
  }
  if (!isNonNegativeInteger(config.minFileAgeMs)) {
    errors.push('min file age must be a non-negative integer number of milliseconds');
  }
  if (!isPositiveInteger(config.staleAfterMinutes)) {
    errors.push('stale-after-minutes must be a positive integer');
  }
  return errors;
}

function envContent(config) {
  return [
    `LOOPLET_RECEIPT_WEBHOOK_URL=${config.webhookUrl}`,
    `LOOPLET_POS_API_KEY=${config.apiKey}`,
    `LOOPLET_RECEIPT_IDENTITY_TOKEN=${config.identityToken}`,
    `LOOPLET_SYNC_TARGETS=${config.syncTargets}`,
    `LOOPLET_BRIDGE_QUEUE_FILE=${config.queueFile}`,
    `LOOPLET_BRIDGE_DEAD_LETTER_FILE=${config.deadLetterFile}`,
    'LOOPLET_BRIDGE_MAX_ATTEMPTS=4',
    'LOOPLET_BRIDGE_RETRY_BASE_MS=1000',
    `LOOPLET_BRIDGE_INBOX_DIR=${config.inboxDir}`,
    `LOOPLET_BRIDGE_LOG_DIR=${config.logDir}`,
    `LOOPLET_BRIDGE_STALE_AFTER_MINUTES=${config.staleAfterMinutes}`,
    'LOOPLET_BRIDGE_POLL_MS=2000',
    `LOOPLET_BRIDGE_MIN_FILE_AGE_MS=${config.minFileAgeMs}`,
    `LOOPLET_READINESS_SAMPLE=${config.readinessSample}`,
    'LOOPLET_READINESS_SKIP_NETWORK=0',
    'LOOPLET_ACCEPTANCE_CONFIRM_LIVE=0',
    'LOOPLET_ACCEPTANCE_RUN_ID=',
    'LOOPLET_ACCEPTANCE_EVIDENCE_FILE=',
    `LOOPLET_ACCEPTANCE_SUPABASE_URL=${config.acceptanceSupabaseUrl ?? ''}`,
    'LOOPLET_ACCEPTANCE_SERVICE_ROLE_KEY=',
    `LOOPLET_ACCEPTANCE_ORG_ID=${config.acceptanceOrgId}`,
    '',
  ].join('\n');
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
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function protectSecretFile(path) {
  const resolvedPath = resolve(path);
  if (process.platform !== 'win32') {
    await chmod(resolvedPath, 0o600);
    return {
      ok: true,
      platform: process.platform,
      mode: '0600',
    };
  }

  const script = `
$ErrorActionPreference = 'Stop'
$path = $env:LOOPLET_SECRET_FILE
if (-not $path) { throw 'LOOPLET_SECRET_FILE was not supplied' }
$resolvedPath = (Resolve-Path -LiteralPath $path).Path
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$administrators = ([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')).Translate([System.Security.Principal.NTAccount]).Value
$system = ([System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')).Translate([System.Security.Principal.NTAccount]).Value
$principals = @($currentUser, $administrators, $system) | Select-Object -Unique
$security = [System.Security.AccessControl.FileSecurity]::new()
foreach ($principal in $principals) {
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $principal,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.InheritanceFlags]::None,
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  $security.AddAccessRule($rule)
}
$security.SetAccessRuleProtection($true, $false)
[System.IO.File]::SetAccessControl($resolvedPath, $security)
$applied = [System.IO.File]::GetAccessControl($resolvedPath)
[ordered]@{
  ok = [bool]$applied.AreAccessRulesProtected
  protected = [bool]$applied.AreAccessRulesProtected
  allowed_principals = @($principals)
} | ConvertTo-Json -Depth 4
`;

  const result = await runCommand('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    ...process.env,
    LOOPLET_SECRET_FILE: resolvedPath,
  });
  if (result.code !== 0) {
    throw new Error(`failed to protect env file ACL: ${result.stderr || result.stdout || `exit ${result.code}`}`);
  }
  const parsed = JSON.parse(result.stdout);
  if (!parsed.ok) throw new Error('failed to protect env file ACL');
  return {
    ok: true,
    platform: 'win32',
    protected: parsed.protected === true,
    allowed_principals: parsed.allowed_principals,
  };
}

function runCommand(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env,
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
    child.on('error', (error) => {
      resolve({ code: -1, stdout, stderr: error instanceof Error ? error.message : String(error) });
    });
    child.on('exit', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function inferSupabaseUrl(webhookUrl) {
  if (!webhookUrl) return '';
  try {
    const url = new URL(webhookUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '';
  }
}

function redactToken(value) {
  if (typeof value !== 'string') return 'invalid';
  const dot = value.indexOf('.');
  if (dot === -1) return value.startsWith('llp_') || value.startsWith('rhp_') ? `${value}[missing-secret]` : 'invalid';
  return `${value.slice(0, dot)}.[redacted]`;
}

function isNonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0;
}

function isPositiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1;
}

await main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});
