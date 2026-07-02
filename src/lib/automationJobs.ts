import { supabase } from '@/lib/supabase';

// ---------------------------------------------------------------------------
// Types — mirror the DB schema
// ---------------------------------------------------------------------------

export type AutomationJobStatus = 'pending' | 'claimed' | 'completed' | 'failed' | 'dead_lettered';

export type AutomationJobKind =
  | 'bill_extract'
  | 'bank_sync'
  | 'receipt_sync'
  | 'xero_push'
  | 'bank_reconcile'
  | 'gmail_backfill'
  | 'gmail_mine'
  | 'bill_code'
  | 'coding_classify'
  | 'payment_record'
  | 'browser_collect';

export interface AutomationJob {
  id: string;
  organization_id: string;
  job_kind: string;
  source_kind: string | null;
  source_id: string | null;
  status: AutomationJobStatus;
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

export interface AutomationJobStep {
  id: string;
  job_id: string;
  step_name: string;
  status: 'started' | 'ok' | 'error' | 'skipped';
  started_at: string;
  finished_at: string | null;
  result: unknown;
  error: string | null;
}

export interface AutomationArtifact {
  id: string;
  job_id: string;
  kind: 'screenshot' | 'log' | 'payload_hash' | 'response_body' | 'db_proof';
  storage_path: string | null;
  payload_hash: string | null;
  metadata: unknown;
  created_at: string;
}

export interface AutomationDeadLetter {
  id: string;
  organization_id: string;
  original_job_id: string;
  job_kind: string;
  source_kind: string | null;
  source_id: string | null;
  last_error: string;
  payload: unknown;
  attempts: number;
  dead_lettered_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function unwrap<T>(label: string, data: T[] | null, error: { message: string } | null): T[] {
  if (error) throw new Error(`${label} failed: ${error.message}`);
  return (data ?? []) as T[];
}

function unwrapOne<T>(label: string, data: T | null, error: { message: string } | null): T {
  if (error) throw new Error(`${label} failed: ${error.message}`);
  return data as T;
}

// ---------------------------------------------------------------------------
// Enqueue — authenticated callers; goes through DEFINER RPC for org check
// ---------------------------------------------------------------------------

export interface EnqueueJobInput {
  organizationId: string;
  jobKind: AutomationJobKind | string;
  sourceKind?: string | null;
  sourceId?: string | null;
  priority?: number;
  runAfter?: Date;
  maxAttempts?: number;
  payload?: unknown;
}

export async function enqueueJob({
  organizationId,
  jobKind,
  sourceKind = null,
  sourceId = null,
  priority = 5,
  runAfter,
  maxAttempts = 3,
  payload = null,
}: EnqueueJobInput): Promise<AutomationJob> {
  const { data, error } = await supabase.rpc('enqueue_automation_job', {
    p_org_id: organizationId,
    p_job_kind: jobKind,
    p_source_kind: sourceKind,
    p_source_id: sourceId,
    p_priority: priority,
    p_run_after: runAfter ? runAfter.toISOString() : new Date().toISOString(),
    p_max_attempts: maxAttempts,
    p_payload: (payload ?? null) as never,
  });

  return unwrapOne<AutomationJob>('enqueueJob', data as unknown as AutomationJob, error);
}

// ---------------------------------------------------------------------------
// Reads — authenticated SELECT (RLS-scoped to org)
// ---------------------------------------------------------------------------

export async function listPendingJobs(
  organizationId: string,
  jobKind?: string,
): Promise<AutomationJob[]> {
  let q = supabase
    .from('automation_jobs')
    .select('*')
    .eq('organization_id', organizationId)
    .in('status', ['pending', 'failed'])
    .order('priority', { ascending: true })
    .order('run_after', { ascending: true });

  if (jobKind) q = q.eq('job_kind', jobKind);

  const { data, error } = await q;
  return unwrap<AutomationJob>('listPendingJobs', data as AutomationJob[] | null, error);
}

export async function listDeadLetters(organizationId: string): Promise<AutomationDeadLetter[]> {
  const { data, error } = await supabase
    .from('automation_dead_letters')
    .select('*')
    .eq('organization_id', organizationId)
    .is('resolved_at', null)
    .order('dead_lettered_at', { ascending: false });

  return unwrap<AutomationDeadLetter>(
    'listDeadLetters',
    data as AutomationDeadLetter[] | null,
    error,
  );
}

export async function listJobSteps(jobId: string): Promise<AutomationJobStep[]> {
  const { data, error } = await supabase
    .from('automation_job_steps')
    .select('*')
    .eq('job_id', jobId)
    .order('started_at', { ascending: true });

  return unwrap<AutomationJobStep>('listJobSteps', data as AutomationJobStep[] | null, error);
}
