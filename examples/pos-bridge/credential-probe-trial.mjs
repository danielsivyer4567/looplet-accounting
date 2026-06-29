#!/usr/bin/env node
import { createServer } from 'node:http';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

const rootDir = '.claude/scratch/pos-credential-probe-trial';
const envFile = join(rootDir, 'probe.env');
let sawProbeRequest = false;
let sawInvalidProbeIdentity = false;

const server = createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body);
      assert(req.method === 'POST', 'probe should POST');
      assert(req.headers.authorization === 'Bearer llp_trial.secret', 'authorization header mismatch');
      assert(String(req.headers['idempotency-key']).startsWith('credential-probe-'), 'idempotency key should be a probe key');
      assert(parsed.identity_token === 'rhp_probe.invalid', 'probe must use deliberately invalid identity');
      assert(parsed.source_channel === 'pos', 'probe source should be pos');
      assert(parsed.event_type === 'sale', 'probe event should be sale');
      assert(parsed.payload?.receipt?.tender_status === 'completed', 'probe receipt should have final tender');
      sawProbeRequest = true;
      sawInvalidProbeIdentity = true;
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'receipt identity not found or inactive' }));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

try {
  await rm(rootDir, { recursive: true, force: true });
  await mkdir(rootDir, { recursive: true });
  await writeFile(envFile, [
    `LOOPLET_RECEIPT_WEBHOOK_URL=http://127.0.0.1:${port}/functions/v1/receipt-webhook`,
    'LOOPLET_POS_API_KEY=llp_trial.secret',
    'LOOPLET_RECEIPT_IDENTITY_TOKEN=rhp_trial.receiptsecret',
    '',
  ].join('\n'));

  const run = await runProbe(envFile, 0);
  const probe = JSON.parse(run.stdout);
  assert(probe.ok === true, 'probe should succeed on identity rejection');
  assert(probe.status === 400, 'probe should report 400 identity rejection');
  assert(probe.api_key_valid === true, 'probe should mark API key valid');
  assert(probe.write_receipts_scope === true, 'probe should mark write scope valid');
  assert(probe.receipt_persisted === false, 'probe should report no receipt persistence');
  assert(!run.stdout.includes('llp_trial.secret'), 'probe output must not leak POS API key');
  assert(sawProbeRequest === true, 'fake webhook did not receive probe request');
  assert(sawInvalidProbeIdentity === true, 'probe did not use invalid identity');

  const badScopeServer = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'missing write:receipts scope' }));
    });
  });
  await new Promise((resolve) => badScopeServer.listen(0, '127.0.0.1', resolve));
  const badScopePort = badScopeServer.address().port;
  const badScopeEnv = join(rootDir, 'bad-scope.env');
  await writeFile(badScopeEnv, [
    `LOOPLET_RECEIPT_WEBHOOK_URL=http://127.0.0.1:${badScopePort}/functions/v1/receipt-webhook`,
    'LOOPLET_POS_API_KEY=llp_trial.secret',
    'LOOPLET_RECEIPT_IDENTITY_TOKEN=rhp_trial.receiptsecret',
    '',
  ].join('\n'));
  const badScope = await runProbe(badScopeEnv, 1);
  const badScopeProbe = JSON.parse(badScope.stdout);
  assert(badScopeProbe.ok === false, 'missing scope probe should fail');
  assert(badScopeProbe.write_receipts_scope === false, 'missing scope should be diagnosed');
  badScopeServer.close();

  console.log(JSON.stringify({
    ok: true,
    identity_rejection_means_key_and_scope_ok: true,
    missing_scope_detected: true,
    receipt_persisted: false,
    secrets_redacted: true,
  }, null, 2));
} finally {
  server.close();
}

async function runProbe(file, expectedCode) {
  const child = spawn(process.execPath, ['examples/pos-bridge/credential-probe.mjs', '--env-file', file], {
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
    throw new Error(`credential probe exited ${code}, expected ${expectedCode}\nstdout=${stdout}\nstderr=${stderr}`);
  }
  return { stdout, stderr };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
