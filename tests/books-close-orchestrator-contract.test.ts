import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

const gstControlAccounts = readFileSync(
  join(root, 'supabase/functions/_shared/gl/gstControlAccounts.ts'),
  'utf8',
);
const depreciationRun = readFileSync(
  join(root, 'supabase/functions/depreciation-run/index.ts'),
  'utf8',
);
const accrualsRun = readFileSync(join(root, 'supabase/functions/accruals-run/index.ts'), 'utf8');
const accrualsMigration = readFileSync(
  join(root, 'supabase/migrations/0098_accruals_detect.sql'),
  'utf8',
);
const closePeriodMigration = readFileSync(
  join(root, 'supabase/migrations/0100_period_close_checks.sql'),
  'utf8',
);
const accountantOrchestrator = readFileSync(
  join(root, 'supabase/functions/accountant-orchestrator/index.ts'),
  'utf8',
);
const payrollFinalisePayRun = readFileSync(
  join(root, 'supabase/functions/payroll-finalise-pay-run/index.ts'),
  'utf8',
);
const payrollExportStp = readFileSync(
  join(root, 'supabase/functions/payroll-export-stp/stp.ts'),
  'utf8',
);
const orchestratorDecide = readFileSync(
  join(root, 'supabase/functions/_shared/orchestrator/decide.ts'),
  'utf8',
);
const orchestratorDispatch = readFileSync(
  join(root, 'supabase/functions/_shared/orchestrator/dispatch.ts'),
  'utf8',
);
const orchestratorDispatchMigration = readFileSync(
  join(root, 'supabase/migrations/20260702123000_orchestrator_engine_dispatch.sql'),
  'utf8',
);
const config = readFileSync(join(root, 'supabase/config.toml'), 'utf8');

