import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static SQL assertions for migration 0207_money_audit_triggers.
 *
 * No DB is available in this worktree, so we assert the migration text wires an
 * append-only audit trigger (audit_log_trigger_v2) onto every money-movement
 * table. The live proof — that a write to one of these tables produces an
 * audit_log row — is deploy-gated.
 */
const root = process.cwd();
const migration = readFileSync(
  join(root, 'supabase/migrations/0207_money_audit_triggers.sql'),
  'utf8',
);

// Every money table the slice must cover.
const MONEY_TABLES = [
  'bills',
  'invoices',
  'customer_invoices',
  'pay_runs',
  'pay_slips',
  'bank_transactions',
  'journal_entries',
  'payment_runs',
] as const;

describe('0207 money audit triggers migration', () => {
  it('wraps the changes in a transaction', () => {
    expect(migration).toMatch(/^\s*begin;/im);
    expect(migration).toMatch(/commit;\s*$/i);
  });

  it('reuses the existing table-agnostic audit_log_trigger_v2 (no new audit fn)', () => {
    expect(migration).toMatch(/execute function public\.audit_log_trigger_v2\(\)/i);
    // It must NOT define a brand-new audit function — the v2 fn is reused.
    expect(migration).not.toMatch(/create (or replace )?function[\s\S]*audit/i);
  });

  it('drives the attach off a guarded, idempotent loop', () => {
    // Guarded so it runs whether or not each table exists (legacy/later tables).
    expect(migration).toMatch(/to_regclass\(format\('public\.%I', t\)\) is not null/i);
    // Idempotent: DROP TRIGGER IF EXISTS before CREATE TRIGGER.
    expect(migration).toMatch(/drop trigger if exists trg_%I_audit_v2 on public\.%I;/i);
    expect(migration).toMatch(
      /create trigger trg_%I_audit_v2\s*[\s\S]*after insert or update or delete on public\.%I/i,
    );
  });

  it('covers every named money table in the attach list', () => {
    for (const table of MONEY_TABLES) {
      // Each table name appears as a quoted element of the loop array.
      expect(migration).toMatch(new RegExp(`'${table}'`, 'i'));
    }
  });

  it('closes the journal_entries gap (had no audit trigger before 0207)', () => {
    expect(migration).toMatch(/'journal_entries'/i);
  });

  it('fires the audit trigger on INSERT, UPDATE and DELETE', () => {
    expect(migration).toMatch(/after insert or update or delete/i);
  });
});
