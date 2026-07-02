import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

const gstControl = readFileSync(
  join(root, 'supabase/functions/_shared/gl/gstControlAccounts.ts'),
  'utf8',
);
const basGst = readFileSync(
  join(root, 'supabase/migrations/20260702103000_bas_g10_capital_split.sql'),
  'utf8',
);
const basPayg = readFileSync(
  join(root, 'supabase/migrations/0121_bas_worksheet_payg_labels.sql'),
  'utf8',
);
const basWorksheet = readFileSync(
  join(root, 'supabase/migrations/20260702104500_bas_worksheet_deterministic_period.sql'),
  'utf8',
);
const statutoryStatements = readFileSync(
  join(root, 'supabase/migrations/20260702100000_statutory_statements_period_scope.sql'),
  'utf8',
);
const invoiceReconciliation = readFileSync(
  join(root, 'supabase/migrations/0196_harden_invoice_reconciliation.sql'),
  'utf8',
);
const abaExport = readFileSync(
  join(root, 'supabase/functions/payment-runs-aba-export/index.ts'),
  'utf8',
);
const superBatchSend = readFileSync(
  join(root, 'supabase/functions/super-batch-send/index.ts'),
  'utf8',
);
const xeroPushBill = readFileSync(
  join(root, 'supabase/functions/xero-push-bill/index.ts'),
  'utf8',
);
const xeroPushInvoice = readFileSync(
  join(root, 'supabase/functions/xero-push-invoice/index.ts'),
  'utf8',
);
const xeroAdapter = readFileSync(
  join(root, 'supabase/functions/_shared/xero/adapter.ts'),
  'utf8',
);

