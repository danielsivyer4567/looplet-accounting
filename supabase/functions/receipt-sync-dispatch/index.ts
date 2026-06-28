/**
 * receipt-sync-dispatch — processes queued Receipt Hub accounting sync jobs.
 *
 * Xero uses the existing server-side adapter. Permanent preconditions (missing
 * job attachment, unconfigured provider adapters) are marked skipped with a
 * clear operator-facing message; transient provider/API failures stay failed
 * and receive a retry timestamp.
 */
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { pushBillToXero } from '../_shared/xero/adapter.ts';
import { requireEnv } from '../_shared/env.ts';

type SyncProvider = 'xero' | 'myob' | 'quickbooks' | 'generic_api';

interface RequestBody {
  organization_id?: string;
  receipt_sync_job_id?: string;
  provider?: SyncProvider;
  limit?: number;
}

interface ReceiptSyncJob {
  id: string;
  organization_id: string;
  receipt_event_id: string;
  bill_id: string | null;
  provider: SyncProvider;
  status: string;
  attempts: number;
  payload: Record<string, unknown>;
}

interface BillForPush {
  id: string;
  organization_id: string;
  job_id: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  total_inc_gst_cents: number | null;
  gst_cents: number | null;
  subtotal_ex_gst_cents: number | null;
  currency_code: string;
  supplier_name_raw: string | null;
  job_reference_raw: string | null;
  line_items?: {
    description: string;
    quantity: number;
    unit_price_cents: number;
    total_cents: number;
    gst_cents: number;
    account_code: string | null;
    category: string | null;
  }[];
}

interface JobForPush {
  id: string;
  job_number: string;
  name: string;
}

class PermanentSyncSkip extends Error {}

export async function handleReceiptSyncDispatchRequest(req: Request): Promise<Response> {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ ok: false, error: 'Unauthorized' }, 401);

  const supabaseUrl = requireEnv('SUPABASE_URL');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const body = (await req.json().catch(() => ({}))) as RequestBody;
  if (!body.organization_id) return json({ ok: false, error: 'organization_id required' }, 400);

  const serviceRole = isServiceRole(authHeader, serviceKey);
  if (!serviceRole) {
    const anonKey = requireEnv('SUPABASE_ANON_KEY');
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: org } = await userClient
      .from('organizations')
      .select('id')
      .eq('id', body.organization_id)
      .maybeSingle();
    if (!org) return json({ ok: false, error: 'Organisation not accessible' }, 403);
  }

  const limit = Math.max(1, Math.min(50, Math.round(body.limit ?? 10)));
  let query = admin
    .from('receipt_sync_jobs')
    .select('id, organization_id, receipt_event_id, bill_id, provider, status, attempts, payload')
    .eq('organization_id', body.organization_id)
    .in('status', ['pending', 'queued'])
    .order('created_at', { ascending: true })
    .limit(limit);
  if (body.receipt_sync_job_id) query = query.eq('id', body.receipt_sync_job_id);
  if (body.provider) query = query.eq('provider', body.provider);

  const { data: jobs, error } = await query;
  if (error) return json({ ok: false, error: error.message }, 500);

  const results = [];
  for (const raw of (jobs ?? []) as ReceiptSyncJob[]) {
    results.push(await processSyncJob(admin, raw));
  }

  return json({ ok: true, processed: results.length, results });
}

if (import.meta.main) {
  Deno.serve(handleReceiptSyncDispatchRequest);
}

async function processSyncJob(admin: SupabaseClient, job: ReceiptSyncJob) {
  const attempts = (job.attempts ?? 0) + 1;
  await admin
    .from('receipt_sync_jobs')
    .update({ status: 'queued', attempts, last_error: null, next_attempt_at: null })
    .eq('id', job.id);

  try {
    if (!job.bill_id) throw new PermanentSyncSkip('No bill was created for this receipt event.');

    if (job.provider !== 'xero') {
      throw new PermanentSyncSkip(`${providerLabel(job.provider)} sync adapter is not configured yet.`);
    }

    const { data: bill, error: billErr } = await admin
      .from('bills')
      .select('*, line_items:bill_line_items(*)')
      .eq('id', job.bill_id)
      .eq('organization_id', job.organization_id)
      .maybeSingle();
    if (billErr) throw new Error(billErr.message);
    if (!bill) throw new Error('Bill not found for receipt sync job.');

    const b = bill as unknown as BillForPush;
    if (!b.job_id) {
      throw new PermanentSyncSkip('Job folder is required before Xero sync. Attach the receipt bill to a job first.');
    }

    const { data: jobRow, error: jobErr } = await admin
      .from('jobs')
      .select('id, job_number, name')
      .eq('id', b.job_id)
      .eq('organization_id', job.organization_id)
      .maybeSingle();
    if (jobErr) throw new Error(jobErr.message);
    if (!jobRow) throw new PermanentSyncSkip('Job folder not found for receipt bill.');

    const result = await pushBillToXero({
      admin,
      organizationId: job.organization_id,
      bill: b,
      job: jobRow as JobForPush,
    });

    await admin
      .from('bills')
      .update({
        xero_status: 'synced',
        xero_invoice_id: result.xeroInvoiceId,
        xero_synced_at: new Date().toISOString(),
      })
      .eq('id', b.id);

    await admin
      .from('receipt_sync_jobs')
      .update({
        status: 'synced',
        last_error: null,
        payload: {
          ...job.payload,
          dispatch_result: {
            provider: job.provider,
            xero_invoice_id: result.xeroInvoiceId,
            is_stub: result.isStub,
            synced_at: new Date().toISOString(),
          },
        },
      })
      .eq('id', job.id);

    return {
      id: job.id,
      provider: job.provider,
      status: 'synced',
      xero_invoice_id: result.xeroInvoiceId,
      is_stub: result.isStub,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const skipped = err instanceof PermanentSyncSkip;
    await admin
      .from('receipt_sync_jobs')
      .update({
        status: skipped ? 'skipped' : 'failed',
        last_error: message.slice(0, 500),
        next_attempt_at: skipped
          ? null
          : new Date(Date.now() + Math.min(attempts, 12) * 5 * 60_000).toISOString(),
      })
      .eq('id', job.id);
    return { id: job.id, provider: job.provider, status: skipped ? 'skipped' : 'failed', error: message };
  }
}

function providerLabel(provider: SyncProvider): string {
  if (provider === 'generic_api') return 'Generic API';
  return provider.toUpperCase();
}

function isServiceRole(authHeader: string, serviceKey: string): boolean {
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  return safeEqual(token, serviceKey);
}

/** Constant-time string compare; false on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
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
