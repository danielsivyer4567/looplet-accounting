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
import { sha256Hex } from '../_shared/apiKeys.ts';

interface BasiqWebhookPayload {
  type: string; // "transactions.updated" | "connection.updated" | etc.
  data?:
    | {
        type?: string;
        id?: string; // affected resource id
        userId?: string;
        connectionId?: string;
        accountId?: string;
      }
    | Record<string, unknown>;
  // Different Basiq event types use different shapes; we fall back to scanning
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  try {
    // 1. Verify URL token — FAIL CLOSED. This function is deployed
    // --no-verify-jwt (Basiq sends no Supabase auth), so the shared secret is
    // the ONLY gate. If it isn't configured we must reject, not wave traffic
    // through: an unset token previously skipped verification entirely, leaving
    // a fully-unauthenticated endpoint that could flip connection state / kick
    // service-role syncs for any org.
    const expectedToken = Deno.env.get('BASIQ_WEBHOOK_VERIFY_TOKEN');
    if (!expectedToken) {
      return json(
        { ok: false, error: 'Server misconfigured: BASIQ_WEBHOOK_VERIFY_TOKEN not set' },
        500,
      );
    }
    const url = new URL(req.url);
    if (url.searchParams.get('token') !== expectedToken) {
      return json({ ok: false, error: 'Invalid webhook verification token' }, 401);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) {
      return json({ ok: false, error: 'Server config missing' }, 500);
    }
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // 2. Parse payload (read as text first so we can hash the raw body)
    const bodyText = await req.text();
    const payload = JSON.parse(bodyText) as BasiqWebhookPayload;
    const type = payload?.type ?? 'unknown';
    const data = (payload?.data ?? {}) as Record<string, unknown>;
    const connection = data.connection as { id?: string } | undefined;
    const connectionId =
      (data.connectionId as string | undefined) ??
      connection?.id ??
      (data.id as string | undefined) ??
      null;

    // 3. Find the matching bank_connection
    const { data: conn } = await admin
      .from('bank_connections')
      .select('id, organization_id')
      .eq('provider', 'basiq')
      .eq('external_item_id', connectionId ?? '')
      .maybeSingle();

    // 4. Store raw event regardless of whether a matching connection was found.
    //    Unmatched events land with organization_id = NULL so they are never
    //    silently dropped — they remain available for investigation/replay via
    //    service_role. Tenants cannot read null-org rows (RLS excludes them).
    const payloadHash = await sha256Hex(bodyText);
    const providerEventId = `${type}:${connectionId ?? 'unknown'}`;
    let duplicateDelivery = false;
    const { error: rawInsertError } = await admin.from('bank_events_raw').insert({
      organization_id: conn?.organization_id ?? null,
      provider: 'basiq',
      provider_event_id: providerEventId,
      payload_hash: payloadHash,
      raw_payload: payload,
    });
    if (rawInsertError) {
      if (rawInsertError.code === '23505') {
        // Exact duplicate delivery. Continue through the action path: a prior
        // delivery may have persisted raw evidence but failed before dispatching
        // bank-sync, and bank-sync is idempotent.
        duplicateDelivery = true;
      } else {
        // Any other persistence failure means we would lose audit evidence.
        // Fail the handler so Basiq retries rather than silently dropping the event.
        console.error(
          'bank_events_raw insert failed:',
          rawInsertError.message,
          rawInsertError.code,
        );
        return json(
          { ok: false, error: 'Failed to persist raw event', code: rawInsertError.code },
          500,
        );
      }
    }
    let action = duplicateDelivery ? 'duplicate_logged' : 'logged';

    // 5. Update connection state + react
    if (conn) {
      if (type.includes('transactions') || type.includes('updated')) {
        // Trigger a sync and require observable acceptance. If this fails after
        // raw evidence was stored, a duplicate delivery will still retry the
        // action path because duplicates no longer return early.
        action = duplicateDelivery ? 'duplicate_sync_kicked' : 'sync_kicked';
        const syncResponse = await fetch(`${supabaseUrl}/functions/v1/bank-sync`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({
            organization_id: conn.organization_id,
            bank_connection_id: conn.id,
          }),
        });
        if (!syncResponse.ok) {
          const detail = await syncResponse.text().catch(() => '');
          console.error('webhook → bank-sync dispatch failed:', syncResponse.status, detail);
          return json(
            {
              ok: false,
              error: 'bank-sync dispatch failed',
              status: syncResponse.status,
              duplicate: duplicateDelivery,
            },
            502,
          );
        }
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

    return json({ ok: true, type, action, matched: !!conn, duplicate: duplicateDelivery });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('bank-webhook error:', msg);
    return json({ ok: false, error: msg }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