describe('accounting engine source contracts', () => {
  it('posts GST-inclusive journals with the correct Dr/Cr split for sales and purchases', () => {
    expect(gstControl).toMatch(/export type GstControlRole = "gst_collected" \| "gst_paid"/);
    expect(gstControl).toMatch(/const role: GstControlRole = kind === "sale" \? "gst_collected" : "gst_paid"/);
    expect(gstControl).toMatch(/const totalCents = netCents \+ gstCents/);
    expect(gstControl).toMatch(
      /\{ account_id: counterAccountId, debit_cents: totalCents, credit_cents: 0, description \}/,
    );
    expect(gstControl).toMatch(
      /\{ account_id: gstAccountId, debit_cents: 0, credit_cents: gstCents, description: "GST collected" \}/,
    );
    expect(gstControl).toMatch(
      /\{ account_id: gstAccountId, debit_cents: gstCents, credit_cents: 0, description: "GST paid" \}/,
    );
    expect(gstControl).toMatch(
      /\{ account_id: counterAccountId, debit_cents: 0, credit_cents: totalCents, description \}/,
    );
  });

  it('builds BAS GST, PAYG-W, PAYG-I, and net payable labels from scoped sources', () => {
    expect(basGst).toMatch(/returns table \([\s\S]*g1_total_sales_cents[\s\S]*label_1b_gst_on_purchases_cents/i);
    expect(basGst).toMatch(/coalesce\(bq\.sales_ex_gst_cents \+ bq\.gst_collected_cents, 0\)::bigint/);
    expect(basGst).not.toMatch(/0::bigint[\s\S]*-- G10 \(no capital split/i);
    expect(basGst).toMatch(/from public\.v_bill_effective_allocations bea/i);
    expect(basGst).toMatch(/cross join lateral public\.au_bas_quarter\(b\.invoice_date\) q/i);
    expect(basGst).toMatch(/b\.is_probable_bill = true/i);
    expect(basGst).toMatch(/left join public\.bill_line_items bli/i);
    expect(basGst).toMatch(/left join public\.chart_of_accounts coa/i);
    expect(basGst).toMatch(
      /coalesce\(coa\.expected_gst_treatment, ps\.supplier_expected_gst_treatment\) = 'GST_ON_CAPITAL'/i,
    );
    expect(basGst).toMatch(
      /ps\.effective_total_inc_gst_cents::numeric[\s\S]*\* lr\.capital_line_total_cents[\s\S]*\/ lr\.line_total_cents/i,
    );
    expect(basGst).toMatch(/sum\(c\.effective_total_inc_gst_cents - c\.capital_purchases_cents\)/i);
    expect(basGst).toMatch(/sum\(c\.effective_gst_cents\)/i);
    expect(basGst).toMatch(/security invoker/i);
    expect(basGst).toMatch(/revoke all on function public\.generate_bas_worksheet_gst[\s\S]*from public, anon/i);

    expect(basPayg).toMatch(/sum\(ps\.gross_total_cents\)/);
    expect(basPayg).toMatch(/sum\(ps\.payg_tax_cents\)/);
    expect(basPayg).toMatch(/pr\.status in \('approved', 'paid'\)/);
    expect(basPayg).toMatch(/cross join lateral public\.au_bas_quarter\(pr\.pay_date\)/);
    expect(basPayg).toMatch(/0::bigint[\s\S]*-- W4 \(no-ABN withholding not tracked/i);
    expect(basPayg).toMatch(/security invoker/i);

    expect(basWorksheet).toMatch(
      /cross join public\.generate_bas_worksheet_gst\(p_org, p_fy_start_year, p_quarter\) gst/,
    );
    expect(basWorksheet).toMatch(
      /cross join public\.generate_bas_worksheet_payg\(p_org, p_fy_start_year, p_quarter\) payg/,
    );
    expect(basWorksheet).toMatch(/when 1 then make_date\(p_fy_start_year, 7, 1\)/);
    expect(basWorksheet).toMatch(/when 2 then make_date\(p_fy_start_year, 10, 1\)/);
    expect(basWorksheet).toMatch(/when 3 then make_date\(p_fy_start_year \+ 1, 1, 1\)/);
    expect(basWorksheet).toMatch(/when 4 then make_date\(p_fy_start_year \+ 1, 4, 1\)/);
    expect(basWorksheet).toMatch(/left join lateral public\.au_bas_quarter\(a\.anchor_date\) q/);
    expect(basWorksheet).not.toMatch(/from public\.v_bas_quarterly/);
    expect(basWorksheet).toMatch(/gst_control_accounts as \(/i);
    expect(basWorksheet).toMatch(/from public\.system_accounts sa/i);
    expect(basWorksheet).toMatch(/sa\.role = 'gst_collected'/i);
    expect(basWorksheet).toMatch(/sa\.role = 'gst_paid'/i);
    expect(basWorksheet).toMatch(/gl_control_totals as \(/i);
    expect(basWorksheet).toMatch(/left join public\.journal_entries je/i);
    expect(basWorksheet).toMatch(/je\.status = 'posted'/i);
    expect(basWorksheet).toMatch(/left join public\.journal_lines jl/i);
    expect(basWorksheet).toMatch(/'gl_reconciliation'/i);
    expect(basWorksheet).toMatch(/'posted_1a_gst_collected_cents'/i);
    expect(basWorksheet).toMatch(/'posted_1b_gst_paid_cents'/i);
    expect(basWorksheet).toMatch(/'label_1a_delta_cents'/i);
    expect(basWorksheet).toMatch(/'label_1b_delta_cents'/i);
    expect(basWorksheet).toMatch(/then jsonb_build_object\('T7', 0, '5A', 0, '5B', 0\)/);
    expect(basWorksheet).toMatch(
      /gst\.label_1a_gst_on_sales_cents\s*-\s*gst\.label_1b_gst_on_purchases_cents\s*\+\s*payg\.label_4_payg_withheld_cents/,
    );
    expect(basWorksheet).toMatch(/revoke all on function public\.generate_bas_worksheet[\s\S]*from public, anon/i);
  });

  it('generates statutory P&L by FY period and Balance Sheet as at FY end from posted GL lines', () => {
    expect(statutoryStatements).toMatch(/create index if not exists journal_entries_org_status_entry_date_idx/i);
    expect(statutoryStatements).toMatch(/on public\.journal_entries \(organization_id, status, entry_date\)/i);
    expect(statutoryStatements).toMatch(/create or replace function public\.generate_statutory_statements/i);
    expect(statutoryStatements).toMatch(/security invoker/i);
    expect(statutoryStatements).toMatch(/join public\.chart_of_accounts coa/i);
    expect(statutoryStatements).toMatch(/left join public\.journal_lines jl/i);
    expect(statutoryStatements).toMatch(/left join public\.journal_entries je/i);
    expect(statutoryStatements).toMatch(/je\.status = 'posted'/i);
    expect(statutoryStatements).toMatch(/je\.entry_date <= b\.period_end/i);
    expect(statutoryStatements).toMatch(/je\.entry_date between b\.period_start and b\.period_end/i);
    expect(statutoryStatements).not.toMatch(/from\s+(public\.)?v_trial_balance/i);

    expect(statutoryStatements).toMatch(/'basis', 'fy_period_and_as_at'/i);
    expect(statutoryStatements).toMatch(/'basis', 'fy_period'/i);
    expect(statutoryStatements).toMatch(/'basis', 'as_at_period_end'/i);
    expect(statutoryStatements).toMatch(/'opening_retained_earnings_cents', opening_retained/i);
    expect(statutoryStatements).toMatch(
      /'total_equity_and_earnings_cents', total_equity \+ opening_retained \+ net_profit/i,
    );
    expect(statutoryStatements).toMatch(
      /'balances', \(total_assets = total_liab \+ total_equity \+ opening_retained \+ net_profit\)/i,
    );
    expect(statutoryStatements).toMatch(
      /revoke all on function public\.generate_statutory_statements\(uuid, integer\) from public, anon/i,
    );
  });

  it('keeps invoice reconciliation atomic around org scope, balance caps, and amount checks', () => {
    expect(invoiceReconciliation).toMatch(/create or replace function public\.reconcile_match_invoice/i);
    expect(invoiceReconciliation).toMatch(/for update;/i);
    expect(invoiceReconciliation).toMatch(/transaction already matched/i);
    expect(invoiceReconciliation).toMatch(/bank transaction must be an inflow/i);
    expect(invoiceReconciliation).toMatch(/invoice is already paid/i);
    expect(invoiceReconciliation).toMatch(
      /v_expected_settlement_cents\s*:=\s*least\(v_txn_amount_cents,\s*v_invoice_balance_due_cents\);/i,
    );
    expect(invoiceReconciliation).toMatch(/'error',\s*'amount mismatch'/i);
    expect(invoiceReconciliation).toMatch(/invoice payment organization mismatch/i);
  });

  it('binds ABA exports to an approval payload before marking payment runs exported', () => {
    expect(abaExport).toMatch(/payment_run_id,/);
    expect(abaExport).toMatch(/items: \(items as Record<string, unknown>\[\]\)/);
    expect(abaExport).toMatch(/\.sort\(\(a, b\) => a\.id\.localeCompare\(b\.id\)\)/);
    expect(abaExport).toMatch(/admin\.rpc\('is_action_approved'/);
    expect(abaExport).toMatch(/p_payload: approvalPayload/);
    expect(abaExport).toMatch(/userClient\.rpc\('request_approval'/);
    expect(abaExport).toMatch(/status:\s*'exported'/);
    expect(abaExport).toMatch(/return json\(\s*\{[\s\S]*Approval required before exporting this payment run/i);
  });

  it('binds super batch send to a Tier-2 approval payload before marking sent', () => {
    expect(superBatchSend).toMatch(/super_batch_id,/);
    expect(superBatchSend).toMatch(/total_super_cents: batch\.total_super_cents/);
    expect(superBatchSend).toMatch(/line_count: batch\.line_count/);
    expect(superBatchSend).toMatch(/admin\.rpc\("is_action_approved"/);
    expect(superBatchSend).toMatch(/p_resource_type:\s*"super_batch"/);
    expect(superBatchSend).toMatch(/p_payload:\s*approvalPayload/);
    expect(superBatchSend).toMatch(/userClient\.rpc\("request_approval"/);
    expect(superBatchSend).toMatch(/Approval required before sending this super batch/);
    expect(superBatchSend).toMatch(/update\(\{ status: "sent" \}\)/);
    expect(superBatchSend).toMatch(/\.in\("status", \["draft", "approved"\]\)/);
    expect(superBatchSend).toMatch(/SEND IS A MARK-SENT STUB/);
  });

  it('sends stable Xero idempotency keys for bill and invoice pushes', () => {
    for (const source of [xeroPushBill, xeroPushInvoice]) {
      expect(source).toMatch(/idempotency_key\?:\s*string/);
      expect(source).toMatch(/resolveXeroIdempotencyKey\(body\.idempotency_key,/);
      expect(source).toMatch(/headers:\s*\{\s*'Idempotency-Key': idempotencyKey\s*\}/);
      expect(source).toMatch(/idempotency_key:\s*idempotencyKey/);
      expect(source).not.toMatch(/crypto\.randomUUID\(\)/);
    }

    expect(xeroPushBill).toMatch(/\[\s*'xero',\s*'bill',\s*organization_id,\s*bill_id,\s*\]/);
    expect(xeroPushInvoice).toMatch(/\[\s*'xero',\s*'invoice',\s*organization_id,\s*invoice_id,\s*\]/);
    expect(xeroAdapter).toMatch(/resolveXeroIdempotencyKey\(undefined, \[/);
    expect(xeroAdapter).toMatch(/\[\s*'xero',\s*'bill',\s*organizationId,\s*bill\.id,\s*\]/);
    expect(xeroAdapter).toMatch(/headers:\s*\{\s*'Idempotency-Key': idempotencyKey\s*\}/);
  });

  it('writes Xero sync outcomes with immutable GL evidence in the append-only audit log', () => {
    for (const source of [xeroPushBill, xeroPushInvoice, xeroAdapter]) {
      expect(source).toMatch(/async function loadGlEvidence/);
      expect(source).toMatch(/from\('journal_entries'\)/);
      expect(source).toMatch(/select\('id, status, posted_at, entry_date, source_type, source_id'\)/);
      expect(source).toMatch(/eq\('organization_id', organization(?:Id|_id)\)/);
      expect(source).toMatch(/eq\('source_type', sourceType\)/);
      expect(source).toMatch(/eq\('source_id', sourceId\)/);
      expect(source).toMatch(/from\('xero_sync_log'\)\.insert/);
      expect(source).toMatch(/looplet_gl_evidence/);
    }

    expect(xeroPushBill).toMatch(/loadGlEvidence\(admin, organization_id, 'bill', bill_id\)/);
    expect(xeroPushInvoice).toMatch(/loadGlEvidence\(admin, organization_id, 'invoice', invoice_id\)/);
    expect(xeroAdapter).toMatch(/loadGlEvidence\(admin, organizationId, 'bill', bill\.id\)/);
  });
});
