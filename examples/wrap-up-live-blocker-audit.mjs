#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rootDir = process.cwd();
const env = loadEnv();
const projectRef = env.VITE_SUPABASE_PROJECT_REF || inferProjectRef(env.VITE_SUPABASE_URL);
const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL || '';
const anonKey = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || '';

const secretNames = [
  'OPENAI_API_KEY',
  'LEGAL_INGEST_SECRET',
  'LEGAL_SYNC_SECRET',
  'LEGAL_SCAN_SECRET',
  'PERPLEXITY_API_KEY',
];
const gmailRuntimeNames = [
  'GMAIL_CLIENT_ID',
  'GMAIL_CLIENT_SECRET',
  'GMAIL_PUBSUB_TOPIC',
  'GMAIL_PUSH_VERIFY_TOKEN',
  'GMAIL_WATCH_RENEW_CRON_SECRET',
];
const signedInSmokeNames = [
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'TEST_USER_JWT',
  'TEST_ORG_ID',
];

const liveProbeResult = await liveProbe();
const cliProbeResult = await cliProbe(projectRef);
const report = {
  ok: liveProbeResult.ok && cliProbeResult.ok,
  project_ref: projectRef || null,
  env_prerequisites: {
    signed_in_smoke: presence(signedInSmokeNames),
    legal_runtime: presence(secretNames),
    gmail_runtime: presence(gmailRuntimeNames),
  },
  signed_in_smokes: {
    advisor: smokeReadiness(),
    receipt_hub: smokeReadiness(),
  },
  live_probe: liveProbeResult,
  cli_probe: cliProbeResult,
};

console.log(JSON.stringify(report, null, 2));

function loadEnv() {
  const out = { ...process.env };
  const envPath = resolve(rootDir, '.env.local');
  if (!existsSync(envPath)) return out;
  const text = readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!(key in out)) out[key] = value;
  }
  return out;
}

function presence(names) {
  return Object.fromEntries(
    names.map((name) => [
      name,
      {
        present: Boolean(env[name]),
        source: env[name] ? (process.env[name] ? 'process' : '.env.local') : null,
      },
    ]),
  );
}

function smokeReadiness() {
  const missing = signedInSmokeNames.filter((name) => !env[name]);
  return {
    runnable: missing.length === 0,
    missing,
  };
}

async function liveProbe() {
  if (!supabaseUrl || !anonKey) {
    return {
      ok: false,
      skipped_reason: 'missing Supabase URL or anon key',
    };
  }

  const probes = {};
  for (const functionName of [
    'advisor',
    'receipt-webhook',
    'legal-corpus-sync',
    'gmail-pubsub-push',
  ]) {
    probes[functionName] = await probeFunction(functionName);
  }
  const ok = Object.values(probes).every(
    (probe) =>
      probe.reachable &&
      probe.status === 200 &&
      probe.cors?.allow_origin &&
      probe.cors?.allow_methods,
  );
  const gmailPushFailClosed = await probeGmailPushFailClosed();
  return {
    ok: ok && gmailPushFailClosed.ok,
    functions: probes,
    auth_fail_closed: {
      'gmail-pubsub-push': gmailPushFailClosed,
    },
  };
}

