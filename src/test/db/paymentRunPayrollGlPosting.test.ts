import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static SQL assertions for migration 0219_payment_run_payroll_gl_posting.
 *
 * No live database is available in this worktree, so these tests prove the
 * payment-run and payroll source posting contracts at the migration text level:
 * canonical posting RPC usage, stable idempotency keys, AP settlement tie-outs,
 * payroll gross/net/tax/super balance, and fail-closed account resolution.
 */
const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/0219_payment_run_payroll_gl_posting.sql',
);
const sql = readFileSync(migrationPath, 'utf8');
const flat = sql.replace(/\s+/g, ' ');

const paymentRunFn =
  flat.match(
    /CREATE OR REPLACE FUNCTION public\.post_payment_run_journal\([\s\S]*?COMMENT ON FUNCTION public\.post_payment_run_journal/,
  )?.[0] ?? '';

const payrollFn =
  flat.match(
    /CREATE OR REPLACE FUNCTION public\.post_payroll_pay_run_journal\([\s\S]*?COMMENT ON FUNCTION public\.post_payroll_pay_run_journal/,
  )?.[0] ?? '';

describe('0219 payment-run/payroll GL posting migration', () => {
  it('is wrapped in a single transaction and keeps posting explicit', () => {
    expect(sql).toMatch(/\bBEGIN;/);
    expect(sql).toMatch(/\bCOMMIT;\s*$/);
    expect(flat).toMatch(/intentionally not triggers/);
    expect(flat).not.toMatch(/CREATE TRIGGER trg_.*pay.*post/i);
  });

  it('defines payment-run and payroll posting RPCs as invoker functions', () => {
    expect(paymentRunFn).toMatch(
      /CREATE OR REPLACE FUNCTION public\.post_payment_run_journal\(p_payment_run_id uuid\)/,
    );
    expect(payrollFn).toMatch(
      /CREATE OR REPLACE FUNCTION public\.post_payroll_pay_run_journal\(p_pay_run_id uuid\)/,
    );
    expect(paymentRunFn).toMatch(/SECURITY INVOKER/);
    expect(payrollFn).toMatch(/SECURITY INVOKER/);
    expect(paymentRunFn).not.toMatch(/SECURITY DEFINER/);
    expect(payrollFn).not.toMatch(/SECURITY DEFINER/);
  });

  it('posts payment runs through create_and_post_journal with stable settlement idempotency', () => {
    expect(paymentRunFn).toMatch(/FROM public\.create_and_post_journal\(/);
    expect(paymentRunFn).toMatch(/'payment_run'/);
    expect(paymentRunFn).toMatch(/'settlement:v1'/);
    expect(paymentRunFn).toMatch(/'source_table', 'payment_runs'/);
    expect(paymentRunFn).toMatch(/'payment_run_id', v_run\.id/);
  });

  it('rejects unsafe payment-run source states before posting', () => {
    expect(paymentRunFn).toMatch(/v_run\.status <> 'paid'::public\.payment_run_status/);
    expect(paymentRunFn).toMatch(/v_run\.total_cents <= 0/);
    expect(paymentRunFn).toMatch(/v_item_count = 0/);
    expect(paymentRunFn).toMatch(/v_item_count <> v_run\.bill_count/);
    expect(paymentRunFn).toMatch(/v_item_total_cents <> v_run\.total_cents/);
    expect(paymentRunFn).toMatch(/b\.payment_run_id IS DISTINCT FROM v_run\.id/);
    expect(paymentRunFn).toMatch(/has invalid bill item/);
  });

  it('prevents payment-run double settlement against bank reconciliation journals', () => {
    expect(paymentRunFn).toMatch(/bt\.matched_bill_id = pri\.bill_id/);
    expect(paymentRunFn).toMatch(/je\.source_type = 'bank_reconciliation'/);
    expect(paymentRunFn).toMatch(/bill\(s\) already have bank-reconciliation settlement journal/);
  });

  it('requires each payment-run bill to have a matching AP-credit bill journal', () => {
    expect(paymentRunFn).toMatch(/je\.source_type = 'bill'/);
    expect(paymentRunFn).toMatch(/SUM\(jl\.credit_cents\) FILTER \(WHERE coa\.code = '2000'\)/);
    expect(paymentRunFn).toMatch(/SUM\(jl\.credit_cents\) FILTER \(WHERE coa\.code = '1000'\)/);
    expect(paymentRunFn).toMatch(/already posted directly to bank/);
    expect(paymentRunFn).toMatch(/no posted AP journal to settle/);
    expect(paymentRunFn).toMatch(/posted AP liability does not match item amount/);
  });

  it('builds balanced payment-run settlement lines to debit AP and credit bank', () => {
    expect(paymentRunFn).toMatch(/coa\.code = '2000'/);
    expect(paymentRunFn).toMatch(/coa\.account_type = 'liability'::public\.account_type/);
    expect(paymentRunFn).toMatch(/coa\.code = '1000'/);
    expect(paymentRunFn).toMatch(/coa\.account_type = 'asset'::public\.account_type/);
    expect(paymentRunFn).toMatch(/'debit_cents', v_run\.total_cents/);
    expect(paymentRunFn).toMatch(/'credit_cents', v_run\.total_cents/);
  });

  it('posts payroll through create_and_post_journal with stable payroll idempotency', () => {
    expect(payrollFn).toMatch(/FROM public\.create_and_post_journal\(/);
    expect(payrollFn).toMatch(/'pay_run'/);
    expect(payrollFn).toMatch(/'payroll:v1'/);
    expect(payrollFn).toMatch(/'source_table', 'pay_runs'/);
    expect(payrollFn).toMatch(/'pay_slip_count', v_slip_count/);
  });

  it('rejects unsafe payroll source states and mismatched slip totals', () => {
    expect(payrollFn).toMatch(/v_run\.status <> 'paid'::public\.pay_run_status/);
    expect(payrollFn).toMatch(/v_run\.total_gross_cents <= 0/);
    expect(payrollFn).toMatch(/ps\.organization_id <> v_run\.organization_id/);
    expect(payrollFn).toMatch(/has cross-org pay slip/);
    expect(payrollFn).toMatch(/v_slip_count = 0/);
    expect(payrollFn).toMatch(/v_slip_gross_cents <> v_run\.total_gross_cents/);
    expect(payrollFn).toMatch(/v_slip_tax_cents <> v_run\.total_tax_cents/);
    expect(payrollFn).toMatch(/v_slip_super_cents <> v_run\.total_super_cents/);
    expect(payrollFn).toMatch(/v_slip_net_cents <> v_run\.total_net_cents/);
    expect(payrollFn).toMatch(/v_run\.total_gross_cents <> v_run\.total_tax_cents \+ v_run\.total_net_cents/);
  });

  it('resolves required payroll accounts fail-closed', () => {
    expect(payrollFn).toMatch(/coa\.code = '6000'/);
    expect(payrollFn).toMatch(/active expense account 6000 is missing/);
    expect(payrollFn).toMatch(/coa\.code = '1000'/);
    expect(payrollFn).toMatch(/active asset account 1000 is missing/);
    expect(payrollFn).toMatch(/coa\.code = '6010'/);
    expect(payrollFn).toMatch(/active expense account 6010 is missing/);
    expect(payrollFn).toMatch(/coa\.code = '2300'/);
    expect(payrollFn).toMatch(/active liability account 2300 is missing/);
    expect(payrollFn).toMatch(/coa\.code = '2200'/);
    expect(payrollFn).toMatch(/active liability account 2200 is missing/);
  });

  it('builds balanced payroll lines for wages, super, PAYG, and net pay', () => {
    expect(payrollFn).toMatch(/'debit_cents', v_run\.total_gross_cents/);
    expect(payrollFn).toMatch(/'description', 'Payroll gross wages'/);
    expect(payrollFn).toMatch(/'debit_cents', v_run\.total_super_cents/);
    expect(payrollFn).toMatch(/'description', 'Payroll superannuation expense'/);
    expect(payrollFn).toMatch(/'credit_cents', v_run\.total_super_cents/);
    expect(payrollFn).toMatch(/'description', 'Payroll superannuation payable'/);
    expect(payrollFn).toMatch(/'credit_cents', v_run\.total_tax_cents/);
    expect(payrollFn).toMatch(/'description', 'Payroll PAYG withholding payable'/);
    expect(payrollFn).toMatch(/'credit_cents', v_run\.total_net_cents/);
    expect(payrollFn).toMatch(/'description', 'Payroll net pay'/);
  });

  it('revoke/grants the RPCs and reloads PostgREST schema cache', () => {
    expect(flat).toMatch(/REVOKE ALL ON FUNCTION public\.post_payment_run_journal\(uuid\) FROM PUBLIC, anon/);
    expect(flat).toMatch(/GRANT EXECUTE ON FUNCTION public\.post_payment_run_journal\(uuid\) TO authenticated, service_role/);
    expect(flat).toMatch(
      /REVOKE ALL ON FUNCTION public\.post_payroll_pay_run_journal\(uuid\) FROM PUBLIC, anon/,
    );
    expect(flat).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.post_payroll_pay_run_journal\(uuid\) TO authenticated, service_role/,
    );
    expect(flat).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });
});
