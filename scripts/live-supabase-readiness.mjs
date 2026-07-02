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

const requiredMigrations = [
  ['20260701070000', 'reconcile_evidence_atomic'],
  ['20260702090000', 'period_lock_money_tables'],
  ['20260702100000', 'statutory_statements_period_scope'],
  ['20260702103000', 'bas_g10_capital_split'],
  ['20260702104500', 'bas_worksheet_deterministic_period'],
  ['20260702110000', 'bas_lodgement_draft_rpc'],
  ['20260702123000', 'orchestrator_engine_dispatch'],
  ['20260702124500', 'gmail_mine_refresh_jobs'],
  ['20260702130000', 'invoice_zero_gst_treatment'],
];

const requiredFunctions = [
  'accountant-orchestrator',
  'advisor',
  'ato-lodge',
  'automation-watchdog',
  'automation-worker',
  'bank-sync',
  'bank-transaction-classifier',
  'bas-lodgement-pack',
  'bills-attach',
  'bills-extract',
  'gmail-classify-ai',
  'ingest',
  'intake-routing-apply',
  'legal-corpus-ingest',
  'legal-corpus-sync',
  'legal-horizon-run',
  'legal-horizon-scan',
  'payroll-export-stp',
  'payroll-finalise-pay-run',
  'receipt-sync-dispatch',
  'xero-push-bill',
  'xero-push-invoice',
];

const requiredSecrets = [
  'AUTO_RECONCILE_CRON_SECRET',
  'BANK_CLASSIFIER_CRON_SECRET',
  'LEGAL_INGEST_SECRET',
  'LEGAL_SCAN_SECRET',
];

const requiredRuntimeEnv = [
  'SUPABASE_DB_PASSWORD',
  'SUPABASE_SERVICE_ROLE_KEY',
  'TEST_USER_JWT',
  'TEST_ORG_ID',
];

const report = await buildReport();
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;

async function buildReport() {
  const authHealth = await probeAuthHealth();
  const functionsList = await runSupabase(['functions', 'list', '--project-ref', projectRef]);
  const secretsList = await runSupabase(['secrets', 'list', '--project-ref', projectRef]);
  const migrationList = await runSupabase(['migration', 'list', '--linked']);

  const functions = parseFunctionRows(functionsList.stdout);
  const liveSecretNames = parseSecretNames(secretsList.stdout);
  const migrationText = `${migrationList.stdout}\n${migrationList.stderr}`;

  const functionChecks = Object.fromEntries(
    requiredFunctions.map((slug) => {
      const row = functions.find((item) => item.slug === slug);
      return [
        slug,
        row
          ? {
              ok: row.status === 'ACTIVE',
              status: row.status,
              version: row.version,
              updated_at_utc: row.updated_at_utc,
            }
          : { ok: false, missing: true },
      ];
    }),
  );

  const secretChecks = Object.fromEntries(
    requiredSecrets.map((name) => [name, { ok: liveSecretNames.has(name), present: liveSecretNames.has(name) }]),
  );

  const migrationBlockedReason = migrationList.ok ? null : migrationFailureReason(migrationList);
  const migrationChecks = migrationList.ok
    ? Object.fromEntries(
        requiredMigrations.map(([version, name]) => [
          version,
          {
            ok: migrationText.includes(version) || migrationText.includes(name),
            name,
          },
        ]),
      )
    : Object.fromEntries(
        requiredMigrations.map(([version, name]) => [
          version,
          {
            ok: false,
            blocked: true,
            name,
            reason: migrationBlockedReason,
          },
        ]),
      );

  const envPrereqs = Object.fromEntries(
    requiredRuntimeEnv.map((name) => [
      name,
      {
        present: Boolean(env[name]),
        source: env[name] ? (process.env[name] ? 'process' : '.env.local') : null,
      },
    ]),
  );

  const failures = [
    ...Object.entries(functionChecks)
      .filter(([, check]) => !check.ok)
      .map(([name, check]) => ({ kind: 'function', name, check })),
    ...Object.entries(secretChecks)
      .filter(([, check]) => !check.ok)
      .map(([name, check]) => ({ kind: 'secret', name, check })),
    ...Object.entries(migrationChecks)
      .filter(([, check]) => !check.ok)
      .map(([version, check]) => ({ kind: 'migration', version, name: check.name, check })),
  ];

  const blocked = [
    ...Object.entries(envPrereqs)
      .filter(([, check]) => !check.present)
      .map(([name]) => ({ kind: 'env', name })),
    ...(migrationList.ok
      ? []
      : [
          {
            kind: migrationBlockedReason.includes('invalid') ? 'env_invalid' : 'migration_list',
            name: migrationBlockedReason.includes('invalid') ? 'SUPABASE_DB_PASSWORD' : undefined,
            command: 'supabase migration list --linked',
            reason: migrationBlockedReason,
          },
        ]),
  ];

  return {
    ok: failures.length === 0 && blocked.length === 0 && authHealth.ok,
    project_ref: projectRef || null,
    generated_at_utc: new Date().toISOString(),
    auth_health: authHealth,
    env_prerequisites: envPrereqs,
    migrations: {
      ok: Object.values(migrationChecks).every((check) => check.ok),
      checks: migrationChecks,
      command: commandStatus(migrationList),
    },
    functions: {
      ok: Object.values(functionChecks).every((check) => check.ok),
      checks: functionChecks,
      command: commandStatus(functionsList),
    },
    secrets: {
      ok: Object.values(secretChecks).every((check) => check.ok),
      checks: secretChecks,
      command: commandStatus(secretsList),
    },
    failures,
    blocked,
    next_actions: buildNextActions({ functionChecks, secretChecks, migrationChecks, blocked }),
  };
}

