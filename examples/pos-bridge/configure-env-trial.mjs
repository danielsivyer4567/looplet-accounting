#!/usr/bin/env node
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';

const rootDir = '.claude/scratch/pos-configure-env-trial';
const envFile = join(rootDir, 'pos-bridge.env');

await rm(rootDir, { recursive: true, force: true });
await mkdir(rootDir, { recursive: true });

const first = await runConfigure([
  '--output', envFile,
  '--webhook-url', 'http://127.0.0.1:55321/functions/v1/receipt-webhook',
  '--api-key', 'llp_trial.secret',
  '--identity-token', 'rhp_trial.receiptsecret',
  '--sync-targets', 'xero,myob',
  '--inbox-dir', join(rootDir, 'inbox'),
  '--log-dir', join(rootDir, 'logs'),
], 0);
const firstJson = JSON.parse(first.stdout);
assert(firstJson.ok === true, 'configure-env should create env file');
assert(firstJson.secret_file_protected === true, 'configure-env should report protected env file');
assert(firstJson.secret_file_protection?.ok === true, 'configure-env should report protection details');
assert(firstJson.api_key_shape === 'llp_trial.[redacted]', 'API key should be redacted in stdout');
assert(firstJson.identity_token_shape === 'rhp_trial.[redacted]', 'identity token should be redacted in stdout');
assert(!first.stdout.includes('llp_trial.secret'), 'stdout must not leak API key');
assert(!first.stdout.includes('rhp_trial.receiptsecret'), 'stdout must not leak receipt identity token');
assert(
  firstJson.next_steps.some((step) => step.startsWith(`node go-live.mjs --env-file ${envFile}`)),
  'configure-env should point operators at the strict go-live runner',
);
assert(
  firstJson.next_steps.some((step) => step.includes('--fit-profile pos-integration-profile.json')),
  'configure-env go-live next step should include the source integration profile',
);

const written = await readFile(envFile, 'utf8');
assert(written.includes('LOOPLET_POS_API_KEY=llp_trial.secret'), 'env file should contain API key for the bridge');
assert(written.includes('LOOPLET_RECEIPT_IDENTITY_TOKEN=rhp_trial.receiptsecret'), 'env file should contain receipt identity for the bridge');
assert(written.includes('LOOPLET_ACCEPTANCE_SUPABASE_URL=http://127.0.0.1:55321'), 'acceptance Supabase URL should be inferred');
assert(written.includes('LOOPLET_BRIDGE_MIN_FILE_AGE_MS=1000'), 'env file should default to settled-file guard');
assert(written.includes(`LOOPLET_BRIDGE_LOG_DIR=${join(rootDir, 'logs')}`), 'env file should contain log dir');
assert(written.includes('LOOPLET_BRIDGE_STALE_AFTER_MINUTES=10'), 'env file should default to stale scheduled-task guard');
const firstProtection = await inspectSecretFileProtection(envFile);
assert(firstProtection.protected === true, 'created env file should be protected');
assert(firstProtection.excludesEveryone === true, 'created env file should not allow Everyone');
assert(firstProtection.excludesAuthenticatedUsers === true, 'created env file should not allow Authenticated Users');
assert(firstProtection.excludesBuiltinUsers === true, 'created env file should not allow built-in Users');

const overwrite = await runConfigure([
  '--output', envFile,
  '--webhook-url', 'http://127.0.0.1:55321/functions/v1/receipt-webhook',
  '--api-key', 'llp_trial.secret',
  '--identity-token', 'rhp_trial.receiptsecret',
], 1);
assert(JSON.parse(overwrite.stderr || overwrite.stdout).error.includes('already exists'), 'overwrite should require --force');

const forced = await runConfigure([
  '--force',
  '--output', envFile,
  '--webhook-url', 'http://127.0.0.1:55321/functions/v1/receipt-webhook',
  '--api-key', 'llp_trial.secret2',
  '--identity-token', 'rhp_trial.receiptsecret2',
], 0);
const forcedJson = JSON.parse(forced.stdout);
assert(forcedJson.replaced_existing === true, 'force should replace existing env file');
assert(forcedJson.secret_file_protected === true, 'force should report protected env file');
const forcedProtection = await inspectSecretFileProtection(envFile);
assert(forcedProtection.protected === true, 'forced env file should remain protected');
assert(forcedProtection.excludesEveryone === true, 'forced env file should not allow Everyone');
assert(forcedProtection.excludesAuthenticatedUsers === true, 'forced env file should not allow Authenticated Users');
assert(forcedProtection.excludesBuiltinUsers === true, 'forced env file should not allow built-in Users');

