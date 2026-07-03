/**
 * bank-disconnect — actually tear down a Basiq connection, not just hide it.
 *
 * BankConnect.tsx's "Disable" action used to only flip our own bank_connections
 * row to status='revoked' and deactivate bank_accounts — the Basiq-side consent
 * stayed live forever, which is both a CDR compliance gap (a user disabling
 * access in-app should actually revoke it upstream) and a cost leak (an
 * un-purged connection may keep counting as billable on Basiq's side).
 *
 * This purges the connection's data at Basiq (POST .../purge — Basiq's docs:
 * "removes all user data related to a specific institution"), then applies the
 * same local revocation BankConnect.tsx already did. Purge only works on an
 * active connection per Basiq's API, so a best-effort purge failure (e.g. the
 * connection is already inactive on Basiq's side) does not block the local
 * revoke — the user's intent (stop syncing this bank) must always succeed
 * locally even if the upstream call errors.
 *
 * Input:  { organization_id, bank_connection_id }
 * Output: { ok: true, purged: boolean, purge_error?: string }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { purgeConnection } from '../_shared/basiq/client.ts';

interface RequestBody {
  organization_id: string;
  bank_connection_id: string;
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
    if (!body.organization_id || !body.bank_connection_id) {
      return json({ ok: false, error: 'organization_id and bank_connection_id required' }, 400);
    }

    // RLS check: caller must actually have access to this org.
    const { data: org } = await userClient
      .from('organizations')
      .select('id, basiq_user_id')
      .eq('id', body.organization_id)
      .maybeSingle();
    if (!org) return json({ ok: false, error: 'Organisation not accessible' }, 403);

    // Load the connection (RLS-scoped read, still via userClient) to get Basiq's
    // external_item_id — the local bank_connections.id is NOT the Basiq connection id.
    const { data: conn, error: connErr } = await userClient
      .from('bank_connections')
      .select('id, provider, external_item_id, status, metadata')
      .eq('id', body.bank_connection_id)
      .eq('organization_id', body.organization_id)
      .maybeSingle();
    if (connErr || !conn) return json({ ok: false, error: 'Bank connection not found' }, 404);

    let purged = false;
    let purgeError: string | undefined;

    if (conn.provider === 'basiq' && org.basiq_user_id && conn.external_item_id) {
      try {
        await purgeConnection(org.basiq_user_id, conn.external_item_id);
        purged = true;
      } catch (e) {
        // Best-effort: log but do not block the local revoke below. Common benign
        // cause: the connection is already inactive on Basiq's side (purge only
        // applies to active connections), which isn't something the user needs to
        // retry over — the outcome they want (stop syncing) still gets applied.
        purgeError = e instanceof Error ? e.message : String(e);
      }
    }

    const disabledAt = new Date().toISOString();
    const { error: updErr } = await admin
      .from('bank_connections')
      .update({
        status: 'revoked',
        last_error: purgeError ? `purge_failed: ${purgeError}` : null,
        updated_at: disabledAt,
        metadata: {
          ...(conn.metadata ?? {}),
          disabled_at: disabledAt,
          basiq_purged: purged,
        },
      })
      .eq('id', conn.id)
      .eq('organization_id', body.organization_id);
    if (updErr) return json({ ok: false, error: `revoke: ${updErr.message}` }, 500);

    const { error: acctErr } = await admin
      .from('bank_accounts')
      .update({ is_active: false, updated_at: disabledAt })
      .eq('bank_connection_id', conn.id)
      .eq('organization_id', body.organization_id);
    if (acctErr) return json({ ok: false, error: `deactivate accounts: ${acctErr.message}` }, 500);

    return json({ ok: true, purged, purge_error: purgeError });
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
