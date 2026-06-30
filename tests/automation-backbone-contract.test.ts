import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const ingest = readFileSync(join(root, 'supabase/functions/ingest/index.ts'), 'utf8');
const worker = readFileSync(join(root, 'supabase/functions/automation-worker/index.ts'), 'utf8');
const automationJobs = readFileSync(
  join(root, 'supabase/functions/_shared/automationJobs.ts'),
  'utf8',
);
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
    expect(worker).toMatch(/case 'payment_record'/);
    expect(worker).toMatch(/from\('invoice_payments'\)[\s\S]*\.insert\(\{/);
    expect(worker).toMatch(/bill payment jobs require bank reconciliation or payment runs/i);
  });

  it('cron and webhook edge functions keep platform JWT disabled', () => {
    for (const fn of ['automation-worker', 'bank-webhook', 'bank-sync', 'auto-reconcile']) {
      expect(config).toMatch(
        new RegExp(`\\[functions\\.${fn}\\][\\s\\S]*?verify_jwt\\s*=\\s*false`, 'i'),
      );
    }
  });
});
