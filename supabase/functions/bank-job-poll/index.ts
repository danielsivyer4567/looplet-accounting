/**
 * bank-job-poll — poll a Basiq job until the connection becomes active
 * (or return the current status so the frontend can poll again).
 *
 * Basiq's Connect flow most commonly returns a jobId (not a connectionId)
 * from the redirect callback. A job contains one or more steps; once all
 * steps complete the job exposes a list of connection IDs. We surface the
 * first active connectionId so BankCallback can immediately call bank-exchange.
 *
 * Input:  { organization_id, job_id }
 * Output: { ok: true, status: 'pending'|'active'|'failed', connection_id?: string }
 *         The frontend calls this every 2 s for up to 30 attempts (60 s total).
 *
 * Auth:   Standard user JWT (verify_jwt = true). RLS check ensures the caller
 *         owns the org before we touch Basiq.
 *
 * Basiq job shape (v3):
 * {
 *   id: string,
 *   status: string,               // "pending" | "processing" | "success" | "failed"
 *   steps: [{ title, status, result: { type, url }[] }],
 *   links: { self, source }
 * }
 * The connection ID is embedded in the step result URL:
 *   "url": "https://au-api.basiq.io/users/{uid}/connections/{cid}"
 *
 * We also fall back to listing the user's connections and returning the newest
 * active one if the job steps don't expose an explicit URL (older Basiq orgs
 * sometimes omit it).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { getBasiqServerToken } from '../_shared/basiq/client.ts';

interface RequestBody {
  organization_id: string;
  job_id: string;
}

interface BasiqJobStep {
  title: string;
  status: string;   // "pending" | "processing" | "success" | "failed"
  result?: Array<{ type: string; url: string }>;
}

interface BasiqJob {
  id: string;
  status: string;
  steps?: BasiqJobStep[];
  links?: { self?: string; source?: string };
}

interface BasiqConnectionListItem {
  id: string;
  status: string;
  created?: string;
}

const BASIQ_BASE = Deno.env.get('BASIQ_BASE_URL') ?? 'https://au-api.basiq.io';

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
    if (!body.organization_id || !body.job_id) {
      return json({ ok: false, error: 'organization_id and job_id required' }, 400);
    }

    // RLS check — the caller must be a member of this org.
    const { data: org } = await userClient
      .from('organizations')
      .select('id, basiq_user_id')
      .eq('id', body.organization_id)
      .maybeSingle();
    if (!org) return json({ ok: false, error: 'Organisation not accessible' }, 403);
    if (!org.basiq_user_id) {
      return json({ ok: false, error: 'No Basiq user yet — call bank-link-token first' }, 400);
    }

    const basiqUserId = org.basiq_user_id as string;
    const serverToken = await getBasiqServerToken();

    // 1. Fetch the job from Basiq.
    const jobResp = await fetch(`${BASIQ_BASE}/jobs/${body.job_id}`, {
      headers: {
        Authorization: `Bearer ${serverToken}`,
        Accept: 'application/json',
        'basiq-version': '3.0',
      },
    });

    if (!jobResp.ok) {
      const t = await jobResp.text();
      return json({
        ok: false,
        error: `Basiq jobs/${body.job_id} ${jobResp.status}: ${t.slice(0, 300)}`,
      }, 502);
    }

    const job = (await jobResp.json()) as BasiqJob;

    // 2. Map Basiq job status → our simplified status.
    //    Basiq top-level status can be "pending" | "processing" | "success" | "failed"
    //    (and historically "in-progress"). We collapse "success" → active only when
    //    we can also resolve a connectionId; otherwise stay pending so the frontend
    //    retries and eventually gets the connectionId from the connections list fallback.
    const basiqStatus = (job.status ?? '').toLowerCase();
    if (basiqStatus === 'failed') {
      return json({ ok: true, status: 'failed' });
    }

    // 3. Try to pull connectionId from step results (v3 standard path).
    let connectionId: string | undefined;

    for (const step of job.steps ?? []) {
      if (step.status !== 'success') continue;
      for (const r of step.result ?? []) {
        // Result URL: ".../users/{uid}/connections/{cid}"
        const m = r.url?.match(/\/connections\/([^/?#]+)/);
        if (m?.[1]) {
          connectionId = m[1];
          break;
        }
      }
      if (connectionId) break;
    }

    // 4. Fallback: if job succeeded but no connectionId in steps, query the
    //    user's connections list and pick the newest active one (created after
    //    the job was submitted, best-effort heuristic).
    if (!connectionId && basiqStatus === 'success') {
      const connResp = await fetch(
        `${BASIQ_BASE}/users/${basiqUserId}/connections`,
        {
          headers: {
            Authorization: `Bearer ${serverToken}`,
            Accept: 'application/json',
            'basiq-version': '3.0',
          },
        },
      );
      if (connResp.ok) {
        const connList = (await connResp.json()) as { data?: BasiqConnectionListItem[] };
        // Sort by created desc, take the first active one.
        const sorted = (connList.data ?? [])
          .filter((c) => c.status === 'active')
          .sort((a, b) => {
            const ta = a.created ? new Date(a.created).getTime() : 0;
            const tb = b.created ? new Date(b.created).getTime() : 0;
            return tb - ta;
          });
        connectionId = sorted[0]?.id;
      }
    }

    // 5. Return status + connectionId (if resolved).
    const isComplete = basiqStatus === 'success' || basiqStatus === 'completed';
    const resolvedStatus = isComplete && connectionId
      ? 'active'
      : isComplete
      ? 'pending'     // job done but no connectionId yet — frontend may retry once more
      : 'pending';    // still running

    return json({
      ok: true,
      status: resolvedStatus,
      connection_id: connectionId ?? null,
      job_status: basiqStatus,
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
