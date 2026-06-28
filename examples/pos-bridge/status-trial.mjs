#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

const rootDir = '.claude/scratch/pos-status-trial';
const cleanDir = join(rootDir, 'clean');
const attentionDir = join(rootDir, 'attention');
const unprotectedDir = join(rootDir, 'unprotected');

await rm(rootDir, { recursive: true, force: true });
await mkdir(cleanDir, { recursive: true });
await mkdir(attentionDir, { recursive: true });

const cleanEnv = await writeEnv(cleanDir);
await writeSchedulerLog(cleanDir, {
  timestamp: new Date(),
  exitCode: 0,
  processed: 0,
});
const cleanRun = await runStatus(cleanEnv, 0);
const clean = JSON.parse(cleanRun.stdout);
assert(clean.ok === true, 'clean status should be ok');
assert(clean.queue.count === 0, 'clean queue should be empty');
assert(clean.dead_letter.count === 0, 'clean dead-letter should be empty');
assert(clean.inbox.pending === 0, 'clean inbox should be empty');
assert(clean.scheduler.ok === true, 'fresh scheduler log should be ok');
assert(clean.scheduler.last_exit_code === 0, 'fresh scheduler exit code mismatch');
assert(clean.local_file_protection.ok === true, 'clean status should prove local files are protected');
assert(clean.local_file_protection.checked_count >= 2, 'clean status should inspect env and scheduler log protection');
assert(!cleanRun.stdout.includes('secret'), 'status output must not expose API-key or receipt-token secrets');

const attentionEnv = await writeEnv(attentionDir);
await mkdir(join(attentionDir, 'inbox', 'processing'), { recursive: true });
await mkdir(join(attentionDir, 'inbox', 'queued'), { recursive: true });
await mkdir(join(attentionDir, 'inbox', 'rejected'), { recursive: true });
await writeProtectedFile(join(attentionDir, 'inbox', 'pending-sale.json'), '{}\n');
await writeProtectedFile(join(attentionDir, 'inbox', 'processing', 'stuck-sale.json'), '{}\n');
await writeProtectedFile(join(attentionDir, 'inbox', 'queued', 'retry-sale.json'), '{}\n');
await writeProtectedFile(join(attentionDir, 'inbox', 'rejected', 'bad-sale.json'), '{}\n');
await writeProtectedFile(join(attentionDir, 'queue.jsonl'), `${JSON.stringify({
  queued_at: '2026-01-01T00:00:00.000Z',
  receipt: { payload: { receipt: { number: 'SHOULD-NOT-PRINT' } } },
  last_error: { status: 503, error: 'provider unavailable' },
})}\nnot-json\n`);
await writeProtectedFile(join(attentionDir, 'dead.jsonl'), `${JSON.stringify({
  rejected_at: '2026-01-01T00:01:00.000Z',
  receipt: { identity_token: 'rhp_trial.secret' },
  last_error: { status: 400, error: 'bad line totals for rhp_trial.secret using llp_trial.secret' },
})}\nnot-json\n`);
await writeSchedulerLog(attentionDir, {
  timestamp: new Date('2000-01-01T00:00:00.000Z'),
  exitCode: 1,
  processed: 0,
  extraLine: 'watch_once_error failed with llp_trial.secret and rhp_trial.secret',
});

const attentionRun = await runStatus(attentionEnv, 1);
const attention = JSON.parse(attentionRun.stdout);
assert(attention.ok === false, 'attention status should fail');
assert(attention.inbox.pending === 1, 'pending inbox count mismatch');
assert(attention.inbox.processing === 1, 'processing inbox count mismatch');
assert(attention.inbox.queued === 1, 'queued inbox count mismatch');
assert(attention.inbox.rejected === 1, 'rejected inbox count mismatch');
assert(attention.queue.count === 2, 'queue row count mismatch');
assert(attention.queue.valid_rows === 1, 'queue valid row count mismatch');
assert(attention.queue.parse_errors === 1, 'queue parse error count mismatch');
assert(attention.queue.last_error_status === 503, 'queue last error status mismatch');
assert(attention.dead_letter.count === 2, 'dead-letter row count mismatch');
assert(attention.dead_letter.valid_rows === 1, 'dead-letter valid row count mismatch');
assert(attention.dead_letter.parse_errors === 1, 'dead-letter parse error count mismatch');
assert(attention.scheduler.ok === false, 'stale or failed scheduler log should fail status');
assert(attention.scheduler.last_exit_code === 1, 'scheduler should report the failing exit code');
assert(attention.scheduler.age_minutes > 10, 'scheduler should report stale run age');
assert(attention.local_file_protection.ok === true, 'attention status should not conflate queue work with file protection');
assert(attention.attention_required.length === 8, 'attention messages mismatch');
assert(attention.attention_required.some((message) => message.includes('queued receipt file')), 'queued inbox files should require attention');
assert(attention.attention_required.some((message) => message.includes('rejected receipt file')), 'rejected inbox files should require attention');
assert(attention.attention_required.some((message) => message.includes('queued receipt row')), 'queue parse errors should require attention');
assert(attention.attention_required.some((message) => message.includes('dead-letter row')), 'dead-letter parse errors should require attention');
assert(!attentionRun.stdout.includes('SHOULD-NOT-PRINT'), 'status output must not expose receipt payloads');
assert(!attentionRun.stdout.includes('rhp_trial.secret'), 'status output must not expose receipt identity tokens');
assert(!attentionRun.stdout.includes('llp_trial.secret'), 'status output must not expose POS API keys');

