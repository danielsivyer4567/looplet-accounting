#!/usr/bin/env node
import { appendFile, chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';
import { buildWebhookBody } from './contract.mjs';

const transientStatuses = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

async function main() {
  const args = process.argv.slice(2);
  await loadEnvFileArg(args);

  if (args[0] === '--flush') {
    await flushQueue();
    return;
  }

  if (args[0] === '--watch' || args[0] === '--watch-once') {
    readConfig();
    const inboxDir = args[1] || process.env.LOOPLET_BRIDGE_INBOX_DIR || 'receipts-inbox';
    const once = args[0] === '--watch-once';
    await watchInbox(inboxDir, { once });
    return;
  }

  const receiptPath = args[0] || 'sample-receipt.json';
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  const result = await sendWithRetry(receipt);
  if (!result.ok) {
    if (isTransientResult(result)) {
      await queueReceipt(receipt, result);
    } else {
      await deadLetterReceipt(receipt, result);
    }
    process.exitCode = 1;
  }
}

async function sendWithRetry(receipt) {
  let lastResult = null;
  const attempts = maxAttempts();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastResult = await sendReceipt(receipt, attempt);
    if (lastResult.ok) return lastResult;
    if (!isTransientResult(lastResult)) return lastResult;
    await sleep(Math.min(retryBaseMs() * 2 ** (attempt - 1), 8000));
  }
  return lastResult ?? { ok: false, status: 0, error: 'send_not_attempted' };
}

async function sendReceipt(receipt, attempt) {
  const config = readConfig();
  let body;

  try {
    body = buildWebhookBody(receipt, config);
  } catch (error) {
    const result = {
      ok: false,
      status: 400,
      attempt,
      idempotency_key: null,
      receipt_event_id: null,
      duplicate: false,
      error: error instanceof Error ? error.message : String(error),
    };
    console.error(JSON.stringify(result));
    return result;
  }

  try {
    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': body.idempotency_key,
      },
      body: JSON.stringify(body),
    });
    const responseBody = await response.json().catch(() => ({}));
    const result = {
      ok: response.ok && responseBody.ok !== false,
      status: response.status,
      attempt,
      idempotency_key: body.idempotency_key,
      receipt_event_id: responseBody.receipt_event_id ?? null,
      duplicate: responseBody.duplicate ?? false,
      error: responseBody.error ?? null,
    };
    console.log(JSON.stringify(result));
    return result;
  } catch (error) {
    const result = {
      ok: false,
      status: 0,
      attempt,
      idempotency_key: body.idempotency_key,
      receipt_event_id: null,
      duplicate: false,
      error: error instanceof Error ? error.message : String(error),
    };
    console.error(JSON.stringify(result));
    return result;
  }
}

