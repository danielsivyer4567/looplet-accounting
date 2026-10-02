/**
 * gmail-oauth-callback — exchanges the OAuth code for tokens, registers
 * users.watch(), and stores everything in `gmail_integrations`.
 *
 * Input:  { organization_id, code, redirect_uri, state }
 * Output: { ok: true, gmail_address, watch_expires_at, history_id }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { oauthStateSecret, verifyOAuthState } from '../_shared/oauthState.ts';
import { authorizeOrgCaller, supabaseOrgAccessDeps } from '../_shared/orgRole.ts';
import { encryptToken } from '../_shared/xero/crypto.ts';
import { registerGmailWatch } from '../_shared/gmail/auth.ts';

const GMAIL_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

interface RequestBody {
  organization_id: string;
  code: string;
  redirect_uri: string;
  state: string;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ ok: false, error: 'Unauthorized' }, 401);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const clientId = Deno.env.get('GMAIL_CLIENT_ID');
    const clientSecret = Deno.env.get('GMAIL_CLIENT_SECRET');
    const topicName = Deno.env.get('GMAIL_PUBSUB_TOPIC');

    if (!supabaseUrl || !serviceKey || !clientId || !clientSecret || !topicName) {
      return json({ ok: false, error: 'Server config missing (check GMAIL_* secrets)' }, 500);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const body = (await req.json()) as RequestBody;
    if (!body.organization_id || !body.code || !body.redirect_uri || !body.state) {
      return json({ ok: false, error: 'organization_id, code, redirect_uri, state required' }, 400);
    }

    // Only an accepted admin or owner of the org, signed in as themselves, may finish connecting a mailbox.
    const access = await authorizeOrgCaller(authHeader, body.organization_id, supabaseOrgAccessDeps(admin, serviceKey), 'admin');
    if (!access.ok) return json({ ok: false, error: access.error }, access.status);
    if (access.caller.kind !== 'member') return json({ ok: false, error: 'Unauthorized' }, 401);

    // CSRF and account-injection guard: the signed state is mandatory and must have been issued to this user, for this
    // org, recently. Before this, a missing state skipped the check and an org-id prefix was enough.
    const stateCheck = await verifyOAuthState(body.state, { provider: 'gmail', organizationId: body.organization_id, userId: access.caller.userId }, oauthStateSecret('gmail'));
    if (!stateCheck.ok) return json({ ok: false, error: `state mismatch: ${stateCheck.reason}` }, 400);

    // 1. Exchange code → tokens
    const tokenResp = await fetch(GMAIL_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: body.code,
        redirect_uri: body.redirect_uri,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!tokenResp.ok) {
      const t = await tokenResp.text();
      return json(
        { ok: false, error: `Token exchange failed (${tokenResp.status}): ${t.slice(0, 300)}` },
        400,
      );
    }

    const tok = (await tokenResp.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };

    if (!tok.refresh_token) {
      // Happens if the user previously authorised without prompt=consent
      return json(
        {
          ok: false,
          error: 'No refresh_token returned. Revoke at https://myaccount.google.com/permissions and reconnect.',
        },
        400,
      );
    }

    // 2. Get gmail address from profile
    const profResp = await fetch(GMAIL_PROFILE_URL, {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    if (!profResp.ok) {
      return json({ ok: false, error: 'Failed to fetch Gmail profile' }, 502);
    }
    const prof = (await profResp.json()) as { emailAddress: string };

    // 3. Register watch() so Google starts publishing notifications
    const watch = await registerGmailWatch(tok.access_token, topicName);

    // 4. Encrypt and persist
    const accessExp = new Date(Date.now() + (tok.expires_in - 60) * 1000);
    const accessEnc = await encryptToken(tok.access_token);
    const refreshEnc = await encryptToken(tok.refresh_token);

    const { error: upsertErr } = await admin
      .from('gmail_integrations')
      .upsert(
        {
          organization_id: body.organization_id,
          gmail_address: prof.emailAddress,
          encrypted_refresh_token: refreshEnc,
          encrypted_access_token: accessEnc,
          access_token_expires_at: accessExp.toISOString(),
          last_history_id: watch.historyId,
          watch_expires_at: watch.expiration.toISOString(),
          is_active: true,
          last_error: null,
          created_by: access.caller.userId,
        },
        { onConflict: 'organization_id,gmail_address' },
      );

    if (upsertErr) {
      return json({ ok: false, error: `DB upsert failed: ${upsertErr.message}` }, 500);
    }

    return json({
      ok: true,
      gmail_address: prof.emailAddress,
      watch_expires_at: watch.expiration.toISOString(),
      history_id: watch.historyId,
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
