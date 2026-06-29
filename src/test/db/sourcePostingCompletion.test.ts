import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static SQL assertions for migration 0221_source_posting_completion.
 *
 * No live database is available in this worktree, so these tests prove the
 * source-posting completion contract text: depreciation, opening balances,
 * manual journals, reversals, and AR/AP credit notes all post through the
 * canonical create_and_post_journal RPC as explicit invoker-only surfaces.
 */
const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/0221_source_posting_completion.sql',
);
const sql = readFileSync(migrationPath, 'utf8');
const flat = sql.replace(/\s+/g, ' ');

function extractFunction(name: string): string {
  return (
    flat.match(
      new RegExp(
        `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?COMMENT ON FUNCTION public\\.${name}`,
      ),
    )?.[0] ?? ''
  );
}

const depreciationFn = extractFunction('post_depreciation_schedule_journal');
const openingFn = extractFunction('post_opening_balance_journal');
const manualFn = extractFunction('post_manual_journal');
const reversalFn = extractFunction('reverse_journal_entry');
const customerCreditNoteFn = extractFunction('post_customer_credit_note_journal');
const supplierCreditNoteFn = extractFunction('post_supplier_credit_note_journal');

describe('0221 source posting completion migration', () => {
  it('is wrapped in a single transaction and leaves posting explicit', () => {
    expect(sql).toMatch(/\bBEGIN;/);
    expect(sql).toMatch(/\bCOMMIT;\s*$/);
    expect(flat).toMatch(/This migration adds explicit RPCs, not triggers/);
    expect(flat).not.toMatch(/CREATE TRIGGER trg_.*post/i);
  });

  it('defines all completion RPCs as invoker functions', () => {
    for (const fn of [
      depreciationFn,
      openingFn,
      manualFn,
      reversalFn,
      customerCreditNoteFn,
      supplierCreditNoteFn,
    ]) {
      expect(fn).toMatch(/SECURITY INVOKER/);
      expect(fn).not.toMatch(/SECURITY DEFINER/);
      expect(fn).toMatch(/FROM public\.create_and_post_journal\(/);
    }

    expect(depreciationFn).toMatch(/CREATE OR REPLACE FUNCTION public\.post_depreciation_schedule_journal\( p_schedule_id uuid, p_period date \)/);
    expect(openingFn).toMatch(/CREATE OR REPLACE FUNCTION public\.post_opening_balance_journal\( p_organization_id uuid, p_opening_date date, p_opening_key text, p_lines jsonb, p_memo text DEFAULT NULL, p_source_metadata jsonb DEFAULT '\{\}'::jsonb \)/);
    expect(manualFn).toMatch(/CREATE OR REPLACE FUNCTION public\.post_manual_journal\( p_organization_id uuid, p_entry_date date, p_manual_key text, p_lines jsonb, p_memo text, p_reason text DEFAULT NULL, p_source_metadata jsonb DEFAULT '\{\}'::jsonb \)/);
    expect(reversalFn).toMatch(/CREATE OR REPLACE FUNCTION public\.reverse_journal_entry\( p_journal_entry_id uuid, p_reversal_date date DEFAULT CURRENT_DATE, p_reversal_key text DEFAULT NULL, p_reason text DEFAULT NULL \)/);
    expect(customerCreditNoteFn).toMatch(/CREATE OR REPLACE FUNCTION public\.post_customer_credit_note_journal\( p_organization_id uuid, p_credit_note_key text, p_credit_note_date date, p_subtotal_ex_gst_cents bigint, p_gst_cents bigint, p_invoice_id uuid DEFAULT NULL, p_revenue_account_code text DEFAULT '4000', p_reason text DEFAULT NULL \)/);
    expect(supplierCreditNoteFn).toMatch(/CREATE OR REPLACE FUNCTION public\.post_supplier_credit_note_journal\( p_organization_id uuid, p_credit_note_key text, p_credit_note_date date, p_subtotal_ex_gst_cents bigint, p_gst_cents bigint, p_counter_account_code text, p_counter_account_type public\.account_type, p_bill_id uuid DEFAULT NULL, p_reason text DEFAULT NULL \)/);
  });

  it('posts depreciation schedules with legacy idempotency protection', () => {
    expect(depreciationFn).toMatch(/FROM public\.depreciation_schedules/);
    expect(depreciationFn).toMatch(/FROM public\.fixed_assets/);
    expect(depreciationFn).toMatch(/v_asset\.status <> 'active'::public\.fixed_asset_status/);
    expect(depreciationFn).toMatch(/public\.compute_depreciation\(v_schedule\.id, v_period_end\)/);
    expect(depreciationFn).toMatch(/je\.source_type = 'depreciation_schedule'/);
    expect(depreciationFn).toMatch(/je\.source_id = v_schedule\.id/);
    expect(depreciationFn).toMatch(/je\.entry_date = v_period_end/);
    expect(depreciationFn).toMatch(/je\.status IN \('posted', 'void'\)/);
    expect(depreciationFn).toMatch(/je\.status = 'draft'/);
    expect(depreciationFn).toMatch(/coa\.code = '6700'/);
    expect(depreciationFn).toMatch(/coa\.code = '1900'/);
    expect(depreciationFn).toMatch(/'debit_cents', v_amount_cents/);
    expect(depreciationFn).toMatch(/'credit_cents', v_amount_cents/);
    expect(depreciationFn).toMatch(/'period:' \|\| v_period_end::text \|\| ':depreciation:v1'/);
    expect(depreciationFn).toMatch(/'source_table', 'depreciation_schedules'/);
  });

  it('keeps opening balance and manual journal wrappers thin and keyed', () => {
    expect(openingFn).toMatch(/'opening_balance'/);
    expect(openingFn).toMatch(/'opening:' \|\| v_key \|\| ':v1'/);
    expect(openingFn).toMatch(/p_lines/);
    expect(openingFn).toMatch(/'opening_key', v_key/);
    expect(openingFn).toMatch(/jsonb_typeof\(v_meta\) <> 'object'/);

    expect(manualFn).toMatch(/'manual_journal'/);
    expect(manualFn).toMatch(/'manual:' \|\| v_key \|\| ':v1'/);
    expect(manualFn).toMatch(/memo is required/);
    expect(manualFn).toMatch(/'manual_key', v_key/);
    expect(manualFn).toMatch(/'reason', NULLIF\(btrim\(COALESCE\(p_reason, ''\)\), ''\)/);
  });

  it('reverses only posted journals and swaps every debit and credit line', () => {
    expect(reversalFn).toMatch(/FROM public\.journal_entries/);
    expect(reversalFn).toMatch(/v_original\.status <> 'posted'::public\.journal_entry_status/);
    expect(reversalFn).toMatch(/je\.source_type = 'journal_reversal'/);
    expect(reversalFn).toMatch(/je\.source_id = v_original\.id/);
    expect(reversalFn).toMatch(/je\.status IN \('posted', 'void'\)/);
    expect(reversalFn).toMatch(/'debit_cents', jl\.credit_cents/);
    expect(reversalFn).toMatch(/'credit_cents', jl\.debit_cents/);
    expect(reversalFn).toMatch(/jsonb_array_length\(v_lines\) = 0/);
    expect(reversalFn).toMatch(/'journal_reversal'/);
    expect(reversalFn).toMatch(/'reversal:' \|\| v_key \|\| ':v1'/);
    expect(reversalFn).toMatch(/'source_table', 'journal_entries'/);
    expect(reversalFn).toMatch(/'original_journal_entry_id', v_original\.id/);
  });

  it('posts customer credit notes by reversing revenue and GST against AR', () => {
    expect(customerCreditNoteFn).toMatch(/FROM public\.invoices/);
    expect(customerCreditNoteFn).toMatch(/v_invoice\.status IN \('draft'::public\.invoice_status, 'void'::public\.invoice_status\)/);
    expect(customerCreditNoteFn).toMatch(/PERFORM public\.post_invoice_journal\(v_invoice\.id\)/);
    expect(customerCreditNoteFn).toMatch(/coa\.code = v_revenue_code/);
    expect(customerCreditNoteFn).toMatch(/coa\.account_type = 'income'::public\.account_type/);
    expect(customerCreditNoteFn).toMatch(/coa\.code = '1100'/);
    expect(customerCreditNoteFn).toMatch(/sa\.role = 'gst_collected'/);
    expect(customerCreditNoteFn).toMatch(/coa\.code = '2100'/);
    expect(customerCreditNoteFn).toMatch(/'debit_cents', p_subtotal_ex_gst_cents/);
    expect(customerCreditNoteFn).toMatch(/'debit_cents', p_gst_cents/);
    expect(customerCreditNoteFn).toMatch(/'credit_cents', v_total_cents/);
    expect(customerCreditNoteFn).toMatch(/'customer_credit_note'/);
    expect(customerCreditNoteFn).toMatch(/'credit-note:' \|\| v_key \|\| ':v1'/);
    expect(customerCreditNoteFn).toMatch(/'source_table', 'customer_credit_notes'/);
  });

  it('posts supplier credit notes by reversing AP, purchase, and GST-input balances', () => {
    expect(supplierCreditNoteFn).toMatch(/FROM public\.bills/);
    expect(supplierCreditNoteFn).toMatch(/v_bill\.status = 'void'::public\.bill_status/);
    expect(supplierCreditNoteFn).toMatch(/coa\.code = v_counter_code/);
    expect(supplierCreditNoteFn).toMatch(/coa\.account_type = p_counter_account_type/);
    expect(supplierCreditNoteFn).toMatch(/coa\.code = '2000'/);
    expect(supplierCreditNoteFn).toMatch(/sa\.role = 'gst_paid'/);
    expect(supplierCreditNoteFn).toMatch(/coa\.code = '1200'/);
    expect(supplierCreditNoteFn).toMatch(/'debit_cents', v_total_cents/);
    expect(supplierCreditNoteFn).toMatch(/'credit_cents', p_subtotal_ex_gst_cents/);
    expect(supplierCreditNoteFn).toMatch(/'credit_cents', p_gst_cents/);
    expect(supplierCreditNoteFn).toMatch(/'supplier_credit_note'/);
    expect(supplierCreditNoteFn).toMatch(/'credit-note:' \|\| v_key \|\| ':v1'/);
    expect(supplierCreditNoteFn).toMatch(/'source_table', 'supplier_credit_notes'/);
  });

  it('revoke/grants the RPCs and reloads PostgREST schema cache', () => {
    for (const fn of [
      'post_depreciation_schedule_journal\\(uuid, date\\)',
      'post_opening_balance_journal\\(uuid, date, text, jsonb, text, jsonb\\)',
      'post_manual_journal\\(uuid, date, text, jsonb, text, text, jsonb\\)',
      'reverse_journal_entry\\(uuid, date, text, text\\)',
      'post_customer_credit_note_journal',
      'post_supplier_credit_note_journal',
    ]) {
      expect(flat).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}`));
      expect(flat).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}`));
    }

    expect(flat).toMatch(/FROM PUBLIC, anon/);
    expect(flat).toMatch(/TO authenticated, service_role/);
    expect(flat).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });
});
