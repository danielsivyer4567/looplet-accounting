/**
 * Gmail OAuth + token refresh shared helper.
 * Mirrors the structure of `_shared/xero/auth.ts` so the patterns rhyme.
 *
 * Tokens are encrypted with the same AES-GCM key as Xero (ENCRYPTION_KEY env).
 * We refresh proactively if the cached access token is within 60s of expiry.
 */

import { encryptToken, decryptToken } from '../xero/crypto.ts';

const GMAIL_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface GmailTokens {
  accessToken: string;
  expiresAt: Date;
  refreshToken: string;
}

interface IntegrationRow {
  id: string;
  organization_id: string;
  gmail_address: string | null;
  encrypted_refresh_token: string;
  encrypted_access_token: string | null;
  access_token_expires_at: string | null;
}

/**
 * Thrown when a Gmail token refresh fails fatally (revoked grant / dead
 * connection) — i.e. an HTTP 400/401 or an `invalid_grant` body from Google.
 * Callers can `instanceof`-check this to distinguish "this mailbox is dead,
 * stop trying" from a transient blip (5xx / network) worth retrying.
 *
 * Before this is thrown, the integration has already been flagged via
 * `flagGmailConnectionError()` (is_active=false + last_error + in-app notify),
 * so callers do NOT need to flag it again — they just stop processing.
 */
export class GmailInvalidGrantError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'GmailInvalidGrantError';
    this.status = status;
  }
}

/**
 * True if `message` indicates the Gmail connection is dead (refresh token
 * revoked/expired or the watch call rejected the credentials) rather than a
 * transient error. Shared by every path (refresh, watch renew, push, backfill)
 * so "fatal" means the same thing everywhere.
 */
export function isFatalGmailAuthError(message: string): boolean {
  // invalid_grant / unauthorized_client => revoked or expired refresh token.
  // 400/401 => bad/expired credentials. 403 => scope revoked or access denied
  // (e.g. history.list after the user removed our app). All require a reconnect;
  // none recover on retry. 404 (stale historyId) and 5xx are NOT fatal.
  return /invalid_grant|unauthorized_client|access_denied|\(40[013]\)|\b40[013]\b/i.test(message);
}

/**
 * Flag a Gmail integration as broken: disable it (when fatal), record the
 * error on the row so the Settings UI can surface a "Reconnect" banner, and —
 * for a fatal disconnect — emit a single in-app notification via the existing
 * SECURITY DEFINER `notify()` RPC so the user is pinged proactively instead of
 * silently no-op'ing every sync.
 *
 * Mirrors Xero's `flagConnectionError(disable=true)`. Idempotent enough for the
 * paths that call it: a fresh notification is emitted each time a fatal error
 * recurs, but the daily watch-renew cron only retries `is_active=true` rows, so
 * once disabled it stops re-notifying until the user reconnects.
 *
 * Best-effort: failures to write/notify are swallowed (logged) so they never
 * mask the underlying auth error the caller is about to surface.
 */
export async function flagGmailConnectionError(
  admin: unknown,
  integration: { id: string; organization_id: string; gmail_address?: string | null },
  errorMessage: string,
  disable: boolean,
): Promise<void> {
  const client = admin as SupabaseLike & {
    rpc?(fn: string, args: Record<string, unknown>): PromiseLike<{ error: unknown }>;
  };

  const update: Record<string, unknown> = { last_error: errorMessage.slice(0, 500) };
  if (disable) update.is_active = false;

  try {
    const { error } = await client
      .from('gmail_integrations')
      .update(update)
      .eq('id', integration.id);
    if (error) console.error('flagGmailConnectionError: integration update failed', error);
  } catch (err) {
    console.error('flagGmailConnectionError: failed to update integration row', err);
  }

  // Only ping the user on a fatal disconnect — a transient blip that doesn't
  // disable the integration shouldn't spam the bell.
  if (!disable || typeof client.rpc !== 'function') return;

  const mailbox = integration.gmail_address ?? 'a connected mailbox';
  try {
    const { error } = await client.rpc('notify', {
      p_org: integration.organization_id,
      p_category: 'connection_expiring',
      p_title: `Gmail disconnected: ${mailbox}`,
      p_body:
        `We can no longer access ${mailbox} — the connection was revoked or expired, ` +
        `so invoice intake from this mailbox has stopped. Reconnect it from Settings to resume.`,
      p_link: '/settings',
      p_severity: 'warning',
      p_user_id: null,
      p_resource_type: 'gmail_integration',
      p_resource_id: integration.id,
      p_metadata: { reason: errorMessage.slice(0, 200) },
    });
    if (error) console.error('flagGmailConnectionError: notify() failed', error);
  } catch (err) {
    console.error('flagGmailConnectionError: notify() threw', err);
  }
}

