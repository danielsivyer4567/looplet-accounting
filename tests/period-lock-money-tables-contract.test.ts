import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const migration = readFileSync(
  join(root, 'supabase/migrations/20260702090000_period_lock_money_tables.sql'),
  'utf8',
);

describe('period-lock money-table trigger contract', () => {
  it('replaces check_period_lock with an RLS-safe, schema-qualified trigger guard', () => {
    expect(migration).toMatch(/create or replace function public\.check_period_lock\(\)/i);
    expect(migration).toMatch(/security definer/i);
    expect(migration).toMatch(/set search_path = ''/i);
    expect(migration).toMatch(/from public\.period_locks pl/i);
    expect(migration).not.toMatch(/from\s+period_locks\b/i);
    expect(migration).toMatch(/pl\.unlocked_at is null/i);
    expect(migration).toMatch(/using errcode = 'check_violation'/i);
    expect(migration).toMatch(/revoke all on function public\.check_period_lock\(\) from public, anon/i);
  });

  it('selects the accounting date from every money-moving table shape', () => {
    expect(migration).toMatch(/when 'bills' then nullif\(v_row ->> 'invoice_date', ''\)::date/i);
    expect(migration).toMatch(/when 'customer_invoices' then nullif\(v_row ->> 'invoice_date', ''\)::date/i);
    expect(migration).toMatch(/when 'invoices' then nullif\(v_row ->> 'issue_date', ''\)::date/i);
    expect(migration).toMatch(
      /when 'invoice_payments' then \(nullif\(v_row ->> 'paid_at', ''\)::timestamptz\)::date/i,
    );
    expect(migration).toMatch(
      /when 'bank_transactions' then \(nullif\(v_row ->> 'posted_at', ''\)::timestamptz\)::date/i,
    );
    expect(migration).toMatch(/when 'wage_entries' then nullif\(v_row ->> 'work_date', ''\)::date/i);
    expect(migration).toMatch(
      /when 'timesheet_entries' then nullif\(v_row ->> 'work_date', ''\)::date/i,
    );
    expect(migration).toMatch(/when 'pay_runs' then coalesce\([\s\S]*'pay_date'[\s\S]*'period_end'/i);
    expect(migration).toMatch(/when 'payment_runs' then nullif\(v_row ->> 'pay_date', ''\)::date/i);
    expect(migration).toMatch(/when 'journal_entries' then nullif\(v_row ->> 'entry_date', ''\)::date/i);
  });

  it('attaches period-lock triggers to original and later-created financial tables', () => {
    for (const table of [
      'bills',
      'customer_invoices',
      'wage_entries',
      'timesheet_entries',
      'invoices',
      'invoice_payments',
      'bank_transactions',
      'pay_runs',
      'payment_runs',
      'journal_entries',
    ]) {
      expect(migration).toContain(`'${table}'`);
    }

    expect(migration).toMatch(/drop trigger if exists %I on %s/i);
    expect(migration).toMatch(/create trigger %I before insert or update on %s/i);
    expect(migration).toMatch(/execute function public\.check_period_lock\(\)/i);
  });
});
