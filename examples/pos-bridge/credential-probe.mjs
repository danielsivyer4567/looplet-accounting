#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { buildWebhookBody } from './contract.mjs';

const defaultSample = new URL('sample-receipt.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:\/)/, '$1');

async function main() {
  const args = process.argv.slice(2);
  await loadEnvFileArg(args);
  const samplePath = readOption(args, '--sample') ?? process.env.LOOPLET_READINESS_SAMPLE ?? defaultSample;
  const config = readConfig();
  const sample = JSON.parse(await readFile(samplePath, 'utf8'));
  const probeId = `credential-probe-${Date.now()}`;
  sample.idempotency_key = probeId;
  sample.payload.receipt.number = probeId;
  sample.payload.receipt.external_event_id = probeId;

  const body = buildWebhookBody(sample, {
    ...config,
    identityToken: 'rhp_probe.invalid',
  });

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
  const error = String(responseBody.error ?? responseBody.msg ?? '').toLowerCase();
  const identityRejected = response.status === 400 && error.includes('identity');
  const result = {
    ok: identityRejected,
    checked_at: new Date().toISOString(),
    webhook_host: safeWebhookHost(config.webhookUrl),
    status: response.status,
    api_key_valid: response.status !== 401,
    write_receipts_scope: response.status !== 403 && response.status !== 401,
    receipt_persisted: false,
    expected_rejection: identityRejected ? 'invalid_probe_identity' : null,
    diagnosis: diagnose(response.status, error),
  };

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

function diagnose(status, error) {
  if (status === 400 && error.includes('identity')) {
    return 'POS API key reached receipt-webhook with write:receipts; probe identity was rejected before receipt persistence.';
  }
  if (status === 401) return 'POS API key was rejected. Check LOOPLET_POS_API_KEY.';
  if (status === 403) return 'POS API key is valid but lacks write:receipts scope.';
  if (status === 429) return 'Rate limited. Retry later or increase the key limit.';
  if (status >= 500) return 'Receipt webhook/server error. Retry after checking Looplet function logs.';
  return `Unexpected probe response${error ? `: ${error}` : ''}`;
}

function readConfig() {
  return {
    webhookUrl: requiredEnv('LOOPLET_RECEIPT_WEBHOOK_URL'),
    apiKey: requiredEnv('LOOPLET_POS_API_KEY'),
    identityToken: process.env.LOOPLET_RECEIPT_IDENTITY_TOKEN ?? 'rhp_unused.invalid',
    syncTargets: [],
  };
}

function safeWebhookHost(webhookUrl) {
  try {
    return new URL(webhookUrl).host;
  } catch {
    return null;
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

await main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});
