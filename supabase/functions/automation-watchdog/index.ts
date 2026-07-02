/**
 * automation-watchdog — background scanner that detects anomalies and heals.
 *
 * Auth: service-role bearer OR ?secret=AUTOMATION_WATCHDOG_SECRET (fail closed).
 * Deployed --no-verify-jwt so pg_cron can drive it.
 *
 * Signals + outcomes (per org):
 *   bills_stuck_received      → retry   enqueue bill_extract (bills in 'received' > 4h, no active job)
 *   bills_no_job_allocation   → retry   enqueue bill_extract (bills in 'received' > 8h, zero jobs ever)
 *   low_ocr_confidence        → task    warning: OCR confidence < 0.6 on a received bill
 *   bank_unmatched_7d         → task    warning: bank transactions unmatched > 7 days
 *   receipt_no_bill           → task    warning: receipt_events without bill_id > 24h
 *   xero_push_dead_letter     → task    critical: dead-lettered xero_push needing reconnect
 *   gmail_watch_stale         → task    info: gmail silent > 6h (blocked_external, never actioned)
 *   bas_coverage_gap          → task    info: books health blocking BAS (blocked_external)
 *   payroll_super_overdue     → task    warning: payroll/super obligation overdue
 *   job_consecutive_failures  → dead_letter + task: failed jobs at max_attempts get dead-lettered
 *   claimed_lock_expired      → reap (or dead_letter if attempts exhausted): a worker claimed a job
 *                               and never completed/failed it (crash, timeout, cold-start kill).
 *                               claim_automation_jobs only ever re-claims status='pending' rows, so a
 *                               stale 'claimed' row is otherwise stuck forever.
 *   pending_starvation        → task    critical: a known, worker-claimable job_kind has jobs stuck
 *                               in 'pending' well past their run_after — the drainer isn't keeping up
 *                               (or isn't running at all).
 *   unreachable_job_kind      → task    critical: a job_kind outside the worker's claimable set (and
 *                               outside the explicitly-excluded set, e.g. browser_collect) is sitting
 *                               in 'pending' — it will NEVER be claimed until code changes, unlike
 *                               pending_starvation which is a capacity/uptime problem.
 *
 * ATO/DSP/SBR lodgement is NEVER actioned — surfaced as blocked_external findings only.
 *
 * Output: { ok, stats: { orgs_scanned, retries_enqueued, tasks_created, dead_lettered, locks_reaped, errors[] } }
 */

import { corsHeaders, preflight } from '../_shared/cors.ts';
import { makeAdminClient } from '../_shared/automationJobs.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OutcomeKind = 'retry' | 'task' | 'blocked_external' | 'dead_letter' | 'reap';
type FindingSeverity = 'info' | 'warning' | 'critical';

// Mirrors automation-worker's DEFAULT_JOB_KINDS + the one kind it deliberately excludes
// (browser_collect, owned by a dedicated runner — see automation-worker/index.ts).
// Kept as a literal list (not shared code) so automation-worker's own contract test can
// keep asserting against its own literal source; automation-backbone-contract.test.ts
// cross-checks these two lists stay in sync.
const KNOWN_CLAIMABLE_JOB_KINDS = [
  'bill_extract',
  'bank_sync',
  'receipt_sync',
  'xero_push',
  'bank_reconcile',
  'gmail_backfill',
  'gmail_mine',
  'coding_classify',
  'payment_record',
] as const;
const KNOWN_EXCLUDED_JOB_KINDS = ['browser_collect'] as const;
const ALL_KNOWN_JOB_KINDS: readonly string[] = [
  ...KNOWN_CLAIMABLE_JOB_KINDS,
  ...KNOWN_EXCLUDED_JOB_KINDS,
];

// A claim's lock (p_lock_secs=120 in claim_automation_jobs) is the worker's own retry
// window; this is a generous multiple of it so a slow-but-alive dispatch isn't reaped
// out from under a worker that's still running.
const LOCK_EXPIRY_SECS = 300;
// Worker cron runs every 2 minutes; 5 missed cycles is a solid signal something is wrong.
const PENDING_STARVATION_MINUTES = 10;
// Unreachable-kind jobs never get claimed regardless of backlog, so a short window is enough.
const UNREACHABLE_KIND_MINUTES = 15;

