/**
 * xero-oauth-start — initiates the Xero OAuth flow for the current org.
 *
 * Input:  { organization_id: UUID, redirect_uri: string }
 * Output: { auth_url: string, state: string }
 *
 * Only an accepted admin or owner may start a connection. The returned state is
 * HMAC-signed and bound to this user, this organisation and a 15-minute window
 * (_shared/oauthState.ts); the browser also keeps a copy in sessionStorage and
 * the callback page refuses a state it did not store.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { createOAuthState, oauthStateSecret } from '../_shared/oauthState.ts';
import { authorizeOrgCaller, supabaseOrgAccessDeps } from '../_shared/orgRole.ts';

const XERO_AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
// Fine-grained scopes Xero actually grants for this app (verified against a live
// token). Overridable via XERO_SCOPES (set in prod to exactly this list so a
// reconnect can't silently narrow access). Covers bank transactions, payments,
// and P&L/Balance-Sheet/Aged reports for the pull-first model.
const DEFAULT_SCOPES =
  'openid profile email offline_access accounting.invoices accounting.contacts accounting.settings.read accounting.payments accounting.attachments accounting.reports.aged.read accounting.reports.profitandloss.read accounting.reports.balancesheet.read accounting.banktransactions';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const clientId = Deno.env.get('XERO_CLIENT_ID');
    if (!clientId) {
      return json({ ok: false, error: 'XERO_CLIENT_ID not configured' }, 500);
    }

    const body = (await req.json().catch(() => ({}))) as {
      organization_id?: string;
      redirect_uri?: string;
    };
    if (!body.organization_id || !body.redirect_uri) {
      return json({ ok: false, error: 'organization_id and redirect_uri required' }, 400);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) return json({ ok: false, error: 'Server config missing' }, 500);
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Connecting Xero lets the app read and write this organisation's books in Xero: accepted admins and owners only.
    const access = await authorizeOrgCaller(
      req.headers.get('Authorization'),
      body.organization_id,
      supabaseOrgAccessDeps(admin, serviceKey),
      'admin',
    );
    if (!access.ok) return json({ ok: false, error: access.error }, access.status);
    if (access.caller.kind !== 'member') return json({ ok: false, error: 'Connect Xero from a signed-in session' }, 401);

    const state = await createOAuthState({ provider: 'xero', organizationId: body.organization_id, userId: access.caller.userId }, oauthStateSecret('xero'));

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: body.redirect_uri,
      scope: Deno.env.get('XERO_SCOPES') ?? DEFAULT_SCOPES,
      state,
    });

    return json({ ok: true, auth_url: `${XERO_AUTHORIZE_URL}?${params.toString()}`, state });
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
