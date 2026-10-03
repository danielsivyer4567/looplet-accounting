#!/usr/bin/env node
// BANK-01 gate: Basiq, the bank-feed provider that never went live, is fully removed; Redbark replaces it.
// Fails on any file (tracked, or new and not ignored) whose path or text names Basiq, outside the allow-list of
// historical records below. Those records describe what was true when they were written, so they keep the name.
// A citation of an allow-listed file by its name (an index row, a link) is not a reference to the provider.
// Run: node scripts/check-no-basiq.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PATTERN = /basiq/i;

const ALLOW = [
  { path: 'scripts/check-no-basiq.mjs', reason: 'this check' },
  // Applied migrations are history and must stay byte-for-byte (the enum label, the old durability tables).
  { path: 'supabase/migrations/0007_bank_connections_accounts_backfill.sql', reason: 'applied migration' },
  { path: 'supabase/migrations/0212_basiq_durability.sql', reason: 'applied migration' },
  { path: 'supabase/migrations/0217_raw_bank_events.sql', reason: 'applied migration' },
  { path: 'supabase/migrations/20260702134500_bank_accounts_to_debts_pipeline.sql', reason: 'applied migration' },
  { path: 'supabase/migrations/20260702180000_drop_orphaned_bank_webhook_events.sql', reason: 'applied migration' },
  // Ledger records are written by the finish-line tooling, not edited by hand.
  { path: 'LEDGER.json', reason: 'finish-line ledger record' },
  { path: 'LEDGER.md', reason: 'finish-line ledger record' },
  { path: '.claude/scratch/ledger.md', reason: 'agent ledger history' },
  // Dated audits, reviews, handovers, proofs and plans: records of their date, not current instructions.
  { path: 'AUDIT.md', reason: 'audit of 2026-06-20' },
  { path: 'docs/COMPLETION_AUDIT.md', reason: 'audit baseline of 2026-05-06' },
  { path: 'docs/CODE_REVIEW_2026-05-06.md', reason: 'review of 2026-05-06' },
  { path: 'docs/SECURITY_AUDIT_2026-05-06.md', reason: 'audit of 2026-05-06' },
  { path: 'docs/HANDOVER-claude-chrome-basiq-key-2026-07-02.md', reason: 'handover of 2026-07-02' },
  { path: 'docs/HANDOVER-claude-chrome-oauth-2026-07-02.md', reason: 'handover of 2026-07-02' },
  { path: 'docs/HANDOVER-commit-split-2026-07-02.md', reason: 'handover of 2026-07-02' },
  { path: 'docs/HANDOVER-crm-sync-2026-07-02.md', reason: 'handover of 2026-07-02' },
  { path: 'docs/HANDOVER-xero-connect-2026-07-03.md', reason: 'handover of 2026-07-03' },
  { path: 'docs/proof-run-2026-07-02.md', reason: 'proof run of 2026-07-02' },
  { path: 'docs/guardrails-live-proof-2026-07.md', reason: 'live proof of July 2026' },
  { path: 'docs/runbook-live-proof-2026-07.md', reason: 'runbook of July 2026' },
  { path: 'docs/runbook-spine-activation-afgc-2026-07.md', reason: 'runbook of July 2026' },
  { path: 'docs/APP_COMPLETION_ROADMAP.md', reason: 'plan of 2026-06-29' },
  { path: 'docs/IMPLEMENTATION_QUEUE.md', reason: 'queue of 2026-06-29' },
  { path: 'docs/PARALLEL_AGENT_EXECUTION_PLAN.md', reason: 'plan of 2026-06-29' },
  { path: 'docs/WRAP_UP_COMPLETION_PLAN.md', reason: 'plan of 2026-06-29' },
  { path: 'docs/AUTOMATION_BACKBONE_DEPLOY_STATUS.md', reason: 'status of 2026-07-01' },
  { path: 'docs/automation-spine.html', reason: 'status page of 2026-07-02' },
  { path: 'docs/remaining-work-todo.md', reason: 'todo status of 2026-07-02' },
  { path: 'docs/WIRING_ACTIVATION_PLAN.md', reason: 'live-verified status of 2026-07-02' },
  { path: 'docs/FINISH_LINE_TRACKER.md', reason: 'checked-off history entry P1-02' },
];

const allowed = new Set(ALLOW.map((entry) => entry.path));
const citations = ALLOW.map((entry) => entry.path.split('/').pop()).filter((name) => PATTERN.test(name));
const problems = [];

for (const entry of ALLOW) {
  if (!existsSync(join(ROOT, entry.path))) problems.push(`allow-list entry no longer exists: ${entry.path} (remove it)`);
}

const files = [
  ...new Set(
    execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\0')
      .filter(Boolean)
      .map((file) => file.replace(/\\/g, '/')),
  ),
].sort();

let scanned = 0;
for (const file of files) {
  if (allowed.has(file)) continue;
  // Ledger run logs are receipts written by the ledger tool; they quote this check's own output.
  if (file.startsWith('.ledger/')) continue;
  const full = join(ROOT, file);
  // A tracked file deleted in the working tree is gone; a directory entry (submodule) is not text.
  if (!existsSync(full) || !statSync(full).isFile()) continue;
  scanned++;
  if (PATTERN.test(file)) {
    problems.push(`${file}: the path names Basiq`);
    continue;
  }
  const bytes = readFileSync(full);
  if (bytes.includes(0)) continue; // binary
  const lines = bytes.toString('utf8').split(/\r?\n/);
  const hits = [];
  lines.forEach((line, index) => {
    let text = line;
    for (const name of citations) text = text.split(name).join('');
    if (PATTERN.test(text)) hits.push(`${index + 1}: ${line.trim().slice(0, 120)}`);
  });
  if (hits.length) problems.push(`${file}: ${hits.length} reference(s)\n    ${hits.slice(0, 3).join('\n    ')}`);
}

if (problems.length) {
  console.error(`check-no-basiq: ${problems.length} problem(s)\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`check-no-basiq: ${scanned} files scanned; no Basiq references outside ${ALLOW.length} allow-listed historical records`);
