#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';

async function main() {
  const args = process.argv.slice(2);
  const envFile = await loadEnvFileArg(args);
  const config = readConfig();

  const [inbox, queue, deadLetter, scheduler] = await Promise.all([
    inspectInbox(config.inboxDir),
    inspectJsonl(config.queueFile, 'queue'),
    inspectJsonl(config.deadLetterFile, 'dead_letter'),
    inspectSchedulerLogs(config.logDir, config.staleAfterMinutes),
  ]);
  const localFileProtection = await inspectLocalFileProtection(config, envFile, scheduler);

  const attention = [];
  if (queue.count > 0) attention.push(`${queue.count} queued receipt(s) need retry`);
  if (queue.parse_errors > 0) attention.push(`${queue.parse_errors} queued receipt row(s) could not be parsed`);
  if (deadLetter.count > 0) attention.push(`${deadLetter.count} dead-letter receipt(s) need operator review`);
  if (deadLetter.parse_errors > 0) attention.push(`${deadLetter.parse_errors} dead-letter row(s) could not be parsed`);
  if (inbox.processing > 0) attention.push(`${inbox.processing} receipt file(s) remain in processing`);
  if (inbox.queued > 0) attention.push(`${inbox.queued} queued receipt file(s) need retry`);
  if (inbox.rejected > 0) attention.push(`${inbox.rejected} rejected receipt file(s) need operator review`);
  if (scheduler.configured && !scheduler.ok) attention.push(scheduler.message);
  if (!localFileProtection.ok) attention.push('local bridge sensitive files are not filesystem-protected');

  const result = {
    ok: attention.length === 0,
    checked_at: new Date().toISOString(),
    config: {
      inbox_dir: config.inboxDir,
      queue_file: config.queueFile,
      dead_letter_file: config.deadLetterFile,
      log_dir: config.logDir,
      stale_after_minutes: config.staleAfterMinutes,
      webhook_host: safeWebhookHost(config.webhookUrl),
      sync_targets: config.syncTargets,
    },
    inbox,
    queue,
    dead_letter: deadLetter,
    scheduler,
    local_file_protection: localFileProtection,
    attention_required: attention,
  };

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

async function inspectInbox(inboxDir) {
  const counts = {
    inbox_dir: inboxDir,
    pending: await countJsonFiles(inboxDir),
    processing: await countJsonFiles(join(inboxDir, 'processing')),
    sent: await countJsonFiles(join(inboxDir, 'sent')),
    queued: await countJsonFiles(join(inboxDir, 'queued')),
    rejected: await countJsonFiles(join(inboxDir, 'rejected')),
  };
  return counts;
}

async function inspectJsonl(file, label) {
  let content = '';
  try {
    content = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        file,
        exists: false,
        count: 0,
        newest_at: null,
        oldest_at: null,
        last_error_status: null,
        last_error: null,
        parse_errors: 0,
      };
    }
    throw error;
  }

  const rows = content.split(/\r?\n/).filter(Boolean);
  let parseErrors = 0;
  const entries = [];
  for (const row of rows) {
    try {
      entries.push(JSON.parse(row));
    } catch {
      parseErrors += 1;
    }
  }

  const dates = entries
    .map((entry) => entry.queued_at ?? entry.rejected_at)
    .filter((value) => typeof value === 'string' && value.trim())
    .sort();
  const latest = entries.at(-1);
  return {
    file,
    exists: true,
    count: rows.length,
    valid_rows: entries.length,
    newest_at: dates.at(-1) ?? null,
    oldest_at: dates[0] ?? null,
    last_error_status: latest?.last_error?.status ?? null,
    last_error: summariseError(latest?.last_error?.error, label),
    parse_errors: parseErrors,
  };
}

