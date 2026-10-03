import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const ingest = readFileSync(join(root, 'supabase/functions/ingest/index.ts'), 'utf8');
const ingestHandlers = readFileSync(join(root, 'supabase/functions/ingest/handlers.ts'), 'utf8');
const worker = readFileSync(join(root, 'supabase/functions/automation-worker/index.ts'), 'utf8');
const watchdog = readFileSync(
  join(root, 'supabase/functions/automation-watchdog/index.ts'),
  'utf8',
);
// Linking a Redbark account queues its first import from the settings panel (it replaced bank-exchange).
const bankFeedLink = readFileSync(join(root, 'src/components/settings/BankFeedLink.tsx'), 'utf8');
// The webhook's order of work lives in handler.ts; index.ts wires it to Supabase and bank-sync.
const bankWebhook = ['index.ts', 'handler.ts']
  .map((file) => readFileSync(join(root, 'supabase/functions/bank-webhook', file), 'utf8'))
  .join('\n');
const bankSync = readFileSync(join(root, 'supabase/functions/bank-sync/index.ts'), 'utf8');
const bankTransactionClassifier = readFileSync(
  join(root, 'supabase/functions/bank-transaction-classifier/index.ts'),
  'utf8',
);
const billsExtract = readFileSync(join(root, 'supabase/functions/bills-extract/index.ts'), 'utf8');
const billsExtractBatch = readFileSync(
  join(root, 'supabase/functions/bills-extract-batch/index.ts'),
  'utf8',
);
const autoReconcile = readFileSync(
  join(root, 'supabase/functions/auto-reconcile/index.ts'),
  'utf8',
);
const xeroPushBill = readFileSync(join(root, 'supabase/functions/xero-push-bill/index.ts'), 'utf8');
const xeroPushInvoice = readFileSync(
  join(root, 'supabase/functions/xero-push-invoice/index.ts'),
  'utf8',
);
const xeroAdapter = readFileSync(join(root, 'supabase/functions/_shared/xero/adapter.ts'), 'utf8');
const atomicReconcileEvidenceMigration = readFileSync(
  join(root, 'supabase/migrations/20260701070000_reconcile_evidence_atomic.sql'),
  'utf8',
);
const xeroIdempotency = readFileSync(
  join(root, 'supabase/functions/_shared/xero/idempotency.ts'),
  'utf8',
);
const xeroOAuthStart = readFileSync(
  join(root, 'supabase/functions/xero-oauth-start/index.ts'),
  'utf8',
);
const xeroOAuthCallback = readFileSync(
  join(root, 'supabase/functions/xero-oauth-callback/index.ts'),
  'utf8',
);
const xeroOAuthState = readFileSync(
  join(root, 'supabase/functions/_shared/oauthState.ts'),
  'utf8',
);
const gmailPubsub = readFileSync(
  join(root, 'supabase/functions/gmail-pubsub-push/index.ts'),
  'utf8',
);
const gmailClassifyAi = readFileSync(
  join(root, 'supabase/functions/gmail-classify-ai/index.ts'),
  'utf8',
);
const gmailMine = readFileSync(join(root, 'supabase/functions/gmail-mine/index.ts'), 'utf8');
const gmailMineRefreshJobs = readFileSync(
  join(root, 'supabase/migrations/20260702124500_gmail_mine_refresh_jobs.sql'),
  'utf8',
);
const billCodeJobs = readFileSync(
  join(root, 'supabase/migrations/20260702173000_bill_code_jobs.sql'),
  'utf8',
);
const stagedEntityApproval = readFileSync(
  join(root, 'supabase/functions/_shared/onboarding/stagedEntityApproval.ts'),
  'utf8',
);
const gmailIngest = readFileSync(join(root, 'supabase/functions/_shared/gmail/ingest.ts'), 'utf8');
const automationJobs = readFileSync(
  join(root, 'supabase/functions/_shared/automationJobs.ts'),
  'utf8',
);
const appAutomationJobs = readFileSync(join(root, 'src/lib/automationJobs.ts'), 'utf8');
const billsPage = readFileSync(join(root, 'src/pages/Bills.tsx'), 'utf8');
const invoiceDetailPage = readFileSync(join(root, 'src/pages/InvoiceDetail.tsx'), 'utf8');
const reconciliationPage = readFileSync(join(root, 'src/pages/Reconciliation.tsx'), 'utf8');
const bankConnect = readFileSync(join(root, 'src/components/settings/BankConnect.tsx'), 'utf8');
const config = readFileSync(join(root, 'supabase/config.toml'), 'utf8');