describe('books close and orchestrator source contracts', () => {
  it('routes GST/BAS control-account posting through the E1 journal posting wrapper', () => {
    expect(gstControlAccounts).toMatch(/resolveGstControlAccount/);
    expect(gstControlAccounts).toMatch(/from<\{ account_id: string \}>\("system_accounts"\)/);
    expect(gstControlAccounts).toMatch(/postJournalEntry\(deps,\s*\{/);
    expect(gstControlAccounts).toMatch(/kind === "sale" \? "gst_collected" : "gst_paid"/);
    expect(gstControlAccounts).toMatch(/GstControlAccountNotConfiguredError/);
  });

  it('posts monthly depreciation through immutable GL journals only', () => {
    expect(depreciationRun).toMatch(/source_type:\s*"depreciation_schedule"/);
    expect(depreciationRun).toMatch(/from\("journal_entries"\)[\s\S]*\.insert\(\{/);
    expect(depreciationRun).toMatch(/from\("journal_lines"\)\.insert\(\[/);
    expect(depreciationRun).toMatch(/orgClient\.rpc\("post_journal_entry", \{ p_entry_id: entryId \}\)/);
    expect(depreciationRun).toMatch(/cleanupAndFail\("CONNECTOR_JWT_SECRET unset; cannot post"\)/);
    expect(config).toMatch(
      /\[functions\.depreciation-run\][\s\S]*?verify_jwt\s*=\s*false/i,
    );
  });

  it('drives accrual posting through the accrue_recurring_bill GL RPC', () => {
    expect(accrualsRun).toMatch(/admin\.rpc\("detect_recurring_bills", \{ p_org: orgId \}\)/);
    expect(accrualsRun).toMatch(/planAccrualJobs\(rows\)/);
    expect(accrualsRun).toMatch(/from\("coding_suggestions"\)/);
    expect(accrualsRun).toMatch(/orgClient\.rpc\("accrue_recurring_bill", \{/);
    expect(accrualsRun).toMatch(/CONNECTOR_JWT_SECRET unset; cannot post/);

    expect(accrualsMigration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.accrue_recurring_bill/i,
    );
    expect(accrualsMigration).toMatch(/PERFORM public\.post_journal_entry\(v_entry_id\)/);
    expect(accrualsMigration).toMatch(/Idempotent per \(source_type, bill, entry_date\)/);
    expect(config).toMatch(/\[functions\.accruals-run\][\s\S]*?verify_jwt\s*=\s*false/i);
  });

  it('feeds period-close preflight into close_period before writing a period lock', () => {
    expect(closePeriodMigration).toMatch(
      /CREATE OR REPLACE FUNCTION public\.period_close_checks/i,
    );
    expect(closePeriodMigration).toMatch(/CREATE OR REPLACE FUNCTION public\.close_period/i);
    expect(closePeriodMigration).toMatch(/FROM public\.v_books_health/);
    expect(closePeriodMigration).toMatch(/public\.period_close_checks\(p_org, p_period\)/);
    expect(closePeriodMigration).toMatch(/'reason', 'books_health_blocking'/);
    expect(closePeriodMigration).toMatch(/'reason', 'preflight_failed'/);
    expect(closePeriodMigration).toMatch(/PERFORM public\.post_journal_entry\(v_entry_id\)/);
    expect(closePeriodMigration).toMatch(/INSERT INTO public\.period_locks/);
  });

  it('loads books-health and tax-calendar rows into accountant-orchestrator decisions', () => {
    expect(accountantOrchestrator).toMatch(/from\("v_tax_calendar"\)/);
    expect(accountantOrchestrator).toMatch(/from\("v_books_health"\)/);
    expect(accountantOrchestrator).toMatch(/from\("advice_notes"\)/);
    expect(accountantOrchestrator).toMatch(/contains\("inputs",\s*\{\s*scheduled:\s*true\s*\}\)/);
    expect(accountantOrchestrator).toMatch(/decideOrchestratorTasks\(input\)/);
    expect(accountantOrchestrator).toMatch(/emitDecisionNotifications/);
    expect(accountantOrchestrator).toMatch(/resource_type:\s*"orchestrator_task"/);

    expect(orchestratorDecide).toMatch(/source:\s*"books_health"/);
    expect(orchestratorDecide).toMatch(/source:\s*"advisor"/);
    expect(orchestratorDecide).toMatch(/action:\s*"review_advice_note"/);
    expect(orchestratorDecide).toMatch(/engine:\s*"books_health"/);
    expect(orchestratorDecide).toMatch(/OBLIGATION_MAPPINGS/);
    expect(orchestratorDecide).toMatch(/bas:\s*\{[\s\S]*?engine:\s*"bas"/);
    expect(orchestratorDecide).toMatch(/super:\s*\{[\s\S]*?engine:\s*"super"/);
    expect(orchestratorDecide).toMatch(/div7a:\s*\{[\s\S]*?action:\s*"prepare_div7a_review"/);
    expect(orchestratorDecide).toMatch(/sgc:\s*\{[\s\S]*?action:\s*"prepare_sgc_review"/);
    expect(orchestratorDecide).toMatch(/franking_account:\s*\{[\s\S]*?action:\s*"prepare_franking_account_review"/);
    expect(orchestratorDecide).toMatch(/cgt:\s*\{[\s\S]*?action:\s*"prepare_cgt_review"/);
  });

  it('dispatches orchestrator decisions into durable draft engines without bypassing legal gates', () => {
    expect(accountantOrchestrator).toMatch(/dispatchOrchestratorTasks\(admin,\s*decision\)/);
    expect(accountantOrchestrator).toMatch(/ok:\s*dispatch\.failed === 0/);
    expect(accountantOrchestrator).toMatch(/dispatch:\s*DispatchSummary \| null/);

    expect(orchestratorDecide).toMatch(/fy_start_year:\s*row\.fy_start_year/);

    expect(orchestratorDispatch).toMatch(/prepare_bas_lodgement_draft_system/);
    expect(orchestratorDispatch).toMatch(/SPECIALIST_DRAFT_ADAPTERS/);
    expect(orchestratorDispatch).toMatch(/generate_super_batch/);
    expect(orchestratorDispatch).toMatch(/build_return/);
    expect(orchestratorDispatch).toMatch(/book_to_tax/);
    expect(orchestratorDispatch).toMatch(/generate_eofy_pack/);
    expect(orchestratorDispatch).toMatch(/generate_workcover_declaration/);
    expect(orchestratorDispatch).toMatch(/smsf_tbc_tbar/);
    expect(orchestratorDispatch).toMatch(/stream_trust_distribution/);
    expect(orchestratorDispatch).toMatch(/div7a_breach_scan/);
    expect(orchestratorDispatch).toMatch(/cgt_calc/);
    expect(orchestratorDispatch).toMatch(/request_system_approval/);
    expect(orchestratorDispatch).toMatch(/from\("compliance_drafts"\)[\s\S]*\.upsert\(/);
    expect(orchestratorDispatch).toMatch(/"Draft super batch only/);
    expect(orchestratorDispatch).toMatch(/"Draft return and book-to-tax workpaper only/);
    expect(orchestratorDispatch).toMatch(/Draft only\. Human accountant approval is required/);
    expect(orchestratorDispatch).toMatch(/externalWalls/);
    expect(orchestratorDispatch).toMatch(/smsf_independent_audit/);
    expect(orchestratorDispatch).toMatch(
      /True-and-correct declaration and lodgement remain external legal walls/,
    );
    expect(orchestratorDispatch).toMatch(/No safe dispatch adapter/);

    expect(orchestratorDispatchMigration).toMatch(
      /create table if not exists public\.compliance_drafts/i,
    );
    expect(orchestratorDispatchMigration).toMatch(
      /create or replace function public\.request_system_approval/i,
    );
    expect(orchestratorDispatchMigration).toMatch(
      /create or replace function public\.prepare_bas_lodgement_draft_system/i,
    );
    expect(orchestratorDispatchMigration).toMatch(
      /public\.generate_bas_worksheet\(p_org, p_fy_start_year, p_quarter\)/i,
    );
    expect(orchestratorDispatchMigration).toMatch(
      /public\.request_system_approval\([\s\S]*'bas_lodgement'[\s\S]*v_lodgement_id[\s\S]*v_payload/i,
    );
    expect(orchestratorDispatchMigration).toMatch(
      /grant execute on function public\.prepare_bas_lodgement_draft_system[\s\S]*to service_role/i,
    );
    expect(orchestratorDispatchMigration).toMatch(
      /grant execute on function public\.generate_super_batch\(uuid, integer, integer\) to service_role/i,
    );
    expect(orchestratorDispatchMigration).toMatch(
      /grant execute on function public\.build_return\(uuid, integer\) to service_role/i,
    );
    expect(orchestratorDispatchMigration).toMatch(
      /grant execute on function public\.book_to_tax\(uuid, integer\) to service_role/i,
    );
    expect(orchestratorDispatchMigration).toMatch(
      /grant execute on function public\.generate_eofy_pack\(uuid, integer\) to service_role/i,
    );
    expect(orchestratorDispatchMigration).toMatch(
      /grant execute on function public\.generate_workcover_declaration\(uuid, integer\) to service_role/i,
    );
    expect(orchestratorDispatchMigration).toMatch(
      /grant execute on function public\.smsf_tbc_tbar\(uuid, integer, uuid\) to service_role/i,
    );
    expect(orchestratorDispatchMigration).toMatch(
      /grant execute on function public\.div7a_breach_scan\(uuid, date\) to service_role/i,
    );
  });

  it('keeps approved payroll/STP and SMSF work at explicit external walls', () => {
    expect(payrollFinalisePayRun).toMatch(/stpTransmissionGate/);
    expect(payrollFinalisePayRun).toMatch(/stp_transmission_gate:\s*stpTransmissionGate\(\)/);
    expect(payrollExportStp).toMatch(/blocked_action:\s*"stp_sbr_transmit"/);
    expect(payrollExportStp).toMatch(/transmit_enabled:\s*false/);
    expect(payrollExportStp).toMatch(/registered_tax_or_bas_agent/);

    expect(orchestratorDispatch).toMatch(/external_walls:\s*adapter\.externalWalls \?\? \[\]/);
    expect(orchestratorDispatch).toMatch(/"smsf_independent_audit"/);
    expect(orchestratorDispatch).toMatch(/"tbar_registered_agent_lodgement"/);
  });
});
