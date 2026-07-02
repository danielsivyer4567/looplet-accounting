import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static SQL assertions for migration 0218_bank_reconciliation_gl_posting.
 *
 * No live database is available in this worktree. These checks prove the bank
 * posting contract text: standalone bank outflows are explicit and gross-only,
 * matched AR/AP rows go through source-specific settlement paths, and the AP
 * settlement function refuses to double-post bills already journaled to bank.
 */
const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/0218_bank_reconciliation_gl_posting.sql',
);
const sql = readFileSync(migrationPath, 'utf8');
const flat = sql.replace(/\s+/g, ' ');

const bankTxnFn =
  flat.match(
    /CREATE OR REPLACE FUNCTION public\.post_bank_transaction_journal\([\s\S]*?COMMENT ON FUNCTION public\.post_bank_transaction_journal/,
  )?.[0] ?? '';

const reconciledFn =
  flat.match(
    /CREATE OR REPLACE FUNCTION public\.post_reconciled_bank_transaction_journal\([\s\S]*?COMMENT ON FUNCTION public\.post_reconciled_bank_transaction_journal/,
  )?.[0] ?? '';

describe('0218 bank/reconciliation GL posting migration', () => {
  it('is wrapped in a single transaction and does not install automatic triggers', () => {
    expect(sql).toMatch(/\bBEGIN;/);
    expect(sql).toMatch(/\bCOMMIT;\s*$/);
    expect(flat).toMatch(/not blindly auto-posted by trigger/);
    expect(flat).not.toMatch(/CREATE TRIGGER trg_.*bank.*post/i);
  });

  it('defines standalone and reconciled bank posting RPCs as invoker functions', () => {
    expect(bankTxnFn).toMatch(
      /CREATE OR REPLACE FUNCTION public\.post_bank_transaction_journal\(p_bank_transaction_id uuid\)/,
    );
    expect(reconciledFn).toMatch(
      /CREATE OR REPLACE FUNCTION public\.post_reconciled_bank_transaction_journal\( p_bank_transaction_id uuid \)/,
    );
    expect(bankTxnFn).toMatch(/SECURITY INVOKER/);
    expect(reconciledFn).toMatch(/SECURITY INVOKER/);
    expect(bankTxnFn).not.toMatch(/SECURITY DEFINER/);
    expect(reconciledFn).not.toMatch(/SECURITY DEFINER/);
  });

  it('posts standalone bank transactions only through create_and_post_journal', () => {
    expect(bankTxnFn).toMatch(/FROM public\.create_and_post_journal\(/);
    expect(bankTxnFn).toMatch(/'bank_transaction'/);
    expect(bankTxnFn).toMatch(/'bank-txn:v1'/);
    expect(bankTxnFn).toMatch(/'source_table', 'bank_transactions'/);
    expect(bankTxnFn).toMatch(/'posted_gross_only', true/);
  });

  it('rejects standalone rows that belong to other posting flows', () => {
    expect(bankTxnFn).toMatch(/is_personal IS TRUE/);
    expect(bankTxnFn).toMatch(
      /matched_bill_id IS NOT NULL OR v_tx\.matched_invoice_id IS NOT NULL/,
    );
    expect(bankTxnFn).toMatch(/amount_cents = 0/);
    expect(bankTxnFn).toMatch(/amount_cents > 0/);
    expect(bankTxnFn).toMatch(/has no auto_category_code/);
    expect(bankTxnFn).toMatch(/v_category\.is_business IS NOT TRUE/);
    expect(bankTxnFn).toMatch(/'customer_payment'/);
    expect(bankTxnFn).toMatch(/'refunds'/);
    expect(bankTxnFn).toMatch(/'ato_bas_super'/);
    expect(bankTxnFn).toMatch(/'employee_wages'/);
  });

  it('maps supported bank spend categories to seeded COA codes fail-closed', () => {
    expect(bankTxnFn).toMatch(/WHEN 'materials' THEN '5000'/);
    expect(bankTxnFn).toMatch(/WHEN 'subcontractor' THEN '5100'/);
    expect(bankTxnFn).toMatch(/WHEN 'plant_equipment' THEN '1500'/);
    expect(bankTxnFn).toMatch(/WHEN 'fuel' THEN '6100'/);
    expect(bankTxnFn).toMatch(/WHEN 'bank_fees' THEN '6600'/);
    expect(bankTxnFn).toMatch(/ELSE '6900'/);
    expect(bankTxnFn).toMatch(/v_counter_account_type := 'asset'::public\.account_type/);
    expect(bankTxnFn).toMatch(/coa\.code = '1000'/);
    expect(bankTxnFn).toMatch(/coa\.code = v_counter_account_code/);
    expect(bankTxnFn).toMatch(/active % account % is missing/);
  });

  it('builds balanced standalone outflow lines to debit spend and credit bank', () => {
    expect(bankTxnFn).toMatch(/v_amount_abs_cents := abs\(v_tx\.amount_cents\)/);
    expect(bankTxnFn).toMatch(/'debit_cents', v_amount_abs_cents/);
    expect(bankTxnFn).toMatch(/'credit_cents', v_amount_abs_cents/);
    expect(bankTxnFn).toMatch(/'description', 'Bank spend ' \|\| v_tx\.auto_category_code/);
    expect(bankTxnFn).toMatch(/'description', 'Bank transaction ' \|\| v_tx\.description/);
  });

  it('routes invoice-matched transactions through invoice payment posting', () => {
    expect(reconciledFn).toMatch(/v_tx\.matched_invoice_id IS NOT NULL/);
    expect(reconciledFn).toMatch(/FROM public\.invoice_payments ip/);
    expect(reconciledFn).toMatch(/ip\.bank_transaction_id = p_bank_transaction_id/);
    expect(reconciledFn).toMatch(/ip\.invoice_id = v_tx\.matched_invoice_id/);
    expect(reconciledFn).toMatch(/is invoice-matched but has no invoice_payments row/);
    expect(reconciledFn).toMatch(
      /FROM public\.post_invoice_payment_journal\(v_invoice_payment_id\)/,
    );
  });

  it('delegates unmatched transactions back to standalone bank posting', () => {
    expect(reconciledFn).toMatch(/v_tx\.matched_bill_id IS NULL/);
    expect(reconciledFn).toMatch(
      /FROM public\.post_bank_transaction_journal\(p_bank_transaction_id\)/,
    );
  });

  it('rejects unsafe AP settlement states before posting', () => {
    expect(reconciledFn).toMatch(/v_tx\.is_personal IS TRUE/);
    expect(reconciledFn).toMatch(/v_tx\.amount_cents >= 0/);
    expect(reconciledFn).toMatch(/FROM public\.bills/);
    expect(reconciledFn).toMatch(/FOR UPDATE/);
    expect(reconciledFn).toMatch(/bill organization mismatch/);
    expect(reconciledFn).toMatch(/void or deleted bill/);
  });

  it('requires AP and bank accounts for AP settlement', () => {
    expect(reconciledFn).toMatch(/coa\.code = '1000'/);
    expect(reconciledFn).toMatch(/active asset account 1000 is missing/);
    expect(reconciledFn).toMatch(/coa\.code = '2000'/);
    expect(reconciledFn).toMatch(/active liability account 2000 is missing/);
  });

  it('settles AP only when the bill journal credited AP and amounts tie out', () => {
    expect(reconciledFn).toMatch(/je\.source_type = 'bill'/);
    expect(reconciledFn).toMatch(/SUM\(jl\.credit_cents\) FILTER \(WHERE coa\.code = '2000'\)/);
    expect(reconciledFn).toMatch(/SUM\(jl\.credit_cents\) FILTER \(WHERE coa\.code = '1000'\)/);
    expect(reconciledFn).toMatch(/was posted directly to bank; AP settlement/);
    expect(reconciledFn).toMatch(/has no posted AP journal to settle/);
    expect(reconciledFn).toMatch(/v_amount_abs_cents <> v_bill_ap_credit_cents/);
  });

  it('posts reconciled bill settlements through create_and_post_journal', () => {
    expect(reconciledFn).toMatch(/FROM public\.create_and_post_journal\(/);
    expect(reconciledFn).toMatch(/'bank_reconciliation'/);
    expect(reconciledFn).toMatch(/'bill-settlement:v1'/);
    expect(reconciledFn).toMatch(/'matched_bill_id', v_bill\.id/);
    expect(reconciledFn).toMatch(/'debit_cents', v_bill_ap_credit_cents/);
    expect(reconciledFn).toMatch(/'credit_cents', v_bill_ap_credit_cents/);
  });

  it('revoke/grants the RPCs and reloads PostgREST schema cache', () => {
    expect(flat).toMatch(
      /REVOKE ALL ON FUNCTION public\.post_bank_transaction_journal\(uuid\) FROM PUBLIC, anon/,
    );
    expect(flat).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.post_bank_transaction_journal\(uuid\) TO authenticated, service_role/,
    );
    expect(flat).toMatch(
      /REVOKE ALL ON FUNCTION public\.post_reconciled_bank_transaction_journal\(uuid\) FROM PUBLIC, anon/,
    );
    expect(flat).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.post_reconciled_bank_transaction_journal\(uuid\) TO authenticated, service_role/,
    );
    expect(flat).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });
});
