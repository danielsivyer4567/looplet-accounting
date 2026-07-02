/**
 * _shared/automationJobs.ts — service-role helpers for the automation job queue.
 *
 * Consumed by: automation-worker (SC-02) and automation-watchdog (SC-03).
 * All writes go through SECURITY DEFINER RPCs (never direct table INSERT).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ---------------------------------------------------------------------------
// Types — mirror 0211_automation_jobs.sql
// ---------------------------------------------------------------------------

export type AutomationJobKind =
  | 'bill_extract'
  | 'bank_sync'
  | 'receipt_sync'
  | 'xero_push'
  | 'bank_reconcile'
  | 'gmail_backfill'
  | 'gmail_mine'
  | 'coding_classify'
  | 'payment_record'
  | 'browser_collect';

export interface AutomationJob {
  id: string;
  organization_id: string;
  job_kind: string;
  source_kind: string | null;
  source_id: string | null;
  status: 'pending' | 'claimed' | 'completed' | 'failed' | 'dead_lettered';
  priority: number;
  run_after: string;
  attempts: number;
  max_attempts: number;
  locked_at: string | null;
  locked_by: string | null;
  last_error: string | null;
  enqueued_at: string;
  enqueued_by: string | null;
  completed_at: string | null;
  payload: unknown;
}

export type StepStatus = 'started' | 'ok' | 'error' | 'skipped';

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

export function makeAdminClient(supabaseUrl: string, serviceKey: string): SupabaseClient {
  return createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ---------------------------------------------------------------------------
// RPC wrappers — service_role only
// ---------------------------------------------------------------------------

export async function claimJobs(
  admin: SupabaseClient,
  workerId: string,
  jobKinds: string[] | null = null,
  limit = 5,
): Promise<AutomationJob[]> {
  const { data, error } = await admin.rpc('claim_automation_jobs', {
    p_worker_id: workerId,
    p_job_kinds: jobKinds,
    p_limit: limit,
    p_lock_secs: 120,
  });
  if (error) throw new Error(`claim_automation_jobs: ${error.message}`);
  return (data ?? []) as AutomationJob[];
}

export async function completeJob(
  admin: SupabaseClient,
  jobId: string,
  workerId: string,
): Promise<void> {
  const { error } = await admin.rpc('complete_automation_job', {
    p_job_id: jobId,
    p_worker_id: workerId,
  });
  if (error) throw new Error(`complete_automation_job: ${error.message}`);
}

export async function failJob(
  admin: SupabaseClient,
  jobId: string,
  workerId: string,
  errorMsg: string,
  runAfter?: Date,
): Promise<AutomationJob> {
  const { data, error } = await admin.rpc('fail_automation_job', {
    p_job_id: jobId,
    p_worker_id: workerId,
    p_error: errorMsg,
    p_run_after: runAfter ? runAfter.toISOString() : null,
  });
  if (error) throw new Error(`fail_automation_job: ${error.message}`);
  return data as AutomationJob;
}

export async function deadLetterJob(
  admin: SupabaseClient,
  jobId: string,
  workerId: string,
  reason: string,
): Promise<void> {
  const { error } = await admin.rpc('dead_letter_automation_job', {
    p_job_id: jobId,
    p_worker_id: workerId,
    p_reason: reason,
  });
  if (error) throw new Error(`dead_letter_automation_job: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Step logging — never throws; failures are non-fatal (best-effort audit)
// ---------------------------------------------------------------------------

export async function logStep(
  admin: SupabaseClient,
  jobId: string,
  stepName: string,
  status: StepStatus,
  result: unknown = null,
  stepError: string | null = null,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await admin.from('automation_job_steps').insert({
    job_id: jobId,
    step_name: stepName,
    status,
    started_at: now,
    finished_at: now,
    result: result ?? null,
    error: stepError ?? null,
  });
  if (error) console.error(`logStep(${stepName}): ${error.message}`);
}
