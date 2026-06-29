import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static SQL assertions for migration 0222_bas_labels_snapshots_drilldown.
 *
 * No live database is available in this worktree, so these tests prove the BAS
 * completion contract text: completed labels, PAYG-I source values, source
 * drilldown, and immutable snapshots are explicit invoker-scoped surfaces.
 */
const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../supabase/migrations/0222_bas_labels_snapshots_drilldown.sql',
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

const gstLabelsFn = extractFunction('generate_bas_worksheet_gst_labels');
const gstCompatFn = extractFunction('generate_bas_worksheet_gst');
const paygLabelsFn = extractFunction('generate_bas_worksheet_payg_labels');
const paygInstalmentFn = extractFunction('generate_bas_worksheet_payg_instalment');
const drilldownFn = extractFunction('generate_bas_worksheet_source_drilldown');
const worksheetFn = extractFunction('generate_bas_worksheet');
const snapshotFn = extractFunction('snapshot_bas_worksheet');
const immutableGuardFn = extractFunction('guard_bas_worksheet_snapshots_immutable');

describe('0222 BAS labels, snapshots, and drilldown migration', () => {
  it('is transactional and does not add BAS posting triggers', () => {
    expect(sql).toMatch(/\bBEGIN;/);
    expect(sql).toMatch(/\bCOMMIT;\s*$/);
    expect(flat).toMatch(/This migration adds explicit RPCs\/tables, not posting triggers/);
    expect(flat).not.toMatch(/SECURITY DEFINER/);
    expect(flat).not.toMatch(/CREATE TRIGGER trg_.*bas.*post/i);
  });

  it('adds auditable PAYG-I source storage instead of silent worksheet placeholders', () => {
    expect(flat).toMatch(/CREATE TABLE IF NOT EXISTS public\.bas_payg_instalment_amounts/);
    expect(flat).toMatch(/t7_payg_instalment_income_cents bigint NOT NULL DEFAULT 0/);
    expect(flat).toMatch(/label_5a_payg_instalment_cents bigint NOT NULL DEFAULT 0/);
    expect(flat).toMatch(/label_5b_payg_instalment_credit_cents bigint NOT NULL DEFAULT 0/);
    expect(flat).toMatch(/bas_payg_instalment_amounts_period_uniq/);
    expect(flat).toMatch(/bas_payg_instalment_amounts_audit/);
    expect(flat).toMatch(/CREATE POLICY bas_payg_instalment_amounts_select/);
    expect(flat).toMatch(/CREATE POLICY bas_payg_instalment_amounts_insert/);
    expect(flat).toMatch(/CREATE POLICY bas_payg_instalment_amounts_update/);
  });

  it('derives complete GST labels including G2, G3, and non-zero G10 evidence', () => {
    expect(gstLabelsFn).toMatch(/RETURNS TABLE \( g1_total_sales_cents bigint, g2_export_sales_cents bigint, g3_gst_free_sales_cents bigint, g10_capital_purchases_cents bigint, g11_noncapital_purchases_cents bigint, label_1a_gst_on_sales_cents bigint, label_1b_gst_on_purchases_cents bigint \)/);
    expect(gstLabelsFn).toMatch(/SECURITY INVOKER/);
    expect(gstLabelsFn).toMatch(/public\.bas_quarter_period\(p_fy_start_year, p_quarter\)/);
    expect(gstLabelsFn).toMatch(/coa\.expected_gst_treatment, ''\) = 'EXPORT'/);
    expect(gstLabelsFn).toMatch(/ili\.gst_treatment = 'free'::public\.invoice_gst_treatment/);
    expect(gstLabelsFn).toMatch(/FROM public\.fixed_assets fa/);
    expect(gstLabelsFn).toMatch(/b\.auto_category_code IN \('plant_equipment', 'motor_vehicle'\)/);
    expect(gstLabelsFn).toMatch(/coa\.expected_gst_treatment = 'GST_ON_CAPITAL'/);
    expect(gstLabelsFn).toMatch(/GREATEST\( COALESCE\(p\.total_purchases_inc_gst_cents, 0\) - COALESCE\(p\.g10_capital_purchases_cents, 0\), 0 \)::bigint/);
    expect(gstLabelsFn).not.toMatch(/0::bigint,\s+-- G10/);

    expect(gstCompatFn).toMatch(/FROM public\.generate_bas_worksheet_gst_labels\(p_org, p_fy_start_year, p_quarter\) g/);
  });

  it('keeps PAYG-W complete and makes PAYG-I source status explicit', () => {
    expect(paygLabelsFn).toMatch(/w3_other_withheld_cents bigint/);
    expect(paygLabelsFn).toMatch(/0::bigint,\s+0::bigint/);
    expect(paygLabelsFn).toMatch(/pr\.status IN \('approved', 'paid'\)/);

    expect(paygInstalmentFn).toMatch(/JOIN public\.bas_payg_instalment_amounts i/);
    expect(paygInstalmentFn).toMatch(/CASE WHEN i\.id IS NULL THEN 'missing' ELSE 'provided' END::text/);
    expect(paygInstalmentFn).toMatch(/t7_payg_instalment_income_cents/);
    expect(paygInstalmentFn).toMatch(/label_5a_payg_instalment_cents/);
    expect(paygInstalmentFn).toMatch(/label_5b_payg_instalment_credit_cents/);
  });

  it('exposes source drilldown rows for each BAS source family', () => {
    expect(drilldownFn).toMatch(/SECURITY INVOKER/);
    expect(drilldownFn).toMatch(/'source_tables', jsonb_build_array\('invoices', 'invoice_line_items', 'chart_of_accounts'\)/);
    expect(drilldownFn).toMatch(/'source_tables', jsonb_build_array\( 'v_bill_effective_allocations', 'bills', 'bill_line_items', 'fixed_assets', 'chart_of_accounts' \)/);
    expect(drilldownFn).toMatch(/'source_tables', jsonb_build_array\('pay_runs', 'pay_slips'\)/);
    expect(drilldownFn).toMatch(/'source_tables', jsonb_build_array\('business_profile', 'bas_payg_instalment_amounts'\)/);
    expect(drilldownFn).toMatch(/'labels', jsonb_build_array\('G1'\)/);
    expect(drilldownFn).toMatch(/jsonb_build_array\('G10', '1B'\)/);
    expect(drilldownFn).toMatch(/jsonb_build_array\('G11', '1B'\)/);
    expect(drilldownFn).toMatch(/jsonb_build_array\('W1', 'W2', 'W5', '4'\)/);
  });

  it('rewrites the worksheet payload with completed labels, evidence, and PAYG-I in label 9', () => {
    expect(worksheetFn).toMatch(/FROM public\.generate_bas_worksheet_gst_labels\(p_org, p_fy_start_year, p_quarter\)/);
    expect(worksheetFn).toMatch(/FROM public\.generate_bas_worksheet_payg_labels\(p_org, p_fy_start_year, p_quarter\)/);
    expect(worksheetFn).toMatch(/FROM public\.generate_bas_worksheet_payg_instalment\(p_org, p_fy_start_year, p_quarter\)/);
    expect(worksheetFn).toMatch(/public\.generate_bas_worksheet_source_drilldown/);
    expect(worksheetFn).toMatch(/'G2', gst\.g2_export_sales_cents/);
    expect(worksheetFn).toMatch(/'G3', gst\.g3_gst_free_sales_cents/);
    expect(worksheetFn).toMatch(/'W3', payg\.w3_other_withheld_cents/);
    expect(worksheetFn).toMatch(/'source_status', paygi\.source_status/);
    expect(worksheetFn).toMatch(/paygi\.label_5a_payg_instalment_cents - paygi\.label_5b_payg_instalment_credit_cents/);
    expect(worksheetFn).toMatch(/'source_drilldown', drilldown\.source_drilldown/);
    expect(worksheetFn).toMatch(/'label_source', 'generate_bas_worksheet:v2'/);
    expect(worksheetFn).toMatch(/'snapshot_rpc', 'snapshot_bas_worksheet'/);
  });

  it('adds immutable worksheet snapshots with a replayable hash RPC', () => {
    expect(flat).toMatch(/CREATE TABLE IF NOT EXISTS public\.bas_worksheet_snapshots/);
    expect(flat).toMatch(/worksheet jsonb NOT NULL CHECK \(jsonb_typeof\(worksheet\) = 'object'\)/);
    expect(flat).toMatch(/source_drilldown jsonb NOT NULL CHECK \(jsonb_typeof\(source_drilldown\) = 'object'\)/);
    expect(flat).toMatch(/snapshot_hash text NOT NULL CHECK \(length\(snapshot_hash\) = 64\)/);
    expect(flat).toMatch(/bas_worksheet_snapshots_hash_uniq/);
    expect(immutableGuardFn).toMatch(/bas_worksheet_snapshots rows are immutable/);
    expect(immutableGuardFn).toMatch(/DELETE on immutable table bas_worksheet_snapshots is forbidden/);
    expect(flat).toMatch(/CREATE TRIGGER bas_worksheet_snapshots_immutable/);

    expect(snapshotFn).toMatch(/SECURITY INVOKER/);
    expect(snapshotFn).toMatch(/p_org NOT IN \(SELECT public\.get_accessible_org_ids\(\)\)/);
    expect(snapshotFn).toMatch(/public\.generate_bas_worksheet\(p_org, p_fy_start_year, p_quarter\)/);
    expect(snapshotFn).toMatch(/digest\( jsonb_build_object/);
    expect(snapshotFn).toMatch(/'source_version', 'generate_bas_worksheet:v2'/);
    expect(snapshotFn).toMatch(/ON CONFLICT \( organization_id, fy_start_year, quarter_num, snapshot_hash \) DO NOTHING/);
    expect(snapshotFn).toMatch(/RETURN v_snapshot/);
  });

  it('restricts grants and reloads PostgREST schema cache', () => {
    for (const fn of [
      'bas_quarter_period\\(integer, integer\\)',
      'generate_bas_worksheet_gst_labels\\(uuid, integer, integer\\)',
      'generate_bas_worksheet_gst\\(uuid, integer, integer\\)',
      'generate_bas_worksheet_payg_labels\\(uuid, integer, integer\\)',
      'generate_bas_worksheet_payg\\(uuid, integer, integer\\)',
      'generate_bas_worksheet_payg_instalment\\(uuid, integer, integer\\)',
      'generate_bas_worksheet_source_drilldown\\(uuid, integer, integer\\)',
      'generate_bas_worksheet\\(uuid, integer, integer\\)',
      'snapshot_bas_worksheet\\(uuid, integer, integer\\)',
    ]) {
      expect(flat).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}`));
      expect(flat).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}`));
    }

    expect(flat).toMatch(/REVOKE ALL ON public\.bas_payg_instalment_amounts FROM PUBLIC, anon/);
    expect(flat).toMatch(/REVOKE ALL ON public\.bas_worksheet_snapshots FROM PUBLIC, anon/);
    expect(flat).toMatch(/TO authenticated, service_role/);
    expect(flat).toMatch(/NOTIFY pgrst, 'reload schema'/);
  });
});
