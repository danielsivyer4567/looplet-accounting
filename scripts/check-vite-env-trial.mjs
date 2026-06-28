#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

const root = await mkdtemp(join(tmpdir(), 'looplet-vite-env-'));

try {
  const cases = [
    {
      name: 'valid',
      content: [
        'VITE_SUPABASE_URL=https://example.supabase.co',
        'VITE_SUPABASE_ANON_KEY=anon',
        'VITE_SUPABASE_PROJECT_REF=example',
      ].join('\n'),
      expectOk: true,
    },
    {
      name: 'duplicate',
      content: [
        'VITE_SUPABASE_URL=https://example.supabase.co',
        'VITE_SUPABASE_ANON_KEY=anon',
        'VITE_SUPABASE_PROJECT_REF=example',
        'VITE_SUPABASE_ANON_KEY=',
      ].join('\n'),
      expectOk: false,
      expectedError: 'appears more than once',
    },
    {
      name: 'blank',
      content: [
        'VITE_SUPABASE_URL=https://example.supabase.co',
        'VITE_SUPABASE_ANON_KEY=',
        'VITE_SUPABASE_PROJECT_REF=example',
      ].join('\n'),
      expectOk: false,
      expectedError: 'must not be blank',
    },
    {
      name: 'missing',
      content: [
        'VITE_SUPABASE_URL=https://example.supabase.co',
        'VITE_SUPABASE_ANON_KEY=anon',
      ].join('\n'),
      expectOk: false,
      expectedError: 'missing VITE_SUPABASE_PROJECT_REF',
    },
  ];

  const results = [];
  for (const trial of cases) {
    const file = join(root, `${trial.name}.env`);
    await writeFile(file, `${trial.content}\n`);
    const run = await runChecker(file);
    const hasExpectedError = trial.expectedError
      ? run.output.includes(trial.expectedError)
      : true;
    const ok = trial.expectOk ? run.code === 0 : run.code !== 0 && hasExpectedError;
    results.push({
      name: trial.name,
      ok,
      exit_code: run.code,
      expected_ok: trial.expectOk,
      expected_error_seen: hasExpectedError,
    });
  }

  const ok = results.every((result) => result.ok);
  console.log(JSON.stringify({ ok, results }, null, 2));
  if (!ok) process.exit(1);
} finally {
  await rm(root, { recursive: true, force: true });
}

function runChecker(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/check-vite-env.mjs', file], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('exit', (code) => {
      resolve({ code, output });
    });
  });
}
