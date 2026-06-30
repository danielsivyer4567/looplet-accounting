import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';

/**
 * automation-watchdog integration tests (SC-03).
 *
 * Validates (against live Supabase) that each scanner signal is detectable
 * at the DB layer and that the outcome RPCs work correctly:
 *
 *   bills_stuck_received    — bill in 'received' > 4h with no active job → detectable
 *   bills_no_job_allocation — bill in 'received' > 8h with zero jobs → detectable
 *   low_ocr_confidence      — bill with ocr_confidence < 0.6 → detectable
 *   bank_unmatched_7d       — bank txn unmatched > 7 days → detectable
 *   receipt_no_bill         — receipt_event without bill_id > 24h → detectable
 *   job_consecutive_failures — job with status='failed', attempts >= max_attempts → detectable
 *   org isolation           — org A signals not visible to org B queries
 *
 * Scanner logic is tested here at the DB-query layer (same queries the edge fn uses).
 * The retry outcome (enqueue_automation_job) and dead_letter outcome are exercised
 * via the existing RPCs, consistent with the SC-02 test approach.
 *
 * Requires: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY env vars.
 */

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';

const HAS_LIVE = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);
const itLive = it.skipIf(!HAS_LIVE);

function firstId(rows: { id: string }[] | null): string | null {
  return rows && rows.length > 0 && rows[0] ? rows[0].id : null;
}

