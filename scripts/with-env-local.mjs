#!/usr/bin/env node
// Runs a command with .env.local values injected into its environment,
// without ever printing those values. .env.local always wins over any
// pre-existing OS-level env var of the same name (see guard-preflight.mjs's
// loadEnv() for why that precedence matters — a stale OS var must never
// silently shadow the one sanctioned place the runbook says to put secrets).
//
// Usage: node scripts/with-env-local.mjs -- <command> [args...]
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const rootDir = process.cwd();
const sepIndex = process.argv.indexOf('--');
if (sepIndex === -1 || sepIndex === process.argv.length - 1) {
  console.error('Usage: node scripts/with-env-local.mjs -- <command> [args...]');
  process.exit(2);
}
const [cmd, ...args] = process.argv.slice(sepIndex + 1);

const env = loadEnv();
// On Windows, PATH-resolved wrapper scripts (npm, npx) are .cmd batch files.
// Windows' CreateProcess cannot execute a .cmd directly — it always needs
// cmd.exe as the interpreter, so spawn(..., {shell:false}) works for native
// .exe binaries (confirmed: `supabase`) but fails for .cmd files even when
// the .cmd extension is appended explicitly (confirmed: EINVAL, not ENOENT
// — this isn't a "file not found", it's "can't exec a batch file this way").
// Strategy: try the bare command with shell:false first (covers native
// binaries with zero shell involvement). On ENOENT, retry through cmd.exe
// directly with each argument explicitly quoted — NOT shell:true, which
// would concatenate args unescaped (Node DEP0190, a real injection risk).
spawnNative(cmd, args);

function spawnNative(command, commandArgs) {
  const child = spawn(command, commandArgs, { cwd: rootDir, env, stdio: 'inherit', shell: false });
  child.on('exit', (code) => process.exit(code ?? 1));
  child.on('error', (error) => {
    if (process.platform === 'win32' && error?.code === 'ENOENT') {
      spawnViaCmdExe(command, commandArgs);
      return;
    }
    console.error(String(error?.message ?? error));
    process.exit(1);
  });
}

function spawnViaCmdExe(command, commandArgs) {
  const quoted = [command, ...commandArgs].map(quoteForCmdExe).join(' ');
  const child = spawn('cmd.exe', ['/d', '/s', '/c', quoted], {
    cwd: rootDir,
    env,
    stdio: 'inherit',
    shell: false,
  });
  child.on('exit', (code) => process.exit(code ?? 1));
  child.on('error', (error) => {
    console.error(String(error?.message ?? error));
    process.exit(1);
  });
}

function quoteForCmdExe(arg) {
  if (arg === '') return '""';
  if (!/[\s"^&|<>%]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
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
    out[key] = value; // .env.local always wins — see header comment
  }
  return out;
}
