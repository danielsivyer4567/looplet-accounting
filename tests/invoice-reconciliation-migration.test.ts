import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const migration = readFileSync(
  join(root, 'supabase/migrations/0196_harden_invoice_reconciliation.sql'),
  'utf8',
);

describe('invoice reconciliation hardening migration', () => {
  it('keeps AR table grants least-privilege for browser clients', () => {
    expect(migration).toMatch(
      /revoke all on table[\s\S]*public\.invoices,[\s\S]*public\.invoice_line_items,[\s\S]*public\.invoice_payments,[\s\S]*public\.invoice_number_counters[\s\S]*from public,\s*anon,\s*authenticated;/i,
    );
    expect(migration).toMatch(
      /grant select,\s*insert,\s*update,\s*delete on table[\s\S]*public\.invoices,[\s\S]*public\.invoice_line_items,[\s\S]*public\.invoice_payments[\s\S]*to authenticated;/i,
    );
    expect(migration).not.toMatch(/grant\s+.*\s+on\s+table[\s\S]*to\s+anon/i);
    expect(migration).not.toMatch(
      /grant\s+select,\s*insert,\s*update,\s*delete,\s*references,\s*trigger,\s*truncate/i,
    );
  });

  it('codifies invoice payment triggers and validates future payments before totals update', () => {
    expect(migration).toMatch(/create or replace function public\.invoices_assign_number\(\)/i);
    expect(migration).toMatch(/create or replace function public\.invoices_recompute_totals\(\)/i);
    expect(migration).toMatch(/create or replace function public\.invoices_apply_payment\(\)/i);
    expect(migration).toMatch(/create or replace function public\.invoice_payments_validate\(\)/i);
    expect(migration).toMatch(/for update;/i);
    expect(migration).toMatch(/invoice payment organization mismatch/i);
    expect(migration).toMatch(/invoice payment bank transaction organization mismatch/i);
    expect(migration).toMatch(/invoice payment exceeds invoice balance/i);
    expect(migration).toMatch(
      /new\.amount_cents\s*<>\s*least\(v_bank_amount,\s*v_remaining_cents\)/i,
    );
    expect(migration).toMatch(
      /create trigger trg_invoice_payments_validate[\s\S]*before insert or update on public\.invoice_payments/i,
    );
  });

  it('hardens invoice bank matching around org access, matched state, inflow direction, and settlement amount', () => {
    expect(migration).toMatch(
      /create or replace view public\.v_bank_invoice_match_candidates\s+with \(security_invoker = on\)/i,
    );
    expect(migration).toMatch(/create or replace function public\.reconcile_match_invoice/i);
    expect(migration).toMatch(/auth\.role\(\) = 'service_role'/i);
    expect(migration).toMatch(/transaction already matched/i);
    expect(migration).toMatch(/bank transaction must be an inflow/i);
    expect(migration).toMatch(/invoice is already paid/i);
    expect(migration).toMatch(
      /v_expected_settlement_cents\s*:=\s*least\(v_txn_amount_cents,\s*v_invoice_balance_due_cents\);/i,
    );
    expect(migration).toMatch(/'error',\s*'amount mismatch'/i);
    expect(migration).toMatch(/notify pgrst,\s*'reload schema';/i);
  });
});
