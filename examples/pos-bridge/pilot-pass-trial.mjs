#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

const rootDir = join('.claude', 'scratch', 'pos-pilot-pass-trial');
const directPass = join(rootDir, 'direct-pass.html');
const envPass = join(rootDir, 'env-pass.html');
const envFile = join(rootDir, 'pilot.env');

await rm(rootDir, { recursive: true, force: true });
await mkdir(rootDir, { recursive: true });
await writeFile(envFile, 'LOOPLET_RECEIPT_IDENTITY_TOKEN=rhp_env.receiptsecret\n', 'utf8');

const direct = await run([
  'examples/pos-bridge/pilot-pass.mjs',
  '--identity-token',
  'rhp_trial.receiptsecret',
  '--output',
  directPass,
  '--business-name',
  'Pilot Trade Pty Ltd',
  '--pilot-id',
  'pilot-pass-trial',
]);
assert.equal(direct.code, 0, direct.stderr);
assert(!direct.stdout.includes('rhp_trial.receiptsecret'), 'stdout must not expose receipt identity token');
const directJson = JSON.parse(direct.stdout);
assert.equal(directJson.ok, true);
assert.equal(directJson.token_redacted, 'rhp_trial.[redacted]');

const directHtml = await readFile(directPass, 'utf8');
assert(directHtml.includes('POS scannable receipt identity barcode'), 'pass must include barcode aria label');
assert(directHtml.includes('rhp_trial.receiptsecret'), 'pass file must include the scannable token');
assert(directHtml.includes('Pilot Trade Pty Ltd'), 'pass must include business name');
assert(directHtml.includes('Code 128 B'), 'pass must state barcode symbology');
assert(directHtml.includes('class="bar"'), 'barcode bars must be styled separately from the white background');
assert(directHtml.includes('.barcode .bar'), 'barcode CSS must not color every SVG rect');

const envRun = await run([
  'examples/pos-bridge/pilot-pass.mjs',
  '--env-file',
  envFile,
  '--output',
  envPass,
]);
assert.equal(envRun.code, 0, envRun.stderr);
assert(!envRun.stdout.includes('rhp_env.receiptsecret'), 'env-file stdout must not expose token');
assert((await readFile(envPass, 'utf8')).includes('rhp_env.receiptsecret'), 'env-file pass must contain token');

const overwrite = await run([
  'examples/pos-bridge/pilot-pass.mjs',
  '--identity-token',
  'rhp_trial.receiptsecret',
  '--output',
  directPass,
]);
assert.notEqual(overwrite.code, 0, 'pilot-pass should refuse accidental overwrite');
assert(overwrite.stderr.includes('already exists'), 'overwrite rejection should explain existing output');
assert(!overwrite.stderr.includes('rhp_trial.receiptsecret'), 'overwrite error must not expose token');

const invalid = await run([
  'examples/pos-bridge/pilot-pass.mjs',
  '--identity-token',
  'not-a-token',
  '--output',
  join(rootDir, 'invalid.html'),
]);
assert.notEqual(invalid.code, 0, 'invalid token shape should fail');
assert(invalid.stderr.includes('rhp_<prefix>.<secret>'), 'invalid token error should explain expected shape');

console.log(JSON.stringify({
  ok: true,
  direct_pass_created: directJson.ok === true,
  stdout_redacted: !direct.stdout.includes('rhp_trial.receiptsecret'),
  env_file_input_passed: envRun.code === 0,
  overwrite_rejected: overwrite.code !== 0,
  invalid_token_rejected: invalid.code !== 0,
  pass_contains_barcode: directHtml.includes('POS scannable receipt identity barcode'),
}, null, 2));

async function run(args) {
  const child = spawn(process.execPath, args, {
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
  return { code, stdout, stderr };
}