async function inspectSchedulerLogs(logDir, staleAfterMinutes) {
  if (!logDir) {
    return {
      ok: true,
      configured: false,
      message: 'LOOPLET_BRIDGE_LOG_DIR is not configured',
    };
  }

  let files = [];
  try {
    files = await readdir(logDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        ok: false,
        configured: true,
        log_dir: logDir,
        latest_log: null,
        last_run_at: null,
        last_exit_code: null,
        last_processed_count: null,
        age_minutes: null,
        stale_after_minutes: staleAfterMinutes,
        message: `scheduled task log directory is missing: ${logDir}`,
      };
    }
    throw error;
  }

  const logs = await Promise.all(
    files
      .filter((entry) => entry.isFile() && /^bridge-\d{4}-\d{2}-\d{2}\.log$/i.test(entry.name))
      .map(async (entry) => {
        const file = join(logDir, entry.name);
        return { file, stat: await stat(file) };
      }),
  );
  logs.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  const latest = logs[0];
  if (!latest) {
    return {
      ok: false,
      configured: true,
      log_dir: logDir,
      latest_log: null,
      last_run_at: null,
      last_exit_code: null,
      last_processed_count: null,
      age_minutes: null,
      stale_after_minutes: staleAfterMinutes,
      message: `no scheduled task logs found in ${logDir}`,
    };
  }

  const content = await readFile(latest.file, 'utf8');
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const lastEnd = findLastMatch(lines, /watch_once_end exit_code=(\d+)/);
  const lastProcessed = findLastMatch(lines, /watch_once_processed\s+(\d+)/);
  const lastRunAt = lastEnd ? parseLogTimestamp(lastEnd.line) : null;
  const ageMinutes = lastRunAt ? Math.max(0, Math.round((Date.now() - lastRunAt.getTime()) / 60000)) : null;
  const lastExitCode = lastEnd ? Number(lastEnd.match[1]) : null;
  const lastProcessedCount = lastProcessed ? Number(lastProcessed.match[1]) : null;
  const issues = [];

  if (!lastEnd) issues.push('latest scheduled task log has no completed watch_once_end entry');
  if (lastExitCode !== null && lastExitCode !== 0) issues.push(`latest scheduled task run exited ${lastExitCode}`);
  if (ageMinutes !== null && ageMinutes > staleAfterMinutes) {
    issues.push(`latest scheduled task run is stale (${ageMinutes} minutes old)`);
  }

  return {
    ok: issues.length === 0,
    configured: true,
    log_dir: logDir,
    latest_log: latest.file,
    last_run_at: lastRunAt?.toISOString() ?? null,
    last_exit_code: lastExitCode,
    last_processed_count: lastProcessedCount,
    age_minutes: ageMinutes,
    stale_after_minutes: staleAfterMinutes,
    message: issues[0] ?? 'scheduled task logs are current',
    last_line: lines.length ? redactSecrets(lines.at(-1)).slice(0, 240) : null,
  };
}

async function inspectLocalFileProtection(config, envFile, scheduler) {
  const targets = [];
  if (envFile) targets.push({ role: 'env_file', file: envFile, required: true });
  targets.push({ role: 'queue_file', file: config.queueFile, required: false });
  targets.push({ role: 'dead_letter_file', file: config.deadLetterFile, required: false });
  if (scheduler?.latest_log) {
    targets.push({ role: 'latest_scheduler_log', file: scheduler.latest_log, required: true });
  }

  for (const folder of ['processing', 'sent', 'queued', 'rejected']) {
    const dir = join(config.inboxDir, folder);
    const files = await listJsonFiles(dir);
    for (const fileName of files) {
      targets.push({
        role: `${folder}_receipt_archive`,
        file: join(dir, fileName),
        required: false,
      });
    }
  }

  const files = await Promise.all(targets.map(inspectProtectedFile));
  const existing = files.filter((file) => file.exists);
  const failures = files.filter((file) => file.exists && file.ok !== true);

  return {
    ok: failures.length === 0,
    platform: process.platform,
    checked_count: existing.length,
    failure_count: failures.length,
    files,
  };
}

