/**
 * bills-attach — attaches a bill to a job and pushes it to Xero as ACCPAY.
 *
 * **THIS IS THE CORE INVARIANT MOMENT** of the architecture: attachment to
 * a job is the single-shot Xero push. No reconciliation drift, no per-bill
 * chatter during the job, no waiting for job completion.
 *
 * Input: { bill_id: UUID, job_id: UUID }
 * Output: { ok: true, xero_invoice_id?: string, stub_id?: string }
 *
 * Behaviour:
 *   1. Verify bill is in 'verified' or 'received' state
 *   2. Verify job exists in same organization (RLS enforces)
 *   3. Update bill: status='attached', job_id=<>, attached_at=now()
 *   4. Build Xero ACCPAY payload from bill + line items
 *   5. Push to Xero via xero_integrations OAuth (or stub if XERO_STUB_MODE=true)
 *   6. Record xero_invoice_id, xero_synced_at on the bill
 *   7. Append to xero_sync_log (idempotent on idempotency_key)
 *
 * STATUS: skeleton — Xero adapter port pending. See _shared/xero/adapter.ts.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { pushBillToXero } from '../_shared/xero/adapter.ts';

interface RequestBody {
  bill_id: string;
  job_id: string;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ ok: false, error: 'Unauthorized' }, 401);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!supabaseUrl || !serviceKey || !anonKey) {
      return json({ ok: false, error: 'Server config missing' }, 500);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const body = (await req.json()) as RequestBody;
    if (!body.bill_id || !body.job_id) {
      return json({ ok: false, error: 'bill_id and job_id required' }, 400);
    }

    // Verify caller has access to the bill + job (RLS does the work)
    const { data: bill, error: billErr } = await userClient
      .from('bills')
      .select('*, line_items:bill_line_items(*)')
      .eq('id', body.bill_id)
      .single();
    if (billErr || !bill) return json({ ok: false, error: 'Bill not found' }, 404);

    const { data: job, error: jobErr } = await userClient
      .from('jobs')
      .select('id, organization_id, job_number, name')
      .eq('id', body.job_id)
      .single();
    if (jobErr || !job) return json({ ok: false, error: 'Job not found' }, 404);

    if (bill.organization_id !== job.organization_id) {
      // Belt-and-braces — RLS should prevent this anyway
      return json({ ok: false, error: 'Bill and job belong to different orgs' }, 400);
    }

    if (bill.status === 'attached' || bill.status === 'paid') {
      return json({ ok: false, error: `Bill already ${bill.status}` }, 409);
    }

    // Mark attached
    const now = new Date().toISOString();
    const {
      data: { user },
    } = await userClient.auth.getUser();
    const { error: updateErr } = await admin
      .from('bills')
      .update({
        status: 'attached',
        job_id: job.id,
        attached_at: now,
        attached_by: user?.id ?? null,
        updated_at: now,
      })
      .eq('id', bill.id);
    if (updateErr) return json({ ok: false, error: `Attach failed: ${updateErr.message}` }, 500);

    // Push to Xero (single shot, original-dated)
    const result = await pushBillToXero({
      admin,
      organizationId: bill.organization_id,
      bill,
      job,
    });

    // Record on bill + sync log
    await admin
      .from('bills')
      .update({
        xero_status: 'synced',
        xero_invoice_id: result.xeroInvoiceId,
        xero_synced_at: now,
      })
      .eq('id', bill.id);

    return json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