describe('automation backbone source contracts', () => {
  it('document ingest creates a bill source before queueing OCR', () => {
    expect(ingestHandlers).toMatch(/storageKey\.startsWith\(`org-\$\{orgId\}\/`\)/);
    expect(ingestHandlers).toMatch(
      /\.from\(['"]bills['"]\)[\s\S]*\.insert\(\{[\s\S]*storage_key: storageKey/i,
    );
    expect(ingestHandlers).toMatch(/p_job_kind:\s*['"]bill_extract['"]/);
    expect(ingestHandlers).toMatch(/p_source_kind:\s*['"]document['"]/);
    expect(ingestHandlers).toMatch(/bill_id:\s*billId/);
  });

  it('connector ingest routes bill and bank pushes observably', () => {
    expect(ingestHandlers).not.toMatch(/fireIntakeRouting/);
    expect(ingestHandlers).not.toMatch(/routing is best-effort/);
    expect(ingestHandlers).not.toMatch(/routing is non-critical/);
    expect(ingestHandlers).toMatch(/await runIntakeRouting\(orgId, 'bill', \[existing\.id\]\)/);
    expect(ingestHandlers).toMatch(/await runIntakeRouting\(orgId, 'bill', \[inserted\.id\]\)/);
    expect(ingestHandlers).toMatch(
      /await runIntakeRouting\(orgId, 'bank_transaction', \[txn\.id\]\)/,
    );
    expect(ingest).toMatch(/return json\(\{ error: 'ingest_failed' \}, 500\)/);
  });

  it('bill extraction jobs dispatch a specific bill when one is known', () => {
    expect(worker).toMatch(/const endpoint = billId \? 'bills-extract' : 'bills-extract-batch'/);
    expect(worker).toMatch(/bill_id:\s*billId/);
    expect(worker).toMatch(/organization_id:\s*job\.organization_id/);
  });

  it('batch bill extraction jobs can drive repair-mode backfills', () => {
    const billExtractCase =
      worker.match(/case 'bill_extract':[\s\S]*?case 'bank_sync':/)?.[0] ?? '';

    expect(billsExtractBatch).toMatch(/mode\?:\s*'received'\s*\|\s*'repair'/);
    expect(billsExtractBatch).toMatch(/body\.mode === 'repair' \? 'repair' : 'received'/);
    expect(billsExtractBatch).toMatch(/force:\s*mode === 'repair'/);

    expect(billExtractCase).toMatch(/function billExtractBatchMode|billExtractBatchMode/);
    expect(worker).toMatch(/value === 'received' \|\| value === 'repair'/);
    expect(billExtractCase).toMatch(/requestBody\['mode'\] = mode/);
    expect(billExtractCase).toMatch(/requestBody\['max'\] = max/);
    expect(billExtractCase).toMatch(/requestBody\['delay_ms'\] = delayMs/);
    expect(billExtractCase).not.toMatch(/payload:\s*job\.payload/);
  });

  it('bill coding has a durable worker job and enqueue cron', () => {
    expect(automationJobs).toMatch(/\|\s*'bill_code'/);
    expect(appAutomationJobs).toMatch(/\|\s*'bill_code'/);
    expect(worker).toMatch(/case 'bill_code'/);
    expect(worker).toMatch(/intake-routing-apply/);
    expect(worker).toMatch(/target:\s*'bill'/);
    expect(worker).toMatch(/target_id:\s*billId/);
    expect(worker).toMatch(/bill_code requires bill_id/);
    expect(worker).toMatch(/job\.job_kind === 'bill_code'[\s\S]*return false/);

    expect(watchdog).toMatch(/'bill_code'/);
    expect(billCodeJobs).toMatch(/create or replace function public\.enqueue_bill_code_jobs/i);
    expect(billCodeJobs).toMatch(/job_kind[\s\S]*'bill_code'/i);
    expect(billCodeJobs).toMatch(/not exists \([\s\S]*public\.coding_suggestions/i);
    expect(billCodeJobs).toMatch(/cron\.schedule\([\s\S]*'bill-code-enqueue-every-5min'/i);
    expect(billCodeJobs).not.toMatch(/net\.http_post/i);
  });

  it('payment jobs record invoice receipts and refuse AP bill shortcuts', () => {
    expect(automationJobs).toMatch(/\|\s*'payment_record'/);
    expect(appAutomationJobs).toMatch(/\|\s*'payment_record'/);
    expect(worker).toMatch(/case 'payment_record'/);
    expect(worker).toMatch(/from\('invoice_payments'\)[\s\S]*\.insert\(\{/);
    expect(worker).toMatch(/bill payment jobs require bank reconciliation or payment runs/i);
  });

  it('gmail mine refresh creates durable worker jobs instead of direct cron HTTP', () => {
    expect(automationJobs).toMatch(/\|\s*'gmail_mine'/);
    expect(appAutomationJobs).toMatch(/\|\s*'gmail_mine'/);
    expect(worker).toMatch(/case 'gmail_mine'/);
    expect(worker).toMatch(/`\$\{base\}\/gmail-mine`/);
    expect(worker).toMatch(/integration_id:\s*integrationId/);
    expect(worker).toMatch(/folder,\s*\}/);
    expect(worker).toMatch(/requestBody\['page_token'\] = pageToken/);
    expect(gmailMine).toMatch(/from\('staged_entities'\)/);
    expect(gmailMine).toMatch(/\.upsert\(/);

    expect(gmailMineRefreshJobs).toMatch(
      /create or replace function public\.enqueue_gmail_mine_refresh_jobs/i,
    );
    expect(gmailMineRefreshJobs).toMatch(/insert into public\.automation_jobs/i);
    expect(gmailMineRefreshJobs).toMatch(/'gmail_mine'/);
    expect(gmailMineRefreshJobs).toMatch(/jsonb_build_object\([\s\S]*'integration_id', gi\.id/i);
    expect(gmailMineRefreshJobs).toMatch(/cron\.schedule\([\s\S]*'gmail-mine-refresh'/i);
    expect(gmailMineRefreshJobs).toMatch(
      /select public\.enqueue_gmail_mine_refresh_jobs\(14, 100\)/i,
    );
    expect(gmailMineRefreshJobs).not.toMatch(/net\.http_post/i);
    expect(gmailMineRefreshJobs).not.toMatch(/functions\/v1\/gmail-mine/i);
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
    expect(worker).toMatch(/idempotency_key:\s*job\.id/);
    expect(worker).toMatch(/xero_push requires invoice_id or bill_id/);
  });

  it('Xero push retries reuse stable idempotency keys', () => {
    for (const source of [xeroPushBill, xeroPushInvoice]) {
      expect(source).toMatch(/resolveXeroIdempotencyKey/);
      expect(source).toMatch(/idempotency_key\?:\s*string/);
      expect(source).not.toMatch(/const idempotencyKey = crypto\.randomUUID\(\)/);
      expect(source).toMatch(/headers:\s*\{\s*'Idempotency-Key': idempotencyKey\s*\}/);
    }

    expect(xeroAdapter).toMatch(/resolveXeroIdempotencyKey/);
    expect(xeroAdapter).not.toMatch(/idempotency_key:\s*crypto\.randomUUID\(\)/);

    expect(xeroIdempotency).toMatch(/UUID_RE/);
    expect(xeroIdempotency).toMatch(/crypto\.subtle\.digest\('SHA-256'/);
    expect(xeroIdempotency).toMatch(/fallbackParts\.join\(':'\)/);
  });

  it('Xero OAuth state is HMAC-signed, bound to the user and callback verified', () => {
    expect(xeroOAuthStart).toMatch(/createOAuthState\(\{ provider: 'xero'/);
    expect(xeroOAuthState).toMatch(/XERO_OAUTH_STATE_SECRET/);
    expect(xeroOAuthState).toMatch(/XERO_CLIENT_SECRET/);
    expect(xeroOAuthState).toMatch(/crypto\.subtle\.sign\('HMAC'/);
    expect(xeroOAuthState).toMatch(/safeEqual/);

    expect(xeroOAuthCallback).toMatch(/verifyOAuthState\(body\.state, \{ provider: 'xero'/);
    expect(xeroOAuthCallback).toMatch(/organization_id, code, redirect_uri, state required/);
    expect(xeroOAuthCallback).not.toContain('startsWith(`${body.organization_id}.`)');
    expect(xeroOAuthStart).not.toMatch(/TODO[\s\S]*sign state/i);
  });

  it('UI queues Xero pushes instead of direct edge fetches', () => {
    for (const source of [billsPage, invoiceDetailPage, reconciliationPage]) {
      expect(source).toMatch(/enqueueJob/);
      expect(source).toMatch(/jobKind:\s*'xero_push'/);
      expect(source).not.toMatch(/functions\/v1\/xero-push-(bill|invoice)/);
    }
  });

  it('scheduled worker only claims job kinds it can execute end-to-end', () => {
    expect(worker).toMatch(/const DEFAULT_JOB_KINDS = \[/);
    expect(worker).toMatch(
      /claimJobs\(admin, workerId, \[\.\.\.DEFAULT_JOB_KINDS\], CLAIM_LIMIT\)/,
    );

    const defaultKindsMatch = worker.match(/const DEFAULT_JOB_KINDS = \[([\s\S]*?)\] as const;/);
    expect(defaultKindsMatch?.[1]).toContain("'bill_extract'");
    expect(defaultKindsMatch?.[1]).toContain("'bank_sync'");
    expect(defaultKindsMatch?.[1]).toContain("'gmail_mine'");
    expect(defaultKindsMatch?.[1]).toContain("'bill_code'");
    expect(defaultKindsMatch?.[1]).toContain("'payment_record'");
    expect(defaultKindsMatch?.[1]).not.toContain("'browser_collect'");
    expect(worker).toMatch(/case 'browser_collect'/);
  });

  it('bank feed linking queues the initial sync job instead of fire-and-forget HTTP', () => {
    expect(worker).toMatch(/case 'bank_sync'/);
    expect(worker).toMatch(/`\$\{base\}\/bank-sync`/);
    expect(bankFeedLink).toMatch(/enqueueJob/);
    expect(bankFeedLink).toMatch(/jobKind:\s*'bank_sync'/);
    expect(bankFeedLink).toMatch(/sourceKind:\s*'bank_connection'/);
    expect(bankFeedLink).not.toMatch(/functions\/v1\/bank-sync/);
  });

  it('bank settings queues manual sync jobs instead of direct edge fetches', () => {
    expect(bankConnect).toMatch(/enqueueJob/);
    expect(bankConnect).toMatch(/jobKind:\s*'bank_sync'/);
    expect(bankConnect).toMatch(/sourceKind:\s*'bank_connection'/);
    expect(bankConnect).not.toMatch(/functions\/v1\/bank-sync/);
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
    expect(billsExtract).not.toMatch(/fireAndForgetIntakeRouting/);
    expect(billsExtract).toMatch(/await writeDecision/);
    expect(billsExtract).toMatch(/await writeExtractionVersion/);
    expect(billsExtract).toMatch(/await runIntakeRouting/);
    expect(billsExtract).toMatch(/Failed to persist automation decision/);
    expect(billsExtract).toMatch(/Failed to persist extraction version/);
    expect(billsExtract).toMatch(/intake-routing-apply failed/);
  });

  it('bank sync surfaces post-sync automation failures', () => {
    expect(bankSync).not.toMatch(/fireAndForgetSubsDetect/);
    expect(bankSync).not.toMatch(/fireAndForgetIntakeRouting/);
    expect(bankSync).toMatch(/await runPostSyncFunction/);
    expect(bankSync).toMatch(/subscriptions-detect/);
    expect(bankSync).toMatch(/subscriptions-autoconfirm/);
    expect(bankSync).toMatch(/bank-transaction-classifier/);
    expect(bankSync).toMatch(/auto-reconcile/);
    expect(bankSync).toMatch(/postSync\['bank_transaction_classifier'\]/);
    expect(bankSync).toMatch(/postSync\['auto_reconcile'\]/);
    expect(bankSync).toMatch(/await runIntakeRouting/);
    expect(bankSync).toMatch(/post_sync:\s*postSync/);
    expect(bankSync).toMatch(/post_sync_errors/);
    expect(bankSync).toMatch(
      /return json\([\s\S]*\{ ok: false, results, post_sync: postSync, post_sync_errors: postSyncErrors \}[\s\S]*502[\s\S]*\)/,
    );
  });

  it('bank transaction classifier posts safe bank-only debit classifications through E1', () => {
    expect(bankTransactionClassifier).toMatch(/import \{ postJournalEntry \}/);
    expect(bankTransactionClassifier).toMatch(/BANK_TRANSACTION_ACCOUNT_CODES/);
    expect(bankTransactionClassifier).toMatch(/matched_bill_reconciliation_owns_gl/);
    expect(bankTransactionClassifier).toMatch(/matched_invoice_reconciliation_owns_gl/);
    expect(bankTransactionClassifier).toMatch(/inbound_bank_transaction_reconciliation_owns_gl/);
    expect(bankTransactionClassifier).toMatch(/personal_transaction_not_posted_to_business_gl/);
    expect(bankTransactionClassifier).toMatch(/category_not_safe_for_bank_only_gl_post/);
    expect(bankTransactionClassifier).toMatch(/sourceType:\s*'bank_transaction'/);
    expect(bankTransactionClassifier).toMatch(/sourceId:\s*txn\.id/);
    expect(bankTransactionClassifier).toMatch(
      /postBankTransactionJournal\(admin, postingDeps, txn, result\.category_code\)/,
    );
    expect(bankTransactionClassifier).toMatch(/glPost\.required && !glPost\.posted/);
    expect(bankTransactionClassifier).toMatch(/coding_status:\s*'needs_review'/);
    expect(bankTransactionClassifier).toMatch(/GL post failed/);
    expect(bankTransactionClassifier).toMatch(/gl_posted/);
    expect(bankTransactionClassifier).toMatch(/gl_failed/);
  });

  it('auto-reconcile applies matches and proof evidence transactionally', () => {
    expect(atomicReconcileEvidenceMigration).toMatch(
      /create or replace function public\.reconcile_match_bill_with_evidence/i,
    );
    expect(atomicReconcileEvidenceMigration).toMatch(
      /create or replace function public\.reconcile_match_invoice_with_evidence/i,
    );
    expect(atomicReconcileEvidenceMigration).toMatch(
      /create or replace function public\.record_reconciliation_skip_evidence/i,
    );
    expect(atomicReconcileEvidenceMigration).toMatch(/public\.reconcile_match_bill\(/);
    expect(atomicReconcileEvidenceMigration).toMatch(/public\.reconcile_match_invoice\(/);
    expect(atomicReconcileEvidenceMigration).toMatch(
      /insert into public\.reconciliation_evidence/i,
    );
    expect(atomicReconcileEvidenceMigration).toMatch(/v_gl_evidence jsonb/i);
    expect(atomicReconcileEvidenceMigration).toMatch(/from public\.journal_entries je/i);
    expect(atomicReconcileEvidenceMigration).toMatch(/je\.source_type = 'bill'/i);
    expect(atomicReconcileEvidenceMigration).toMatch(/je\.source_type = 'invoice'/i);
    expect(atomicReconcileEvidenceMigration).toMatch(/'\{gl_evidence\}'/i);
    expect(atomicReconcileEvidenceMigration).toMatch(/jsonb_set\(/i);
    expect(atomicReconcileEvidenceMigration).toMatch(/evidence_recorded/);
    expect(atomicReconcileEvidenceMigration).toMatch(
      /revoke all on function public\.reconcile_match_bill_with_evidence[\s\S]*from public, anon/i,
    );
    expect(atomicReconcileEvidenceMigration).toMatch(
      /grant execute on function public\.reconcile_match_bill_with_evidence[\s\S]*to authenticated/i,
    );

    expect(autoReconcile).toMatch(/reconcile_match_bill_with_evidence/);
    expect(autoReconcile).toMatch(/reconcile_match_invoice_with_evidence/);
    expect(autoReconcile).toMatch(/record_reconciliation_skip_evidence/);
    expect(autoReconcile).toMatch(/evidence\.reason_codes/);
    expect(autoReconcile).toMatch(/evidence\.score_components/);
    expect(autoReconcile).toMatch(/if \(!r\?\.evidence_recorded\)/);
    expect(autoReconcile).toMatch(/return json\(\{ ok: false, stats \}, 502\)/);
    expect(autoReconcile).not.toMatch(/from\('reconciliation_evidence'\)[\s\S]*\.insert/);
    expect(autoReconcile).not.toMatch(/_evidence_batch/);
  });

  it('gmail bill ingestion queues extraction jobs instead of direct fire-and-forget HTTP', () => {
    for (const source of [gmailPubsub, gmailIngest]) {
      expect(source).toMatch(/enqueue_automation_job/);
      expect(source).toMatch(/p_job_kind:\s*'bill_extract'/);
      expect(source).not.toMatch(/functions\/v1\/bills-extract/);
      expect(source).not.toMatch(/bills-extract dispatch failed/);
    }
  });

  it('gmail classifier can auto-approve safe high-confidence staged senders into intake rules', () => {
    expect(gmailClassifyAi).toMatch(/approveStagedEntity/);
    expect(gmailClassifyAi).toMatch(/isSafeStagedAutoApproval/);
    expect(gmailClassifyAi).toMatch(/auto_approved:\s*0/);
    expect(stagedEntityApproval).toMatch(/intake_rules/);
    expect(stagedEntityApproval).toMatch(/resolved_rule_id/);
    expect(stagedEntityApproval).toMatch(/AUTO_APPROVE_BLOCKED_CATEGORIES/);
    expect(stagedEntityApproval).not.toMatch(/onConflict:\s*['"]organization_id,name['"]/);
  });

  it('cron and webhook edge functions keep platform JWT disabled', () => {
    for (const fn of [
      'automation-worker',
      'automation-watchdog',
      'bank-webhook',
      'bank-sync',
      'auto-reconcile',
      'bank-transaction-classifier',
    ]) {
      expect(config).toMatch(
        new RegExp(`\\[functions\\.${fn}\\][\\s\\S]*?verify_jwt\\s*=\\s*false`, 'i'),
      );
    }
  });
});
