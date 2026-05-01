/**
 * xero-oauth-start — initiates the Xero OAuth flow for the current org.
 *
 * Input:  { organization_id: UUID, redirect_uri: string }
 * Output: { auth_url: string, state: string }
 *
 * The frontend stashes `state` in localStorage (or a server session) and
 * verifies on the callback to prevent CSRF.
 *
 * STATUS: skeleton. Port from Loopletnumero `xero.controller.ts authStart`.
 */

import { corsHeaders, preflight } from '../_shared/cors.ts';

const XERO_AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
const DEFAULT_SCOPES =
  'openid profile email offline_access accounting.invoices accounting.contacts accounting.settings.read';

Deno.serve((req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const clientId = Deno.env.get('XERO_CLIENT_ID');
    if (!clientId) {
      return json({ ok: false, error: 'XERO_CLIENT_ID not configured' }, 500);
    }

    return req.json().then((body: { organization_id?: string; redirect_uri?: string }) => {
      if (!body.organization_id || !body.redirect_uri) {
        return json({ ok: false, error: 'organization_id and redirect_uri required' }, 400);
      }

      // CSRF state encodes the org id so callback can route to the right org.
      // TODO Phase 3.4: sign state with HMAC so it can't be forged.
      const state = `${body.organization_id}.${crypto.randomUUID()}`;

      const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: body.redirect_uri,
        scope: Deno.env.get('XERO_SCOPES') ?? DEFAULT_SCOPES,
        state,
      });

      return json({ ok: true, auth_url: `${XERO_AUTHORIZE_URL}?${params.toString()}`, state });
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