async function listJsonFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function inspectProtectedFile(target) {
  try {
    await stat(target.file);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        ...target,
        exists: false,
        ok: true,
        protected: null,
      };
    }
    throw error;
  }

  if (process.platform !== 'win32') {
    const info = await stat(target.file);
    const mode = info.mode & 0o777;
    const protectedMode = (mode & 0o077) === 0;
    return {
      ...target,
      exists: true,
      ok: protectedMode,
      protected: protectedMode,
      mode: mode.toString(8).padStart(3, '0'),
    };
  }

  const inspection = await inspectWindowsAcl(target.file);
  return {
    ...target,
    exists: true,
    ok: inspection.protected === true &&
      inspection.excludes_everyone === true &&
      inspection.excludes_authenticated_users === true &&
      inspection.excludes_builtin_users === true,
    ...inspection,
  };
}

async function inspectWindowsAcl(file) {
  const script = `
$ErrorActionPreference = 'Stop'
$path = (Resolve-Path -LiteralPath $env:LOOPLET_PROTECTED_FILE).Path
$acl = [System.IO.File]::GetAccessControl($path)
$sids = @($acl.Access | ForEach-Object {
  try {
    $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  } catch {
    $_.IdentityReference.Value
  }
})
[ordered]@{
  protected = [bool]$acl.AreAccessRulesProtected
  excludes_everyone = -not ($sids -contains 'S-1-1-0')
  excludes_authenticated_users = -not ($sids -contains 'S-1-5-11')
  excludes_builtin_users = -not ($sids -contains 'S-1-5-32-545')
} | ConvertTo-Json -Depth 4
`;
  const result = await runCommand('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    ...process.env,
    LOOPLET_PROTECTED_FILE: file,
  });
  if (result.code !== 0) {
    return {
      protected: false,
      excludes_everyone: false,
      excludes_authenticated_users: false,
      excludes_builtin_users: false,
      error: redactSecrets(result.stderr || result.stdout || `exit ${result.code}`),
    };
  }
  return JSON.parse(result.stdout);
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

async function countJsonFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json')).length;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

function findLastMatch(lines, pattern) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].match(pattern);
    if (match) return { line: lines[index], match };
  }
  return null;
}

function parseLogTimestamp(line) {
  const raw = line.split(/\s+/, 1)[0];
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function summariseError(value, label) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return `${label}: ${redactSecrets(value.trim()).slice(0, 180)}`;
}

function redactSecrets(value) {
  return value
    .replace(/llp_[^\s"',}]+/g, 'llp_[redacted]')
    .replace(/rhp_[^\s"',}]+/g, 'rhp_[redacted]');
}

function safeWebhookHost(webhookUrl) {
  try {
    return new URL(webhookUrl).host;
  } catch {
    return null;
  }
}

function readConfig() {
  return {
    webhookUrl: process.env.LOOPLET_RECEIPT_WEBHOOK_URL ?? '',
    syncTargets: (process.env.LOOPLET_SYNC_TARGETS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    queueFile: process.env.LOOPLET_BRIDGE_QUEUE_FILE || '.looplet-pos-queue.jsonl',
    deadLetterFile: process.env.LOOPLET_BRIDGE_DEAD_LETTER_FILE || '.looplet-pos-dead.jsonl',
    inboxDir: process.env.LOOPLET_BRIDGE_INBOX_DIR || 'receipts-inbox',
    logDir: process.env.LOOPLET_BRIDGE_LOG_DIR || '',
    staleAfterMinutes: readPositiveInteger('LOOPLET_BRIDGE_STALE_AFTER_MINUTES', 10),
  };
}

function readPositiveInteger(name, defaultValue) {
  const value = process.env[name];
  if (value == null || value === '') return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return defaultValue;
  return parsed;
}

async function loadEnvFileArg(args) {
  const index = args.indexOf('--env-file');
  if (index === -1) return null;
  const file = args[index + 1];
  if (!file) throw new Error('--env-file requires a path');
  await loadEnvFile(file);
  args.splice(index, 2);
  return file;
}

async function loadEnvFile(file) {
  await stat(file);
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

await main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});
