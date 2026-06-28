#!/usr/bin/env node
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { appendFile, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

const rootDir = process.env.LOOPLET_BRIDGE_WATCH_TRIAL_DIR || '.claude/scratch/pos-bridge-watch-trial';
const inboxDir = join(rootDir, 'inbox');
const envFile = join(rootDir, 'bridge.env');
const freshGuardEnvFile = join(rootDir, 'fresh-guard.env');
const queueDir = join(rootDir, 'state', 'queue');
const deadLetterDir = join(rootDir, 'state', 'dead-letter');
const queueFile = join(queueDir, 'queue.jsonl');
const deadLetterFile = join(deadLetterDir, 'dead.jsonl');
const received = [];
let mode = 'success';
let failedRequests = 0;

const server = createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    if (mode === 'fail') {
      failedRequests += 1;
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'temporary_outage' }));
      return;
    }
    if (mode === 'reject') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'permanent_reject_after_queue' }));
      return;
    }

    try {
      const parsed = JSON.parse(body);
      assert(req.method === 'POST', 'method must be POST');
      assert(req.headers.authorization === 'Bearer llp_trial.secret', 'Authorization header mismatch');
      assert(req.headers['idempotency-key'] === parsed.idempotency_key, 'Idempotency-Key mismatch');
      assert(parsed.identity_token === 'rhp_trial.receiptsecret', 'identity token mismatch');
      assert(parsed.source_channel === 'pos', 'source_channel mismatch');
      received.push(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        duplicate: false,
        event_type: parsed.event_type,
        receipt_event_id: `watch-${parsed.event_type}-${received.length}`,
      }));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: error.message }));
    }
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

