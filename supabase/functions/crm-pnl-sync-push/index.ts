/**
 * crm-pnl-sync-push — pushes a live P&L summary for one org to Looplet CRM.
 *
 * Dispatched by automation-worker for job_kind='crm_pnl_sync' (enqueued by
 * enqueue_crm_pnl_sync_jobs(), 20260702183000_crm_pnl_sync_jobs.sql). Reads
 * ONLY existing views (v_job_pnl, v_organization_realtime_pnl) — never raw
 * tables — so Accounting controls exactly what leaves the system, per the
 * CRM-sync handover doc's stated principle.
 *
 * Two separate Supabase projects, no shared auth: this is a plain
 * server-to-server POST authenticated with a static shared secret
 * (CRM_SYNC_SECRET), matching the "dedicated signing secret" option the CRM
 * surface map documented for exactly this case (server-to-server between two
 * systems Looplet owns, not a user-mediated action).
 *
 * CRM_SYNC_ENDPOINT_URL and CRM_SYNC_SECRET are not yet coordinated with the
 * CRM side as of this deploy — until they are, this function fails cleanly
 * (ok:false, clear error) rather than crashing or silently no-op'ing, so the
 * job retries/dead-letters visibly instead of vanishing.
 *
 * Input:  { organization_id: UUID }
 * Output: { ok: boolean, pushed_jobs?: number, error?: string }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { requireEnv } from '../_shared/env.ts';

interface RequestBody {
  organization_id: string;
}

interface JobPnlRow {
  job_id: string;
  job_number: string | null;
  job_name: string | null;
  job_status: string | null;
  revenue_inc_gst_cents: number;
  total_cost_cents: number;
  gross_profit_cents: number;
  budget_cents: number | null;
}

interface OrgPnlRow {
  organization_id: string;
  organization_name: string;
  revenue_inc_gst_cents: number;
  total_cost_cents: number;
  gross_profit_cents: number;
  tax_set_aside_cents: number;
  really_yours_cents: number;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  try {
    const supabaseUrl = requireEnv('SUPABASE_URL');
    const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const body = (await req.json()) as RequestBody;
    if (!body.organization_id) {
      return json({ ok: false, error: 'organization_id required' }, 400);
    }

    const { data: org, error: orgErr } = await admin
      .from('organizations')
      .select('id, crm_organization_id')
      .eq('id', body.organization_id)
      .maybeSingle();
    if (orgErr || !org) return json({ ok: false, error: 'Organisation not found' }, 404);
    if (!org.crm_organization_id) {
      // Enqueue guard already filters this, but a race (org unlinked between
      // enqueue and dispatch) must not error the worker — no-op is correct.
      return json({ ok: true, pushed_jobs: 0, skipped: 'no crm_organization_id' });
    }

    const [{ data: jobRows, error: jobErr }, { data: orgPnl, error: orgPnlErr }] =
      await Promise.all([
        admin
          .from('v_job_pnl')
          .select(
            'job_id, job_number, job_name, job_status, revenue_inc_gst_cents, total_cost_cents, gross_profit_cents, budget_cents',
          )
          .eq('organization_id', body.organization_id),
        admin
          .from('v_organization_realtime_pnl')
          .select(
            'organization_id, organization_name, revenue_inc_gst_cents, total_cost_cents, gross_profit_cents, tax_set_aside_cents, really_yours_cents',
          )
          .eq('organization_id', body.organization_id)
          .maybeSingle(),
      ]);
    if (jobErr) return json({ ok: false, error: `v_job_pnl read: ${jobErr.message}` }, 500);
    if (orgPnlErr) {
      return json({ ok: false, error: `v_organization_realtime_pnl read: ${orgPnlErr.message}` }, 500);
    }

    const endpointUrl = Deno.env.get('CRM_SYNC_ENDPOINT_URL');
    const syncSecret = Deno.env.get('CRM_SYNC_SECRET');
    if (!endpointUrl || !syncSecret) {
      // Not yet coordinated with CRM — fail visibly (job retries/dead-letters)
      // rather than pretending success.
      return json(
        {
          ok: false,
          error: 'CRM_SYNC_ENDPOINT_URL/CRM_SYNC_SECRET not configured — CRM sync target not yet coordinated',
        },
        503,
      );
    }

    const jobs = (jobRows ?? []) as JobPnlRow[];
    const org_pnl = orgPnl as OrgPnlRow | null;
    const updatedAt = new Date().toISOString();

    const payload = {
      // Bumped only on a breaking payload change so the CRM receiver can pin a
      // shape. See docs/CRM_PNL_SYNC_CONTRACT.md — additive fields do NOT bump.
      schema_version: 1,
      crm_organization_id: org.crm_organization_id,
      updated_at: updatedAt,
      idempotency_key: `${body.organization_id}:${updatedAt}`,
      organization: org_pnl
        ? {
            revenue_inc_gst_cents: org_pnl.revenue_inc_gst_cents,
            total_cost_cents: org_pnl.total_cost_cents,
            gross_profit_cents: org_pnl.gross_profit_cents,
            tax_set_aside_cents: org_pnl.tax_set_aside_cents,
            really_yours_cents: org_pnl.really_yours_cents,
          }
        : null,
      jobs: jobs.map((j) => ({
        job_id: j.job_id,
        job_number: j.job_number,
        job_name: j.job_name,
        job_status: j.job_status,
        revenue_inc_gst_cents: j.revenue_inc_gst_cents,
        total_cost_cents: j.total_cost_cents,
        gross_profit_cents: j.gross_profit_cents,
        budget_cents: j.budget_cents,
      })),
    };

    const res = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${syncSecret}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return json(
        { ok: false, error: `CRM push failed: ${res.status} ${detail.slice(0, 300)}` },
        502,
      );
    }

    return json({ ok: true, pushed_jobs: jobs.length });
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