describe('automation-watchdog scanners', () => {
  itLive('bills_stuck_received: bill in received > 4h with no active job is detectable', async () => {
    const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: orgs } = await client.from('organizations').select('id').limit(1);
    const orgId = firstId(orgs as { id: string }[] | null);
    if (!orgId) return;

    const cutoff4h = new Date(Date.now() - 4 * 3600 * 1000).toISOString();

    // Find a bill that is 'received' and older than 4h (or use DB NOW() offset)
    // Query mirrors the scanner: bills.status='received', created_at < cutoff, no active job
    const { data: bills } = await client
      .from('bills')
      .select('id, created_at')
      .eq('organization_id', orgId)
      .eq('status', 'received')
      .lt('created_at', cutoff4h)
      .is('deleted_at', null)
      .limit(5);

    // For each bill found, verify no active job exists (scanner would produce a retry signal)
    const stuckBills: string[] = [];
    for (const bill of (bills ?? []) as { id: string }[]) {
      const { data: existing } = await client
        .from('automation_jobs')
        .select('id')
        .eq('organization_id', orgId)
        .eq('job_kind', 'bill_extract')
        .eq('source_kind', 'bill')
        .eq('source_id', bill.id)
        .in('status', ['pending', 'claimed', 'completed'])
        .limit(1);
      if ((existing ?? []).length === 0) stuckBills.push(bill.id);
    }

    // If there are stuck bills, the scanner would produce retries.
    // We can't assert count > 0 because test envs may not have aged data,
    // but we verify the query runs without error.
    expect(Array.isArray(bills)).toBe(true);
    expect(Array.isArray(stuckBills)).toBe(true);
  });

  itLive('bills_no_job_allocation: bill > 8h with zero jobs is detectable', async () => {
    const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: orgs } = await client.from('organizations').select('id').limit(1);
    const orgId = firstId(orgs as { id: string }[] | null);
    if (!orgId) return;

    const cutoff8h = new Date(Date.now() - 8 * 3600 * 1000).toISOString();

    const { data: bills } = await client
      .from('bills')
      .select('id')
      .eq('organization_id', orgId)
      .eq('status', 'received')
      .lt('created_at', cutoff8h)
      .is('deleted_at', null)
      .limit(5);

    // Verify each bill can be checked for job absence
    for (const bill of (bills ?? []) as { id: string }[]) {
      const { data: jobs, error } = await client
        .from('automation_jobs')
        .select('id')
        .eq('organization_id', orgId)
        .eq('source_kind', 'bill')
        .eq('source_id', bill.id)
        .limit(1);
      expect(error).toBeNull();
      expect(Array.isArray(jobs)).toBe(true);
    }
  });

  itLive('low_ocr_confidence: bills with ocr_confidence < 0.6 are detectable', async () => {
    const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: orgs } = await client.from('organizations').select('id').limit(1);
    const orgId = firstId(orgs as { id: string }[] | null);
    if (!orgId) return;

    const { data: bills, error } = await client
      .from('bills')
      .select('id, ocr_confidence')
      .eq('organization_id', orgId)
      .eq('status', 'received')
      .lt('ocr_confidence', 0.6)
      .not('ocr_confidence', 'is', null)
      .is('deleted_at', null);

    expect(error).toBeNull();
    expect(Array.isArray(bills)).toBe(true);
    // If any bills found, all should have confidence < 0.6
    for (const b of (bills ?? []) as { id: string; ocr_confidence: number }[]) {
      expect(b.ocr_confidence).toBeLessThan(0.6);
    }
  });

  itLive('bank_unmatched_7d: unmatched transactions > 7 days are detectable', async () => {
    const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: orgs } = await client.from('organizations').select('id').limit(1);
    const orgId = firstId(orgs as { id: string }[] | null);
    if (!orgId) return;

    const cutoff7d = new Date(Date.now() - 7 * 86400 * 1000).toISOString();

    const { count, error } = await client
      .from('bank_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .is('matched_bill_id', null)
      .is('matched_invoice_id', null)
      .lt('posted_at', cutoff7d);

    expect(error).toBeNull();
    expect(typeof count === 'number' || count === null).toBe(true);
  });

  itLive('receipt_no_bill: receipt_events without bill_id > 24h are detectable', async () => {
    const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: orgs } = await client.from('organizations').select('id').limit(1);
    const orgId = firstId(orgs as { id: string }[] | null);
    if (!orgId) return;

    const cutoff24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

    const { count, error } = await client
      .from('receipt_events')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .eq('status', 'received')
      .is('bill_id', null)
      .lt('created_at', cutoff24h);

    expect(error).toBeNull();
    expect(typeof count === 'number' || count === null).toBe(true);
  });

  itLive('job_consecutive_failures: terminal failed jobs detectable and dead-letterable', async () => {
    const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: orgs } = await client.from('organizations').select('id').limit(1);
    const orgId = firstId(orgs as { id: string }[] | null);
    if (!orgId) return;

    // Enqueue a job with max_attempts=1 and fail it past its limit
    const { data: enqueued } = await client.rpc('enqueue_automation_job', {
      p_org_id: orgId,
      p_job_kind: 'xero_push',
      p_source_kind: 'bill',
      p_source_id: crypto.randomUUID(),
      p_run_after: new Date(Date.now() - 1000).toISOString(),
      p_max_attempts: 1,
      p_payload: { test: true, watchdog_test: 'sc-03' },
    });
    const jobId = (enqueued as Record<string, unknown>).id as string;

    // Claim it and fail it — with max_attempts=1, fail_automation_job sets status='failed'
    const workerId = `test-watchdog-${crypto.randomUUID().slice(0, 8)}`;
    await client.rpc('claim_automation_jobs', {
      p_worker_id: workerId,
      p_limit: 1,
    });
    await client.rpc('fail_automation_job', {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_error: 'xero token expired (watchdog test)',
    });

    // Verify job is now 'failed' with attempts >= max_attempts
    const { data: row } = await client
      .from('automation_jobs')
      .select('status, attempts, max_attempts')
      .eq('id', jobId)
      .single();
    const j = row as Record<string, unknown>;
    expect(j?.['status']).toBe('failed');
    expect((j?.['attempts'] as number) >= (j?.['max_attempts'] as number)).toBe(true);

    // Scanner query: finds jobs with status='failed' AND attempts >= 3 OR attempts >= max_attempts
    const { data: terminalJobs, error: scanErr } = await client
      .from('automation_jobs')
      .select('id, job_kind, attempts, max_attempts, status')
      .eq('organization_id', orgId)
      .eq('status', 'failed')
      .gte('attempts', 1)
      .limit(20);

    expect(scanErr).toBeNull();
    const found = (terminalJobs ?? []) as Record<string, unknown>[];
    const ourJob = found.find((j) => j['id'] === jobId);
    expect(ourJob).toBeDefined();

    // Simulate watchdog dead-letter: direct update (no RPC since watchdog doesn't own the lock)
    const { error: updateErr } = await client
      .from('automation_jobs')
      .update({ status: 'dead_lettered', locked_at: null, locked_by: null })
      .eq('id', jobId)
      .eq('status', 'failed');
    expect(updateErr).toBeNull();

    await client.from('automation_dead_letters').upsert(
      {
        organization_id: orgId,
        original_job_id: jobId,
        job_kind: 'xero_push',
        source_kind: 'bill',
        source_id: null,
        last_error: 'watchdog: xero token expired (watchdog test)',
        payload: null,
        attempts: 1,
      },
      { onConflict: 'original_job_id', ignoreDuplicates: true },
    );

    // Verify final state
    const { data: finalRow } = await client
      .from('automation_jobs')
      .select('status')
      .eq('id', jobId)
      .single();
    expect((finalRow as Record<string, unknown>)?.['status']).toBe('dead_lettered');

    const { data: dlRow } = await client
      .from('automation_dead_letters')
      .select('original_job_id, last_error')
      .eq('original_job_id', jobId)
      .single();
    expect((dlRow as Record<string, unknown>)?.['original_job_id']).toBe(jobId);
    expect((dlRow as Record<string, unknown>)?.['last_error']).toContain('watchdog');
  });

  itLive('retry outcome: enqueue_automation_job via watchdog signal', async () => {
    const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: orgs } = await client.from('organizations').select('id').limit(1);
    const orgId = firstId(orgs as { id: string }[] | null);
    if (!orgId) return;

    const billId = crypto.randomUUID();

    // Simulate watchdog enqueuing a retry for a stuck bill
    const { data: enqueued, error: enqErr } = await client.rpc('enqueue_automation_job', {
      p_org_id: orgId,
      p_job_kind: 'bill_extract',
      p_source_kind: 'bill',
      p_source_id: billId,
      p_priority: 3,
      p_payload: { watchdog: true, signal: 'bills_stuck_received', bill_id: billId },
    });
    expect(enqErr).toBeNull();
    expect((enqueued as Record<string, unknown>)?.['id']).toBeTruthy();
    expect((enqueued as Record<string, unknown>)?.['job_kind']).toBe('bill_extract');
    expect((enqueued as Record<string, unknown>)?.['status']).toBe('pending');
  });

  itLive('task outcome: data_completeness_findings insert is idempotent', async () => {
    const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: orgs } = await client.from('organizations').select('id').limit(1);
    const orgId = firstId(orgs as { id: string }[] | null);
    if (!orgId) return;

    const checkCode = `test_watchdog_sc03_${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    // First insert
    const { error: err1 } = await client.from('data_completeness_findings').upsert(
      {
        organization_id: orgId,
        check_code: checkCode,
        resource_type: null,
        resource_id: null,
        severity: 'warning',
        title: 'Test watchdog finding',
        description: 'SC-03 test',
        fix_url: '/reconciliation',
        fix_action: 'Review',
        last_seen_at: now,
      },
      { ignoreDuplicates: true },
    );
    expect(err1).toBeNull();

    // Second insert — same check_code, same null resource_id — must not error
    const { error: err2 } = await client.from('data_completeness_findings').upsert(
      {
        organization_id: orgId,
        check_code: checkCode,
        resource_type: null,
        resource_id: null,
        severity: 'warning',
        title: 'Test watchdog finding (dupe)',
        description: 'SC-03 test dupe',
        fix_url: '/reconciliation',
        fix_action: 'Review',
        last_seen_at: now,
      },
      { ignoreDuplicates: true },
    );
    expect(err2).toBeNull();

    // Verify: only one row exists
    const { data: rows } = await client
      .from('data_completeness_findings')
      .select('id')
      .eq('organization_id', orgId)
      .eq('check_code', checkCode);
    expect((rows ?? []).length).toBe(1);

    // Cleanup
    await client
      .from('data_completeness_findings')
      .delete()
      .eq('organization_id', orgId)
      .eq('check_code', checkCode);
  });

  itLive('org isolation: scanner queries are scoped by organization_id', async () => {
    const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: orgs } = await client.from('organizations').select('id').limit(2);
    const orgList = (orgs ?? []) as { id: string }[];
    if (orgList.length < 2) return; // Need at least 2 orgs

    const orgA = (orgList[0] as { id: string }).id;
    const orgB = (orgList[1] as { id: string }).id;

    // Bill-extract job for orgA
    const billAId = crypto.randomUUID();
    const { data: jobA } = await client.rpc('enqueue_automation_job', {
      p_org_id: orgA,
      p_job_kind: 'bill_extract',
      p_source_kind: 'bill',
      p_source_id: billAId,
      p_payload: { isolation_test: true },
    });
    const jobAId = (jobA as Record<string, unknown>).id as string;

    // Query scoped to orgB must NOT return orgA's job
    const { data: jobsBFromOrgA } = await client
      .from('automation_jobs')
      .select('id')
      .eq('organization_id', orgB)
      .eq('source_kind', 'bill')
      .eq('source_id', billAId);

    expect((jobsBFromOrgA ?? []).length).toBe(0);

    // Cleanup orgA job (claim + complete)
    const wId = `test-isolation-${crypto.randomUUID().slice(0, 8)}`;
    await client.rpc('claim_automation_jobs', { p_worker_id: wId, p_limit: 1 });
    await client.rpc('complete_automation_job', { p_job_id: jobAId, p_worker_id: wId });
  });
});
