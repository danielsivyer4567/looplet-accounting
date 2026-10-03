/**
 * bank-feed-accounts — list the Redbark accounts an organisation's admin can link, and which are already linked.
 *
 * Input:  { organization_id }
 * Output: { ok: true, accounts: [{ account_id, connection_id, name, institution, account_last4, status, link }] }
 *         status is linked | available | linked_elsewhere | not_aud (see accounts.ts).
 *
 * Auth: an accepted admin or owner of the organisation (or the exact service-role key), and the organisation must be
 * listed in REDBARK_ORGANIZATION_IDS: the server key can read every account on the Redbark login, so the list is
 * never shown to other organisations.
 * Secrets: REDBARK_API_KEY, REDBARK_ORGANIZATION_IDS.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { authorizeOrgCaller, supabaseOrgAccessDeps } from '../_shared/orgRole.ts';
import { FEED_NOT_ENABLED, feedOrganizationIds, isFeedOrganization } from '../_shared/bankfeed/access.ts';
import { createRedbarkClient, RedbarkError } from '../_shared/redbark/client.ts';
import { listFeedAccounts, type FeedConnectionOwner, type OrgFeedAccountRow } from './accounts.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) return json({ ok: false, error: 'Server config missing' }, 500);
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const body = (await req.json().catch(() => null)) as { organization_id?: unknown } | null;
    if (!body || typeof body.organization_id !== 'string' || !body.organization_id) {
      return json({ ok: false, error: 'organization_id required' }, 400);
    }
    const organizationId = body.organization_id;

    const access = await authorizeOrgCaller(
      req.headers.get('Authorization'),
      organizationId,
      supabaseOrgAccessDeps(admin, serviceKey),
      'admin',
    );
    if (!access.ok) return json({ ok: false, error: access.error }, access.status);
    if (!isFeedOrganization(feedOrganizationIds(Deno.env.get('REDBARK_ORGANIZATION_IDS')), organizationId)) {
      return json({ ok: false, error: FEED_NOT_ENABLED }, 403);
    }
    const apiKey = Deno.env.get('REDBARK_API_KEY');
    if (!apiKey) return json({ ok: false, error: 'The bank feed is not configured on the server.' }, 503);
    const client = createRedbarkClient(apiKey);

    const accounts = await listFeedAccounts(organizationId, {
      feedAccounts: () => client.accounts(),
      async connectionsFor(externalConnectionIds) {
        const { data, error } = await admin
          .from('bank_connections')
          .select('id, organization_id, external_item_id, status')
          .eq('provider', 'redbark')
          .in('external_item_id', externalConnectionIds);
        if (error) throw new Error(`connections: ${error.message}`);
        return (data ?? []) as FeedConnectionOwner[];
      },
      async accountsFor(orgId, bankConnectionIds) {
        const { data, error } = await admin
          .from('bank_accounts')
          .select('id, external_id, bank_connection_id, feed_sync_from, feed_covered_through, is_active')
          .eq('organization_id', orgId)
          .in('bank_connection_id', bankConnectionIds);
        if (error) throw new Error(`accounts: ${error.message}`);
        return (data ?? []) as OrgFeedAccountRow[];
      },
    });
    return json({ ok: true, accounts });
  } catch (err) {
    if (err instanceof RedbarkError) return json({ ok: false, error: err.message }, 502);
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