const invalid = await runConfigure([
  '--output', join(rootDir, 'invalid.env'),
  '--webhook-url', 'http://example.com/not-receipt-webhook',
  '--api-key', 'bad',
  '--identity-token', 'bad',
  '--min-file-age-ms', '-1',
  '--stale-after-minutes', '0',
], 1);
const invalidJson = JSON.parse(invalid.stderr || invalid.stdout);
assert(invalidJson.ok === false, 'invalid config should fail');
assert(invalidJson.errors.length >= 5, 'invalid config should report all shape errors');

let protection_failure_left_no_env_file = true;
if (process.platform === 'win32') {
  const protectionFailureFile = join(rootDir, 'protection-failure.env');
  const protectionFailure = await runConfigure([
    '--output', protectionFailureFile,
    '--webhook-url', 'http://127.0.0.1:55321/functions/v1/receipt-webhook',
    '--api-key', 'llp_trial.secret',
    '--identity-token', 'rhp_trial.receiptsecret',
  ], 1, { PATH: '', Path: '' });
  const protectionFailureJson = JSON.parse(protectionFailure.stderr || protectionFailure.stdout);
  assert(protectionFailureJson.ok === false, 'protection failure should fail closed');
  assert(protectionFailureJson.error.includes('failed to protect env file ACL'), 'protection failure should explain ACL failure');
  assert(!(await exists(protectionFailureFile)), 'protection failure must not leave final env file with secrets');
  const leftovers = await readdir(rootDir);
  protection_failure_left_no_env_file = !leftovers.some((name) => name.startsWith('protection-failure.env.'));
  assert(protection_failure_left_no_env_file, 'protection failure must remove temporary secret env file');
}

console.log(JSON.stringify({
  ok: true,
  env_file: envFile,
  created: true,
  overwrite_guard: true,
  force_replace: true,
  invalid_config_rejected: true,
  stdout_secrets_redacted: true,
  acceptance_url_inferred: true,
  go_live_next_step: true,
  go_live_source_profile_next_step: true,
  secret_file_protected: true,
  forced_secret_file_protected: true,
  protection_failure_left_no_env_file,
}, null, 2));

async function runConfigure(args, expectedCode, extraEnv = {}) {
  const child = spawn(process.execPath, ['examples/pos-bridge/configure-env.mjs', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
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
    throw new Error(`configure-env exited ${code}, expected ${expectedCode}\nstdout=${stdout}\nstderr=${stderr}`);
  }
  return { stdout, stderr };
}

async function inspectSecretFileProtection(file) {
  if (process.platform !== 'win32') {
    const info = await stat(file);
    const mode = info.mode & 0o777;
    const protectedMode = (mode & 0o077) === 0;
    return {
      protected: protectedMode,
      excludesEveryone: protectedMode,
      excludesAuthenticatedUsers: protectedMode,
      excludesBuiltinUsers: protectedMode,
    };
  }

  const script = `
$ErrorActionPreference = 'Stop'
$path = (Resolve-Path -LiteralPath $env:LOOPLET_SECRET_FILE).Path
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
  sids = @($sids)
} | ConvertTo-Json -Depth 4
`;
  const result = await runPowerShell(script, { LOOPLET_SECRET_FILE: file });
  const parsed = JSON.parse(result.stdout);
  const sids = Array.isArray(parsed.sids) ? parsed.sids : [parsed.sids].filter(Boolean);
  return {
    protected: parsed.protected === true,
    excludesEveryone: !sids.includes('S-1-1-0'),
    excludesAuthenticatedUsers: !sids.includes('S-1-5-11'),
    excludesBuiltinUsers: !sids.includes('S-1-5-32-545'),
  };
}

async function runPowerShell(script, extraEnv) {
  const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
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
    throw new Error(`PowerShell exited ${code}\nstdout=${stdout}\nstderr=${stderr}`);
  }
  return { stdout, stderr };
}

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
