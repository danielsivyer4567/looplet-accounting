/**
 * bank-webhook — Redbark transaction webhook receiver.
 *
 * Redbark sends a signed `transactions.synced` event when it has new or updated transactions. The event is a wake-up
 * signal: it is verified, stored in bank_events_raw, and then one bank-sync runs per linked connection, which reads
 * the transactions from the Redbark REST API. See handler.ts for the order of work and why syncs run after the
 * acknowledgement.
 *
 * Auth: deployed with verify_jwt = false because Redbark sends no Supabase JWT. The HMAC-SHA256 signature over
 * "<X-Redbark-Timestamp>.<raw body>" with REDBARK_WEBHOOK_SECRET is the only gate, and an unset secret refuses every
 * delivery (fail closed).
 *
 * Secrets: REDBARK_WEBHOOK_SECRET (the destination's signing secret), REDBARK_ORGANIZATION_IDS (organisations allowed
 * to use the feed), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { feedOrganizationIds } from '../_shared/bankfeed/access.ts';
// Importing the shared CORS module also installs the response wrapper (generic 5xx bodies, per-origin headers).
import { corsHeaders } from '../_shared/cors.ts';
import { handleBankWebhook, type LinkedConnection } from './handler.ts';

interface LinkedAccountRow {
  bank_connection_id: string;
  organization_id: string;
}

Deno.serve(async (req) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ ok: false, error: 'Server config missing' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return await handleBankWebhook(req, {
    secret: Deno.env.get('REDBARK_WEBHOOK_SECRET'),
    allowedOrganizationIds: feedOrganizationIds(Deno.env.get('REDBARK_ORGANIZATION_IDS')),

    async findLinkedConnections(accountIds) {
      const { data, error } = await admin
        .from('bank_accounts')
        .select('bank_connection_id, organization_id, bank_connections!inner(provider, status)')
        .in('external_id', accountIds)
        .eq('is_active', true)
        .eq('bank_connections.provider', 'redbark')
        .eq('bank_connections.status', 'active');
      if (error) throw new Error(`linked account lookup failed: ${error.message}`);
      return ((data ?? []) as LinkedAccountRow[]).map((row) => ({
        id: row.bank_connection_id,
        organization_id: row.organization_id,
      }));
    },

    async storeEvent(row) {
      const { error } = await admin.from('bank_events_raw').insert(row);
      if (!error) return 'stored';
      // Exact re-delivery of an event already stored (same provider, organisation, event id and payload hash).
      if (error.code === '23505') return 'duplicate';
      throw new Error(`${error.code ?? ''} ${error.message}`.trim());
    },

    async dispatchSync(connection: LinkedConnection) {
      await admin
        .from('bank_connections')
        .update({ webhook_received_at: new Date().toISOString() })
        .eq('id', connection.id);
      const syncResponse = await fetch(`${supabaseUrl}/functions/v1/bank-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceKey}` },
        body: JSON.stringify({ organization_id: connection.organization_id, bank_connection_id: connection.id }),
      });
      const detail = await syncResponse.text().catch(() => '');
      if (!syncResponse.ok) throw new Error(`bank-sync dispatch failed: HTTP ${syncResponse.status} ${detail.slice(0, 300)}`.trim());
    },

    async recordDispatchFailure(connection, message) {
      console.error(JSON.stringify({ event: 'bankfeed.webhook_sync_failed', connection: connection.id, message }));
      const status = /HTTP (\d{3})/.exec(message)?.[1];
      await admin
        .from('bank_connections')
        .update({
          last_error: `A sync started by a Redbark notification failed${status ? ` (HTTP ${status})` : ''}. The scheduled sync will try again.`,
        })
        .eq('id', connection.id);
    },

    background(work) {
      const runtime = (globalThis as { EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void } }).EdgeRuntime;
      if (runtime) runtime.waitUntil(work);
      else void work;
    },
  });
});