/**
 * Returns a valid (refreshed if needed) access token. Persists the rotated
 * access token + expiry back to the row.
 */
interface GmailSelectQueryBuilder {
  select(columns: string): GmailFilterQueryBuilder;
  update(values: Record<string, unknown>): GmailUpdateQueryBuilder;
}
interface GmailFilterQueryBuilder extends PromiseLike<{
  data: unknown;
  error: { message?: string } | null;
}> {
  eq(column: string, value: unknown): GmailFilterQueryBuilder;
  single(): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}
interface GmailUpdateQueryBuilder extends PromiseLike<{
  data: unknown;
  error: { message?: string } | null;
}> {
  eq(column: string, value: unknown): GmailUpdateQueryBuilder;
}
interface SupabaseLike {
  from(table: string): GmailSelectQueryBuilder;
}

export async function loadAndRefreshGmail(
  admin: unknown,
  integrationId: string,
): Promise<GmailTokens> {
  const client = admin as SupabaseLike;
  const { data, error } = await client
    .from('gmail_integrations')
    .select(
      'id, organization_id, gmail_address, encrypted_refresh_token, encrypted_access_token, access_token_expires_at',
    )
    .eq('id', integrationId)
    .single();

  if (error || !data) {
    throw new Error(`Gmail integration ${integrationId} not found: ${error?.message}`);
  }

  const row = data as IntegrationRow;
  const refreshToken = await decryptToken(row.encrypted_refresh_token);

  // Use cached access token if still valid (60s buffer)
  if (row.encrypted_access_token && row.access_token_expires_at) {
    const expiresAt = new Date(row.access_token_expires_at);
    if (expiresAt.getTime() - Date.now() > 60_000) {
      return {
        accessToken: await decryptToken(row.encrypted_access_token),
        expiresAt,
        refreshToken,
      };
    }
  }

  // Refresh
  const clientId = Deno.env.get('GMAIL_CLIENT_ID');
  const clientSecret = Deno.env.get('GMAIL_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    throw new Error('GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET not set');
  }

  const resp = await fetch(GMAIL_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    const detail = `Gmail token refresh failed (${resp.status}): ${txt.slice(0, 200)}`;
    // A 400/401 (typically Google's `invalid_grant`) means the refresh token is
    // dead — the user revoked access, changed password, or the grant expired.
    // Retrying never recovers it, so DISABLE the integration and ping the user
    // (mirrors Xero's flagConnectionError(disable=true)). Every Gmail path —
    // watch-renew, pubsub-push, backfill, mine — flows through here, so the
    // disable + notify is consistent across all of them. A 5xx / network error
    // is left transient: flag last_error only, keep is_active=true so the next
    // run can retry.
    const fatal = isFatalGmailAuthError(detail) || resp.status === 400 || resp.status === 401;
    await flagGmailConnectionError(client, row, `token refresh: ${detail}`, fatal);
    if (fatal) throw new GmailInvalidGrantError(detail, resp.status);
    throw new Error(detail);
  }

  const tok = (await resp.json()) as {
    access_token: string;
    expires_in: number;
    // Google does not return a new refresh_token on refresh
  };

  const expiresAt = new Date(Date.now() + (tok.expires_in - 60) * 1000);
  const accessEnc = await encryptToken(tok.access_token);

  await client
    .from('gmail_integrations')
    .update({
      encrypted_access_token: accessEnc,
      access_token_expires_at: expiresAt.toISOString(),
    })
    .eq('id', integrationId);

  return { accessToken: tok.access_token, expiresAt, refreshToken };
}

/**
 * Register a Gmail `users.watch()` so Google starts publishing change
 * notifications to our Pub/Sub topic. Watch expires after 7 days.
 *
 * Returns { historyId, expiration } to persist on the integration row.
 */
export async function registerGmailWatch(
  accessToken: string,
  topicName: string, // e.g. "projects/my-gcp-project/topics/gmail-watch"
): Promise<{ historyId: string; expiration: Date }> {
  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/watch', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      topicName,
      labelIds: ['INBOX'],
      labelFilterBehavior: 'INCLUDE',
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Gmail watch() failed (${resp.status}): ${txt.slice(0, 300)}`);
  }

  const w = (await resp.json()) as { historyId: string; expiration: string };
  // expiration is ms since epoch as string
  return { historyId: w.historyId, expiration: new Date(Number(w.expiration)) };
}
