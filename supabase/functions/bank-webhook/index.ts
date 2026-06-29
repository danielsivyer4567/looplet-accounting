/**
 * bank-webhook — Basiq webhook receiver. PERSIST-BEFORE-ACK + idempotent.
 *
 * Basiq events we care about:
 *   - transactions.updated → kick an (idempotent) sync for that connection
 *   - connection.updated   → refresh status + accounts (via sync)
 *   - connection.invalid   → mark our row 'revoked' so the user re-auths
 *   - connection.expired   → mark our row 'expired'
 *
 * DURABILITY (slice P1-02): the inbound event is written to bank_webhook_events
 * BEFORE we return 200 to Basiq. If this function crashes after acking, the
 * event is already durable and can be reprocessed. Replays of the SAME provider
 * event id collapse onto one row (unique (provider, external_event_id)), so a
 * Basiq retry-storm does not double-process.
 *
 * Auth (documented provider constraint): Basiq's v3 webhooks do NOT send a
 * per-request HMAC signature header; integrity rests on the pre-registered
 * HTTPS callback URL + a shared secret in the URL query (?token=...). We verify
 * that shared token FAIL-CLOSED. If a provider/version DOES sign (X-Signature),
 * verifyWebhookSignature() does constant-time HMAC-SHA256 instead. See
 * _shared/basiq/durability.ts.
 *
 * Deployed --no-verify-jwt because Basiq sends no Supabase auth.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import {
  classifyWebhookAction,
  deriveWebhookEventId,
  extractConnectionId,
  isDuplicateKeyError,
  parseWebhookEventType,
  verifyWebhookSignature,
} from '../_shared/basiq/durability.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) {
      return json({ ok: false, error: 'Server config missing' }, 500);
    }

    // Read the raw body ONCE — HMAC verification needs the exact bytes.
    const rawBody = await req.text();
    const url = new URL(req.url);

    // 1. Authenticate. HMAC if the provider signed + a secret is held; else the
    //    documented URL-token gate, FAIL CLOSED if the token is not configured.
    const auth = await verifyWebhookSignature({
      rawBody,
      signatureHeader:
        req.headers.get('x-signature') ??
        req.headers.get('basiq-signature') ??
        req.headers.get('x-basiq-signature'),
      hmacSecret: Deno.env.get('BASIQ_WEBHOOK_HMAC_SECRET') ?? null,
      urlToken: url.searchParams.get('token'),
      expectedUrlToken: Deno.env.get('BASIQ_WEBHOOK_VERIFY_TOKEN') ?? null,
    });
    if (!auth.ok) {
      // Misconfiguration is a server error; a bad/absent token is a client 401.
      const status = auth.reason === 'verify_token_not_configured' ? 500 : 401;
      return json({ ok: false, error: `webhook auth failed: ${auth.reason}` }, status);
    }

    // 2. Parse payload (after auth so unauthenticated bodies never reach logic).
    let payload: unknown;
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return json({ ok: false, error: 'invalid_json' }, 400);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const eventType = parseWebhookEventType(payload);
    const externalEventId = deriveWebhookEventId(payload);
    const connectionExternalId = extractConnectionId(payload);

    // 3. PERSIST BEFORE ACK. Insert (not upsert) so a replay of the same event
    //    id trips the unique index — we detect that and short-circuit as a
    //    no-op rather than re-running the side effect.
    const { data: inserted, error: insErr } = await admin
      .from('bank_webhook_events')
      .insert({
        provider: 'basiq',
        external_event_id: externalEventId,
        event_type: eventType,
        connection_external_id: connectionExternalId,
        signature:
          req.headers.get('x-signature') ?? req.headers.get('basiq-signature') ?? null,
        status: 'received',
        payload,
      })
      .select('id')
      .single();

    if (insErr) {
      if (isDuplicateKeyError(insErr)) {
        // Already persisted by an earlier delivery — ack without re-processing.
        return json({ ok: true, type: eventType, action: 'duplicate_ignored', replay: true });
      }
      // Could not persist → do NOT ack. Returning 500 lets Basiq retry, which
      // is exactly what we want when the durable store is unavailable.
      return json({ ok: false, error: `persist failed: ${insErr.message}` }, 500);
    }

    const eventRowId = inserted.id as string;

    // 4. The event is now durable. Process it; failures from here only mark the
    //    stored row 'failed' (replayable) — they never lose the event.
    const result = await processEvent(admin, {
      eventRowId,
      eventType,
      connectionExternalId,
      supabaseUrl,
      serviceKey,
    });

    return json({ ok: true, type: eventType, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('bank-webhook error:', msg);
    // 500 (not a silent 200): the event may not have been persisted, so let
    // Basiq retry. Persist-before-ack means a *persisted* event is never lost.
    return json({ ok: false, error: msg }, 500);
  }
});

interface ProcessArgs {
  eventRowId: string;
  eventType: string;
  connectionExternalId: string | null;
  supabaseUrl: string;
  serviceKey: string;
}

async function processEvent(
  admin: SupabaseClient,
  args: ProcessArgs,
): Promise<{ action: string; matched: boolean }> {
  const action = classifyWebhookAction(args.eventType);

  // Resolve our connection (and its org) from the Basiq connection id.
  let conn: { id: string; organization_id: string } | null = null;
  if (args.connectionExternalId) {
    const { data } = await admin
      .from('bank_connections')
      .select('id, organization_id')
      .eq('provider', 'basiq')
      .eq('external_item_id', args.connectionExternalId)
      .maybeSingle();
    conn = (data as typeof conn) ?? null;
  }

  if (!conn) {
    await finishEvent(admin, args.eventRowId, {
      status: action === 'ignore' ? 'ignored' : 'processed',
      action: 'unmatched',
    });
    return { action: 'unmatched', matched: false };
  }

  let appliedAction = 'logged';
  try {
    if (action === 'sync') {
      appliedAction = 'sync_kicked';
      // Fire-and-forget an idempotent sync; the webhook event id seeds the
      // sync's idempotency key so replays correlate in bank_sync_runs.
      fetch(`${args.supabaseUrl}/functions/v1/bank-sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${args.serviceKey}`,
        },
        body: JSON.stringify({
          organization_id: conn.organization_id,
          bank_connection_id: conn.id,
          trigger_source: 'webhook',
          idempotency_key: `webhook:${args.eventRowId}`,
        }),
      }).catch((e) => console.error('webhook → bank-sync dispatch failed:', e));
    } else if (action === 'mark_revoked' || action === 'mark_expired') {
      appliedAction = action === 'mark_revoked' ? 'marked_revoked' : 'marked_expired';
      await admin
        .from('bank_connections')
        .update({
          status: action === 'mark_revoked' ? 'revoked' : 'expired',
          last_error: `Basiq webhook: ${args.eventType}`,
          webhook_received_at: new Date().toISOString(),
        })
        .eq('id', conn.id);
    } else if (action === 'ignore') {
      appliedAction = 'ignored';
    } else {
      // 'touch' — just record receipt.
      await admin
        .from('bank_connections')
        .update({ webhook_received_at: new Date().toISOString() })
        .eq('id', conn.id);
    }

    await finishEvent(admin, args.eventRowId, {
      status: action === 'ignore' ? 'ignored' : 'processed',
      action: appliedAction,
      organizationId: conn.organization_id,
      bankConnectionId: conn.id,
    });
    return { action: appliedAction, matched: true };
  } catch (procErr) {
    const msg = procErr instanceof Error ? procErr.message : String(procErr);
    await finishEvent(admin, args.eventRowId, {
      status: 'failed',
      action: appliedAction,
      error: msg.slice(0, 500),
      organizationId: conn.organization_id,
      bankConnectionId: conn.id,
    });
    return { action: `failed:${appliedAction}`, matched: true };
  }
}

async function finishEvent(
  admin: SupabaseClient,
  eventRowId: string,
  patch: {
    status: string;
    action: string;
    error?: string;
    organizationId?: string;
    bankConnectionId?: string;
  },
): Promise<void> {
  await admin
    .from('bank_webhook_events')
    .update({
      status: patch.status,
      action: patch.action,
      error: patch.error ?? null,
      organization_id: patch.organizationId ?? null,
      bank_connection_id: patch.bankConnectionId ?? null,
      processed_at: new Date().toISOString(),
    })
    .eq('id', eventRowId);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