const unprotectedEnv = await writeEnv(unprotectedDir, { protect: false });
await writeSchedulerLog(unprotectedDir, {
  timestamp: new Date(),
  exitCode: 0,
  processed: 0,
  protect: false,
});
const unprotectedRun = await runStatus(unprotectedEnv, 1);
const unprotected = JSON.parse(unprotectedRun.stdout);
assert(unprotected.ok === false, 'unprotected local files should fail status');
assert(unprotected.local_file_protection.ok === false, 'status should report unprotected local files');
assert(
  unprotected.attention_required.some((message) => message.includes('filesystem-protected')),
  'status should require local file protection attention',
);

console.log(JSON.stringify({
  ok: true,
  clean_ok: clean.ok,
  attention_ok: attention.ok,
  queue_count: attention.queue.count,
  queue_parse_errors: attention.queue.parse_errors,
  dead_letter_count: attention.dead_letter.count,
  dead_letter_parse_errors: attention.dead_letter.parse_errors,
  processing_files: attention.inbox.processing,
  queued_files: attention.inbox.queued,
  rejected_files: attention.inbox.rejected,
  scheduler_ok: clean.scheduler.ok,
  scheduler_failure_detected: attention.scheduler.ok === false,
  local_file_protection_ok: clean.local_file_protection.ok,
  unprotected_local_files_rejected: true,
  secrets_redacted: true,
  payloads_redacted: true,
}, null, 2));

async function writeEnv(dir, options = {}) {
  await mkdir(join(dir, 'inbox'), { recursive: true });
  const logDir = join(dir, 'logs');
  const file = join(dir, 'bridge.env');
  await writeFile(file, [
    'LOOPLET_RECEIPT_WEBHOOK_URL=https://example.supabase.co/functions/v1/receipt-webhook',
    'LOOPLET_POS_API_KEY=llp_trial.secret',
    'LOOPLET_RECEIPT_IDENTITY_TOKEN=rhp_trial.receiptsecret',
    'LOOPLET_SYNC_TARGETS=xero,myob',
    `LOOPLET_BRIDGE_QUEUE_FILE=${join(dir, 'queue.jsonl')}`,
    `LOOPLET_BRIDGE_DEAD_LETTER_FILE=${join(dir, 'dead.jsonl')}`,
    `LOOPLET_BRIDGE_INBOX_DIR=${join(dir, 'inbox')}`,
    `LOOPLET_BRIDGE_LOG_DIR=${logDir}`,
    'LOOPLET_BRIDGE_STALE_AFTER_MINUTES=10',
    '',
  ].join('\n'));
  if (options.protect !== false) await protectFile(file);
  return file;
}

async function writeSchedulerLog(dir, options) {
  const logDir = join(dir, 'logs');
  await mkdir(logDir, { recursive: true });
  const iso = options.timestamp.toISOString();
  const day = iso.slice(0, 10);
  const file = join(logDir, `bridge-${day}.log`);
  await writeFile(file, [
    `${iso} watch_once_start bridge=bridge.mjs inbox=${join(dir, 'inbox')}`,
    options.extraLine ? `${iso} ${options.extraLine}` : null,
    `${iso} watch_once_processed ${options.processed}`,
    `${iso} watch_once_end exit_code=${options.exitCode}`,
    '',
  ].filter(Boolean).join('\n'));
  if (options.protect !== false) await protectFile(file);
}

async function writeProtectedFile(file, content) {
  await writeFile(file, content);
  await protectFile(file);
}

async function protectFile(file) {
  if (process.platform !== 'win32') {
    await chmod(file, 0o600);
    return;
  }

  const script = `
$ErrorActionPreference = 'Stop'
$path = (Resolve-Path -LiteralPath $env:LOOPLET_PROTECTED_FILE).Path
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
[System.IO.File]::SetAccessControl($path, $security)
`;
  const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    cwd: process.cwd(),
    env: { ...process.env, LOOPLET_PROTECTED_FILE: file },
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
  if (code !== 0) {
    throw new Error(`protectFile exited ${code}\nstdout=${stdout}\nstderr=${stderr}`);
  }
}

async function runStatus(envFile, expectedCode) {
  const child = spawn(process.execPath, ['examples/pos-bridge/status.mjs', '--env-file', envFile], {
    cwd: process.cwd(),
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
  if (code !== expectedCode) {
    throw new Error(`status exited ${code}, expected ${expectedCode}\nstdout=${stdout}\nstderr=${stderr}`);
  }
  return { stdout, stderr };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
