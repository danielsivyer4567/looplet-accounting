import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageJson {
  scripts?: Record<string, string>;
}

const root = process.cwd();

function readRepoFile(relativePath: string): string {
  return readFileSync(join(root, relativePath), 'utf8');
}

const packageJson = JSON.parse(readRepoFile('package.json')) as PackageJson;
const accountingScript = packageJson.scripts?.['test:accounting'] ?? '';
const ci = readRepoFile('.github/workflows/ci.yml');

describe('accounting-engine CI gate', () => {
  it('defines a named npm script for the CI-safe accounting suite', () => {
    expect(accountingScript).toContain('vitest run');
    expect(accountingScript).toContain('accountingEngineGate.test.ts');
    expect(accountingScript).toContain('glCanonicalPosting.test.ts');
    expect(accountingScript).toContain('periodLockCoverage.test.ts');
    expect(accountingScript).toContain('requireRoleAccepted.test.ts');
    expect(accountingScript).toContain('apReconciliationParity.test.ts');
    expect(accountingScript).toContain('invoiceGlPosting.test.ts');
    expect(accountingScript).toContain('bankReconciliationGlPosting.test.ts');
    expect(accountingScript).toContain('paymentRunPayrollGlPosting.test.ts');
    expect(accountingScript).toContain('useRegistrations.test.ts');
    expect(accountingScript).toContain('Bas.test.tsx');
    expect(accountingScript).toContain('invoice-reconciliation-migration.test.ts');
    expect(accountingScript).toContain('receipt-webhook.test.ts');
  });

  it('wires the accounting suite into GitHub Actions as an explicit gate', () => {
    expect(ci).toMatch(/Accounting engine tests/);
    expect(ci).toMatch(/npm run test:accounting/);
  });

  it('keeps canonical GL posting and period-lock SQL assertions in the accounting suite', () => {
    const gl = readRepoFile('supabase/migrations/0215_gl_canonical_posting.sql');
    const periodLocks = readRepoFile('supabase/migrations/0209_period_lock_coverage.sql');
    const apReconciliation = readRepoFile('supabase/migrations/0216_ap_reconciliation_parity.sql');
    const invoiceGlPosting = readRepoFile('supabase/migrations/0217_invoice_gl_posting.sql');
    const bankReconciliationGlPosting = readRepoFile(
      'supabase/migrations/0218_bank_reconciliation_gl_posting.sql',
    );
    const paymentRunPayrollGlPosting = readRepoFile(
      'supabase/migrations/0219_payment_run_payroll_gl_posting.sql',
    );

    expect(gl).toMatch(/CREATE OR REPLACE FUNCTION public\.create_and_post_journal\(/);
    expect(gl).toMatch(/CREATE OR REPLACE FUNCTION public\.trial_balance_by_period\(/);
    expect(gl).toMatch(/journal_entries_org_source_event_key_uniq/);
    expect(periodLocks).toMatch(/check_period_lock_v2/);
    expect(periodLocks).toMatch(/journal_entries:entry_date/);
    expect(apReconciliation).toMatch(/CREATE OR REPLACE FUNCTION public\.reconcile_match_bill\(/);
    expect(apReconciliation).toMatch(/CREATE OR REPLACE VIEW public\.v_bank_match_candidates/);
    expect(invoiceGlPosting).toMatch(/CREATE OR REPLACE FUNCTION public\.post_invoice_journal\(/);
    expect(invoiceGlPosting).toMatch(/CREATE OR REPLACE FUNCTION public\.post_invoice_payment_journal\(/);
    expect(invoiceGlPosting).toMatch(/create_and_post_journal/);
    expect(bankReconciliationGlPosting).toMatch(
      /CREATE OR REPLACE FUNCTION public\.post_bank_transaction_journal\(/,
    );
    expect(bankReconciliationGlPosting).toMatch(
      /CREATE OR REPLACE FUNCTION public\.post_reconciled_bank_transaction_journal\(/,
    );
    expect(bankReconciliationGlPosting).toMatch(/create_and_post_journal/);
    expect(paymentRunPayrollGlPosting).toMatch(
      /CREATE OR REPLACE FUNCTION public\.post_payment_run_journal\(/,
    );
    expect(paymentRunPayrollGlPosting).toMatch(
      /CREATE OR REPLACE FUNCTION public\.post_payroll_pay_run_journal\(/,
    );
    expect(paymentRunPayrollGlPosting).toMatch(/create_and_post_journal/);
  });

  it('keeps GST, BAS, PAYG, and reconciliation coverage represented', () => {
    const receiptTest = readRepoFile('tests/receipt-webhook.test.ts');
    const basUiTest = readRepoFile('src/test/pages/Bas.test.tsx');
    const registrationsTest = readRepoFile('src/test/hooks/useRegistrations.test.ts');
    const reconciliationTest = readRepoFile('tests/invoice-reconciliation-migration.test.ts');

    expect(receiptTest).toMatch(/normalizeReceiptTaxBreakdown/);
    expect(receiptTest).toMatch(/estimates GST as 1\/11/);
    expect(basUiTest).toMatch(/1A GST on sales/);
    expect(basUiTest).toMatch(/1B GST on purchases/);
    expect(registrationsTest).toMatch(/PAYG withholding/);
    expect(reconciliationTest).toMatch(/reconcile_match_invoice/);
    expect(reconciliationTest).toMatch(/v_bank_invoice_match_candidates/);
  });

  it('keeps deploy-gated accounting integration and Deno tests discoverable', () => {
    const aba = readRepoFile('tests/payment-runs-aba-export.test.ts');
    const basPdf = readRepoFile('tests/bas-worksheet-pdf.test.ts');
    const xeroIdempotency = readRepoFile('supabase/functions/_shared/xero/idempotency.test.ts');
    const xeroRetry = readRepoFile('supabase/functions/_shared/xero/retry.test.ts');

    expect(aba).toMatch(/payment-runs-aba-export/);
    expect(aba).toMatch(/IS_CI && !HAS_ENV/);
    expect(basPdf).toMatch(/bas-worksheet-pdf/);
    expect(xeroIdempotency).toMatch(/deriveXeroIdempotencyKey/);
    expect(xeroRetry).toMatch(/callXeroWithRetry/);
  });
});