async function flushQueue() {
  const queueFile = queueFilePath();
  let content = '';
  try {
    content = await readFile(queueFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      console.log(`queue_empty ${queueFile}`);
      return;
    }
    throw error;
  }

  const remaining = [];
  for (const [index, line] of content.split(/\r?\n/).filter(Boolean).entries()) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      await deadLetterQueueRow(line, {
        ok: false,
        status: 400,
        attempt: 0,
        idempotency_key: null,
        receipt_event_id: null,
        duplicate: false,
        error: `invalid queue JSONL row ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (!entry.receipt || typeof entry.receipt !== 'object' || Array.isArray(entry.receipt)) {
      await deadLetterQueueRow(line, {
        ok: false,
        status: 400,
        attempt: 0,
        idempotency_key: null,
        receipt_event_id: null,
        duplicate: false,
        error: `invalid queue JSONL row ${index + 1}: missing receipt object`,
      });
      continue;
    }
    const result = await sendWithRetry(entry.receipt);
    if (result.ok) {
      await markQueuedArchiveSent(entry);
      continue;
    }
    if (isTransientResult(result)) {
      remaining.push(JSON.stringify({ ...entry, last_error: result, retried_at: new Date().toISOString() }));
    } else {
      await deadLetterReceipt(entry.receipt, result);
      await markQueuedArchiveRejected(entry);
    }
  }

  if (remaining.length === 0) {
    await unlink(queueFile).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    console.log(`queue_flushed ${queueFile}`);
    return;
  }

  const tmp = `${queueFile}.tmp`;
  await ensureFileParentDir(tmp);
  await writeProtectedStateFile(tmp, `${remaining.join('\n')}\n`);
  await rename(tmp, queueFile);
  await protectLocalStateFile(queueFile);
  console.log(`queue_remaining ${remaining.length}`);
}

async function watchInbox(inboxDir, { once = false } = {}) {
  await ensureInboxDirs(inboxDir);
  console.log(`watching ${inboxDir}${once ? ' once' : ''}`);

  do {
    await flushQueue();
    const processed = await processInboxOnce(inboxDir);
    if (once) {
      console.log(`watch_once_processed ${processed}`);
      return;
    }
    if (processed === 0) await sleep(pollMs());
  } while (true);
}

async function processInboxOnce(inboxDir) {
  const entries = await readdir(inboxDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map((entry) => entry.name)
    .sort();

  let processed = 0;
  for (const fileName of files) {
    const sourcePath = join(inboxDir, fileName);
    if (!(await isSettledInboxFile(sourcePath))) continue;
    const workPath = join(inboxDir, 'processing', `${timestampPrefix()}-${safeFileName(fileName)}`);
    try {
      await rename(sourcePath, workPath);
      await protectLocalStateFile(workPath);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }

    let receipt;
    try {
      receipt = JSON.parse(await readFile(workPath, 'utf8'));
    } catch (error) {
      await moveBridgeFile(workPath, join(inboxDir, 'rejected'), fileName);
      console.error(JSON.stringify({
        ok: false,
        status: 400,
        file: fileName,
        error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      }));
      processed += 1;
      continue;
    }

    const result = await sendWithRetry(receipt);
    if (result.ok) {
      await moveBridgeFile(workPath, join(inboxDir, 'sent'), fileName);
    } else if (isTransientResult(result)) {
      const queuedArchiveName = archiveFileName(fileName);
      await queueReceipt(receipt, result, {
        inbox_dir: inboxDir,
        original_file_name: fileName,
        queued_archive_name: queuedArchiveName,
      });
      await moveBridgeFileToPath(workPath, join(inboxDir, 'queued', queuedArchiveName));
    } else {
      await deadLetterReceipt(receipt, result);
      await moveBridgeFile(workPath, join(inboxDir, 'rejected'), fileName);
    }
    processed += 1;
  }
  return processed;
}

async function isSettledInboxFile(path) {
  const minAgeMs = minFileAgeMs();
  if (minAgeMs === 0) return true;
  try {
    const file = await stat(path);
    return Date.now() - file.mtimeMs >= minAgeMs;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function ensureInboxDirs(inboxDir) {
  await mkdir(inboxDir, { recursive: true });
  await mkdir(join(inboxDir, 'processing'), { recursive: true });
  await mkdir(join(inboxDir, 'sent'), { recursive: true });
  await mkdir(join(inboxDir, 'queued'), { recursive: true });
  await mkdir(join(inboxDir, 'rejected'), { recursive: true });
}

async function moveBridgeFile(fromPath, toDir, originalName) {
  await moveBridgeFileToPath(fromPath, join(toDir, archiveFileName(originalName)));
}

async function moveBridgeFileToPath(fromPath, toPath) {
  await mkdir(dirname(toPath), { recursive: true });
  await rename(fromPath, toPath);
  await protectLocalStateFile(toPath);
}

function archiveFileName(originalName) {
  return `${timestampPrefix()}-${safeFileName(basename(originalName))}`;
}

async function markQueuedArchiveSent(entry) {
  await moveQueuedArchive(entry, 'sent');
}

async function markQueuedArchiveRejected(entry) {
  await moveQueuedArchive(entry, 'rejected');
}

async function moveQueuedArchive(entry, destination) {
  if (!entry || typeof entry !== 'object') return;
  if (typeof entry.inbox_dir !== 'string' || typeof entry.queued_archive_name !== 'string') return;
  const archiveName = safeFileName(basename(entry.queued_archive_name));
  const fromPath = join(entry.inbox_dir, 'queued', archiveName);
  const toPath = join(entry.inbox_dir, destination, archiveName);
  await moveBridgeFileToPath(fromPath, toPath).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
}

async function queueReceipt(receipt, result, metadata = {}) {
  const queueFile = queueFilePath();
  const entry = {
    queued_at: new Date().toISOString(),
    receipt,
    last_error: result,
    ...metadata,
  };
  await appendProtectedStateFile(queueFile, `${JSON.stringify(entry)}\n`);
  console.error(`queued ${queueFile}`);
}

async function deadLetterReceipt(receipt, result) {
  const deadLetterFile = deadLetterFilePath();
  const entry = {
    rejected_at: new Date().toISOString(),
    receipt: redactDeep(receipt),
    last_error: redactDeep(result),
  };
  await appendProtectedStateFile(deadLetterFile, `${JSON.stringify(entry)}\n`);
  console.error(`dead_lettered ${deadLetterFile}`);
}

async function deadLetterQueueRow(rawLine, result) {
  const deadLetterFile = deadLetterFilePath();
  const entry = {
    rejected_at: new Date().toISOString(),
    receipt: null,
    raw_queue_row: summarizeQueueRow(rawLine),
    last_error: redactDeep(result),
  };
  await appendProtectedStateFile(deadLetterFile, `${JSON.stringify(entry)}\n`);
  console.error(`dead_lettered ${deadLetterFile}`);
}

async function ensureFileParentDir(file) {
  await mkdir(dirname(file), { recursive: true });
}

async function appendProtectedStateFile(file, line) {
  await ensureFileParentDir(file);
  if (await exists(file)) {
    await protectLocalStateFile(file);
    await appendFile(file, line);
    await protectLocalStateFile(file);
    return;
  }

  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeProtectedStateFile(tmp, line);
    await rename(tmp, file);
    await protectLocalStateFile(file);
  } catch (error) {
    await unlink(tmp).catch((unlinkError) => {
      if (unlinkError?.code !== 'ENOENT') throw unlinkError;
    });
    throw error;
  }
}

async function writeProtectedStateFile(file, content) {
  await ensureFileParentDir(file);
  await writeFile(file, content, { mode: 0o600 });
  await protectLocalStateFile(file);
}

async function protectLocalStateFile(file) {
  if (process.platform !== 'win32') {
    await chmod(file, 0o600);
    return;
  }

  const script = `
$ErrorActionPreference = 'Stop'
$path = $env:LOOPLET_PROTECTED_STATE_FILE
if (-not $path) { throw 'LOOPLET_PROTECTED_STATE_FILE was not supplied' }
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
if (-not $applied.AreAccessRulesProtected) { throw 'state file ACL is not protected' }
`;

  const result = await runCommand('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    ...process.env,
    LOOPLET_PROTECTED_STATE_FILE: file,
  });
  if (result.code !== 0) {
    throw new Error(`failed to protect bridge state file: ${result.stderr || result.stdout || `exit ${result.code}`}`);
  }
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

async function exists(file) {
  return await stat(file).then(() => true).catch((error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
}

function readConfig() {
  const webhookUrl = requiredEnv('LOOPLET_RECEIPT_WEBHOOK_URL');
  const apiKey = requiredEnv('LOOPLET_POS_API_KEY');
  const identityToken = process.env.LOOPLET_RECEIPT_IDENTITY_TOKEN || null;
  const syncTargets = (process.env.LOOPLET_SYNC_TARGETS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return { webhookUrl, apiKey, identityToken, syncTargets };
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
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

function readPositiveIntegerEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function readNonNegativeIntegerEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function queueFilePath() {
  return process.env.LOOPLET_BRIDGE_QUEUE_FILE || '.looplet-pos-queue.jsonl';
}

function deadLetterFilePath() {
  return process.env.LOOPLET_BRIDGE_DEAD_LETTER_FILE || queueFilePath().replace(/\.jsonl$/i, '.dead.jsonl');
}

function maxAttempts() {
  return readPositiveIntegerEnv('LOOPLET_BRIDGE_MAX_ATTEMPTS', 4);
}

function retryBaseMs() {
  return readPositiveIntegerEnv('LOOPLET_BRIDGE_RETRY_BASE_MS', 1000);
}

function pollMs() {
  return readPositiveIntegerEnv('LOOPLET_BRIDGE_POLL_MS', 2000);
}

function minFileAgeMs() {
  return readNonNegativeIntegerEnv('LOOPLET_BRIDGE_MIN_FILE_AGE_MS', 1000);
}

function isTransientResult(result) {
  return result.status === 0 || transientStatuses.has(result.status);
}

function timestampPrefix() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function safeFileName(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function summarizeQueueRow(value) {
  return redactSecrets(String(value)).slice(0, 500);
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
  return value
    .replace(/llp_[^\s"',}]+/g, 'llp_[redacted]')
    .replace(/rhp_[^\s"',}]+/g, 'rhp_[redacted]');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
