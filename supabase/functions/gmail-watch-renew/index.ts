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
import { loadAndRefreshGmail, registerGmailWatch } from '../_shared/gmail/auth.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const topicName = Deno.env.get('GMAIL_PUBSUB_TOPIC');

    if (!supabaseUrl || !serviceKey || !topicName) {
      return json({ ok: false, error: 'Server config missing' }, 500);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Fetch active integrations expiring in next 24h (or already expired)
    const cutoff = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { data: rows, error } = await admin
      .from('gmail_integrations')
      .select('id, gmail_address')
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
        await admin
          .from('gmail_integrations')
          .update({ last_error: `watch renew: ${msg}`.slice(0, 500) })
          .eq('id', row.id);
      }
    }

    return json({ ok: true, renewed, failed, candidates: rows?.length ?? 0 });
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
