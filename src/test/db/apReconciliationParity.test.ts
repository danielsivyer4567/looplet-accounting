import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const migration = readFileSync(
  join(root, 'supabase/migrations/0216_ap_reconciliation_parity.sql'),
  'utf8',
);
const flat = migration.replace(/\s+/g, ' ');

const matchBillFn =
  flat.match(
    /CREATE OR REPLACE FUNCTION public\.reconcile_match_bill\([\s\S]*?COMMENT ON FUNCTION public\.reconcile_match_bill/,
  )?.[0] ?? '';

const undoFn =
  flat.match(
    /CREATE OR REPLACE FUNCTION public\.reconcile_undo_match\([\s\S]*?COMMENT ON FUNCTION public\.reconcile_undo_match/,
  )?.[0] ?? '';

describe('0216 AP reconciliation parity migration', () => {
  it('wraps the AP parity changes in a transaction', () => {
    expect(migration).toMatch(/^\s*BEGIN;/m);
    expect(migration).toMatch(/COMMIT;\s*$/);
  });

  it('keeps the AP candidate view RLS-safe and filters only outstanding business bills', () => {
    expect(flat).toMatch(
      /CREATE OR REPLACE VIEW public\.v_bank_match_candidates WITH \(security_invoker = on\)/,
    );
    expect(flat).toMatch(
      /b\.status NOT IN \('paid'::public\.bill_status, 'void'::public\.bill_status\)/,
    );
    expect(flat).toMatch(/b\.is_personal IS NOT TRUE/);
    expect(flat).toMatch(/b\.is_probable_bill = true/);
    expect(flat).toMatch(/bt\.amount_cents < 0/);
    expect(flat).toMatch(/bt\.is_personal IS NOT TRUE/);
    expect(flat).toMatch(/bt\.matched_bill_id IS NULL/);
    expect(flat).toMatch(/bt\.matched_invoice_id IS NULL/);
  });

  it('locks the bank transaction and bill rows before applying an AP match', () => {
    expect(matchBillFn).toMatch(
      /FROM public\.bank_transactions WHERE id = p_bank_transaction_id FOR UPDATE/,
    );
    expect(matchBillFn).toMatch(/FROM public\.bills WHERE id = p_bill_id FOR UPDATE/);
  });

  it('preserves org access checks while allowing service-role cron callers', () => {
    expect(matchBillFn).toMatch(/auth\.role\(\) = 'service_role'/);
    expect(matchBillFn).toMatch(
      /NOT v_is_service AND v_org_txn NOT IN \(SELECT public\.get_accessible_org_ids\(\)\)/,
    );
  });

  it('rejects unsafe bill matches before mutating rows', () => {
    expect(matchBillFn).toMatch(/transaction already matched/);
    expect(matchBillFn).toMatch(/bank transaction must be an outflow/);
    expect(matchBillFn).toMatch(/bank transaction is personal/);
    expect(matchBillFn).toMatch(/bill is void or deleted/);
    expect(matchBillFn).toMatch(/bill is already paid/);
    expect(matchBillFn).toMatch(/bill is personal/);
    expect(matchBillFn).toMatch(/bill is not a probable bill/);
    expect(matchBillFn).toMatch(/bill has no amount/);
    expect(matchBillFn).toMatch(/match confidence out of range/);
    expect(matchBillFn).toMatch(/amount mismatch/);
  });

  it('uses the same 50-cent tolerance as the candidate view', () => {
    expect(matchBillFn).toMatch(/c_tolerance_cents constant bigint := 50/);
    expect(matchBillFn).toMatch(
      /abs\(abs\(v_txn_amount_cents\) - v_bill_amount_cents\) > c_tolerance_cents/,
    );
  });

  it('updates the bank transaction and bill atomically after validation', () => {
    expect(matchBillFn).toMatch(/UPDATE public\.bank_transactions SET matched_bill_id = p_bill_id/);
    expect(matchBillFn).toMatch(/manually_matched = p_manually_matched/);
    expect(matchBillFn).toMatch(/match_confidence = p_match_confidence/);
    expect(matchBillFn).toMatch(/UPDATE public\.bills SET paid_at = COALESCE\(paid_at, now\(\)\)/);
    expect(matchBillFn).toMatch(/status = 'paid'::public\.bill_status/);
  });

  it('hardens undo so void or deleted bills are not forced back to attached', () => {
    expect(undoFn).toMatch(/transaction is not matched/);
    expect(undoFn).toMatch(/DELETE FROM public\.invoice_payments/);
    expect(undoFn).toMatch(
      /status = CASE WHEN status = 'paid'::public\.bill_status THEN 'attached'::public\.bill_status ELSE status END/,
    );
    expect(undoFn).toMatch(/deleted_at IS NULL/);
    expect(undoFn).toMatch(/status <> 'void'::public\.bill_status/);
  });

  it('reloads PostgREST schema cache for changed RPC and view surfaces', () => {
    expect(flat).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });
});
