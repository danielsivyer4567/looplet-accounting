/**
 * automation-worker — claims due automation_jobs and dispatches by job_kind.
 *
 * Auth: service-role bearer OR ?secret=AUTOMATION_WORKER_SECRET (fail closed).
 * Deployed --no-verify-jwt so pg_cron can drive it via HTTP.
 *
 * Job kinds handled (this slice):
 *   bill_extract    — forward to bills-extract-batch edge fn
 *   receipt_sync    — forward to generic receipt-sync API helper
 *   xero_push       — forward to xero-push-bill edge fn
 *   bank_reconcile  — forward to auto-reconcile edge fn
 *   gmail_backfill  — forward to gmail-backfill edge fn
 *   coding_classify — forward to gmail-classify-ai edge fn
 *
 * Each dispatch path:
 *   1. Idempotency check (skip if a completed job exists for same source)
 *   2. Log 'dispatch' step as 'started'
 *   3. Call the handler
 *   4. Log result step as 'ok' or 'error'
 *   5. complete_job / fail_job (dead-letter when attempts >= max_attempts)
 *
 * Output: { ok, stats: { claimed, completed, failed, dead_lettered, errors[] } }
 */

import { corsHeaders, preflight } from '../_shared/cors.ts';
import {
  makeAdminClient,
  claimJobs,
  completeJob,
  failJob,
  deadLetterJob,
  logStep,
} from '../_shared/automationJobs.ts';
import type { AutomationJob } from '../_shared/automationJobs.ts';

const CLAIM_LIMIT = 10;

// Exponential backoff delays per attempt (seconds): 60, 300, 900
function backoffDelay(attempts: number): Date {
  const secs = [60, 300, 900][Math.min(attempts - 1, 2)] ?? 900;
  return new Date(Date.now() + secs * 1_000);
}

/** Constant-time string compare to prevent timing attacks. */
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
// Dispatcher — calls existing edge functions by relative URL
// ---------------------------------------------------------------------------

interface DispatchResult { ok: boolean; detail?: unknown }

