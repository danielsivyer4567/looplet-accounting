import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const enumMigration = readFileSync(
  join(root, 'supabase/migrations/20260702134000_expand_debt_kind_enum.sql'),
  'utf8',
);
const pipelineMigration = readFileSync(
  join(root, 'supabase/migrations/20260702134500_bank_accounts_to_debts_pipeline.sql'),
  'utf8',
);
const debtsPage = readFileSync(join(root, 'src/pages/Debts.tsx'), 'utf8');
const debtDetailPage = readFileSync(join(root, 'src/pages/DebtDetail.tsx'), 'utf8');

describe('bank account to debt pipeline contract', () => {
  it('keeps debt_kind aligned with the UI debt options', () => {
    for (const value of ['business_loan', 'overdraft', 'tax_debt']) {
      expect(enumMigration).toContain(`ADD VALUE IF NOT EXISTS '${value}'`);
      expect(debtsPage).toContain(`'${value}'`);
      expect(debtDetailPage).toContain(`'${value}'`);
    }
  });

  it('promotes liability bank accounts into tracked debts', () => {
    expect(pipelineMigration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_debts_org_bank_account_active/i);
    expect(pipelineMigration).toMatch(/ON public\.debts \(organization_id, bank_account_id\)/i);
    expect(pipelineMigration).toMatch(/WHERE bank_account_id IS NOT NULL\s+AND deleted_at IS NULL/i);
    expect(pipelineMigration).toMatch(/CREATE OR REPLACE FUNCTION public\.sync_debt_from_bank_account/i);
    expect(pipelineMigration).toMatch(/SECURITY DEFINER/i);
    expect(pipelineMigration).toMatch(/SET search_path = public/i);
    expect(pipelineMigration).toMatch(/NEW\.account_type NOT IN \('credit_card'::public\.bank_account_type, 'loan'::public\.bank_account_type\)/i);
    expect(pipelineMigration).toMatch(/WHEN 'credit_card'::public\.bank_account_type THEN 'credit_card'::public\.debt_kind/i);
    expect(pipelineMigration).toMatch(/ELSE 'business_loan'::public\.debt_kind/i);
    expect(pipelineMigration).toMatch(/bank_account_id,\s+original_balance_cents,\s+current_balance_cents/i);
    expect(pipelineMigration).toMatch(/abs\(coalesce\(NEW\.current_balance_cents, 0\)\)/i);
    expect(pipelineMigration).toMatch(/ON CONFLICT \(organization_id, bank_account_id\)/i);
    expect(pipelineMigration).toMatch(/AFTER INSERT OR UPDATE OF account_type, current_balance_cents, account_number_last4, name, is_active/i);
    expect(pipelineMigration).toMatch(/INSERT INTO public\.debts[\s\S]*FROM public\.bank_accounts ba/i);
    expect(pipelineMigration).toMatch(/REVOKE ALL ON FUNCTION public\.sync_debt_from_bank_account\(\) FROM PUBLIC, anon, authenticated/i);
  });
});
