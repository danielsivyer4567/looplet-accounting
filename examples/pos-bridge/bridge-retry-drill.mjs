#!/usr/bin/env node
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

async function main() {
  const args = process.argv.slice(2);
  await loadEnvFileArg(args);
  const sampleOption = readOption(args, '--sample');
  const sample = sampleOption ? resolve(sampleOption) : join(scriptDir(), 'sample-receipt.json');
  const keepWorkDir = args.includes('--keep-work-dir');
  removeFlag(args, '--keep-work-dir');
  if (args.length > 0) throw new Error(`unsupported arguments: ${args.join(' ')}`);

  const workDir = await mkdtemp(join(tmpdir(), 'looplet-pos-retry-drill-'));
  const queueFile = join(workDir, 'queue.jsonl');
  const deadLetterFile = join(workDir, 'dead-letter.jsonl');
  const received = [];
  let mode = 'fail';
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

      try {
        const parsed = JSON.parse(body);
        if (req.method !== 'POST') throw new Error('method must be POST');
        if (!String(req.headers.authorization ?? '').startsWith('Bearer llp_')) {
          throw new Error('Authorization header must contain a Looplet POS API key');
        }
        if (req.headers['idempotency-key'] !== parsed.idempotency_key) {
          throw new Error('Idempotency-Key header must match body idempotency_key');
        }
        if (!String(parsed.identity_token ?? '').startsWith('rhp_')) {
          throw new Error('identity_token must be a Looplet receipt identity');
        }
        received.push(parsed);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          duplicate: false,
          event_type: parsed.event_type,
          receipt_event_id: `retry-drill-${received.length}`,
        }));
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const env = {
      ...process.env,
      LOOPLET_RECEIPT_WEBHOOK_URL: `http://127.0.0.1:${port}/functions/v1/receipt-webhook`,
      LOOPLET_BRIDGE_QUEUE_FILE: queueFile,
      LOOPLET_BRIDGE_DEAD_LETTER_FILE: deadLetterFile,
      LOOPLET_BRIDGE_MAX_ATTEMPTS: '2',
      LOOPLET_BRIDGE_RETRY_BASE_MS: '10',
    };

    const firstRun = await runBridge([sample], 1, env);
    const queued = await exists(queueFile);
    mode = 'success';
    const flushRun = await runBridge(['--flush'], 0, env);
    const queueFlushed = !(await exists(queueFile));
    const deadLetterExists = await exists(deadLetterFile);
    const combinedOutput = `${firstRun.stdout}\n${firstRun.stderr}\n${flushRun.stdout}\n${flushRun.stderr}`;
    const result = {
      ok: failedRequests >= 2 &&
        queued === true &&
        queueFlushed === true &&
        received.length === 1 &&
        deadLetterExists === false &&
        !containsUnredactedSecret(combinedOutput),
      non_sending: true,
      work_dir: keepWorkDir ? workDir : null,
      failed_requests_seen: failedRequests,
      queued_after_outage: queued,
      queue_flushed_after_recovery: queueFlushed,
      accepted_after_recovery: received.length === 1,
      dead_letter_created: deadLetterExists,
      idempotency_key: received[0]?.idempotency_key ?? null,
      receipt_event_id: received.length ? 'retry-drill-1' : null,
      secrets_redacted: !containsUnredactedSecret(combinedOutput),
    };
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
  } finally {
    server.close();
    if (!keepWorkDir) await rm(workDir, { recursive: true, force: true });
  }
}

async function runBridge(args, expectedCode, env) {
  const child = spawn(process.execPath, [join(scriptDir(), 'bridge.mjs'), ...args], {
    cwd: scriptDir(),
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

  const code = await new Promise((resolve) => child.on('exit', resolve));
  if (code !== expectedCode) {
    throw new Error(`bridge ${args.join(' ')} exited ${code}, expected ${expectedCode}\nstdout=${stdout}\nstderr=${stderr}`);
  }
  return { stdout, stderr };
}

async function exists(path) {
  return await stat(path).then(() => true).catch((error) => {
    if (error?.code === 'ENOENT') return false;
    throw error;
  });
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

function containsUnredactedSecret(text) {
  return /llp_(?!\[redacted\])[^"\s',}]+\.[^"\s',}]+/.test(text) ||
    /rhp_(?!\[redacted\])[^"\s',}]+\.[^"\s',}]+/.test(text);
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
