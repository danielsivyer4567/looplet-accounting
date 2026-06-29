import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static SQL assertions for migration 0220_gst_bas_control_gl_posting.
 *
 * No live database is available in this worktree, so these tests prove the
 * GST/BAS posting contract text: BAS bank settlements tie to the generated
 * worksheet, dedicated ATO/BAS bank rows clear GST/PAYG controls through the
 * canonical posting RPC, and focused adjustments require explicit counters.
 */
const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/0220_gst_bas_control_gl_posting.sql',
);
const sql = readFileSync(migrationPath, 'utf8');
const flat = sql.replace(/\s+/g, ' ');

const basSettlementFn =
  flat.match(
    /CREATE OR REPLACE FUNCTION public\.post_bas_bank_transaction_journal\([\s\S]*?COMMENT ON FUNCTION public\.post_bas_bank_transaction_journal/,
  )?.[0] ?? '';

const adjustmentFn =
  flat.match(
    /CREATE OR REPLACE FUNCTION public\.post_gst_bas_adjustment_journal\([\s\S]*?COMMENT ON FUNCTION public\.post_gst_bas_adjustment_journal/,
  )?.[0] ?? '';

describe('0220 GST/BAS control GL posting migration', () => {
  it('is wrapped in a single transaction and leaves posting explicit', () => {
    expect(sql).toMatch(/\bBEGIN;/);
    expect(sql).toMatch(/\bCOMMIT;\s*$/);
    expect(flat).toMatch(/deliberately do not add triggers/);
    expect(flat).not.toMatch(/CREATE TRIGGER trg_.*bas.*post/i);
  });

  it('defines BAS settlement and adjustment RPCs as invoker functions', () => {
    expect(basSettlementFn).toMatch(
      /CREATE OR REPLACE FUNCTION public\.post_bas_bank_transaction_journal\( p_bank_transaction_id uuid, p_fy_start_year integer, p_quarter integer \)/,
    );
    expect(adjustmentFn).toMatch(
      /CREATE OR REPLACE FUNCTION public\.post_gst_bas_adjustment_journal\( p_organization_id uuid, p_adjustment_date date, p_adjustment_key text, p_adjustment_type text, p_amount_cents bigint, p_counter_account_code text, p_counter_account_type public\.account_type, p_reason text DEFAULT NULL \)/,
    );
    expect(basSettlementFn).toMatch(/SECURITY INVOKER/);
    expect(adjustmentFn).toMatch(/SECURITY INVOKER/);
    expect(basSettlementFn).not.toMatch(/SECURITY DEFINER/);
    expect(adjustmentFn).not.toMatch(/SECURITY DEFINER/);
  });

  it('posts BAS bank settlements through create_and_post_journal with stable idempotency', () => {
    expect(basSettlementFn).toMatch(/FROM public\.create_and_post_journal\(/);
    expect(basSettlementFn).toMatch(/'bas_bank_transaction'/);
    expect(basSettlementFn).toMatch(/v_tx\.id/);
    expect(basSettlementFn).toMatch(/'bas-settlement:v1'/);
    expect(basSettlementFn).toMatch(/'source_table', 'bank_transactions'/);
    expect(basSettlementFn).toMatch(/'bas_worksheet', v_worksheet/);
  });

  it('derives BAS settlement amounts from the generated BAS worksheet', () => {
    expect(basSettlementFn).toMatch(
      /public\.generate_bas_worksheet\(v_tx\.organization_id, p_fy_start_year, p_quarter\)/,
    );
    expect(basSettlementFn).toMatch(/v_worksheet #>> ARRAY\['gst', '1A'\]/);
    expect(basSettlementFn).toMatch(/v_worksheet #>> ARRAY\['gst', '1B'\]/);
    expect(basSettlementFn).toMatch(/v_worksheet #>> ARRAY\['payg_withholding', '4'\]/);
    expect(basSettlementFn).toMatch(/v_worksheet #>> ARRAY\['summary', '9_net_amount_cents'\]/);
    expect(basSettlementFn).toMatch(/v_tx\.amount_cents <> -v_net_cents/);
  });

  it('rejects unsafe BAS bank transaction states before posting', () => {
    expect(basSettlementFn).toMatch(/p_quarter NOT BETWEEN 1 AND 4/);
    expect(basSettlementFn).toMatch(/FROM public\.bank_transactions/);
    expect(basSettlementFn).toMatch(/FOR UPDATE/);
    expect(basSettlementFn).toMatch(/is_personal IS TRUE/);
    expect(basSettlementFn).toMatch(
      /matched_bill_id IS NOT NULL OR v_tx\.matched_invoice_id IS NOT NULL/,
    );
    expect(basSettlementFn).toMatch(/amount_cents = 0/);
    expect(basSettlementFn).toMatch(/auto_category_code, ''\) <> 'ato_bas_super'/);
    expect(basSettlementFn).toMatch(/v_net_cents = 0/);
  });

  it('resolves BAS control accounts with system-account fallback and seeded codes', () => {
    expect(basSettlementFn).toMatch(/sa\.role = 'gst_collected'/);
    expect(basSettlementFn).toMatch(/coa\.code = '2100'/);
    expect(basSettlementFn).toMatch(
      /gst_collected system account or active liability account 2100 is missing/,
    );
    expect(basSettlementFn).toMatch(/coa\.code = '2200'/);
    expect(basSettlementFn).toMatch(/active liability account 2200 is missing/);
    expect(basSettlementFn).toMatch(/sa\.role = 'gst_paid'/);
    expect(basSettlementFn).toMatch(/coa\.code = '1200'/);
    expect(basSettlementFn).toMatch(
      /gst_paid system account or active asset account 1200 is missing/,
    );
    expect(basSettlementFn).toMatch(/coa\.code = '1000'/);
    expect(basSettlementFn).toMatch(/active asset account 1000 is missing/);
  });

  it('builds balanced BAS payable and refund settlement lines', () => {
    expect(basSettlementFn).toMatch(/'debit_cents', v_label_1a_cents/);
    expect(basSettlementFn).toMatch(/'description', 'BAS GST on sales 1A'/);
    expect(basSettlementFn).toMatch(/'debit_cents', v_payg_w_cents/);
    expect(basSettlementFn).toMatch(/'description', 'BAS PAYG withholding label 4'/);
    expect(basSettlementFn).toMatch(/'credit_cents', v_label_1b_cents/);
    expect(basSettlementFn).toMatch(/'description', 'BAS GST on purchases 1B'/);
    expect(basSettlementFn).toMatch(/IF v_net_cents > 0 THEN/);
    expect(basSettlementFn).toMatch(/'credit_cents', v_net_cents/);
    expect(basSettlementFn).toMatch(/'debit_cents', abs\(v_net_cents\)/);
  });

  it('posts GST/BAS adjustments through create_and_post_journal with adjustment-key idempotency', () => {
    expect(adjustmentFn).toMatch(/FROM public\.create_and_post_journal\(/);
    expect(adjustmentFn).toMatch(/'gst_bas_adjustment'/);
    expect(adjustmentFn).toMatch(/'adjustment:' \|\| v_adjustment_key \|\| ':v1'/);
    expect(adjustmentFn).toMatch(/'adjustment_key', v_adjustment_key/);
    expect(adjustmentFn).toMatch(/'adjustment_type', v_adjustment_type/);
    expect(adjustmentFn).toMatch(/'counter_account_code', v_counter_code/);
  });

  it('limits adjustment types and requires explicit active counter accounts', () => {
    expect(adjustmentFn).toMatch(/'increase_gst_payable'/);
    expect(adjustmentFn).toMatch(/'decrease_gst_payable'/);
    expect(adjustmentFn).toMatch(/'increase_gst_credit'/);
    expect(adjustmentFn).toMatch(/'decrease_gst_credit'/);
    expect(adjustmentFn).toMatch(/p_amount_cents IS NULL OR p_amount_cents <= 0/);
    expect(adjustmentFn).toMatch(/coa\.code = v_counter_code/);
    expect(adjustmentFn).toMatch(/coa\.account_type = p_counter_account_type/);
    expect(adjustmentFn).toMatch(/control and counter account are the same/);
  });

  it('uses GST payable and GST credit controls for focused adjustment lines', () => {
    expect(adjustmentFn).toMatch(/sa\.role = 'gst_collected'/);
    expect(adjustmentFn).toMatch(/coa\.code = '2100'/);
    expect(adjustmentFn).toMatch(/sa\.role = 'gst_paid'/);
    expect(adjustmentFn).toMatch(/coa\.code = '1200'/);
    expect(adjustmentFn).toMatch(/v_adjustment_type = 'increase_gst_payable'/);
    expect(adjustmentFn).toMatch(/v_adjustment_type = 'decrease_gst_payable'/);
    expect(adjustmentFn).toMatch(/v_adjustment_type = 'increase_gst_credit'/);
    expect(adjustmentFn).toMatch(/'description', 'GST payable adjustment'/);
    expect(adjustmentFn).toMatch(/'description', 'GST credit adjustment'/);
  });

  it('revoke/grants the RPCs and reloads PostgREST schema cache', () => {
    expect(flat).toMatch(
      /REVOKE ALL ON FUNCTION public\.post_bas_bank_transaction_journal\(uuid, integer, integer\) FROM PUBLIC, anon/,
    );
    expect(flat).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.post_bas_bank_transaction_journal\(uuid, integer, integer\) TO authenticated, service_role/,
    );
    expect(flat).toMatch(/REVOKE ALL ON FUNCTION public\.post_gst_bas_adjustment_journal/);
    expect(flat).toMatch(/GRANT EXECUTE ON FUNCTION public\.post_gst_bas_adjustment_journal/);
    expect(flat).toMatch(/TO authenticated, service_role/);
    expect(flat).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });
});
