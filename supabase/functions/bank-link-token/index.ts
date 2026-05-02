/**
 * bank-link-token — start Basiq Connect flow.
 *
 * Input:  { organization_id, redirect_uri?: string }
 * Output: { ok: true, url: string, expires_at: string, basiq_user_id: string }
 *
 * Frontend redirects user to `url`. After user completes Connect on Basiq's
 * hosted UI, Basiq redirects to redirect_uri with `?jobId=...&userId=...`.
 * Frontend then calls bank-exchange with the resulting connection_id.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { getOrCreateBasiqUser, createAuthLink } from '../_shared/basiq/client.ts';

interface RequestBody {
  organization_id: string;
  redirect_uri?: string;
  email?: string;          // override; defaults to caller's auth.users email
  mobile?: string;
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
    if (!body.organization_id) {
      return json({ ok: false, error: 'organization_id required' }, 400);
    }

    // RLS check
    const { data: org, error: orgErr } = await userClient
      .from('organizations')
      .select('id, name')
      .eq('id', body.organization_id)
      .maybeSingle();
    if (orgErr || !org) return json({ ok: false, error: 'Organisation not accessible' }, 403);

    const { data: { user } } = await userClient.auth.getUser();
    const email = body.email ?? user?.email;
    if (!email) return json({ ok: false, error: 'No email available for Basiq user' }, 400);

    const basiqUserId = await getOrCreateBasiqUser(admin, body.organization_id, email, body.mobile);
    const link = await createAuthLink(basiqUserId, body.redirect_uri);

    return json({
      ok: true,
      url: link.url,
      expires_at: link.expiresAt,
      basiq_user_id: basiqUserId,
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
