#!/usr/bin/env node
// Go/no-go gate for Tier 2 prod work. See docs/guardrails-live-proof-2026-07.md.
// Green (exit 0) writes .claude/scratch/guard-preflight-passed; Tier 2 runbook
// cards require that marker to be less than 30 minutes old.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rootDir = process.cwd();
const markerPath = resolve(rootDir, '.claude/scratch/guard-preflight-passed');
const env = loadEnv();

const report = await buildReport();
console.log(JSON.stringify(report, null, 2));
if (report.safe_to_proceed) {
  writeFileSync(markerPath, `${new Date().toISOString()} HEAD=${report.checks.git.head ?? 'unknown'}\n`);
}
process.exitCode = report.ok ? 0 : 1;

async function buildReport() {
  const checks = {
    env_parse: checkEnvParse(),
    git: await checkGit(),
    db_password: await checkDbPassword(),
    leak_tripwire: await checkLeakTripwire(),
    migration_filename_collisions: checkMigrationCollisions(),
    readiness: await runReadiness(),
  };

  const failures = [];
  if (!checks.env_parse.ok) failures.push({ check: 'env_parse', detail: checks.env_parse });
  if (!checks.db_password.ok) failures.push({ check: 'db_password', detail: checks.db_password });
  if (!checks.leak_tripwire.ok) failures.push({ check: 'leak_tripwire', detail: checks.leak_tripwire });
  if (!checks.readiness.ok) failures.push({ check: 'readiness', detail: checks.readiness.summary });

  const warnings = [];
  if (checks.git.dirty_files > 0) {
    warnings.push(`working tree has ${checks.git.dirty_files} modified files — fine for docs work, but know what they are before prod writes`);
  }
  if (!checks.migration_filename_collisions.ok) {
    warnings.push(`duplicate migration timestamps: ${checks.migration_filename_collisions.collisions.join(', ')} — flag to owner (see runbook LP-02)`);
  }
  if (env.__loadEnvOverrodeOsEnv?.length > 0) {
    warnings.push(
      `.env.local overrode a stale OS-level env var for: ${env.__loadEnvOverrodeOsEnv.join(', ')} — ` +
      'something else on this machine had these set already (Windows User/Machine env var, shell profile, ' +
      'etc). .env.local now wins, but consider clearing the stale source so future terminals aren\'t confusing.',
    );
  }

  const ok = failures.length === 0;
  // "safe_to_proceed" gates the Tier 2 marker and is deliberately narrower
  // than `ok`. `ok` also requires readiness.ok — which itself requires
  // migrations already applied and test creds already loaded. Tier 2 EXISTS
  // to apply those migrations, so requiring readiness.ok to unlock Tier 2
  // would be circular (nothing could ever start). Tier 2 only needs: the DB
  // password genuinely works, and no secret is leaking into git. It does
  // NOT need test creds (LP-07/Tier 3) or completed migrations (the Tier 2
  // work itself) — those stay required for the broader `ok`/closeout signal.
  const safeToProceed = checks.db_password.ok && checks.leak_tripwire.ok;
  const unlockedTiers = ok ? [0, 1, 2] : safeToProceed ? [0, 1, 2] : checks.env_parse.ok ? [0, 1] : [0];

  return {
    ok,
    safe_to_proceed: safeToProceed,
    generated_at_utc: new Date().toISOString(),
    unlocked_tiers: unlockedTiers,
    next_card: nextCard(checks),
    checks,
    warnings,
    failures,
    next_actions: nextActions(checks),
  };
}

function nextCard(checks) {
  if (!checks.db_password.ok) return 'LP-01 (owner: valid SUPABASE_DB_PASSWORD)';
  const missing = checks.readiness.missing_test_env ?? [];
  if (checks.readiness.migrations_pending) return 'LP-02..LP-06 (confirm + apply pending migrations)';
  if (missing.length > 0) return 'LP-07 (owner: test credentials)';
  return 'see .claude/scratch/ledger.md for the next unblocked card';
}

function nextActions(checks) {
  const actions = [];
  if (!checks.env_parse.ok) actions.push('Fix .env.local: ' + checks.env_parse.errors.join('; '));
  if (!checks.db_password.ok) actions.push('Owner loads a valid SUPABASE_DB_PASSWORD into .env.local (runbook LP-01), then rerun.');
  if (!checks.leak_tripwire.ok) actions.push('SECRET LEAK SUSPECTED in git-tracked files — stop all work and escalate (guardrails: Secrets hygiene).');
  if (checks.readiness.summary?.next_actions?.length) actions.push(...checks.readiness.summary.next_actions);
  if (actions.length === 0) actions.push('Green. Tier 2 unlocked for 30 minutes (marker written).');
  return actions;
}

function checkEnvParse() {
  const errors = [];
  const envPath = resolve(rootDir, '.env.local');
  if (!existsSync(envPath)) errors.push('.env.local missing');
  for (const key of ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY']) {
    if (!env[key]) errors.push(`${key} missing/blank`);
  }
  return { ok: errors.length === 0, errors };
}

async function checkGit() {
  try {
    const [branch, head, status] = await Promise.all([
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: rootDir }),
      execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: rootDir }),
      execFileAsync('git', ['status', '--porcelain'], { cwd: rootDir, maxBuffer: 4 * 1024 * 1024 }),
    ]);
    return {
      ok: true,
      branch: branch.stdout.trim(),
      head: head.stdout.trim(),
      dirty_files: status.stdout.split(/\r?\n/).filter(Boolean).length,
    };
  } catch (error) {
    return { ok: false, error: redact(error instanceof Error ? error.message : String(error)) };
  }
}

