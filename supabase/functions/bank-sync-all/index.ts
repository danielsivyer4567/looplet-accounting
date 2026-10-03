/**
 * bank-sync-all — fan-out cron entry point.
 *
 * Selects every distinct organization_id with an active Redbark connection,
 * limited to the organisations allowed to use the feed (REDBARK_ORGANIZATION_IDS),
 * and invokes bank-sync once per org via HTTP (so each org's sync is its own
 * isolated execution / log line / failure boundary).
 *
 * Trigger via pg_cron every 6 hours (cron expression: 0 every-6-hours * * *):
 *   SELECT cron.schedule(
 *     'bank-sync-all',
 *     '0 0,6,12,18 * * *',
 *     $$ SELECT net.http_post(
 *          url := 'https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/bank-sync-all?secret='
 *            || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'bank_sync_all_cron_secret' LIMIT 1),
 *          headers := jsonb_build_object('Content-Type','application/json')
 *        ); $$
 *   );
 *
 * Deployed with --no-verify-jwt because pg_cron calls this without a Supabase
 * user JWT. The handler does its own exact secret/service-role check.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { feedOrganizationIds } from '../_shared/bankfeed/access.ts';
import { isExactSecret, isExactServiceRoleBearer } from '../_shared/serviceRole.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const cronSecret = Deno.env.get('BANK_SYNC_ALL_CRON_SECRET');
    if (!supabaseUrl || !serviceKey || !cronSecret) {
      return json(
        { ok: false, error: 'Server config missing (need BANK_SYNC_ALL_CRON_SECRET)' },
        500,
      );
    }

    // SECURITY: deployed --no-verify-jwt because pg_cron calls this. Gate
    // access on a URL-query secret OR service-role bearer. Anything else =
    // 403, no information about org_ids leaks in the response.
    const url = new URL(req.url);
    const urlSecret = url.searchParams.get('secret');
    const authHeader = req.headers.get('Authorization') ?? '';
    // Exact service-role key OR ?secret= — both constant-time. The previous
    // "base64-decode the JWT and trust its role claim" path was forgeable
    // (any token whose UNVERIFIED payload said role=service_role passed). Removed.
    // See AUDIT.md §3d.
    const isServiceRole = isExactServiceRoleBearer(authHeader, serviceKey);
    const secretOk = isExactSecret(urlSecret, cronSecret);
    if (!isServiceRole && !secretOk) {
      return json({ ok: false, error: 'forbidden' }, 403);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const allowed = feedOrganizationIds(Deno.env.get('REDBARK_ORGANIZATION_IDS'));
    if (allowed.size === 0) return json({ ok: true, orgs: 0, results: [] });

    const { data: rows, error } = await admin
      .from('bank_connections')
      .select('organization_id')
      .eq('provider', 'redbark')
      .eq('status', 'active')
      .in('organization_id', [...allowed]);
    if (error) return json({ ok: false, error: error.message }, 500);

    const orgIds = Array.from(
      new Set((rows ?? []).map((r: { organization_id: string }) => r.organization_id)),
    );

    const results: { org: string; ok: boolean; detail?: unknown }[] = [];
    for (const orgId of orgIds) {
      try {
        const res = await fetch(`${supabaseUrl}/functions/v1/bank-sync`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${serviceKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ organization_id: orgId }),
        });
        const detail = await res.json().catch(() => ({}));
        results.push({ org: orgId, ok: res.ok, detail });
      } catch (err) {
        results.push({ org: orgId, ok: false, detail: { error: String(err) } });
      }
    }

    return json({ ok: true, orgs: orgIds.length, results });
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
