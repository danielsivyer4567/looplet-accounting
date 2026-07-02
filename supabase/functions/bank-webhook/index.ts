/**
 * bank-webhook — Basiq webhook receiver.
 *
 * Event routing is delegated to _shared/basiq/durability.ts's
 * classifyWebhookAction() (unit-tested — see durability.test.ts) rather than
 * reimplemented inline here, so the mapping from Basiq event type → action
 * ('sync' | 'mark_revoked' | 'mark_expired' | 'touch' | 'ignore') has one
 * source of truth:
 *   - sync         → kick a re-sync for that connection (transactions.updated,
 *                     any *.updated event)
 *   - mark_revoked → connection.invalid — user must re-authenticate
 *   - mark_expired → "expired" or "error" event types — connection needs re-auth or retry
 *   - touch        → unrecognised-but-present event type; just record receipt
 *   - ignore       → empty/unknown type; still persisted as raw evidence, no action
 *
 * Auth: Basiq doesn't send a JWT, and per durability.ts's documented provider
 * constraint, Basiq's v3 webhooks carry no per-request HMAC signature either
 * — verifyWebhookSignature() falls back to the shared URL-token gate
 * (?token=<secret> matching BASIQ_WEBHOOK_VERIFY_TOKEN), FAILING CLOSED if
 * unset. Same pattern as gmail-pubsub-push.
 *
 * Deployed --no-verify-jwt because Basiq sends no Supabase auth.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { sha256Hex } from '../_shared/apiKeys.ts';
import {
  classifyWebhookAction,
  extractConnectionId,
  parseWebhookEventType,
  verifyWebhookSignature,
} from '../_shared/basiq/durability.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  try {
    // 1. Parse payload first (read as text so we can both verify HMAC-over-body,
    // if Basiq ever ships one, and hash the raw body for dedupe).
    const bodyText = await req.text();

    // 2. Verify — FAIL CLOSED. This function is deployed --no-verify-jwt
    // (Basiq sends no Supabase auth), so this is the ONLY gate. An unset
    // BASIQ_WEBHOOK_VERIFY_TOKEN must reject, not wave traffic through.
    const url = new URL(req.url);
    const authResult = await verifyWebhookSignature({
      rawBody: bodyText,
      signatureHeader: req.headers.get('x-basiq-signature'),
      hmacSecret: Deno.env.get('BASIQ_WEBHOOK_HMAC_SECRET') ?? null,
      urlToken: url.searchParams.get('token'),
      expectedUrlToken: Deno.env.get('BASIQ_WEBHOOK_VERIFY_TOKEN') ?? null,
    });
    if (!authResult.ok) {
      const status = authResult.reason === 'verify_token_not_configured' ? 500 : 401;
      return json(
        { ok: false, error: `Webhook auth failed: ${authResult.reason}` },
        status,
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) {
      return json({ ok: false, error: 'Server config missing' }, 500);
    }
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const payload = JSON.parse(bodyText) as unknown;
    const type = parseWebhookEventType(payload);
    const connectionId = extractConnectionId(payload);

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
    let action: string = duplicateDelivery ? 'duplicate_logged' : 'logged';
    const webhookAction = classifyWebhookAction(type);

    // 5. Update connection state + react — routing decided by
    // classifyWebhookAction() (unit-tested), not reimplemented inline.
    if (conn) {
      if (webhookAction === 'sync') {
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
      } else if (webhookAction === 'mark_revoked' || webhookAction === 'mark_expired') {
        action = 'marked_expired';
        await admin
          .from('bank_connections')
          .update({
            status: webhookAction === 'mark_revoked' ? 'revoked' : 'expired',
            last_error: `Basiq webhook: ${type}`,
            webhook_received_at: new Date().toISOString(),
          })
          .eq('id', conn.id);
      } else if (webhookAction === 'touch') {
        await admin
          .from('bank_connections')
          .update({ webhook_received_at: new Date().toISOString() })
          .eq('id', conn.id);
      }
      // webhookAction === 'ignore' — raw evidence already persisted above, no action.
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