async function probeFunction(functionName) {
  const url = `${supabaseUrl.replace(/\/$/, '')}/functions/v1/${functionName}`;
  try {
    const response = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        apikey: anonKey,
        Origin: 'http://127.0.0.1',
        'Access-Control-Request-Method': 'POST',
      },
    });
    return {
      reachable: response.status < 500,
      status: response.status,
      cors: {
        allow_origin: response.headers.get('access-control-allow-origin') != null,
        allow_methods: response.headers.get('access-control-allow-methods') != null,
      },
    };
  } catch (error) {
    return {
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeGmailPushFailClosed() {
  const url = `${supabaseUrl.replace(/\/$/, '')}/functions/v1/gmail-pubsub-push`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          data: Buffer.from(
            JSON.stringify({
              emailAddress: 'proof@example.invalid',
              historyId: '0',
            }),
          ).toString('base64'),
          messageId: 'wrap-up-proof',
        },
      }),
    });
    return {
      ok: response.status === 401,
      status: response.status,
      expected_status: 401,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function cliProbe(ref) {
  if (!ref) {
    return {
      ok: false,
      skipped_reason: 'missing project ref',
    };
  }

  const functionsList = await runSupabase(['functions', 'list', '--project-ref', ref]);
  const secretsList = await runSupabase(['secrets', 'list', '--project-ref', ref]);
  const functions = parseFunctionRows(functionsList.stdout);
  const liveSecretNames = parseSecretNames(secretsList.stdout);
  const selectedFunctions = pickFunctions(functions, [
    'advisor',
    'receipt-webhook',
    'receipt-sync-dispatch',
    'legal-corpus-ingest',
    'legal-corpus-sync',
    'legal-horizon-run',
    'legal-horizon-scan',
    'gmail-pubsub-push',
    'xero-push-bill',
    'xero-push-invoice',
    'xero-sync-payments',
  ]);
  const selectedFunctionsOk = Object.values(selectedFunctions).every(
    (fn) => fn?.status === 'ACTIVE',
  );

  return {
    ok: functionsList.ok && secretsList.ok && selectedFunctionsOk,
    functions: selectedFunctions,
    required_live_secrets: Object.fromEntries(
      [
        'OPENAI_API_KEY',
        'LEGAL_INGEST_SECRET',
        'LEGAL_SYNC_SECRET',
        'LEGAL_SCAN_SECRET',
        'PERPLEXITY_API_KEY',
        'SUPABASE_SERVICE_ROLE_KEY',
        ...gmailRuntimeNames,
      ].map((name) => [name, liveSecretNames.has(name)]),
    ),
    commands: {
      functions_list: commandStatus(functionsList),
      secrets_list: commandStatus(secretsList),
    },
  };
}

async function runSupabase(args) {
  try {
    const { stdout, stderr } = await execFileAsync('supabase', args, {
      cwd: rootDir,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    return {
      ok: true,
      stdout,
      stderr: redact(stderr.trim()),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? redact(error.message) : redact(String(error)),
      stdout: String(error?.stdout ?? ''),
      stderr: redact(error?.stderr ?? ''),
    };
  }
}

function commandStatus(result) {
  return {
    ok: result.ok,
    error: result.error ?? null,
    stderr: result.stderr,
  };
}

function parseFunctionRows(text) {
  return summarizeSupabaseTable(text)
    .map((line) => line.split('|').map((part) => part.trim()))
    .filter((cols) => cols.length >= 6 && cols[0] !== 'ID' && cols[2] !== 'SLUG')
    .map((cols) => ({
      name: cols[1],
      slug: cols[2],
      status: cols[3],
      version: cols[4],
      updated_at_utc: cols[5],
    }));
}

function parseSecretNames(text) {
  return new Set(
    summarizeSupabaseTable(text)
      .map((line) => line.split('|')[0]?.trim() ?? '')
      .filter((name) => name && name !== 'NAME' && /^[A-Z0-9_]+$/.test(name)),
  );
}

function pickFunctions(rows, slugs) {
  return Object.fromEntries(
    slugs.map((slug) => {
      const row = rows.find((item) => item.slug === slug);
      return [
        slug,
        row
          ? {
              status: row.status,
              version: row.version,
              updated_at_utc: row.updated_at_utc,
            }
          : null,
      ];
    }),
  );
}

function summarizeSupabaseTable(text) {
  const lines = text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];
  return lines
    .filter((line) => !/^[-+\s|]+$/.test(line))
    .map((line) => redact(line))
    .slice(0, 80);
}

function redact(value) {
  let out = String(value ?? '');
  for (const key of Object.keys(env)) {
    const secret = env[key];
    if (!secret || secret.length < 8) continue;
    out = out.split(secret).join(`[redacted:${key}]`);
  }
  out = out.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted:jwt]');
  out = out.replace(/sk-[A-Za-z0-9_-]+/g, '[redacted:openai-key]');
  out = out.replace(/gsk_[A-Za-z0-9_-]+/g, '[redacted:groq-key]');
  out = out.replace(/pplx-[A-Za-z0-9_-]+/g, '[redacted:perplexity-key]');
  return out;
}

function inferProjectRef(url) {
  if (!url) return '';
  try {
    const host = new URL(url).hostname;
    return host.endsWith('.supabase.co') ? host.split('.')[0] : '';
  } catch {
    return '';
  }
}