try {
  await rm(rootDir, { recursive: true, force: true });
  await mkdir(inboxDir, { recursive: true });
  await writeFile(envFile, [
    `LOOPLET_RECEIPT_WEBHOOK_URL=http://127.0.0.1:${port}/functions/v1/receipt-webhook`,
    'LOOPLET_POS_API_KEY=llp_trial.secret',
    'LOOPLET_RECEIPT_IDENTITY_TOKEN=rhp_trial.receiptsecret',
    'LOOPLET_SYNC_TARGETS=xero,myob',
    `LOOPLET_BRIDGE_QUEUE_FILE=${queueFile}`,
    `LOOPLET_BRIDGE_DEAD_LETTER_FILE=${deadLetterFile}`,
    'LOOPLET_BRIDGE_MAX_ATTEMPTS=2',
    'LOOPLET_BRIDGE_RETRY_BASE_MS=10',
    'LOOPLET_BRIDGE_MIN_FILE_AGE_MS=0',
    '',
  ].join('\n'));
  await writeFile(freshGuardEnvFile, [
    `LOOPLET_RECEIPT_WEBHOOK_URL=http://127.0.0.1:${port}/functions/v1/receipt-webhook`,
    'LOOPLET_POS_API_KEY=llp_trial.secret',
    'LOOPLET_RECEIPT_IDENTITY_TOKEN=rhp_trial.receiptsecret',
    'LOOPLET_SYNC_TARGETS=xero,myob',
    `LOOPLET_BRIDGE_QUEUE_FILE=${queueFile}`,
    `LOOPLET_BRIDGE_DEAD_LETTER_FILE=${deadLetterFile}`,
    'LOOPLET_BRIDGE_MAX_ATTEMPTS=2',
    'LOOPLET_BRIDGE_RETRY_BASE_MS=10',
    'LOOPLET_BRIDGE_MIN_FILE_AGE_MS=60000',
    '',
  ].join('\n'));

  await copyFile('examples/pos-bridge/sample-receipt.json', join(inboxDir, '001-sale.json'));
  await runBridge(['--watch-once', inboxDir], 0);
  assert(received.length === 1 && received[0].event_type === 'sale', 'watch-once should send one sale');
  assert((await listFiles(join(inboxDir, 'sent'))).length === 1, 'sale file should move to sent');
  await assertAllProtected(join(inboxDir, 'sent'), 'sent sale archive');

  const invalidPending = JSON.parse(await readFile('examples/pos-bridge/sample-invalid-pending.json', 'utf8'));
  invalidPending.identity_token = 'rhp_trial.receiptsecret';
  invalidPending.payload.receipt.identity_token = 'rhp_payload.receiptsecret';
  invalidPending.payload.customer = { looplet_identity_token: 'rhp_customer.receiptsecret' };
  await writeFile(join(inboxDir, '002-invalid-pending.json'), JSON.stringify(invalidPending, null, 2));
  await runBridge(['--watch-once', inboxDir], 0);
  assert(received.length === 1, 'invalid pending receipt must not be posted');
  assert((await listFiles(join(inboxDir, 'rejected'))).length === 1, 'invalid receipt should move to rejected');
  await assertAllProtected(join(inboxDir, 'rejected'), 'rejected invalid archive');
  await stat(deadLetterFile);
  const firstDeadLetterProtection = await inspectProtectedStateFile(deadLetterFile);
  assert(firstDeadLetterProtection.protected === true, 'dead-letter file should be filesystem-protected');
  const permanentRejectDeadLetter = await readFile(deadLetterFile, 'utf8');
  assert(!permanentRejectDeadLetter.includes('rhp_trial.receiptsecret'), 'dead-lettered receipt should redact top-level receipt token');
  assert(!permanentRejectDeadLetter.includes('rhp_payload.receiptsecret'), 'dead-lettered receipt should redact payload receipt token');
  assert(!permanentRejectDeadLetter.includes('rhp_customer.receiptsecret'), 'dead-lettered receipt should redact customer receipt token');
  assert(permanentRejectDeadLetter.includes('rhp_[redacted]'), 'dead-lettered receipt should keep a redacted receipt-token marker');

  mode = 'fail';
  const retryRefund = JSON.parse(await readFile('examples/pos-bridge/sample-refund.json', 'utf8'));
  retryRefund.identity_token = 'rhp_trial.receiptsecret';
  await writeFile(join(inboxDir, '003-refund.json'), JSON.stringify(retryRefund, null, 2));
  await runBridge(['--watch-once', inboxDir], 0);
  assert(failedRequests >= 2, 'transient outage should be retried');
  assert((await listFiles(join(inboxDir, 'queued'))).length === 1, 'transient failure should move to queued');
  await assertAllProtected(join(inboxDir, 'queued'), 'queued refund archive');
  await stat(queueFile);
  const firstQueueProtection = await inspectProtectedStateFile(queueFile);
  assert(firstQueueProtection.protected === true, 'retry queue file should be filesystem-protected');
  const queuedReceiptContent = await readFile(queueFile, 'utf8');
  assert(queuedReceiptContent.includes('rhp_trial.receiptsecret'), 'retry queue must retain receipt token for resend');
  await appendFile(queueFile, '{"receipt":{"identity_token":"rhp_trial.receiptsecret"}\n');

  mode = 'success';
  await runBridge(['--flush'], 0);
  const queueStillExists = await exists(queueFile);
  assert(!queueStillExists, 'queue should be removed after successful flush');
  assert(received.length === 2 && received[1].event_type === 'refund', 'queued refund should flush successfully');
  assert((await listFiles(join(inboxDir, 'queued'))).length === 0, 'queued archive should move to sent after successful flush');
  assert((await listFiles(join(inboxDir, 'sent'))).length === 2, 'sent folder should contain the original sale and flushed refund archives');
  await assertAllProtected(join(inboxDir, 'sent'), 'sent archives after queue flush');
  assert(await exists(queueDir), 'queue parent directory should be created on demand');
  assert(await exists(deadLetterDir), 'dead-letter parent directory should be created on demand');
  const deadLetterContent = await readFile(deadLetterFile, 'utf8');
  const secondDeadLetterProtection = await inspectProtectedStateFile(deadLetterFile);
  assert(secondDeadLetterProtection.protected === true, 'dead-letter file should remain protected after append');
  assert(deadLetterContent.includes('invalid queue JSONL row'), 'malformed queue row should be dead-lettered');
  assert(!deadLetterContent.includes('rhp_trial.receiptsecret'), 'dead-lettered queue row should redact receipt token');

  mode = 'fail';
  const retryVoid = JSON.parse(await readFile('examples/pos-bridge/sample-void.json', 'utf8'));
  retryVoid.identity_token = 'rhp_trial.receiptsecret';
  await writeFile(join(inboxDir, '004-void.json'), JSON.stringify(retryVoid, null, 2));
  await runBridge(['--watch-once', inboxDir], 0);
  assert((await listFiles(join(inboxDir, 'queued'))).length === 1, 'transient void failure should move to queued');
  await assertAllProtected(join(inboxDir, 'queued'), 'queued void archive');
  const secondQueueProtection = await inspectProtectedStateFile(queueFile);
  assert(secondQueueProtection.protected === true, 'retry queue file should remain protected after append');

  mode = 'reject';
  await runBridge(['--flush'], 0);
  assert(!(await exists(queueFile)), 'queue should be removed after permanent queued receipt rejection');
  assert((await listFiles(join(inboxDir, 'queued'))).length === 0, 'permanently rejected queued archive should leave queued');
  assert(
    (await listFiles(join(inboxDir, 'rejected'))).length === 2,
    'permanently rejected queued archive should move to rejected',
  );
  await assertAllProtected(join(inboxDir, 'rejected'), 'rejected archives after queued rejection');
  const permanentQueueRejectDeadLetter = await readFile(deadLetterFile, 'utf8');
  assert(
    permanentQueueRejectDeadLetter.includes('permanent_reject_after_queue'),
    'permanently rejected queued receipt should be dead-lettered',
  );
  assert(
    !permanentQueueRejectDeadLetter.includes('rhp_trial.receiptsecret'),
    'permanently rejected queued receipt dead-letter should redact receipt token',
  );

  mode = 'success';
  await writeFile(join(inboxDir, '005-partial.json'), '{"still":"being written"');
  const freshGuard = await runBridge(['--watch-once', inboxDir], 0, freshGuardEnvFile);
  assert(freshGuard.stdout.includes('watch_once_processed 0'), 'fresh files should be skipped until settled');
  assert((await listFiles(inboxDir)).includes('005-partial.json'), 'fresh unsettled file should remain in the inbox');
  assert((await listFiles(join(inboxDir, 'rejected'))).length === 2, 'fresh unsettled file must not be rejected');

  console.log(JSON.stringify({
    ok: true,
    watched_sale: received[0].event_type,
    rejected_pending: true,
    transient_retry_attempts_seen: failedRequests,
    flushed_event: received[1].event_type,
    queued_archive_cleared_after_flush: true,
    queued_archive_rejected_after_permanent_failure: true,
    malformed_queue_row_dead_lettered: true,
    permanent_reject_dead_letter_redacted: true,
    retry_queue_file_protected: true,
    dead_letter_file_protected: true,
    receipt_archives_protected: true,
    retry_queue_keeps_token_for_resend: true,
    queue_parent_dirs_created: true,
    sent_files: (await listFiles(join(inboxDir, 'sent'))).length,
    queued_files: (await listFiles(join(inboxDir, 'queued'))).length,
    rejected_files: (await listFiles(join(inboxDir, 'rejected'))).length,
    fresh_files_skipped_until_settled: true,
  }, null, 2));
} finally {
  server.close();
}

