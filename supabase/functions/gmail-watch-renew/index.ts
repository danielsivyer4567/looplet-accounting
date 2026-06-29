/**
 * gmail-watch-renew — re-registers Gmail users.watch() for any integrations
 * whose watch_expires_at is within the next 24h. Gmail watches expire after
 * 7 days, so we run this on a daily cron.
 *
 * Trigger via pg_cron:
 *   SELECT cron.schedule(
 *     'gmail-watch-renew',
 *     '0 3 * * *',
 *     $$ SELECT net.http_post(
 *          url := 'https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/gmail-watch-renew',
 *          headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.service_role_key'))
 *        ); $$
 *   );
 *
 * Deployed with --no-verify-jwt because pg_cron uses service_role bearer.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import {
  flagGmailConnectionError,
  GmailInvalidGrantError,
  isFatalGmailAuthError,
  loadAndRefreshGmail,
  registerGmailWatch,
} from '../_shared/gmail/auth.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const topicName = Deno.env.get('GMAIL_PUBSUB_TOPIC');
    const cronSecret = Deno.env.get('GMAIL_WATCH_RENEW_CRON_SECRET');

    if (!supabaseUrl || !serviceKey || !topicName || !cronSecret) {
      return json(
        { ok: false, error: 'Server config missing (need GMAIL_WATCH_RENEW_CRON_SECRET)' },
        500,
      );
    }

    // SECURITY: deployed --no-verify-jwt for pg_cron. Gate on a URL-query secret
    // OR the service-role bearer (both constant-time); anything else = 403.
    // Previously this had NO auth gate at all — any anonymous POST swept every
    // tenant's active Gmail integrations and called Google's API on their behalf,
    // overwriting watch state across orgs. Mirrors bank-sync-all / notifications-cron.
    const url = new URL(req.url);
    const urlSecret = url.searchParams.get('secret');
    const authHeader = req.headers.get('Authorization') ?? '';
    const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!safeEqual(bearer, serviceKey) && !safeEqual(urlSecret ?? '', cronSecret)) {
      return json({ ok: false, error: 'forbidden' }, 403);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Fetch active integrations expiring in next 24h (or already expired)
    const cutoff = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { data: rows, error } = await admin
      .from('gmail_integrations')
      .select('id, gmail_address, organization_id')
      .eq('is_active', true)
      .lt('watch_expires_at', cutoff);

    if (error) return json({ ok: false, error: error.message }, 500);

    const renewed: string[] = [];
    const failed: { id: string; error: string }[] = [];

    for (const row of rows ?? []) {
      try {
        const { accessToken } = await loadAndRefreshGmail(admin, row.id);
        const watch = await registerGmailWatch(accessToken, topicName);
        await admin
          .from('gmail_integrations')
          .update({
            last_history_id: watch.historyId,
            watch_expires_at: watch.expiration.toISOString(),
            last_error: null,
          })
          .eq('id', row.id);
        renewed.push(row.gmail_address);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failed.push({ id: row.id, error: msg });
        // Distinguish a dead connection (revoked / invalid refresh token) from a
        // transient blip. On fatal auth errors, DISABLE the integration so the app
        // shows a "Reconnect Gmail" banner, stop silently no-op'ing every day, AND
        // emit an in-app notification so the user is pinged proactively — mirrors
        // Xero's flagConnectionError(disable=true). See AUDIT.md B3. (Re-connecting
        // via OAuth sets is_active=true again and resumes renewal.)
        //
        // A GmailInvalidGrantError from loadAndRefreshGmail has ALREADY been
        // flagged + notified inside the shared helper, so don't double-flag it.
        // Anything else here came from registerGmailWatch (a successful refresh
        // followed by a watch() rejection) or a transient blip — flag it now,
        // disabling only when fatal.
        if (!(err instanceof GmailInvalidGrantError)) {
          await flagGmailConnectionError(
            admin,
            row,
            `watch renew: ${msg}`,
            isFatalGmailAuthError(msg),
          );
        }
      }
    }

    return json({ ok: true, renewed, failed, candidates: rows?.length ?? 0 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

/** Constant-time string compare; false on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
