/**
 * gmail-oauth-start — returns a Google OAuth consent URL the frontend can
 * redirect to. State carries the org_id so the callback knows where to
 * file the integration.
 *
 * Input:  { organization_id: UUID, redirect_uri: string }
 * Output: { ok: true, url: string }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';

const GMAIL_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

// Minimum scopes for read-only access to attachments + metadata
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.metadata',
];

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ ok: false, error: 'Unauthorized' }, 401);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const clientId = Deno.env.get('GMAIL_CLIENT_ID');
    if (!supabaseUrl || !anonKey || !clientId) {
      return json({ ok: false, error: 'Server config missing' }, 500);
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const body = (await req.json()) as { organization_id?: string; redirect_uri?: string };
    if (!body.organization_id || !body.redirect_uri) {
      return json({ ok: false, error: 'organization_id and redirect_uri required' }, 400);
    }

    // Verify caller can access this org via RLS
    const { data: org, error: orgErr } = await userClient
      .from('organizations')
      .select('id')
      .eq('id', body.organization_id)
      .maybeSingle();
    if (orgErr || !org) return json({ ok: false, error: 'Organisation not accessible' }, 403);

    // CSRF state: prefix with org id so callback can verify
    const state = `${body.organization_id}.${crypto.randomUUID()}`;

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
