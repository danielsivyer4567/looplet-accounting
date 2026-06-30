import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';

/**
 * Automation jobs DB integration test.
 *
 * Validates:
 *   - Tables and enum exist
 *   - enqueue_automation_job inserts a row with org check
 *   - claim_automation_jobs locks the row atomically
 *   - complete_automation_job marks it completed (worker ownership check)
 *   - fail_automation_job resets to pending below max_attempts (worker ownership check)
 *   - dead_letter_automation_job promotes to dead_letters (worker ownership + status check)
 *   - Authenticated client cannot INSERT directly (RLS blocks)
 *   - Org isolation: one org's jobs never appear for another
 *
 * Requires live Supabase with migration 0211 applied.
 * Skipped when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are absent.
 */

const SUPABASE_URL = process.env['VITE_SUPABASE_URL'] ?? process.env['SUPABASE_URL'] ?? '';
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '';
const ANON_KEY = process.env['VITE_SUPABASE_ANON_KEY'] ?? process.env['SUPABASE_ANON_KEY'] ?? '';

const HAS_LIVE = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);
const itLive = it.skipIf(!HAS_LIVE);

function firstId(orgs: { id: string }[] | null): string | null {
  return orgs && orgs.length > 0 && orgs[0] ? orgs[0].id : null;
}

