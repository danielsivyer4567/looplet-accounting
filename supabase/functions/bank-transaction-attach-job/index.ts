/**
 * bank-transaction-attach-job — confirms a bank transaction's job attribution.
 *
 * bank-transaction-classifier writes suggested_job_id (an unconfirmed
 * heuristic guess) — this is the human confirm step that promotes it to a
 * real job_id, mirroring bills-attach's bill_id → job_id confirm pattern.
 * Once confirmed, the transaction feeds v_job_costs.bank_direct_costs
 * (20260702181500_bank_transaction_job_attribution.sql) — UNLESS it's
 * already matched to a bill/invoice, in which case that view intentionally
 * excludes it to avoid double-counting against bill_costs/invoice revenue.
 *
 * Input:  { bank_transaction_id: UUID, job_id: UUID }
 * Output: { ok: true, job_id: UUID, already_counted_via: 'bill' | 'invoice' | null }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';

interface RequestBody {
  bank_transaction_id: string;
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
    if (!body.bank_transaction_id || !body.job_id) {
      return json({ ok: false, error: 'bank_transaction_id and job_id required' }, 400);
    }

    // RLS check on both rows via user client — confirms the caller's org
    // actually owns them before any service-role write.
    const { data: txn, error: txnErr } = await userClient
      .from('bank_transactions')
      .select('id, organization_id, matched_bill_id, matched_invoice_id')
      .eq('id', body.bank_transaction_id)
      .maybeSingle();
    if (txnErr || !txn) return json({ ok: false, error: 'Bank transaction not found' }, 404);

    const { data: job, error: jobErr } = await userClient
      .from('jobs')
      .select('id, organization_id')
      .eq('id', body.job_id)
      .maybeSingle();
    if (jobErr || !job) return json({ ok: false, error: 'Job not found' }, 404);

    if (txn.organization_id !== job.organization_id) {
      return json({ ok: false, error: 'Transaction and job in different orgs' }, 400);
    }

    const { error: updErr } = await admin
      .from('bank_transactions')
      .update({ job_id: job.id, updated_at: new Date().toISOString() })
      .eq('id', txn.id);
    if (updErr) return json({ ok: false, error: `Attach failed: ${updErr.message}` }, 500);

    // Inform the caller if this transaction is already accounted for via a
    // bill/invoice match — v_job_costs.bank_direct_costs excludes it, so the
    // job attribution is recorded for traceability but won't double the cost.
    const alreadyCountedVia = txn.matched_bill_id ? 'bill' : txn.matched_invoice_id ? 'invoice' : null;

    return json({ ok: true, job_id: job.id, already_counted_via: alreadyCountedVia });
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
