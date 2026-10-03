/**
 * bills-attach — attaches a bill to a job and pushes it to Xero as ACCPAY.
 *
 * Single-shot push principle (per docs/ROADMAP.md):
 *   - Bill enters via any of 3 lanes; sits as 'received' or 'verified'
 *   - User attaches → push to Xero ACCPAY exactly once, original-dated
 *   - No reconciliation drift, no per-bill chatter during the job
 *
 * Input:  { bill_id: UUID, job_id: UUID }
 * Output: { ok: true, xero_status: 'synced' | 'not_connected', xero_invoice_id: string | null,
 *           xero_message?: string }
 * The bill is only marked synced with the id Xero returned. Not connected leaves it
 * pending; a failed push marks it failed and returns 502 (the bill stays attached).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { billXeroSyncUpdate, pushBillToXero } from '../_shared/xero/adapter.ts';

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

    // Read bill via user client → RLS confirms access
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
      return json({ ok: false, error: 'Bill and job in different orgs' }, 400);
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

    // Push to Xero. Only an id Xero returned marks the bill synced.
    let result;
    try {
      result = await pushBillToXero({
        admin,
        organizationId: bill.organization_id,
        bill,
        job,
      });
    } catch (pushErr) {
      const pushMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
      await admin.from('bills').update({ xero_status: 'failed' }).eq('id', bill.id);
      return json(
        {
          ok: false,
          attached: true,
          xero_status: 'failed',
          error: `Bill attached to the job, but sending it to Xero failed: ${pushMsg}`,
        },
        502,
      );
    }

    await admin.from('bills').update(billXeroSyncUpdate(result, now)).eq('id', bill.id);

    return json({
      ok: true,
      xero_status: result.status,
      xero_invoice_id: result.status === 'synced' ? result.xeroInvoiceId : null,
      ...(result.status === 'not_connected' ? { xero_message: result.reason } : {}),
    });
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
