/**
 * bank-webhook — Basiq webhook receiver.
 *
 * Basiq events we care about:
 *   - transactions.updated → kick a sync for that connection
 *   - connection.updated   → refresh status + accounts
 *   - connection.invalid   → mark our row as 'expired' so user re-auths
 *
 * Auth: Basiq doesn't send a JWT. We verify via a shared secret in the URL
 * query: ?token=<secret> matching env BASIQ_WEBHOOK_VERIFY_TOKEN. Same pattern
 * as gmail-pubsub-push.
 *
 * Deployed --no-verify-jwt because Basiq sends no Supabase auth.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';

interface BasiqWebhookPayload {
  type: string;                    // "transactions.updated" | "connection.updated" | etc.
  data?: {
    type?: string;
    id?: string;                    // affected resource id
    userId?: string;
    connectionId?: string;
    accountId?: string;
  } | Record<string, any>;
  // Different Basiq event types use different shapes; we fall back to scanning
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  try {
    // 1. Verify URL token
    const expectedToken = Deno.env.get('BASIQ_WEBHOOK_VERIFY_TOKEN');
    if (expectedToken) {
      const url = new URL(req.url);
      if (url.searchParams.get('token') !== expectedToken) {
        return json({ ok: false, error: 'Invalid webhook verification token' }, 401);
      }
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) {
      return json({ ok: false, error: 'Server config missing' }, 500);
    }
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // 2. Parse payload
    const payload = (await req.json()) as BasiqWebhookPayload;
    const type = payload?.type ?? 'unknown';
    const data = (payload?.data ?? {}) as Record<string, any>;
    const connectionId =
      data.connectionId ?? data.connection?.id ?? data.id ?? null;
    const userId = data.userId ?? data.user?.id ?? null;

    // 3. Find the matching bank_connection
    const { data: conn } = await admin
      .from('bank_connections')
      .select('id, organization_id')
      .eq('provider', 'basiq')
      .eq('external_item_id', connectionId ?? '')
      .maybeSingle();

    // 4. Update connection state + react
    let action = 'logged';
    if (conn) {
      if (type.includes('transactions') || type.includes('updated')) {
        // Trigger a sync (fire-and-forget)
        action = 'sync_kicked';
        fetch(`${supabaseUrl}/functions/v1/bank-sync`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({
            organization_id: conn.organization_id,
            bank_connection_id: conn.id,
          }),
        }).catch((e) => console.error('webhook → bank-sync dispatch failed:', e));
      } else if (type.includes('invalid') || type.includes('expired') || type.includes('error')) {
        action = 'marked_expired';
        await admin
          .from('bank_connections')
          .update({
            status: type.includes('invalid') ? 'revoked' : 'expired',
            last_error: `Basiq webhook: ${type}`,
            webhook_received_at: new Date().toISOString(),
          })
          .eq('id', conn.id);
      } else {
        await admin
          .from('bank_connections')
          .update({ webhook_received_at: new Date().toISOString() })
          .eq('id', conn.id);
      }
    }

    return json({ ok: true, type, action, matched: !!conn });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('bank-webhook error:', msg);
    // Always 200 so Basiq doesn't retry-storm us on app-level errors
    return json({ ok: false, error: msg });
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