async function checkDbPassword() {
  if (!env.SUPABASE_DB_PASSWORD) {
    return { ok: false, reason: 'SUPABASE_DB_PASSWORD not set in .env.local or shell' };
  }
  try {
    await execFileAsync('supabase', ['migration', 'list', '--linked'], {
      cwd: rootDir,
      timeout: 90_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, SUPABASE_DB_PASSWORD: env.SUPABASE_DB_PASSWORD },
    });
    return { ok: true };
  } catch (error) {
    const text = redact(`${error?.message ?? ''}\n${error?.stderr ?? ''}`);
    const invalid = /password authentication failed|failed SASL auth/i.test(text);
    return {
      ok: false,
      reason: invalid
        ? 'SUPABASE_DB_PASSWORD is present but INVALID for the linked remote database'
        : 'supabase migration list --linked failed',
      detail: text.slice(0, 400),
    };
  }
}

async function checkLeakTripwire() {
  const jwtShape = /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g;
  // The Supabase anon key is a JWT by design and is meant to be public
  // (RLS enforces access control, not secrecy of this key) — it is
  // deliberately committed in .env.production. Exclude only that exact
  // value from the JWT-shape check; any OTHER JWT-shaped string (a leaked
  // service-role key, a TEST_USER_JWT, etc.) still trips the tripwire.
  const publicAnonKey = env.VITE_SUPABASE_ANON_KEY || '';
  const secretValues = Object.entries(env)
    .filter(([key, value]) =>
      /(KEY|SECRET|PASSWORD|JWT|TOKEN)/.test(key) &&
      !key.startsWith('VITE_') && // anon key/url are public by design
      typeof value === 'string' && value.length >= 12)
    .map(([key, value]) => [key, value]);

  let files;
  try {
    const { stdout } = await execFileAsync('git', ['ls-files'], { cwd: rootDir, maxBuffer: 16 * 1024 * 1024 });
    files = stdout.split(/\r?\n/).filter(Boolean);
  } catch (error) {
    return { ok: false, error: redact(error instanceof Error ? error.message : String(error)) };
  }

  const hits = [];
  for (const file of files) {
    if (/\.(png|jpg|jpeg|gif|ico|woff2?|ttf|pdf|zip|lock)$/i.test(file)) continue;
    const abs = resolve(rootDir, file);
    let size;
    try { size = statSync(abs).size; } catch { continue; }
    if (size > 2 * 1024 * 1024) continue;
    let text;
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    const jwtMatches = text.match(jwtShape) ?? [];
    const nonPublicJwt = jwtMatches.some((match) => !publicAnonKey || match !== publicAnonKey);
    if (nonPublicJwt) hits.push({ file, kind: 'jwt-shaped string (not the known-public anon key)' });
    for (const [key, value] of secretValues) {
      if (text.includes(value)) hits.push({ file, kind: `value of ${key}` });
    }
  }
  return { ok: hits.length === 0, scanned_files: files.length, hits };
}

function checkMigrationCollisions() {
  const dir = resolve(rootDir, 'supabase/migrations');
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => /^\d{14}_.+\.sql$/.test(name));
  } catch {
    return { ok: true, collisions: [], note: 'migrations dir unreadable' };
  }
  const byStamp = new Map();
  for (const name of names) {
    const stamp = name.slice(0, 14);
    byStamp.set(stamp, [...(byStamp.get(stamp) ?? []), name]);
  }
  const collisions = [...byStamp.entries()].filter(([, group]) => group.length > 1).map(([stamp]) => stamp);
  return { ok: collisions.length === 0, collisions };
}

async function runReadiness() {
  try {
    const { stdout } = await execFileAsync('node', ['scripts/live-supabase-readiness.mjs'], {
      cwd: rootDir,
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    }).catch((error) => {
      // readiness exits 1 when red but still prints its JSON report
      if (error && typeof error.stdout === 'string' && error.stdout.trim().startsWith('{')) {
        return { stdout: error.stdout };
      }
      throw error;
    });
    const parsed = JSON.parse(stdout);
    const missingTestEnv = Object.entries(parsed.env_prerequisites ?? {})
      .filter(([, check]) => !check.present)
      .map(([name]) => name);
    return {
      ok: parsed.ok === true,
      migrations_pending: parsed.migrations ? parsed.migrations.ok !== true : null,
      missing_test_env: missingTestEnv,
      summary: {
        ok: parsed.ok,
        auth_health: parsed.auth_health?.ok ?? null,
        failures: (parsed.failures ?? []).slice(0, 20),
        blocked: parsed.blocked ?? [],
        next_actions: parsed.next_actions ?? [],
      },
    };
  } catch (error) {
    return { ok: false, error: redact(error instanceof Error ? error.message : String(error)) };
  }
}

function loadEnv() {
  const out = { ...process.env };
  const envPath = resolve(rootDir, '.env.local');
  if (!existsSync(envPath)) return out;
  const text = readFileSync(envPath, 'utf8');
  const fileKeysOverridingOsEnv = [];
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
    // .env.local is the ONE sanctioned place the runbook tells a junior dev
    // to type credentials — it must always win over a stray/stale OS-level
    // env var (e.g. a leftover Windows User env var from a prior session),
    // or an edit here would silently have zero effect with no error shown.
    if (key in process.env && process.env[key] !== value) {
      fileKeysOverridingOsEnv.push(key);
    }
    out[key] = value;
  }
  if (fileKeysOverridingOsEnv.length > 0) {
    out.__loadEnvOverrodeOsEnv = fileKeysOverridingOsEnv;
  }
  return out;
}

function redact(value) {
  let out = String(value ?? '');
  for (const key of Object.keys(env)) {
    const secret = env[key];
    if (!secret || secret.length < 8) continue;
    out = out.split(secret).join(`[redacted:${key}]`);
  }
  out = out.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted:jwt]');
  return out;
}
