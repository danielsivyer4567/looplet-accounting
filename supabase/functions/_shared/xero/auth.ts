/**
 * Xero auth + retry — Deno port of Loopletnumero `services/accounting/xeroAuth.ts`.
 * Same contract: load, refresh on demand with 60s buffer, persist rotated
 * refresh tokens, retry once on 401, surface 429 with Retry-After.
 *
 * Single source of truth — never write fresh refresh logic anywhere else.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { encryptToken, decryptToken } from './crypto.ts';

export class XeroApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'XeroApiError';
    this.status = status;
  }
}

export interface XeroContext {
  accessToken: string;
  tenantId: string;
  organizationId: string;
}

const REFRESH_BUFFER_MS = 60_000;

function getCreds(): { clientId: string; clientSecret: string } {
  const clientId = Deno.env.get('XERO_CLIENT_ID');
  const clientSecret = Deno.env.get('XERO_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    throw new XeroApiError(
      'Xero credentials not configured (XERO_CLIENT_ID / XERO_CLIENT_SECRET)',
      500,
    );
  }
  return { clientId, clientSecret };
}

async function flagConnectionError(
  admin: SupabaseClient,
  organizationId: string,
  errorMessage: string,
  disable: boolean,
): Promise<void> {
  const update: Record<string, unknown> = {
    last_error: errorMessage.slice(0, 500),
    updated_at: new Date().toISOString(),
  };
  if (disable) update.is_enabled = false;
  await admin.from('xero_integrations').update(update).eq('organization_id', organizationId);
}

export async function loadAndRefreshXero(
  admin: SupabaseClient,
  organizationId: string,
  forceRefresh = false,
): Promise<XeroContext> {
  const { data: integration, error } = await admin
    .from('xero_integrations')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('is_enabled', true)
    .maybeSingle();

  if (error) throw new XeroApiError(`xero_integrations read failed: ${error.message}`, 500);
  if (!integration) throw new XeroApiError('Xero is not connected for this organisation', 404);
  if (!integration.xero_tenant_id) {
    throw new XeroApiError('Xero tenant not selected. Pick an organisation.', 400);
  }

  const expiresAt = new Date(integration.token_expires_at);
  const needsRefresh =
    forceRefresh || !expiresAt || expiresAt.getTime() - Date.now() < REFRESH_BUFFER_MS;

  if (!needsRefresh) {
    return {
      accessToken: await decryptToken(integration.access_token_encrypted),
      tenantId: integration.xero_tenant_id,
      organizationId,
    };
  }

  // Refresh path
  const { clientId, clientSecret } = getCreds();
  const refreshToken = await decryptToken(integration.refresh_token_encrypted);

  const refreshResp = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!refreshResp.ok) {
    const errText = await refreshResp.text();
    const fatal = refreshResp.status === 400 || refreshResp.status === 401;
    await flagConnectionError(
      admin,
      organizationId,
      `Xero refresh failed (${refreshResp.status}): ${errText.slice(0, 200)}`,
      fatal,
    );
    throw new XeroApiError('Xero refresh failed. Please reconnect.', 401);
  }

  const refreshData = (await refreshResp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  // CRITICAL: Xero rotates refresh tokens and invalidates the OLD one the instant the
  // new one is issued. The new refresh token exists only in-memory until this update()
  // persists it — and supabase-js returns { error } rather than throwing, so a
  // silently-dropped error here would re-send the now-invalid old token next time and
  // permanently wedge the org. Persist with a short retry, then fail loudly if it
  // still won't stick (surfaces the failure; a genuine persist loss may need reconnect).
  const newAccess = refreshData.access_token;
  const newRefresh = refreshData.refresh_token ?? refreshToken;
  const tokenUpdate = {
    access_token_encrypted: await encryptToken(newAccess),
    refresh_token_encrypted: await encryptToken(newRefresh),
    token_expires_at: new Date(Date.now() + (refreshData.expires_in ?? 1800) * 1000).toISOString(),
    last_error: null,
    updated_at: new Date().toISOString(),
  };
  let persistErr: { message: string } | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { error: err } = await admin
      .from('xero_integrations')
      .update(tokenUpdate)
      .eq('id', integration.id);
    if (!err) {
      persistErr = null;
      break;
    }
    persistErr = err;
    if (attempt < 2) await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }
  if (persistErr) {
    throw new XeroApiError(
      `Xero token rotated but persistence failed — reconnect may be required: ${persistErr.message}`,
      500,
    );
  }

  return {
    accessToken: newAccess,
    tenantId: integration.xero_tenant_id,
    organizationId,
  };
}

export async function xeroFetch(
  ctx: XeroContext,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = path.startsWith('http') ? path : `https://api.xero.com${path}`;
  return await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${ctx.accessToken}`,
      'Xero-tenant-id': ctx.tenantId,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

/**
 * Wraps a Xero call with token refresh + one 401 retry + 429 passthrough.
 * Returns the parsed JSON body; throws XeroApiError on any non-OK status.
 */
export async function callXeroWithRetry<T = unknown>(
  admin: SupabaseClient,
  organizationId: string,
  doCall: (ctx: XeroContext) => Promise<Response>,
): Promise<T> {
  let ctx = await loadAndRefreshXero(admin, organizationId);
  let response = await doCall(ctx);

  if (response.status === 401) {
    ctx = await loadAndRefreshXero(admin, organizationId, true);
    response = await doCall(ctx);
  }

  // Transient throttle/5xx: back off once (honouring Retry-After) and retry, rather
  // than treating a temporary condition as fatal and burning the caller's attempt.
  if (response.status === 429 || response.status >= 500) {
    const retryAfter = parseInt(response.headers.get('Retry-After') ?? '', 10);
    const waitSecs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) : 5;
    await new Promise((r) => setTimeout(r, waitSecs * 1000));
    response = await doCall(ctx);
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After') ?? '60';
    throw new XeroApiError(`Xero rate limit. Retry after ${retryAfter}s.`, 429);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new XeroApiError(
      `Xero API error (${response.status}): ${text.slice(0, 500)}`,
      response.status,
    );
  }

  // Mark sync time
  await admin
    .from('xero_integrations')
    .update({ last_synced_at: new Date().toISOString(), last_error: null })
    .eq('organization_id', organizationId);

  return (await response.json()) as T;
}