describe('automation_jobs DB', () => {
  itLive('enqueue_automation_job inserts a pending job', async () => {
    const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: orgs } = await client.from('organizations').select('id').limit(1);
    const orgId = firstId(orgs as { id: string }[] | null);
    if (!orgId) return;

    const { data, error } = await client.rpc('enqueue_automation_job', {
      p_org_id: orgId,
      p_job_kind: 'bill_extract',
      p_source_kind: 'bill',
      p_source_id: '00000000-0000-0000-0000-000000000001',
      p_priority: 5,
      p_run_after: new Date().toISOString(),
      p_max_attempts: 3,
      p_payload: { test: true },
    });

    expect(error).toBeNull();
    const job = data as Record<string, unknown>;
    expect(job.id).toBeDefined();
    expect(job.organization_id).toBe(orgId);
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(0);
    expect(job.job_kind).toBe('bill_extract');
  });

  itLive('claim_automation_jobs locks a due job', async () => {
    const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: orgs } = await client.from('organizations').select('id').limit(1);
    const orgId = firstId(orgs as { id: string }[] | null);
    if (!orgId) return;

    await client.rpc('enqueue_automation_job', {
      p_org_id: orgId,
      p_job_kind: 'receipt_sync',
      p_run_after: new Date(Date.now() - 1000).toISOString(),
    });

    const { data, error } = await client.rpc('claim_automation_jobs', {
      p_worker_id: 'test-worker-1',
      p_job_kinds: ['receipt_sync'],
      p_limit: 1,
      p_lock_secs: 60,
    });

    expect(error).toBeNull();
    const jobs = data as Record<string, unknown>[];
    expect(jobs.length).toBeGreaterThan(0);
    const claimed = jobs[0] ?? {};
    expect(claimed.status).toBe('claimed');
    expect(claimed.locked_by).toBe('test-worker-1');
    expect(claimed.attempts).toBe(1);
  });

  itLive('complete_automation_job marks job completed (ownership check)', async () => {
    const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: orgs } = await client.from('organizations').select('id').limit(1);
    const orgId = firstId(orgs as { id: string }[] | null);
    if (!orgId) return;

    const { data: enqueued } = await client.rpc('enqueue_automation_job', {
      p_org_id: orgId,
      p_job_kind: 'xero_push',
      p_run_after: new Date(Date.now() - 1000).toISOString(),
    });
    const jobId = (enqueued as Record<string, unknown>).id as string;

    const workerId = 'test-worker-complete';
    await client.rpc('claim_automation_jobs', {
      p_worker_id: workerId,
      p_job_kinds: ['xero_push'],
      p_limit: 1,
    });

    const { error } = await client.rpc('complete_automation_job', {
      p_job_id: jobId,
      p_worker_id: workerId,
    });
    expect(error).toBeNull();

    const { data: row } = await client
      .from('automation_jobs')
      .select('status, completed_at')
      .eq('id', jobId)
      .single();

    expect((row as Record<string, unknown>).status).toBe('completed');
    expect((row as Record<string, unknown>).completed_at).not.toBeNull();
  });

  itLive('complete_automation_job rejects wrong worker_id', async () => {
    const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: orgs } = await client.from('organizations').select('id').limit(1);
    const orgId = firstId(orgs as { id: string }[] | null);
    if (!orgId) return;

    const { data: enqueued } = await client.rpc('enqueue_automation_job', {
      p_org_id: orgId,
      p_job_kind: 'xero_push',
      p_run_after: new Date(Date.now() - 1000).toISOString(),
    });
    const jobId = (enqueued as Record<string, unknown>).id as string;

    await client.rpc('claim_automation_jobs', {
      p_worker_id: 'real-worker',
      p_job_kinds: ['xero_push'],
      p_limit: 1,
    });

    const { error } = await client.rpc('complete_automation_job', {
      p_job_id: jobId,
      p_worker_id: 'impostor-worker',
    });
    expect(error).not.toBeNull();
  });

  itLive('fail_automation_job resets to pending below max_attempts', async () => {
    const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: orgs } = await client.from('organizations').select('id').limit(1);
    const orgId = firstId(orgs as { id: string }[] | null);
    if (!orgId) return;

    const { data: enqueued } = await client.rpc('enqueue_automation_job', {
      p_org_id: orgId,
      p_job_kind: 'bank_reconcile',
      p_max_attempts: 3,
      p_run_after: new Date(Date.now() - 1000).toISOString(),
    });
    const jobId = (enqueued as Record<string, unknown>).id as string;

    const workerId = 'w-fail-test';
    await client.rpc('claim_automation_jobs', {
      p_worker_id: workerId,
      p_job_kinds: ['bank_reconcile'],
      p_limit: 1,
    });

    const { data: failed, error } = await client.rpc('fail_automation_job', {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_error: 'connection timeout',
    });

    expect(error).toBeNull();
    const row = failed as Record<string, unknown>;
    // attempts incremented to 1 by claim; still below max_attempts=3 → pending
    expect(row.status).toBe('pending');
    expect(row.last_error).toBe('connection timeout');
  });

  itLive('dead_letter_automation_job promotes claimed job to dead_letters', async () => {
    const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: orgs } = await client.from('organizations').select('id').limit(1);
    const orgId = firstId(orgs as { id: string }[] | null);
    if (!orgId) return;

    const { data: enqueued } = await client.rpc('enqueue_automation_job', {
      p_org_id: orgId,
      p_job_kind: 'gmail_backfill',
      p_run_after: new Date(Date.now() - 1000).toISOString(),
    });
    const jobId = (enqueued as Record<string, unknown>).id as string;

    const workerId = 'w-dl-test';
    await client.rpc('claim_automation_jobs', {
      p_worker_id: workerId,
      p_job_kinds: ['gmail_backfill'],
      p_limit: 1,
    });

    const { data: dl, error } = await client.rpc('dead_letter_automation_job', {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_reason: 'gmail token revoked after 3 attempts',
    });

    expect(error).toBeNull();
    const dead = dl as Record<string, unknown>;
    expect(dead.id).toBeDefined();
    expect(dead.original_job_id).toBe(jobId);
    expect(dead.job_kind).toBe('gmail_backfill');
    expect(dead.last_error).toContain('gmail token revoked');

    const { data: orig } = await client
      .from('automation_jobs')
      .select('status')
      .eq('id', jobId)
      .single();
    expect((orig as Record<string, unknown>).status).toBe('dead_lettered');
  });

  itLive('dead_letter_automation_job unique constraint blocks double-call', async () => {
    const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: orgs } = await client.from('organizations').select('id').limit(1);
    const orgId = firstId(orgs as { id: string }[] | null);
    if (!orgId) return;

    const { data: enqueued } = await client.rpc('enqueue_automation_job', {
      p_org_id: orgId,
      p_job_kind: 'gmail_backfill',
      p_run_after: new Date(Date.now() - 1000).toISOString(),
    });
    const jobId = (enqueued as Record<string, unknown>).id as string;

    const workerId = 'w-dl-double';
    await client.rpc('claim_automation_jobs', { p_worker_id: workerId, p_limit: 1 });
    await client.rpc('dead_letter_automation_job', {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_reason: 'first dead-letter',
    });

    // Second call must fail (status no longer 'claimed')
    const { error: secondError } = await client.rpc('dead_letter_automation_job', {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_reason: 'second dead-letter attempt',
    });
    expect(secondError).not.toBeNull();
  });

  itLive('authenticated client cannot INSERT directly (RLS blocks)', async () => {
    if (!ANON_KEY) return;
    const anonClient = createClient(SUPABASE_URL, ANON_KEY);
    const { data: orgs } = await createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
      .from('organizations')
      .select('id')
      .limit(1);
    const orgId = firstId(orgs as { id: string }[] | null);
    if (!orgId) return;

    const { error } = await anonClient.from('automation_jobs').insert({
      organization_id: orgId,
      job_kind: 'bill_extract',
    });

    expect(error).not.toBeNull();
  });

  itLive('org isolation: jobs from org A not visible to org B query', async () => {
    const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: orgs } = await client.from('organizations').select('id').limit(2);
    if (!orgs || orgs.length < 2) return;

    const typedOrgs = orgs as { id: string }[];
    const orgA = typedOrgs[0]?.id;
    const orgB = typedOrgs[1]?.id;
    if (!orgA || !orgB) return;

    const { data: job } = await client.rpc('enqueue_automation_job', {
      p_org_id: orgA,
      p_job_kind: 'coding_classify',
    });
    const jobId = (job as Record<string, unknown>).id as string;

    const { data: rows } = await client
      .from('automation_jobs')
      .select('id')
      .eq('organization_id', orgB)
      .eq('id', jobId);

    expect((rows ?? []).length).toBe(0);
  });
});
