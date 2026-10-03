/**
 * bank-disconnect — stop a bank feed in Looplet (local unlink only).
 *
 * Marks the organisation's bank connection 'revoked' and its accounts inactive, so bank-sync, bank-sync-all and
 * bank-webhook stop importing for it. Transactions already imported stay in the books. Nothing is changed at Redbark:
 * the bank connection there belongs to the Redbark login and is managed or removed in Redbark itself. Linking an
 * account again (bank-feed-link) reactivates the connection.
 *
 * Input:  { organization_id, bank_connection_id }
 * Output: { ok: true }
 *
 * Auth: an accepted admin or owner of the organisation (or the exact service-role key). Writes use the service role:
 * signed-in users cannot change Redbark links directly (migration 20261003140100).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { authorizeOrgCaller, supabaseOrgAccessDeps } from '../_shared/orgRole.ts';

interface RequestBody {
  organization_id?: unknown;
  bank_connection_id?: unknown;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) {
      return json({ ok: false, error: 'Server config missing' }, 500);
    }
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const body = (await req.json().catch(() => null)) as RequestBody | null;
    if (!body || typeof body.organization_id !== 'string' || typeof body.bank_connection_id !== 'string') {
      return json({ ok: false, error: 'organization_id and bank_connection_id required' }, 400);
    }
    const organizationId = body.organization_id;

    const access = await authorizeOrgCaller(
      req.headers.get('Authorization'),
      organizationId,
      supabaseOrgAccessDeps(admin, serviceKey),
      'admin',
    );
    if (!access.ok) return json({ ok: false, error: access.error }, access.status);

    const { data: conn, error: connErr } = await admin
      .from('bank_connections')
      .select('id, metadata')
      .eq('id', body.bank_connection_id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (connErr) return json({ ok: false, error: `connection lookup: ${connErr.message}` }, 500);
    if (!conn) return json({ ok: false, error: 'Bank connection not found' }, 404);

    const disabledAt = new Date().toISOString();
    const { error: updErr } = await admin
      .from('bank_connections')
      .update({
        status: 'revoked',
        last_error: null,
        updated_at: disabledAt,
        metadata: {
          ...((conn.metadata as Record<string, unknown> | null) ?? {}),
          disabled_at: disabledAt,
          disabled_by: access.caller.kind === 'member' ? access.caller.userId : 'service',
        },
      })
      .eq('id', conn.id)
      .eq('organization_id', organizationId);
    if (updErr) return json({ ok: false, error: `revoke: ${updErr.message}` }, 500);

    const { error: acctErr } = await admin
      .from('bank_accounts')
      .update({ is_active: false, updated_at: disabledAt })
      .eq('bank_connection_id', conn.id)
      .eq('organization_id', organizationId);
    if (acctErr) return json({ ok: false, error: `deactivate accounts: ${acctErr.message}` }, 500);

    return json({ ok: true });
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
