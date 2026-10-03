/**
 * bank-feed-link — link one Redbark account to a bank account in an organisation, with an import-from date.
 *
 * Input:  { organization_id, connection_id, account_id, sync_from: 'YYYY-MM-DD' }  (Redbark connection and account ids)
 * Output: { ok: true, bank_connection_id, bank_account_id, sync_from }
 *
 * Auth: an accepted admin or owner of the organisation (or the exact service-role key), and the organisation must be
 * listed in REDBARK_ORGANIZATION_IDS. Writes use the service role: signed-in users cannot write Redbark links directly
 * (migration 20261003140100). The first import is not started here; the caller queues a bank_sync job.
 * Secrets: REDBARK_API_KEY, REDBARK_ORGANIZATION_IDS.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { authorizeOrgCaller, supabaseOrgAccessDeps } from '../_shared/orgRole.ts';
import { FEED_NOT_ENABLED, feedOrganizationIds, isFeedOrganization } from '../_shared/bankfeed/access.ts';
import { createRedbarkClient, RedbarkError } from '../_shared/redbark/client.ts';
import { feedToday } from '../_shared/redbark/history.ts';
import { linkFeedAccount, type FeedConnectionRow } from './link.ts';

interface RequestBody {
  organization_id?: string;
  connection_id?: unknown;
  account_id?: unknown;
  sync_from?: unknown;
}

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

    const body = (await req.json().catch(() => null)) as RequestBody | null;
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

    const result = await linkFeedAccount(
      {
        organizationId,
        connectionId: body.connection_id,
        accountId: body.account_id,
        syncFrom: body.sync_from,
        userId: access.caller.kind === 'member' ? access.caller.userId : null,
        today: feedToday(),
      },
      {
        feedAccounts: () => client.accounts(),
        async findConnection(externalConnectionId) {
          const { data, error } = await admin
            .from('bank_connections')
            .select('id, organization_id, status')
            .eq('provider', 'redbark')
            .eq('external_item_id', externalConnectionId)
            .maybeSingle();
          if (error) throw new Error(`connection lookup: ${error.message}`);
          return data as FeedConnectionRow | null;
        },
        async createConnection(row) {
          const { data, error } = await admin.from('bank_connections').insert(row).select('id').single();
          if (error?.code === '23505') return 'conflict';
          if (error || !data) throw new Error(`connection create: ${error?.message ?? 'no row returned'}`);
          return { id: (data as { id: string }).id };
        },
        async reactivateConnection(id) {
          const { error } = await admin
            .from('bank_connections')
            .update({ status: 'active', last_error: null, updated_at: new Date().toISOString() })
            .eq('id', id)
            .eq('organization_id', organizationId);
          if (error) throw new Error(`connection reactivate: ${error.message}`);
        },
        async upsertAccount(row) {
          const { data, error } = await admin
            .from('bank_accounts')
            .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'organization_id,bank_connection_id,external_id' })
            .select('id')
            .single();
          if (error || !data) throw new Error(`account link: ${error?.message ?? 'no row returned'}`);
          return { id: (data as { id: string }).id };
        },
      },
    );
    if (!result.ok) return json({ ok: false, error: result.error }, result.status);
    return json(result);
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