function migrationFailureReason(result) {
  const text = `${result.error ?? ''}\n${result.stderr ?? ''}`;
  if (/password authentication failed|failed SASL auth/i.test(text)) {
    return 'invalid SUPABASE_DB_PASSWORD for the linked remote database';
  }
  if (/SUPABASE_DB_PASSWORD/i.test(text)) {
    return 'SUPABASE_DB_PASSWORD missing or not accepted by the linked remote database';
  }
  return 'supabase migration list --linked failed';
}

function buildNextActions({ functionChecks, secretChecks, migrationChecks, blocked }) {
  const actions = [];
  if (Object.values(migrationChecks).some((check) => !check.ok)) {
    const invalidDbPassword = blocked.some(
      (item) => item.kind === 'env_invalid' && item.name === 'SUPABASE_DB_PASSWORD',
    );
    actions.push(
      invalidDbPassword
        ? 'Replace SUPABASE_DB_PASSWORD with the correct linked project DB password, then rerun npm run supabase:readiness.'
        : 'Apply the pending migrations after confirming the SQL diff.',
    );
  }
  const missingFunctions = Object.entries(functionChecks)
    .filter(([, check]) => !check.ok)
    .map(([name]) => name);
  if (missingFunctions.length > 0) {
    actions.push(`Deploy missing/outdated required Edge Functions: ${missingFunctions.join(', ')}.`);
  }
  const missingSecrets = Object.entries(secretChecks)
    .filter(([, check]) => !check.ok)
    .map(([name]) => name);
  if (missingSecrets.length > 0) {
    actions.push(`Add missing Edge Function secrets without exposing values: ${missingSecrets.join(', ')}.`);
  }
  if (blocked.some((item) => item.name === 'SUPABASE_SERVICE_ROLE_KEY' || item.name === 'TEST_USER_JWT')) {
    actions.push('Load service-role/test JWT/fixture IDs and run deploy-gated tests without skips.');
  }
  return actions;
}

async function probeAuthHealth() {
  if (!supabaseUrl || !anonKey) {
    return {
      ok: false,
      skipped_reason: 'missing Supabase URL or anon key',
    };
  }
  try {
    const response = await fetch(`${supabaseUrl.replace(/\/$/, '')}/auth/v1/health`, {
      headers: { apikey: anonKey },
    });
    return {
      ok: response.ok,
      status: response.status,
      content_type: response.headers.get('content-type'),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

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
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in out)) out[key] = value;
  }
  return out;
}

async function runSupabase(args) {
  if (!projectRef) {
    return {
      ok: false,
      error: 'missing project ref',
      stdout: '',
      stderr: '',
    };
  }
  try {
    const { stdout, stderr } = await execFileAsync('supabase', args, {
      cwd: rootDir,
      timeout: 90_000,
      maxBuffer: 1024 * 1024,
    });
    return {
      ok: true,
      stdout: redact(stdout),
      stderr: redact(stderr.trim()),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? redact(error.message) : redact(String(error)),
      stdout: redact(String(error?.stdout ?? '')),
      stderr: redact(String(error?.stderr ?? '')),
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

function summarizeSupabaseTable(text) {
  return String(text ?? '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^[-+\s|]+$/.test(line))
    .map((line) => redact(line))
    .slice(0, 120);
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
