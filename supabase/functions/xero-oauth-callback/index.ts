/**
 * xero-oauth-callback — exchanges the OAuth code for tokens, fetches the
 * tenant list, stores encrypted tokens in `xero_integrations`.
 *
 * Input:  { organization_id: UUID, code: string, redirect_uri: string, state: string }
 * Output: { ok: true, tenant: {id, name}, auto_selected: boolean }
 *
 * Port of Loopletnumero `xero.controller.ts authCallback`. v1 auto-selects
 * the first tenant if multiple exist; multi-tenant pick UI is v1.5.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { encryptToken } from '../_shared/xero/crypto.ts';
import { verifyXeroOAuthState } from '../_shared/xero/oauthState.ts';

const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';

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
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!supabaseUrl || !serviceKey || !anonKey) {
      return json({ ok: false, error: 'Server config missing' }, 500);
    }

    const clientId = Deno.env.get('XERO_CLIENT_ID');
    const clientSecret = Deno.env.get('XERO_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      return json({ ok: false, error: 'Xero credentials not configured' }, 500);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const body = (await req.json()) as RequestBody;
    if (!body.organization_id || !body.code || !body.redirect_uri || !body.state) {
      return json({ ok: false, error: 'organization_id, code, redirect_uri, state required' }, 400);
    }

    // Verify caller has access to this org via RLS
    const { data: org, error: orgErr } = await userClient
      .from('organizations')
      .select('id')
      .eq('id', body.organization_id)
      .maybeSingle();
    if (orgErr || !org) return json({ ok: false, error: 'Organisation not accessible' }, 403);

    // CSRF + org binding: state is org.nonce.HMAC(org.nonce).
    if (!(await verifyXeroOAuthState(body.state, body.organization_id))) {
      return json({ ok: false, error: 'state mismatch' }, 400);
    }

    // 1. Exchange code for tokens
    const tokenResp = await fetch(XERO_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: body.code,
        redirect_uri: body.redirect_uri,
      }),
    });

    if (!tokenResp.ok) {
      const errText = await tokenResp.text();
      return json(
        {
          ok: false,
          error: `Token exchange failed (${tokenResp.status}): ${errText.slice(0, 200)}`,
        },
        400,
      );
    }

    const tokenData = (await tokenResp.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope?: string;
    };

    // 2. Fetch tenant connections
    const connResp = await fetch(XERO_CONNECTIONS_URL, {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'Content-Type': 'application/json',
      },
    });
    if (!connResp.ok) {
      return json({ ok: false, error: 'Failed to fetch Xero connections' }, 502);
    }

    const connections = (await connResp.json()) as {
      id: string;
      tenantId: string;
      tenantName: string;
      tenantType?: string;
    }[];

    if (!connections.length) {
      return json(
        { ok: false, error: 'No Xero organisations found on this account.' },
        400,
      );
    }

    // v1: auto-select the first tenant. Multi-tenant pick is v1.5.
    const picked = connections[0];
    if (!picked) {
      return json(
        { ok: false, error: 'No Xero organisations found on this account.' },
        400,
      );
    }

    const expiresAt = new Date(Date.now() + (tokenData.expires_in ?? 1800) * 1000).toISOString();
    const accessEnc = await encryptToken(tokenData.access_token);
    const refreshEnc = await encryptToken(tokenData.refresh_token);

    // 3. Upsert into xero_integrations (org_id + tenant_id is unique)
    const { error: upsertErr } = await admin
      .from('xero_integrations')
      .upsert(
        {
          organization_id: body.organization_id,
          xero_tenant_id: picked.tenantId,
          xero_tenant_name: picked.tenantName,
          access_token_encrypted: accessEnc,
          refresh_token_encrypted: refreshEnc,
          token_expires_at: expiresAt,
          scopes: tokenData.scope ?? null,
          is_enabled: true,
          last_error: null,
        },
        { onConflict: 'organization_id,xero_tenant_id' },
      );

    if (upsertErr) {
      return json({ ok: false, error: `DB upsert failed: ${upsertErr.message}` }, 500);
    }

    return json({
      ok: true,
      tenant: { id: picked.tenantId, name: picked.tenantName },
      auto_selected: true,
      multiple_tenants_available: connections.length > 1,
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
