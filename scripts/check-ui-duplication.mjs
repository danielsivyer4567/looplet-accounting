#!/usr/bin/env node
// UI-02 gate: pages use the shared primitives in src/components/ui (PageHeader, Stat, StatusBadge,
// EmptyState, Alert, Field) instead of re-implementing them. Each pattern has a detectable signature
// below; a hit outside src/components/ui fails unless the allow-list names it with a reason.
// Run: node scripts/check-ui-duplication.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['src/pages', 'src/components'];
const PRIMITIVES_DIR = 'src/components/ui/';

/**
 * Signatures. `line` tests one line; `window` tests a block of WINDOW lines joined with '\n' and
 * reports the first line of the block.
 */
const WINDOW = 10;
const SIGNATURES = [
  {
    id: 'local-primitive',
    primitive: 'PageHeader / Stat / StatusBadge / EmptyState / Alert / Field',
    // A page-local component with a primitive's job, by the names the pages used for their copies.
    line: /^(?:export )?(?:function|const) (?:PageHeader|Kpi|KpiCard|StatCard|Stat|Metric|Field|FormField|StatusBadge|StatusPill|Pill|EmptyState|Empty|Alert|Banner|Notice)\b(?:\(|\s*=)/,
  },
  {
    id: 'inline-kpi',
    primitive: 'Stat',
    // The KPI card drawn by hand: a card with the 4px coloured left border.
    line: /borderLeft:\s*[`'"]4px solid/,
  },
  {
    id: 'inline-status-pill',
    primitive: 'StatusBadge',
    // A status word mapped to a badge class by hand.
    line: /badgeClass\s*=\s*['"`]badge-|case\s+['"][\w-]+['"]:\s*(?:\r?\n\s*)?return\s*<span className="badge badge-/,
    window: /case\s+['"][\w-]+['"]:\s*\r?\n\s*return\s*<span className="badge badge-/,
  },
  {
    id: 'inline-empty-state',
    primitive: 'EmptyState',
    // A centred, muted "nothing here" block built from a style object.
    window:
      /style=\{\{(?:(?!\}\})[\s\S])*textAlign:\s*'center'(?:(?!\}\})[\s\S])*\}\}\s*>\s*(?:\r?\n\s*)*(?:<[^>]*>\s*)*(?:No |Nothing |Nothing's |You have no |There are no |[^<\n]*\b(?:yet|found)\b)/,
    requires: /var\(--text-muted\)|empty/,
  },
  {
    id: 'inline-field',
    primitive: 'Field',
    // A label restyled by hand inside a form group instead of <Field>.
    line: /className="form-label"\s+style=/,
  },
  {
    id: 'inline-page-header',
    primitive: 'PageHeader',
    // A page heading with its layout written inline.
    line: /<h1\s+style=/,
  },
];

/** Intentional exceptions: { path, id, reason }. Keep each reason specific. */
const ALLOW = [
  {
    path: 'src/components/lodge/LodgeReadinessChecklist.tsx',
    id: 'inline-kpi',
    reason: 'A checklist row whose left border shows pass/fail; it is a status line, not a KPI card.',
  },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)))
  .map((f) => relative(ROOT, f).replace(/\\/g, '/'))
  .filter((f) => !f.startsWith(PRIMITIVES_DIR))
  .sort();

const problems = [];
let allowedCount = 0;
const used = new Set();

function report(file, lineNo, sig, text) {
  const allow = ALLOW.find((a) => a.path === file && a.id === sig.id);
  if (allow) {
    allowedCount += 1;
    used.add(allow);
    return;
  }
  problems.push(`${file}:${lineNo}: ${sig.id} -> use <${sig.primitive}>  | ${text.trim().slice(0, 100)}`);
}

for (const file of files) {
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
  const seen = new Set();
  lines.forEach((line, i) => {
    for (const sig of SIGNATURES) {
      if (sig.line && sig.line.test(line)) {
        const key = `${sig.id}:${i}`;
        if (!seen.has(key)) {
          seen.add(key);
          report(file, i + 1, sig, line);
        }
      }
    }
  });
  for (const sig of SIGNATURES) {
    if (!sig.window) continue;
    for (let i = 0; i < lines.length; i++) {
      const block = lines.slice(i, i + WINDOW).join('\n');
      if (!sig.window.test(block)) continue;
      if (sig.requires && !sig.requires.test(block)) continue;
      // Report once per block start: skip if the previous line already started a matching block.
      const prev = i > 0 ? lines.slice(i - 1, i - 1 + WINDOW).join('\n') : '';
      if (prev && sig.window.test(prev) && (!sig.requires || sig.requires.test(prev))) continue;
      const key = `${sig.id}:${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      report(file, i + 1, sig, lines[i] ?? '');
    }
  }
}

for (const entry of ALLOW) {
  if (!files.includes(entry.path)) problems.push(`allow-list entry no longer exists: ${entry.path} (remove it)`);
  else if (!used.has(entry)) problems.push(`allow-list entry no longer matches anything: ${entry.path} ${entry.id} (remove it)`);
}

if (problems.length > 0) {
  console.error(`UI duplication (${problems.length}): pages re-implement a shared primitive. Use the component or add an allow-list reason.`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(
  `UI duplication check passed: ${files.length} files scanned against ${SIGNATURES.length} signatures, ${allowedCount} allow-listed site(s), no page re-implements a shared primitive.`,
);