async function runBridge(args, expectedCode, file = envFile) {
  const child = spawn(process.execPath, ['examples/pos-bridge/bridge.mjs', '--env-file', file, ...args], {
    cwd: process.cwd(),
    env: bridgeEnv(),
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
    throw new Error(`bridge ${args.join(' ')} exited ${code}, expected ${expectedCode}\nstdout=${stdout}\nstderr=${stderr}`);
  }
  return { stdout, stderr };
}

function bridgeEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('LOOPLET_')) delete env[key];
  }
  return env;
}

async function assertAllProtected(dir, label) {
  const files = await listFiles(dir);
  assert(files.length > 0, `${label} should have files to inspect`);
  for (const file of files) {
    const protection = await inspectProtectedStateFile(join(dir, file));
    assert(protection.protected === true, `${label} ${file} should be filesystem-protected`);
  }
}

async function inspectProtectedStateFile(file) {
  if (process.platform !== 'win32') {
    const info = await stat(file);
    const mode = info.mode & 0o777;
    const protectedMode = (mode & 0o077) === 0;
    return { protected: protectedMode };
  }

  const script = `
$ErrorActionPreference = 'Stop'
$path = (Resolve-Path -LiteralPath $env:LOOPLET_PROTECTED_STATE_FILE).Path
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
  const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    cwd: process.cwd(),
    env: { ...process.env, LOOPLET_PROTECTED_STATE_FILE: file },
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
    throw new Error(`PowerShell ACL inspection failed ${code}\nstdout=${stdout}\nstderr=${stderr}`);
  }
  const parsed = JSON.parse(stdout);
  return {
    protected: parsed.protected === true &&
      parsed.excludes_everyone === true &&
      parsed.excludes_authenticated_users === true &&
      parsed.excludes_builtin_users === true,
  };
}

async function listFiles(dir) {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function exists(path) {
  return await stat(path).then(() => true).catch((error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