async function dispatchJob(
  job: AutomationJob,
  supabaseUrl: string,
  serviceKey: string,
  workerSecret: string,
): Promise<DispatchResult> {
  const base = `${supabaseUrl}/functions/v1`;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${serviceKey}`,
  };

  switch (job.job_kind) {
    case 'bill_extract': {
      const res = await fetch(`${base}/bills-extract-batch`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          organization_id: job.organization_id,
          source_id: job.source_id,
          payload: job.payload,
        }),
      });
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok, detail: body };
    }

    case 'receipt_sync': {
      const res = await fetch(`${base}/ingest`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          organization_id: job.organization_id,
          source_kind: job.source_kind,
          source_id: job.source_id,
          payload: job.payload,
        }),
      });
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok, detail: body };
    }

    case 'xero_push': {
      const endpoint = job.source_kind === 'invoice' ? 'xero-push-invoice' : 'xero-push-bill';
      const res = await fetch(`${base}/${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          organization_id: job.organization_id,
          source_id: job.source_id,
          payload: job.payload,
        }),
      });
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok, detail: body };
    }

    case 'bank_reconcile': {
      const res = await fetch(`${base}/auto-reconcile?secret=${workerSecret}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ organization_id: job.organization_id }),
      });
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok, detail: body };
    }

    case 'gmail_backfill': {
      const pl = (job.payload ?? {}) as Record<string, unknown>;
      const res = await fetch(`${base}/gmail-backfill`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          integration_id: pl['integration_id'] ?? job.source_id,
          days: pl['days'] ?? 180,
        }),
      });
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok, detail: body };
    }

    case 'coding_classify': {
      const pl = (job.payload ?? {}) as Record<string, unknown>;
      const res = await fetch(`${base}/gmail-classify-ai`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          organization_id: job.organization_id,
          thread_id: pl['thread_id'] ?? job.source_id,
          payload: job.payload,
        }),
      });
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok, detail: body };
    }

    default:
      return { ok: false, detail: { error: `unsupported job_kind: ${job.job_kind}` } };
  }
}

// ---------------------------------------------------------------------------
// Idempotency check — skip if source already has a completed job of same kind
// ---------------------------------------------------------------------------

async function isAlreadyComplete(
  supabaseUrl: string,
  serviceKey: string,
  job: AutomationJob,
): Promise<boolean> {
  if (!job.source_id || !job.source_kind) return false;
  const admin = makeAdminClient(supabaseUrl, serviceKey);
  const { data } = await admin
    .from('automation_jobs')
    .select('id')
    .eq('organization_id', job.organization_id)
    .eq('job_kind', job.job_kind)
    .eq('source_kind', job.source_kind)
    .eq('source_id', job.source_id)
    .eq('status', 'completed')
    .neq('id', job.id)
    .limit(1);
  return (data ?? []).length > 0;
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
    const workerSecret = Deno.env.get('AUTOMATION_WORKER_SECRET') ?? '';

    if (!supabaseUrl || !serviceKey) {
      return json({ ok: false, error: 'Server config missing' }, 500);
    }

    // Auth: service-role bearer OR ?secret=AUTOMATION_WORKER_SECRET
    const url = new URL(req.url);
    const urlSecret = url.searchParams.get('secret') ?? '';
    const authHeader = req.headers.get('Authorization') ?? '';
    const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();

    const isServiceRole = safeEqual(bearer, serviceKey);
    const secretOk = workerSecret.length > 0 && safeEqual(urlSecret, workerSecret);

    if (!isServiceRole && !secretOk) {
      return json({ ok: false, error: 'Unauthorized' }, 401);
    }

    const workerId = `automation-worker-${crypto.randomUUID()}`;
    const admin = makeAdminClient(supabaseUrl, serviceKey);

    // Claim due jobs
    const jobs = await claimJobs(admin, workerId, null, CLAIM_LIMIT);

    const stats = {
      claimed: jobs.length,
      completed: 0,
      failed: 0,
      dead_lettered: 0,
      errors: [] as { job_id: string; job_kind: string; error: string }[],
    };

    for (const job of jobs) {
      try {
        // Idempotency check
        const already = await isAlreadyComplete(supabaseUrl, serviceKey, job);
        if (already) {
          await logStep(admin, job.id, 'idempotency_check', 'skipped', {
            reason: 'source already completed by another job',
          });
          await completeJob(admin, job.id, workerId);
          stats.completed += 1;
          continue;
        }

        await logStep(admin, job.id, 'dispatch', 'started', { job_kind: job.job_kind });

        const result = await dispatchJob(job, supabaseUrl, serviceKey, workerSecret);

        if (result.ok) {
          await logStep(admin, job.id, 'dispatch', 'ok', result.detail);
          await completeJob(admin, job.id, workerId);
          stats.completed += 1;
        } else {
          const errMsg = extractError(result.detail);
          await logStep(admin, job.id, 'dispatch', 'error', null, errMsg);

          if (job.attempts >= job.max_attempts) {
            await deadLetterJob(admin, job.id, workerId, errMsg);
            stats.dead_lettered += 1;
          } else {
            await failJob(admin, job.id, workerId, errMsg, backoffDelay(job.attempts));
            stats.failed += 1;
          }
          stats.errors.push({ job_id: job.id, job_kind: job.job_kind, error: errMsg });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await logStep(admin, job.id, 'dispatch', 'error', null, errMsg).catch(() => undefined);

        try {
          if (job.attempts >= job.max_attempts) {
            await deadLetterJob(admin, job.id, workerId, errMsg);
            stats.dead_lettered += 1;
          } else {
            await failJob(admin, job.id, workerId, errMsg, backoffDelay(job.attempts));
            stats.failed += 1;
          }
        } catch (rpcErr) {
          const rpcMsg = rpcErr instanceof Error ? rpcErr.message : String(rpcErr);
          stats.errors.push({ job_id: job.id, job_kind: job.job_kind, error: rpcMsg });
        }

        stats.errors.push({ job_id: job.id, job_kind: job.job_kind, error: errMsg });
      }
    }

    return json({ ok: true, worker_id: workerId, stats });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

function extractError(detail: unknown): string {
  if (!detail || typeof detail !== 'object') return 'dispatch failed';
  const d = detail as Record<string, unknown>;
  if (typeof d['error'] === 'string') return d['error'];
  if (typeof d['message'] === 'string') return d['message'];
  return JSON.stringify(detail).slice(0, 200);
}
