#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import process from 'node:process';

const file = process.argv[2] ?? '.env.local';
const requiredKeys = new Set([
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  'VITE_SUPABASE_PROJECT_REF',
]);

const content = await readFile(file, 'utf8');
const seen = new Map();
const errors = [];

for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
  const lineNumber = index + 1;
  const line = rawLine.trim();
  if (!line || line.startsWith('#')) continue;

  const equalsAt = line.indexOf('=');
  if (equalsAt <= 0) continue;

  const key = line.slice(0, equalsAt).trim();
  const value = line.slice(equalsAt + 1).trim();
  if (!key.startsWith('VITE_SUPABASE_')) continue;

  const lines = seen.get(key) ?? [];
  lines.push(lineNumber);
  seen.set(key, lines);

  if (requiredKeys.has(key) && value.length === 0) {
    errors.push(`${file}:${lineNumber} ${key} must not be blank`);
  }
}

for (const key of requiredKeys) {
  const lines = seen.get(key) ?? [];
  if (lines.length === 0) {
    errors.push(`${file}: missing ${key}`);
  }
  if (lines.length > 1) {
    errors.push(`${file}: ${key} appears more than once on lines ${lines.join(', ')}`);
  }
}

const result = {
  ok: errors.length === 0,
  file,
  checked_keys: [...requiredKeys].sort(),
  errors,
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
