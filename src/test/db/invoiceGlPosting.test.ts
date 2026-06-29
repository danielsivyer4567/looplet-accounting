import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static SQL assertions for migration 0217_invoice_gl_posting.
 *
 * No live database is available in this worktree, so this proves the source
 * posting contract text: invoices and invoice payments post through the
 * canonical GL RPC, use stable idempotency keys, resolve required COA accounts,
 * reject unsafe source rows, and keep service-role automation out of automatic
 * triggers until org-scoped backend callers are wired.
 */
const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/0217_invoice_gl_posting.sql',
);
const sql = readFileSync(migrationPath, 'utf8');
const flat = sql.replace(/\s+/g, ' ');

const invoiceFn =
  flat.match(
    /CREATE OR REPLACE FUNCTION public\.post_invoice_journal\([\s\S]*?COMMENT ON FUNCTION public\.post_invoice_journal/,
  )?.[0] ?? '';

const paymentFn =
  flat.match(
    /CREATE OR REPLACE FUNCTION public\.post_invoice_payment_journal\([\s\S]*?COMMENT ON FUNCTION public\.post_invoice_payment_journal/,
  )?.[0] ?? '';

describe('0217 invoice GL posting migration', () => {
  it('is wrapped in a single transaction and leaves triggers out intentionally', () => {
    expect(sql).toMatch(/\bBEGIN;/);
    expect(sql).toMatch(/\bCOMMIT;\s*$/);
    expect(flat).toMatch(/does not install table triggers yet/);
    expect(flat).not.toMatch(/CREATE TRIGGER trg_.*invoice.*post/i);
  });

  it('defines invoice and invoice-payment posting RPCs as invoker functions', () => {
    expect(invoiceFn).toMatch(/CREATE OR REPLACE FUNCTION public\.post_invoice_journal\(p_invoice_id uuid\)/);
    expect(paymentFn).toMatch(
      /CREATE OR REPLACE FUNCTION public\.post_invoice_payment_journal\(p_invoice_payment_id uuid\)/,
    );
    expect(invoiceFn).toMatch(/SECURITY INVOKER/);
    expect(paymentFn).toMatch(/SECURITY INVOKER/);
    expect(invoiceFn).not.toMatch(/SECURITY DEFINER/);
    expect(paymentFn).not.toMatch(/SECURITY DEFINER/);
  });

  it('posts invoices only through create_and_post_journal with a stable source event', () => {
    expect(invoiceFn).toMatch(/FROM public\.create_and_post_journal\(/);
    expect(invoiceFn).toMatch(/'invoice'/);
    expect(invoiceFn).toMatch(/'issue:v1'/);
    expect(invoiceFn).toMatch(/'source_table', 'invoices'/);
    expect(invoiceFn).toMatch(/'subtotal_ex_gst_cents', v_invoice\.subtotal_ex_gst_cents/);
    expect(invoiceFn).toMatch(/'gst_cents', v_invoice\.gst_cents/);
    expect(invoiceFn).toMatch(/'total_inc_gst_cents', v_invoice\.total_inc_gst_cents/);
  });

  it('rejects unsafe invoice source states before posting', () => {
    expect(invoiceFn).toMatch(/FOR UPDATE/);
    expect(invoiceFn).toMatch(/deleted_at IS NOT NULL/);
    expect(invoiceFn).toMatch(/'draft'::public\.invoice_status/);
    expect(invoiceFn).toMatch(/'void'::public\.invoice_status/);
    expect(invoiceFn).toMatch(/total_inc_gst_cents <= 0/);
    expect(invoiceFn).toMatch(/has no positive line items to post/);
    expect(invoiceFn).toMatch(/invalid or cross-org line items/);
    expect(invoiceFn).toMatch(/line totals do not match header totals/);
  });

  it('resolves invoice AR, revenue, and GST accounts fail-closed', () => {
    expect(invoiceFn).toMatch(/coa\.code = '1100'/);
    expect(invoiceFn).toMatch(/coa\.account_type = 'asset'::public\.account_type/);
    expect(invoiceFn).toMatch(/active asset account 1100 is missing/);
    expect(invoiceFn).toMatch(/COALESCE\(NULLIF\(btrim\(ili\.account_code\), ''\), '4000'\)/);
    expect(invoiceFn).toMatch(/coa\.account_type = 'income'::public\.account_type/);
    expect(invoiceFn).toMatch(/missing, inactive, or non-income revenue account code/);
    expect(invoiceFn).toMatch(/sa\.role = 'gst_collected'/);
    expect(invoiceFn).toMatch(/coa\.code = '2100'/);
    expect(invoiceFn).toMatch(/gst_collected system account or active liability account 2100 is missing/);
  });

  it('builds balanced invoice journal lines from AR, revenue, and GST', () => {
    expect(invoiceFn).toMatch(/'debit_cents', v_invoice\.total_inc_gst_cents/);
    expect(invoiceFn).toMatch(/'credit_cents', r\.amount_cents/);
    expect(invoiceFn).toMatch(/'credit_cents', v_invoice\.gst_cents/);
    expect(invoiceFn).toMatch(/v_lines := v_lines \|\| jsonb_build_array/);
    expect(invoiceFn).toMatch(/'description', 'Accounts receivable ' \|\| v_invoice\.invoice_number/);
    expect(invoiceFn).toMatch(/'description', 'Invoice revenue ' \|\| r\.code/);
    expect(invoiceFn).toMatch(/'description', 'GST collected ' \|\| v_invoice\.invoice_number/);
  });

  it('posts invoice payments only through create_and_post_journal with a stable receipt event', () => {
    expect(paymentFn).toMatch(/FROM public\.create_and_post_journal\(/);
    expect(paymentFn).toMatch(/'invoice_payment'/);
    expect(paymentFn).toMatch(/'receipt:v1'/);
    expect(paymentFn).toMatch(/'source_table', 'invoice_payments'/);
    expect(paymentFn).toMatch(/'invoice_id', v_invoice\.id/);
    expect(paymentFn).toMatch(/'bank_transaction_id', v_payment\.bank_transaction_id/);
  });

  it('requires the invoice issue journal before reducing accounts receivable', () => {
    expect(paymentFn).toMatch(/PERFORM public\.post_invoice_journal\(v_invoice\.id\)/);
    expect(paymentFn).toMatch(/invoice issue journal exists before reducing AR/);
  });

  it('rejects unsafe invoice payment source states before posting', () => {
    expect(paymentFn).toMatch(/FROM public\.invoice_payments/);
    expect(paymentFn).toMatch(/FOR UPDATE/);
    expect(paymentFn).toMatch(/organization mismatch/);
    expect(paymentFn).toMatch(/void or deleted invoice/);
    expect(paymentFn).toMatch(/amount must be positive/);
    expect(paymentFn).toMatch(/bank transaction organization mismatch/);
    expect(paymentFn).toMatch(/bank transaction must be an inflow/);
  });

  it('resolves receipt bank/cash and AR accounts fail-closed', () => {
    expect(paymentFn).toMatch(/v_cash_account_code text := '1000'/);
    expect(paymentFn).toMatch(/v_cash_account_code := '1010'/);
    expect(paymentFn).toMatch(/coa\.code = v_cash_account_code/);
    expect(paymentFn).toMatch(/active asset account % is missing/);
    expect(paymentFn).toMatch(/coa\.code = '1100'/);
    expect(paymentFn).toMatch(/active asset account 1100 is missing/);
  });

  it('builds balanced receipt journal lines to debit cash or bank and credit AR', () => {
    expect(paymentFn).toMatch(/'debit_cents', v_payment\.amount_cents/);
    expect(paymentFn).toMatch(/'credit_cents', v_payment\.amount_cents/);
    expect(paymentFn).toMatch(/'description', 'Invoice receipt ' \|\| v_invoice\.invoice_number/);
    expect(paymentFn).toMatch(
      /'description', 'Accounts receivable receipt ' \|\| v_invoice\.invoice_number/,
    );
  });

  it('revoke/grants the RPCs and reloads PostgREST schema cache', () => {
    expect(flat).toMatch(/REVOKE ALL ON FUNCTION public\.post_invoice_journal\(uuid\) FROM PUBLIC, anon/);
    expect(flat).toMatch(/GRANT EXECUTE ON FUNCTION public\.post_invoice_journal\(uuid\) TO authenticated, service_role/);
    expect(flat).toMatch(
      /REVOKE ALL ON FUNCTION public\.post_invoice_payment_journal\(uuid\) FROM PUBLIC, anon/,
    );
    expect(flat).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.post_invoice_payment_journal\(uuid\) TO authenticated, service_role/,
    );
    expect(flat).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });
});
