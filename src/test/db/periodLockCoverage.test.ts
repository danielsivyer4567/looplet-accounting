import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static SQL assertions for migration 0209_period_lock_coverage.
 *
 * No DB is available in this worktree, so we assert the migration text extends
 * the period-lock guard (the 0001 period_locks primitive) onto every money
 * table that was previously unprotected, with the correct per-table date
 * column, and that the guard fires on INSERT / UPDATE / DELETE. The live proof
 * — that a write into a locked period is rejected — is deploy-gated.
 */
const root = process.cwd();
const migration = readFileSync(
  join(root, 'supabase/migrations/0209_period_lock_coverage.sql'),
  'utf8',
);

// Each previously-unprotected money table and the date column the guard tests.
// pay_slips has no own date column — it resolves the period from its parent
// pay_run via the special '@pay_run' token.
const COVERAGE: readonly (readonly [string, string])[] = [
  ['invoices', 'issue_date'],
  ['customer_invoices', 'invoice_date'],
  ['pay_runs', 'period_end'],
  ['pay_slips', '@pay_run'],
  ['bank_transactions', 'posted_at'],
  ['journal_entries', 'entry_date'],
];

describe('0209 period-lock coverage migration', () => {
  it('wraps the changes in a transaction', () => {
    expect(migration).toMatch(/^\s*begin;/im);
    expect(migration).toMatch(/commit;\s*$/i);
  });

  it('defines the table-agnostic check_period_lock_v2 guard fn', () => {
    expect(migration).toMatch(
      /create or replace function public\.check_period_lock_v2\(\)\s*returns trigger/i,
    );
  });

  it('reuses the existing period_locks primitive (no new lock storage)', () => {
    // It must read the lock state from period_locks, not invent a new table.
    expect(migration).toMatch(/from public\.period_locks/i);
    expect(migration).not.toMatch(/create table[\s\S]*period_lock/i);
  });

  it('applies the canonical active-lock predicate (unlocked_at IS NULL + range)', () => {
    expect(migration).toMatch(/unlocked_at is null/i);
    expect(migration).toMatch(/between pl\.period_start and pl\.period_end/i);
  });

  it('raises check_violation when a write touches a locked period', () => {
    expect(migration).toMatch(/period is locked/i);
    expect(migration).toMatch(/errcode = 'check_violation'/i);
  });

  it('drives the attach off a guarded, idempotent loop', () => {
    // Guarded so it runs whether or not each table exists in the DB.
    expect(migration).toMatch(/to_regclass\(format\('public\.%I', v_table\)\) is not null/i);
    // Idempotent: DROP TRIGGER IF EXISTS before CREATE TRIGGER.
    expect(migration).toMatch(/drop trigger if exists trg_%I_period_lock_v2 on public\.%I;/i);
    expect(migration).toMatch(
      /create trigger trg_%I_period_lock_v2\s*[\s\S]*before insert or update or delete on public\.%I/i,
    );
    // The guard fn is the trigger body, passed the date column as an argument.
    expect(migration).toMatch(/execute function public\.check_period_lock_v2\(%l\)/i);
  });

  it('fires the guard on INSERT, UPDATE and DELETE (closes the DELETE gap)', () => {
    expect(migration).toMatch(/before insert or update or delete/i);
  });

  it('also checks the OLD date on UPDATE so a row cannot be moved out of a lock', () => {
    expect(migration).toMatch(/v_date_old/i);
  });

  it('covers every named money table with its correct date column', () => {
    for (const [table, column] of COVERAGE) {
      // The spec appears verbatim as a quoted 'table:column' element of the
      // attach loop array.
      expect(migration).toMatch(new RegExp(`'${table}:${column}'`, 'i'));
    }
  });

  it('resolves the pay_slips period from the parent pay_run (no own date column)', () => {
    expect(migration).toMatch(/'pay_slips:@pay_run'/i);
    // The guard joins pay_runs for the '@pay_run' token.
    expect(migration).toMatch(/from public\.pay_runs pr/i);
    expect(migration).toMatch(/pay_run_id/i);
  });

  it('leaves the original 0001 trigger name untouched (distinct v2 trigger)', () => {
    // v2 trigger name must differ from the 0001 trg_<table>_period_lock so the
    // two never collide on bills/customer_invoices/wage_entries.
    expect(migration).toMatch(/trg_%I_period_lock_v2/i);
  });
});
