/**
 * gmail-oauth-start — returns a Google OAuth consent URL the frontend can
 * redirect to. Only an accepted admin or owner may start a connection. The
 * state is HMAC-signed and bound to this user, this organisation and a
 * 15-minute window (_shared/oauthState.ts); the browser keeps a copy and the
 * callback page refuses a state it did not store.
 *
 * Input:  { organization_id: UUID, redirect_uri: string }
 * Output: { ok: true, url: string }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { createOAuthState, oauthStateSecret } from '../_shared/oauthState.ts';
import { authorizeOrgCaller, supabaseOrgAccessDeps } from '../_shared/orgRole.ts';

const GMAIL_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

// gmail.readonly covers headers, body, and attachments. We initially also
// requested gmail.metadata, but Google rejects messages.list `q=` filtering
// whenever the metadata scope is granted ("Metadata scope does not support
// 'q' parameter"), even if readonly is also granted.
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ ok: false, error: 'Unauthorized' }, 401);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const clientId = Deno.env.get('GMAIL_CLIENT_ID');
    if (!supabaseUrl || !serviceKey || !clientId) {
      return json({ ok: false, error: 'Server config missing' }, 500);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const body = (await req.json()) as { organization_id?: string; redirect_uri?: string };
    if (!body.organization_id || !body.redirect_uri) {
      return json({ ok: false, error: 'organization_id and redirect_uri required' }, 400);
    }

    // Connecting a mailbox lets the app read its email for bills: accepted admins and owners only.
    const access = await authorizeOrgCaller(authHeader, body.organization_id, supabaseOrgAccessDeps(admin, serviceKey), 'admin');
    if (!access.ok) return json({ ok: false, error: access.error }, access.status);
    if (access.caller.kind !== 'member') return json({ ok: false, error: 'Connect Gmail from a signed-in session' }, 401);

    const state = await createOAuthState({ provider: 'gmail', organizationId: body.organization_id, userId: access.caller.userId }, oauthStateSecret('gmail'));

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: body.redirect_uri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline', // ensures refresh_token in callback
      prompt: 'consent', // forces refresh_token even on re-auth
      state,
      include_granted_scopes: 'true',
    });

    return json({ ok: true, url: `${GMAIL_AUTH_URL}?${params.toString()}`, state });
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
