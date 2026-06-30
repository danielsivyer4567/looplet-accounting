/**
 * automation-worker — claims due automation_jobs and dispatches by job_kind.
 *
 * Auth: service-role bearer OR ?secret=AUTOMATION_WORKER_SECRET (fail closed).
 * Deployed --no-verify-jwt so pg_cron can drive it via HTTP.
 *
 * Job kinds handled (this slice):
 *   bill_extract    — forward to bills-extract-batch edge fn
 *   bank_sync       — forward to bank-sync edge fn
 *   receipt_sync    — forward to receipt-sync-dispatch
 *   xero_push       — forward to xero-push-bill edge fn
 *   bank_reconcile  — forward to auto-reconcile edge fn
 *   gmail_backfill  — forward to gmail-backfill edge fn
 *   coding_classify — forward to gmail-classify-ai edge fn
 *   payment_record  — record AR invoice receipts from ingest payment jobs
 *
 * Browser collection is intentionally excluded from the default claim loop.
 * A dedicated browser runner must claim browser_collect jobs with its own
 * filtered claim_automation_jobs call so evidence collection is never marked
 * complete by this worker without a real browser run.
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
const DEFAULT_JOB_KINDS = [
  'bill_extract',
  'bank_sync',
  'receipt_sync',
  'xero_push',
  'bank_reconcile',
  'gmail_backfill',
  'coding_classify',
  'payment_record',
] as const;

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

interface DispatchResult {
  ok: boolean;
  detail?: unknown;
}

async function dispatchJob(
  job: AutomationJob,
  supabaseUrl: string,
  serviceKey: string,
  workerSecret: string,
): Promise<DispatchResult> {
  const base = `${supabaseUrl}/functions/v1`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${serviceKey}`,
  };

  switch (job.job_kind) {
    case 'bill_extract': {
      const pl = objectPayload(job.payload);
      const billId =
        stringValue(pl['bill_id']) ?? (job.source_kind === 'bill' ? job.source_id : null);
      const endpoint = billId ? 'bills-extract' : 'bills-extract-batch';
      const requestBody = billId
        ? { bill_id: billId, force: booleanValue(pl['force']) }
        : {
            organization_id: job.organization_id,
            source_id: job.source_id,
            payload: job.payload,
          };
      const res = await fetch(`${base}/${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok, detail: body };
    }

    case 'bank_sync': {
      const pl = objectPayload(job.payload);
      const bankConnectionId =
        stringValue(pl['bank_connection_id']) ??
        (job.source_kind === 'bank_connection' ? job.source_id : null);
      const days = numberValue(pl['days']);
      const requestBody: Record<string, unknown> = {
        organization_id: job.organization_id,
      };
      if (bankConnectionId) requestBody['bank_connection_id'] = bankConnectionId;
      if (days && Number.isFinite(days) && days > 0) requestBody['days'] = days;
      const res = await fetch(`${base}/bank-sync`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok, detail: body };
    }

    case 'receipt_sync': {
      const pl = objectPayload(job.payload);
      const receiptSyncJobId =
        stringValue(pl['receipt_sync_job_id']) ??
        (job.source_kind === 'receipt_sync_job' ? job.source_id : null);
      const provider = stringValue(pl['provider']);
      const limit = numberValue(pl['limit']);
      const requestBody: Record<string, unknown> = {
        organization_id: job.organization_id,
      };
      if (receiptSyncJobId) requestBody['receipt_sync_job_id'] = receiptSyncJobId;
      if (provider) requestBody['provider'] = provider;
      if (limit && Number.isInteger(limit) && limit > 0) requestBody['limit'] = limit;
      const res = await fetch(`${base}/receipt-sync-dispatch`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok, detail: body };
    }

    case 'xero_push': {
      const pl = objectPayload(job.payload);
      const invoiceId =
        stringValue(pl['invoice_id']) ??
        (job.source_kind === 'invoice' || job.source_kind === 'customer_invoice'
          ? job.source_id
          : null);
      const billId =
        stringValue(pl['bill_id']) ?? (job.source_kind === 'bill' ? job.source_id : null);
      if (invoiceId && billId) {
        return {
          ok: false,
          detail: { error: 'xero_push must target either invoice_id or bill_id, not both' },
        };
      }
      if (!invoiceId && !billId) {
        return { ok: false, detail: { error: 'xero_push requires invoice_id or bill_id' } };
      }
      const endpoint = invoiceId ? 'xero-push-invoice' : 'xero-push-bill';
      const requestBody = invoiceId
        ? { organization_id: job.organization_id, invoice_id: invoiceId, idempotency_key: job.id }
        : { organization_id: job.organization_id, bill_id: billId, idempotency_key: job.id };
      const res = await fetch(`${base}/${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
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
      const pl = objectPayload(job.payload);
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

    case 'payment_record':
      return await recordPayment(job, supabaseUrl, serviceKey);

    case 'browser_collect':
      // Defensive fallback only. The default claim loop excludes browser jobs;
      // a real browser runner must claim them explicitly.
      return {
        ok: true,
        detail: { status: 'not_supported', reason: 'no browser runner attached' },
      };

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

    // Claim only jobs this worker can fully execute. Browser evidence jobs are
    // owned by a separate runner because completing them without screenshots or
    // collected artifacts would create false proof.
    const jobs = await claimJobs(admin, workerId, [...DEFAULT_JOB_KINDS], CLAIM_LIMIT);

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

async function recordPayment(
  job: AutomationJob,
  supabaseUrl: string,
  serviceKey: string,
): Promise<DispatchResult> {
  const pl = objectPayload(job.payload);
  if (stringValue(pl['bill_id'])) {
    return {
      ok: false,
      detail: {
        error:
          'bill payment jobs require bank reconciliation or payment runs; invoice payments only',
      },
    };
  }

  const invoiceId = stringValue(pl['invoice_id']);
  const amountCents = numberValue(pl['amount_cents']);
  const paidAt = paidAtIso(pl['payment_date']);
  if (!invoiceId) return { ok: false, detail: { error: 'invoice_id required' } };
  if (!amountCents || amountCents <= 0 || !Number.isInteger(amountCents)) {
    return { ok: false, detail: { error: 'amount_cents must be a positive integer' } };
  }
  if (!paidAt) return { ok: false, detail: { error: 'payment_date required' } };

  const admin = makeAdminClient(supabaseUrl, serviceKey);
  const { data: invoice, error: invoiceErr } = await admin
    .from('invoices')
    .select('id, organization_id')
    .eq('id', invoiceId)
    .eq('organization_id', job.organization_id)
    .maybeSingle();
  if (invoiceErr)
    return { ok: false, detail: { error: `invoice lookup failed: ${invoiceErr.message}` } };
  if (!invoice) return { ok: false, detail: { error: 'invoice not found for organization' } };

  const idempotencyKey = stringValue(pl['idempotency_key']);
  const reference = stringValue(pl['reference']) ?? `ingest:${idempotencyKey ?? job.id}`;
  const { data: existing, error: existingErr } = await admin
    .from('invoice_payments')
    .select('id')
    .eq('organization_id', job.organization_id)
    .eq('invoice_id', invoiceId)
    .eq('amount_cents', amountCents)
    .eq('reference', reference)
    .maybeSingle();
  if (existingErr) {
    return { ok: false, detail: { error: `payment dedupe lookup failed: ${existingErr.message}` } };
  }
  if (existing) {
    return { ok: true, detail: { status: 'deduped', payment_id: existing.id } };
  }

  const { data: inserted, error: insertErr } = await admin
    .from('invoice_payments')
    .insert({
      organization_id: job.organization_id,
      invoice_id: invoiceId,
      paid_at: paidAt,
      amount_cents: amountCents,
      method: stringValue(pl['payment_method']) ?? 'api',
      reference,
      notes: `Recorded by automation worker from ingest payment ${idempotencyKey ?? job.id}`,
    })
    .select('id')
    .single();
  if (insertErr) {
    return { ok: false, detail: { error: `invoice payment insert failed: ${insertErr.message}` } };
  }

  return { ok: true, detail: { status: 'recorded', payment_id: inserted.id } };
}

function objectPayload(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim().length > 0) return Number(value);
  return null;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function paidAtIso(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