interface ScanResult {
  kind: OutcomeKind;
  org_id: string;
  signal: string;
  resource_type?: string;
  resource_id?: string;
  detail: Record<string, unknown>;
}

interface WatchdogStats {
  orgs_scanned: number;
  retries_enqueued: number;
  tasks_created: number;
  dead_lettered: number;
  locks_reaped: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Scanners — each returns ScanResult[]
// ---------------------------------------------------------------------------

/** Bills stuck in 'received' > 4h with no active or completed bill_extract job. */
async function scanBillsStuckReceived(admin: SupabaseClient, orgId: string): Promise<ScanResult[]> {
  const cutoff = new Date(Date.now() - 4 * 3600 * 1000).toISOString();
  const { data: bills } = await admin
    .from('bills')
    .select('id, created_at')
    .eq('organization_id', orgId)
    .eq('status', 'received')
    .lt('created_at', cutoff)
    .is('deleted_at', null);

  const results: ScanResult[] = [];
  for (const bill of (bills ?? []) as { id: string; created_at: string }[]) {
    const { data: existing } = await admin
      .from('automation_jobs')
      .select('id')
      .eq('organization_id', orgId)
      .eq('job_kind', 'bill_extract')
      .eq('source_kind', 'bill')
      .eq('source_id', bill.id)
      .in('status', ['pending', 'claimed', 'completed'])
      .limit(1);
    if ((existing ?? []).length > 0) continue;

    results.push({
      kind: 'retry',
      org_id: orgId,
      signal: 'bills_stuck_received',
      resource_type: 'bill',
      resource_id: bill.id,
      detail: { bill_id: bill.id, created_at: bill.created_at, threshold_hours: 4 },
    });
  }
  return results;
}

/** Bills in 'received' > 8h with zero automation jobs of any kind ever. */
async function scanBillsNoJobAllocation(admin: SupabaseClient, orgId: string): Promise<ScanResult[]> {
  const cutoff = new Date(Date.now() - 8 * 3600 * 1000).toISOString();
  const { data: bills } = await admin
    .from('bills')
    .select('id, created_at')
    .eq('organization_id', orgId)
    .eq('status', 'received')
    .lt('created_at', cutoff)
    .is('deleted_at', null);

  const results: ScanResult[] = [];
  for (const bill of (bills ?? []) as { id: string; created_at: string }[]) {
    const { data: jobs } = await admin
      .from('automation_jobs')
      .select('id')
      .eq('organization_id', orgId)
      .eq('source_kind', 'bill')
      .eq('source_id', bill.id)
      .limit(1);
    if ((jobs ?? []).length > 0) continue;

    results.push({
      kind: 'retry',
      org_id: orgId,
      signal: 'bills_no_job_allocation',
      resource_type: 'bill',
      resource_id: bill.id,
      detail: { bill_id: bill.id, created_at: bill.created_at, threshold_hours: 8 },
    });
  }
  return results;
}

/** Bills with ocr_confidence < 0.6 that are still in 'received'. */
async function scanLowOcrConfidence(admin: SupabaseClient, orgId: string): Promise<ScanResult[]> {
  const { data: bills } = await admin
    .from('bills')
    .select('id, ocr_confidence, created_at')
    .eq('organization_id', orgId)
    .eq('status', 'received')
    .lt('ocr_confidence', 0.6)
    .not('ocr_confidence', 'is', null)
    .is('deleted_at', null);

  return ((bills ?? []) as { id: string; ocr_confidence: number; created_at: string }[]).map((b) => ({
    kind: 'task' as OutcomeKind,
    org_id: orgId,
    signal: 'low_ocr_confidence',
    resource_type: 'bill',
    resource_id: b.id,
    detail: { bill_id: b.id, ocr_confidence: b.ocr_confidence },
  }));
}

/** Bank transactions with no match that are > 7 days old. */
async function scanBankUnmatched7d(admin: SupabaseClient, orgId: string): Promise<ScanResult[]> {
  const cutoff = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  const { count } = await admin
    .from('bank_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .is('matched_bill_id', null)
    .is('matched_invoice_id', null)
    .lt('posted_at', cutoff);

  if (!count || count === 0) return [];
  return [{
    kind: 'task',
    org_id: orgId,
    signal: 'bank_unmatched_7d',
    detail: { count, threshold_days: 7 },
  }];
}

/** receipt_events without a linked bill_id that are > 24h old. */
async function scanReceiptsNoBill(admin: SupabaseClient, orgId: string): Promise<ScanResult[]> {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count } = await admin
    .from('receipt_events')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', orgId)
    .eq('status', 'received')
    .is('bill_id', null)
    .lt('created_at', cutoff);

  if (!count || count === 0) return [];
  return [{
    kind: 'task',
    org_id: orgId,
    signal: 'receipt_no_bill',
    detail: { count, threshold_hours: 24 },
  }];
}

/** Dead-lettered xero_push jobs that haven't been resolved. */
async function scanXeroPushDeadLetters(admin: SupabaseClient, orgId: string): Promise<ScanResult[]> {
  const { data: dls } = await admin
    .from('automation_dead_letters')
    .select('id, original_job_id, last_error, dead_lettered_at')
    .eq('organization_id', orgId)
    .eq('job_kind', 'xero_push')
    .is('resolved_at', null)
    .order('dead_lettered_at', { ascending: false })
    .limit(10);

  return ((dls ?? []) as {
    id: string;
    original_job_id: string;
    last_error: string;
    dead_lettered_at: string;
  }[]).map((dl) => ({
    kind: 'task' as OutcomeKind,
    org_id: orgId,
    signal: 'xero_push_dead_letter',
    resource_type: 'automation_dead_letter',
    resource_id: dl.original_job_id,
    detail: {
      dead_letter_id: dl.id,
      error: dl.last_error,
      dead_lettered_at: dl.dead_lettered_at,
    },
  }));
}

/** Gmail integrations that haven't synced in > 6h — watch may have lapsed. */
async function scanGmailWatchStaleness(admin: SupabaseClient, orgId: string): Promise<ScanResult[]> {
  const cutoff = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  const { data: integrations } = await admin
    .from('gmail_integrations')
    .select('id, last_synced_at')
    .eq('organization_id', orgId)
    .eq('is_active', true)
    .lt('last_synced_at', cutoff);

  return ((integrations ?? []) as { id: string; last_synced_at: string }[]).map((i) => ({
    kind: 'blocked_external' as OutcomeKind,
    org_id: orgId,
    signal: 'gmail_watch_stale',
    resource_type: 'gmail_integration',
    resource_id: i.id,
    detail: { integration_id: i.id, last_synced_at: i.last_synced_at, threshold_hours: 6 },
  }));
}

/** Books health score below 80 — blocking BAS preparation (ATO-adjacent, blocked_external). */
async function scanBasCoverageGap(admin: SupabaseClient, orgId: string): Promise<ScanResult[]> {
  const { data: health } = await admin
    .from('v_books_health')
    .select('score, blocking, uncoded_count, coverage_pct')
    .eq('organization_id', orgId)
    .eq('blocking', true)
    .limit(1);

  const healthArr = (health ?? []) as { score: number; uncoded_count: number; coverage_pct: number }[]
  if (!healthArr.length) return [];
  const h = healthArr[0];
  if (!h) return [];
  return [{
    kind: 'blocked_external',
    org_id: orgId,
    signal: 'bas_coverage_gap',
    detail: { score: h.score, uncoded_count: h.uncoded_count, coverage_pct: h.coverage_pct },
  }];
}

/** Payroll/super obligations from v_tax_calendar that are overdue. */
async function scanPayrollSuperOverdue(admin: SupabaseClient, orgId: string): Promise<ScanResult[]> {
  const { data: obligations } = await admin
    .from('v_tax_calendar')
    .select('obligation_key, title, period_label, due_date, days_until_due')
    .eq('organization_id', orgId)
    .in('obligation_key', ['payg_w_ias', 'sgc_q', 'payroll_tax'])
    .lt('days_until_due', 0);

  return ((obligations ?? []) as {
    obligation_key: string;
    title: string;
    period_label: string;
    due_date: string;
    days_until_due: number;
  }[]).map((o) => ({
    kind: 'task' as OutcomeKind,
    org_id: orgId,
    signal: 'payroll_super_overdue',
    detail: {
      obligation_key: o.obligation_key,
      title: o.title,
      period_label: o.period_label,
      due_date: o.due_date,
      days_overdue: Math.abs(o.days_until_due),
    },
  }));
}

/**
 * Jobs stuck in 'failed' with attempts >= max_attempts.
 * The worker sets status='failed' when attempts >= max_attempts instead of dead-lettering
 * (dead-lettering requires being the owning worker). The watchdog finishes the job off.
 */
async function scanJobConsecutiveFailures(admin: SupabaseClient, orgId: string): Promise<ScanResult[]> {
  const { data: jobs } = await admin
    .from('automation_jobs')
    .select('id, job_kind, source_kind, source_id, attempts, max_attempts, last_error')
    .eq('organization_id', orgId)
    .eq('status', 'failed')
    .gte('attempts', 3)
    .order('attempts', { ascending: false })
    .limit(20);

  return ((jobs ?? []) as {
    id: string;
    job_kind: string;
    source_kind: string | null;
    source_id: string | null;
    attempts: number;
    max_attempts: number;
    last_error: string | null;
  }[])
    .filter((j) => j.attempts >= j.max_attempts)
    .map((j) => ({
      kind: 'dead_letter' as OutcomeKind,
      org_id: orgId,
      signal: 'job_consecutive_failures',
      resource_type: 'automation_job',
      resource_id: j.id,
      detail: {
        job_id: j.id,
        job_kind: j.job_kind,
        attempts: j.attempts,
        max_attempts: j.max_attempts,
        last_error: j.last_error,
      },
    }));
}

/**
 * Jobs stuck in 'claimed' whose lock has expired (worker crashed/timed out mid-run).
 * claim_automation_jobs only re-claims status='pending' rows, so a stale 'claimed' row
 * is otherwise invisible to every other scanner and sits forever.
 */
async function scanLockExpiry(admin: SupabaseClient, orgId: string): Promise<ScanResult[]> {
  const cutoff = new Date(Date.now() - LOCK_EXPIRY_SECS * 1000).toISOString();
  const { data: jobs } = await admin
    .from('automation_jobs')
    .select('id, job_kind, attempts, max_attempts, locked_by, locked_at')
    .eq('organization_id', orgId)
    .eq('status', 'claimed')
    .lt('locked_at', cutoff);

  return (
    (jobs ?? []) as {
      id: string;
      job_kind: string;
      attempts: number;
      max_attempts: number;
      locked_by: string | null;
      locked_at: string;
    }[]
  ).map((j) => ({
    kind: j.attempts >= j.max_attempts ? 'dead_letter' : 'reap',
    org_id: orgId,
    signal: 'claimed_lock_expired',
    resource_type: 'automation_job',
    resource_id: j.id,
    detail: {
      job_id: j.id,
      job_kind: j.job_kind,
      locked_by: j.locked_by,
      locked_at: j.locked_at,
      attempts: j.attempts,
      max_attempts: j.max_attempts,
      last_error: 'expired lock — worker crashed or timed out',
    },
  }));
}

/**
 * Known, worker-claimable job_kinds with jobs still 'pending' well past their run_after.
 * Signals the drainer isn't keeping up (or the cron isn't running at all) — distinct from
 * unreachable_job_kind, which is a code-contract gap rather than a capacity/uptime one.
 */
async function scanPendingStarvation(admin: SupabaseClient, orgId: string): Promise<ScanResult[]> {
  const cutoff = new Date(Date.now() - PENDING_STARVATION_MINUTES * 60 * 1000).toISOString();
  const { data: jobs } = await admin
    .from('automation_jobs')
    .select('job_kind')
    .eq('organization_id', orgId)
    .eq('status', 'pending')
    .in('job_kind', [...KNOWN_CLAIMABLE_JOB_KINDS])
    .lt('run_after', cutoff);

  const counts = new Map<string, number>();
  for (const j of (jobs ?? []) as { job_kind: string }[]) {
    counts.set(j.job_kind, (counts.get(j.job_kind) ?? 0) + 1);
  }

  return [...counts.entries()].map(([jobKind, count]) => ({
    kind: 'task' as OutcomeKind,
    org_id: orgId,
    signal: 'pending_starvation',
    resource_type: 'automation_job_kind',
    resource_id: jobKind,
    detail: { job_kind: jobKind, count, threshold_minutes: PENDING_STARVATION_MINUTES },
  }));
}

/**
 * Jobs whose job_kind is outside both the worker's claimable set and the explicitly
 * excluded set (browser_collect). These will NEVER be claimed until code changes —
 * a config-drift / dead-handler bug, not a backlog.
 */
async function scanUnreachableJobKinds(admin: SupabaseClient, orgId: string): Promise<ScanResult[]> {
  const cutoff = new Date(Date.now() - UNREACHABLE_KIND_MINUTES * 60 * 1000).toISOString();
  const { data: jobs } = await admin
    .from('automation_jobs')
    .select('job_kind')
    .eq('organization_id', orgId)
    .eq('status', 'pending')
    .lt('run_after', cutoff);

  const counts = new Map<string, number>();
  for (const j of (jobs ?? []) as { job_kind: string }[]) {
    if (ALL_KNOWN_JOB_KINDS.includes(j.job_kind)) continue;
    counts.set(j.job_kind, (counts.get(j.job_kind) ?? 0) + 1);
  }

  return [...counts.entries()].map(([jobKind, count]) => ({
    kind: 'task' as OutcomeKind,
    org_id: orgId,
    signal: 'unreachable_job_kind',
    resource_type: 'automation_job_kind',
    resource_id: jobKind,
    detail: { job_kind: jobKind, count, threshold_minutes: UNREACHABLE_KIND_MINUTES },
  }));
}

// ---------------------------------------------------------------------------
// Outcome handlers
// ---------------------------------------------------------------------------

async function handleRetry(admin: SupabaseClient, result: ScanResult): Promise<void> {
  const jobKindMap: Record<string, string> = {
    bills_stuck_received: 'bill_extract',
    bills_no_job_allocation: 'bill_extract',
  };
  await admin.rpc('enqueue_automation_job', {
    p_org_id: result.org_id,
    p_job_kind: jobKindMap[result.signal] ?? 'bill_extract',
    p_source_kind: result.resource_type ?? null,
    p_source_id: result.resource_id ?? null,
    p_priority: 3,
    p_payload: { watchdog: true, signal: result.signal, ...result.detail },
  });
}

async function handleTask(
  admin: SupabaseClient,
  result: ScanResult,
  severity: FindingSeverity,
): Promise<void> {
  const titleMap: Record<string, string> = {
    low_ocr_confidence: 'Low OCR confidence — review extraction',
    bank_unmatched_7d: 'Bank transactions unmatched for 7+ days',
    receipt_no_bill: 'Receipts without linked bill',
    xero_push_dead_letter: 'Xero push failed — reconnect required',
    payroll_super_overdue: `Payroll/super overdue`,
    job_consecutive_failures: 'Automation job failing repeatedly',
    gmail_watch_stale: 'Gmail watch silent — may need renewal',
    bas_coverage_gap: 'Books health blocking BAS preparation',
    claimed_lock_expired: 'Automation job stuck — worker crashed mid-run',
    pending_starvation: 'Automation queue backing up',
    unreachable_job_kind: 'Automation job type is never processed',
  };

  const descMap: Record<string, string> = {
    low_ocr_confidence: `Bill extraction confidence below 0.6 — manual review recommended`,
    bank_unmatched_7d: `${result.detail['count'] ?? 'Some'} bank transactions have no match for 7+ days`,
    receipt_no_bill: `${result.detail['count'] ?? 'Some'} receipts have no linked bill or audit package`,
    xero_push_dead_letter: `Xero push dead-lettered: ${result.detail['error'] ?? 'unknown error'}`,
    payroll_super_overdue: `${result.detail['title']} — ${result.detail['days_overdue']} day(s) overdue`,
    job_consecutive_failures: `Job ${result.detail['job_kind']} has failed ${result.detail['attempts']} time(s)`,
    gmail_watch_stale: `Gmail integration silent since ${result.detail['last_synced_at']}`,
    bas_coverage_gap: `Books score ${result.detail['score']}/100 — ${result.detail['uncoded_count']} uncoded transactions`,
    claimed_lock_expired: `Job ${result.detail['job_kind']} (${result.detail['job_id']}) dead-lettered after its worker lock expired with no retries left`,
    pending_starvation: `${result.detail['count']} ${result.detail['job_kind']} job(s) pending more than ${result.detail['threshold_minutes']} minutes — the worker cron may be down`,
    unreachable_job_kind: `${result.detail['count']} job(s) of kind "${result.detail['job_kind']}" have no worker handler — they will never run`,
  };

  const fixUrlMap: Record<string, string> = {
    low_ocr_confidence: result.resource_id ? `/bills/${result.resource_id}` : '/bills',
    bank_unmatched_7d: '/reconciliation',
    receipt_no_bill: '/bills',
    xero_push_dead_letter: '/settings/integrations',
    payroll_super_overdue: '/tax',
    job_consecutive_failures: '/settings/automation',
    gmail_watch_stale: '/settings/integrations',
    bas_coverage_gap: '/reconciliation',
    claimed_lock_expired: '/settings/automation',
    pending_starvation: '/settings/automation',
    unreachable_job_kind: '/settings/automation',
  };

  // Use INSERT ... ON CONFLICT DO NOTHING — safe with the functional unique index
  await admin.from('data_completeness_findings').upsert(
    {
      organization_id: result.org_id,
      check_code: result.signal,
      resource_type: result.resource_type ?? null,
      resource_id: result.resource_id ?? null,
      severity,
      title: titleMap[result.signal] ?? result.signal,
      description: descMap[result.signal] ?? JSON.stringify(result.detail).slice(0, 200),
      fix_url: fixUrlMap[result.signal] ?? null,
      fix_action: 'Review and resolve',
      last_seen_at: new Date().toISOString(),
    },
    { ignoreDuplicates: true },
  );
}

/**
 * Dead-letter a terminal job directly via service_role writes. Terminal here means
 * 'failed' (worker-side max_attempts) or 'claimed' with an expired lock and no attempts
 * left (scanLockExpiry) — the same two source statuses dead_letter_automation_job itself
 * allows. The RPC requires the caller to be the locking worker; the watchdog uses direct
 * SQL instead.
 */
async function handleDeadLetter(admin: SupabaseClient, result: ScanResult): Promise<void> {
  const jobId = result.resource_id;
  if (!jobId) return;

  const { error: updateErr } = await admin
    .from('automation_jobs')
    .update({ status: 'dead_lettered', locked_at: null, locked_by: null })
    .eq('id', jobId)
    .in('status', ['failed', 'claimed']);

  if (updateErr) throw new Error(`dead_letter update: ${updateErr.message}`);

  // Fetch job details for dead_letters row
  const { data: job } = await admin
    .from('automation_jobs')
    .select('organization_id, job_kind, source_kind, source_id, attempts, payload')
    .eq('id', jobId)
    .single();

  if (!job) return;

  const j = job as {
    organization_id: string;
    job_kind: string;
    source_kind: string | null;
    source_id: string | null;
    attempts: number;
    payload: unknown;
  };

  await admin.from('automation_dead_letters').upsert(
    {
      organization_id: j.organization_id,
      original_job_id: jobId,
      job_kind: j.job_kind,
      source_kind: j.source_kind ?? null,
      source_id: j.source_id ?? null,
      last_error: `watchdog: ${result.detail['last_error'] ?? 'max attempts reached'}`,
      payload: j.payload ?? null,
      attempts: j.attempts,
    },
    { onConflict: 'original_job_id', ignoreDuplicates: true },
  );
}

/**
 * Reclaim a job whose lock expired but still has retry budget left: reset it to
 * 'pending' so the next claim_automation_jobs run can pick it up again. Guarded by
 * status='claimed' so a job the owning worker completed/failed in the meantime
 * (race between the scan read and this write) is left alone.
 */
async function handleReap(admin: SupabaseClient, result: ScanResult): Promise<void> {
  const jobId = result.resource_id;
  if (!jobId) return;

  const { error } = await admin
    .from('automation_jobs')
    .update({
      status: 'pending',
      locked_at: null,
      locked_by: null,
      last_error: `watchdog: reaped expired lock (held by ${result.detail['locked_by'] ?? 'unknown worker'})`,
    })
    .eq('id', jobId)
    .eq('status', 'claimed');

  if (error) throw new Error(`reap update: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Per-org scan runner
// ---------------------------------------------------------------------------

async function scanOrg(
  admin: SupabaseClient,
  orgId: string,
  stats: WatchdogStats,
): Promise<void> {
  const scanners = [
    scanBillsStuckReceived,
    scanBillsNoJobAllocation,
    scanLowOcrConfidence,
    scanBankUnmatched7d,
    scanReceiptsNoBill,
    scanXeroPushDeadLetters,
    scanGmailWatchStaleness,
    scanBasCoverageGap,
    scanPayrollSuperOverdue,
    scanJobConsecutiveFailures,
    scanLockExpiry,
    scanPendingStarvation,
    scanUnreachableJobKinds,
  ];

  const results: ScanResult[] = [];
  for (const scanner of scanners) {
    try {
      const found = await scanner(admin, orgId);
      results.push(...found);
    } catch (err) {
      stats.errors.push(
        `${orgId}/${scanner.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  for (const result of results) {
    try {
      if (result.kind === 'retry') {
        await handleRetry(admin, result);
        stats.retries_enqueued += 1;
      } else if (result.kind === 'task') {
        const criticalSignals = ['xero_push_dead_letter', 'pending_starvation', 'unreachable_job_kind'];
        const severity: FindingSeverity = criticalSignals.includes(result.signal)
          ? 'critical'
          : 'warning';
        await handleTask(admin, result, severity);
        stats.tasks_created += 1;
      } else if (result.kind === 'blocked_external') {
        await handleTask(admin, result, 'info');
        stats.tasks_created += 1;
      } else if (result.kind === 'dead_letter') {
        await handleDeadLetter(admin, result);
        stats.dead_lettered += 1;
        // Also surface as a critical finding in the Today feed
        await handleTask(admin, result, 'critical');
        stats.tasks_created += 1;
      } else if (result.kind === 'reap') {
        await handleReap(admin, result);
        stats.locks_reaped += 1;
      }
    } catch (err) {
      stats.errors.push(
        `${orgId}/${result.signal}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const watchdogSecret = Deno.env.get('AUTOMATION_WATCHDOG_SECRET') ?? '';

    if (!supabaseUrl || !serviceKey) {
      return json({ ok: false, error: 'Server config missing' }, 500);
    }

    const url = new URL(req.url);
    const urlSecret = url.searchParams.get('secret') ?? '';
    const authHeader = req.headers.get('Authorization') ?? '';
    const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();

    const isServiceRole = safeEqual(bearer, serviceKey);
    const secretOk = watchdogSecret.length > 0 && safeEqual(urlSecret, watchdogSecret);

    if (!isServiceRole && !secretOk) {
      return json({ ok: false, error: 'Unauthorized' }, 401);
    }

    const admin = makeAdminClient(supabaseUrl, serviceKey);

    const stats: WatchdogStats = {
      orgs_scanned: 0,
      retries_enqueued: 0,
      tasks_created: 0,
      dead_lettered: 0,
      locks_reaped: 0,
      errors: [],
    };

    const { data: orgs, error: orgErr } = await admin
      .from('organizations')
      .select('id')
      .is('deleted_at', null);

    if (orgErr) throw new Error(`load orgs: ${orgErr.message}`);

    for (const org of (orgs ?? []) as { id: string }[]) {
      try {
        await scanOrg(admin, org.id, stats);
        stats.orgs_scanned += 1;
      } catch (err) {
        stats.errors.push(`org ${org.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return json({ ok: true, stats });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});
