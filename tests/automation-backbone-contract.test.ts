import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const ingest = readFileSync(join(root, 'supabase/functions/ingest/index.ts'), 'utf8');
const worker = readFileSync(join(root, 'supabase/functions/automation-worker/index.ts'), 'utf8');
const bankWebhook = readFileSync(join(root, 'supabase/functions/bank-webhook/index.ts'), 'utf8');
const bankSync = readFileSync(join(root, 'supabase/functions/bank-sync/index.ts'), 'utf8');
const billsExtract = readFileSync(join(root, 'supabase/functions/bills-extract/index.ts'), 'utf8');
const automationJobs = readFileSync(
  join(root, 'supabase/functions/_shared/automationJobs.ts'),
  'utf8',
);
const appAutomationJobs = readFileSync(join(root, 'src/lib/automationJobs.ts'), 'utf8');
const config = readFileSync(join(root, 'supabase/config.toml'), 'utf8');

describe('automation backbone source contracts', () => {
  it('document ingest creates a bill source before queueing OCR', () => {
    expect(ingest).toMatch(/storageKey\.startsWith\(`org-\$\{orgId\}\/`\)/);
    expect(ingest).toMatch(
      /\.from\(['"]bills['"]\)[\s\S]*\.insert\(\{[\s\S]*storage_key: storageKey/i,
    );
    expect(ingest).toMatch(/p_job_kind:\s*['"]bill_extract['"]/);
    expect(ingest).toMatch(/p_source_kind:\s*['"]document['"]/);
    expect(ingest).toMatch(/bill_id:\s*billId/);
  });

  it('bill extraction jobs dispatch a specific bill when one is known', () => {
    expect(worker).toMatch(/const endpoint = billId \? 'bills-extract' : 'bills-extract-batch'/);
    expect(worker).toMatch(/bill_id:\s*billId/);
    expect(worker).toMatch(/organization_id:\s*job\.organization_id/);
  });

  it('payment jobs record invoice receipts and refuse AP bill shortcuts', () => {
    expect(automationJobs).toMatch(/\|\s*'payment_record'/);
    expect(appAutomationJobs).toMatch(/\|\s*'payment_record'/);
    expect(worker).toMatch(/case 'payment_record'/);
    expect(worker).toMatch(/from\('invoice_payments'\)[\s\S]*\.insert\(\{/);
    expect(worker).toMatch(/bill payment jobs require bank reconciliation or payment runs/i);
  });

  it('receipt and Xero queue dispatches match target function contracts', () => {
    expect(worker).toMatch(/case 'receipt_sync'/);
    expect(worker).toMatch(/receipt-sync-dispatch/);
    expect(worker).toMatch(/receipt_sync_job_id/);
    expect(worker).not.toMatch(/case 'receipt_sync':[\s\S]*?functions\/v1`\}\?\/ingest/);

    expect(worker).toMatch(/case 'xero_push'/);
    expect(worker).toMatch(/xero-push-invoice/);
    expect(worker).toMatch(/xero-push-bill/);
    expect(worker).toMatch(/invoice_id:\s*invoiceId/);
    expect(worker).toMatch(/bill_id:\s*billId/);
    expect(worker).toMatch(/xero_push requires invoice_id or bill_id/);
  });

  it('scheduled worker only claims job kinds it can execute end-to-end', () => {
    expect(worker).toMatch(/const DEFAULT_JOB_KINDS = \[/);
    expect(worker).toMatch(
      /claimJobs\(admin, workerId, \[\.\.\.DEFAULT_JOB_KINDS\], CLAIM_LIMIT\)/,
    );

    const defaultKindsMatch = worker.match(/const DEFAULT_JOB_KINDS = \[([\s\S]*?)\] as const;/);
    expect(defaultKindsMatch?.[1]).toContain("'bill_extract'");
    expect(defaultKindsMatch?.[1]).toContain("'payment_record'");
    expect(defaultKindsMatch?.[1]).not.toContain("'browser_collect'");
    expect(worker).toMatch(/case 'browser_collect'/);
  });

  it('bank webhooks do not lose sync dispatch after raw-event persistence', () => {
    expect(bankWebhook).toMatch(/let duplicateDelivery = false/);
    expect(bankWebhook).toMatch(/duplicateDelivery = true/);
    expect(bankWebhook).not.toMatch(/duplicate_skipped/);
    expect(bankWebhook).toMatch(/const syncResponse = await fetch/);
    expect(bankWebhook).not.toContain("}).catch((e) => console.error('webhook");
    expect(bankWebhook).toMatch(/bank-sync dispatch failed/);
  });

  it('bill extraction persists proof rows before returning ok', () => {
    expect(billsExtract).not.toMatch(/void writeDecision/);
    expect(billsExtract).not.toMatch(/void writeExtractionVersion/);
    expect(billsExtract).toMatch(/await writeDecision/);
    expect(billsExtract).toMatch(/await writeExtractionVersion/);
    expect(billsExtract).toMatch(/Failed to persist automation decision/);
    expect(billsExtract).toMatch(/Failed to persist extraction version/);
  });

  it('bank sync surfaces post-sync automation failures', () => {
    expect(bankSync).not.toMatch(/fireAndForgetSubsDetect/);
    expect(bankSync).not.toMatch(/fireAndForgetIntakeRouting/);
    expect(bankSync).toMatch(/await runSubsDetect/);
    expect(bankSync).toMatch(/await runIntakeRouting/);
    expect(bankSync).toMatch(/post_sync_errors/);
    expect(bankSync).toMatch(
      /return json\(\{ ok: false, results, post_sync_errors: postSyncErrors \}, 502\)/,
    );
  });

  it('cron and webhook edge functions keep platform JWT disabled', () => {
    for (const fn of [
      'automation-worker',
      'automation-watchdog',
      'bank-webhook',
      'bank-sync',
      'auto-reconcile',
    ]) {
      expect(config).toMatch(
        new RegExp(`\\[functions\\.${fn}\\][\\s\\S]*?verify_jwt\\s*=\\s*false`, 'i'),
      );
    }
  });
});
