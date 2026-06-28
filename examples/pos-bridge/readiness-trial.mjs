#!/usr/bin/env node
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

const rootDir = process.env.LOOPLET_READINESS_TRIAL_DIR || '.claude/scratch/pos-readiness-trial';
const inboxDir = join(rootDir, 'inbox');
const envFile = join(rootDir, 'bridge.env');
const noFallbackEnvFile = join(rootDir, 'bridge-no-fallback.env');
const badEnvFile = join(rootDir, 'bad.env');
const scannedSampleFile = join(rootDir, 'sample-scanned-identity.json');
const incompleteBridgeDir = join(rootDir, 'incomplete-bridge');
let optionsSeen = false;

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    optionsSeen = true;
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, idempotency-key',
    });
    res.end();
    return;
  }
  res.writeHead(405, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

try {
  await rm(rootDir, { recursive: true, force: true });
  await mkdir(rootDir, { recursive: true });
  await mkdir(incompleteBridgeDir, { recursive: true });
  await cp('examples/pos-bridge/readiness.mjs', join(incompleteBridgeDir, 'readiness.mjs'));
  await cp('examples/pos-bridge/contract.mjs', join(incompleteBridgeDir, 'contract.mjs'));
  await cp('examples/pos-bridge/sample-receipt.json', join(incompleteBridgeDir, 'sample-receipt.json'));
  await writeFile(envFile, [
    `LOOPLET_RECEIPT_WEBHOOK_URL=http://127.0.0.1:${port}/functions/v1/receipt-webhook`,
    'LOOPLET_POS_API_KEY=llp_trial.secret',
    'LOOPLET_RECEIPT_IDENTITY_TOKEN=rhp_trial.receiptsecret',
    'LOOPLET_SYNC_TARGETS=xero,myob',
    `LOOPLET_BRIDGE_INBOX_DIR=${inboxDir}`,
    `LOOPLET_BRIDGE_QUEUE_FILE=${join(rootDir, 'queue.jsonl')}`,
    `LOOPLET_BRIDGE_DEAD_LETTER_FILE=${join(rootDir, 'dead.jsonl')}`,
    'LOOPLET_BRIDGE_MIN_FILE_AGE_MS=1000',
    '',
  ].join('\n'));
  await writeFile(noFallbackEnvFile, [
    `LOOPLET_RECEIPT_WEBHOOK_URL=http://127.0.0.1:${port}/functions/v1/receipt-webhook`,
    'LOOPLET_POS_API_KEY=llp_trial.secret',
    'LOOPLET_SYNC_TARGETS=xero,myob',
    `LOOPLET_BRIDGE_INBOX_DIR=${join(rootDir, 'inbox-no-fallback')}`,
    `LOOPLET_BRIDGE_QUEUE_FILE=${join(rootDir, 'queue-no-fallback.jsonl')}`,
    `LOOPLET_BRIDGE_DEAD_LETTER_FILE=${join(rootDir, 'dead-no-fallback.jsonl')}`,
    'LOOPLET_BRIDGE_MIN_FILE_AGE_MS=1000',
    '',
  ].join('\n'));
  const scannedSample = JSON.parse(await readFile('examples/pos-bridge/sample-receipt.json', 'utf8'));
  scannedSample.identity_token = 'rhp_trial.receiptsecret';
  await writeFile(scannedSampleFile, JSON.stringify(scannedSample, null, 2));
  await writeFile(badEnvFile, [
    `LOOPLET_RECEIPT_WEBHOOK_URL=http://127.0.0.1:${port}/wrong-path`,
    'LOOPLET_POS_API_KEY=bad',
    'LOOPLET_RECEIPT_IDENTITY_TOKEN=also-bad',
    `LOOPLET_BRIDGE_INBOX_DIR=${join(rootDir, 'bad-inbox')}`,
    'LOOPLET_BRIDGE_MIN_FILE_AGE_MS=-1',
    '',
  ].join('\n'));

  const good = await runReadiness(envFile, 0);
  const goodJson = parseJson(good.stdout);
  assert(goodJson.ok === true, 'readiness should pass with valid local config');
  assert(goodJson.checks.node.ok === true, 'node check should pass');
  assert(goodJson.checks.config.api_key_shape === 'llp_*', 'api key shape should be redacted');
  assert(goodJson.checks.config.identity_token_fallback_shape === 'rhp_*', 'identity token fallback shape should be redacted');
  assert(goodJson.checks.config.min_file_age_ms === '1000', 'min file age should be reported');
  assert(goodJson.checks.bridge_files.ok === true, 'bridge file completeness check should pass');
  assert(goodJson.checks.bridge_files.present_count === goodJson.checks.bridge_files.required_count, 'bridge file completeness should count every required file');
  assert(goodJson.checks.bridge_files.files.some((entry) => entry.file === 'csv-adapter.mjs'), 'bridge file completeness should include the CSV adapter');
  assert(goodJson.checks.bridge_files.manifest.present === false, 'source-tree readiness should report no package manifest');
  assert(goodJson.checks.inbox.writable === true, 'inbox should be writable');
  assert(goodJson.checks.contract.idempotency_key === 'pos-payment-evt-100042', 'sample idempotency mismatch');
  assert(goodJson.checks.network.status === 204, 'network readiness should use OPTIONS');
  assert(optionsSeen === true, 'fake endpoint did not see OPTIONS readiness probe');
  assert(!good.stdout.includes('llp_trial.secret'), 'readiness output leaked API key');
  assert(!good.stdout.includes('rhp_trial.receiptsecret'), 'readiness output leaked identity token');

  const noFallback = await runReadiness(noFallbackEnvFile, 0, ['--sample', scannedSampleFile]);
  const noFallbackJson = parseJson(noFallback.stdout);
  assert(noFallbackJson.ok === true, 'readiness should pass with scanned sample identity and no fallback env token');
  assert(noFallbackJson.checks.config.identity_token_fallback_shape === null, 'no fallback env token should be reported as absent');
  assert(noFallbackJson.checks.contract.identity_token_source === 'receipt', 'readiness should use the scanned receipt identity from the sample');
  assert(!noFallback.stdout.includes('rhp_trial.receiptsecret'), 'no-fallback readiness output leaked sample identity token');

  const bad = await runReadiness(badEnvFile, 1);
  const badJson = parseJson(bad.stdout);
  assert(badJson.ok === false, 'readiness should fail with bad config');
  assert(badJson.checks.config.errors.length >= 3, 'bad config should report multiple errors');

  const incomplete = await runReadiness(envFile, 1, [], join(incompleteBridgeDir, 'readiness.mjs'));
  const incompleteJson = parseJson(incomplete.stdout);
  assert(incompleteJson.ok === false, 'readiness should fail when the installed bridge directory is incomplete');
  assert(incompleteJson.checks.bridge_files.ok === false, 'incomplete bridge should fail bridge_files check');
  assert(incompleteJson.checks.bridge_files.missing.includes('bridge.mjs'), 'incomplete bridge should report missing bridge.mjs');
  assert(incompleteJson.checks.bridge_files.missing.includes('csv-adapter.mjs'), 'incomplete bridge should report missing csv-adapter.mjs');

  console.log(JSON.stringify({
    ok: true,
    valid_config_passed: goodJson.ok,
    options_probe_seen: optionsSeen,
    inbox_writable: goodJson.checks.inbox.writable,
    contract_validated: goodJson.checks.contract.ok,
    scanned_identity_without_fallback_env_passed: noFallbackJson.ok,
    scanned_identity_source_reported: noFallbackJson.checks.contract.identity_token_source,
    bridge_files_checked: goodJson.checks.bridge_files.ok,
    incomplete_bridge_rejected: incompleteJson.ok === false,
    secrets_redacted: true,
    bad_config_failed: badJson.ok === false,
  }, null, 2));
} finally {
  server.close();
}

async function runReadiness(file, expectedCode, extraArgs = [], script = 'examples/pos-bridge/readiness.mjs') {
  const child = spawn(process.execPath, [script, '--env-file', file, ...extraArgs], {
    cwd: process.cwd(),
    env: readinessEnv(),
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
    throw new Error(`readiness exited ${code}, expected ${expectedCode}\nstdout=${stdout}\nstderr=${stderr}`);
  }
  return { stdout, stderr };
}

function readinessEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('LOOPLET_')) delete env[key];
  }
  return env;
}

function parseJson(value) {
  return JSON.parse(value.slice(value.indexOf('{')));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
