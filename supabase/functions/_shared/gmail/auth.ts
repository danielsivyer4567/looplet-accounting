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
  encrypted_refresh_token: string;
  encrypted_access_token: string | null;
  access_token_expires_at: string | null;
}

/**
 * Returns a valid (refreshed if needed) access token. Persists the rotated
 * access token + expiry back to the row.
 */
export async function loadAndRefreshGmail(
  admin: any,
  integrationId: string,
): Promise<GmailTokens> {
  const { data, error } = await admin
    .from('gmail_integrations')
    .select('id, encrypted_refresh_token, encrypted_access_token, access_token_expires_at')
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
    throw new Error(`Gmail token refresh failed (${resp.status}): ${txt.slice(0, 200)}`);
  }

  const tok = (await resp.json()) as {
    access_token: string;
    expires_in: number;
    // Google does not return a new refresh_token on refresh
  };

  const expiresAt = new Date(Date.now() + (tok.expires_in - 60) * 1000);
  const accessEnc = await encryptToken(tok.access_token);

  await admin
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
