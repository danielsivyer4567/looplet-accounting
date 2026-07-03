/**
 * xero-webhook — Xero webhook receiver + "Intent to Receive" validator.
 *
 * Xero signs every delivery: header `x-xero-signature` =
 * base64(HMAC-SHA256(rawRequestBody, XERO_WEBHOOK_KEY)). To pass Xero's
 * "Intent to Receive" check the endpoint MUST, within 5 seconds:
 *   - return 200 when the computed signature matches the header, and
 *   - return 401 when it does not.
 * Xero deliberately sends one correctly-signed and one wrongly-signed request
 * during validation; it only enables the webhook if it sees 200 then 401.
 *
 * Auth is the HMAC ONLY — Xero sends no Supabase JWT — so this function is
 * deployed with verify_jwt=false (config.toml) and FAILS CLOSED: an unset
 * XERO_WEBHOOK_KEY returns 500 and never waves traffic through. Same posture
 * as bank-webhook / gmail-pubsub-push.
 *
 * On a valid signature it best-effort persists the raw delivery to
 * `xero_webhook_events` for durable capture, then returns 200. The persist step
 * NEVER downgrades a validly-signed 200 to a non-2xx — a non-2xx on a genuine
 * Xero delivery fails Intent-to-Receive and makes Xero disable the webhook, so
 * persistence errors are logged, not surfaced. Turning each stored event into a
 * live sync (map tenantId → xero_integrations → fetch changed resources) is a
 * deliberate follow-up; v1 is a signature-verified, durable inbox.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { sha256Hex } from '../_shared/apiKeys.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  // 1. Raw body — MUST be the exact bytes Xero signed. Re-serialising the JSON
  //    would change the signature, so read as text before any parsing.
  const rawBody = await req.text();

  // 2. Signature gate — the ONLY auth on this function. Fail closed if the
  //    signing key is missing (would otherwise accept unsigned traffic).
  const signingKey = Deno.env.get('XERO_WEBHOOK_KEY');
  if (!signingKey) {
    console.error('xero-webhook: XERO_WEBHOOK_KEY not configured');
    return json({ ok: false, error: 'XERO_WEBHOOK_KEY not configured' }, 500);
  }
  const provided = req.headers.get('x-xero-signature') ?? '';
  const expected = await hmacSha256Base64(signingKey, rawBody);
  if (!timingSafeEqualStr(provided, expected)) {
    // Invalid signature → 401. This is the branch Xero's "Intent to Receive"
    // triggers on purpose with a wrong key and REQUIRES to be 401.
    return json({ ok: false, error: 'invalid signature' }, 401);
  }

  // 3. Valid signature → we WILL return 200. Persist best-effort for durability.
  //    Nothing below may turn the response into a non-2xx.
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (supabaseUrl && serviceKey) {
      const admin = createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const payload = safeParse(rawBody) as
        | { events?: unknown[]; firstEventSequence?: number; lastEventSequence?: number }
        | null;
      const events = payload?.events && Array.isArray(payload.events) ? payload.events : [];
      const payloadHash = await sha256Hex(rawBody);
      const providerEventId =
        `xero:${payload?.firstEventSequence ?? ''}:${payload?.lastEventSequence ?? ''}`;

      const { error } = await admin.from('xero_webhook_events').insert({
        provider_event_id: providerEventId,
        payload_hash: payloadHash,
        event_count: events.length,
        raw_payload: payload ?? { unparseable: rawBody.slice(0, 2000) },
      });
      // 23505 = exact duplicate delivery, already stored — fine. Any other error
      // (incl. table not yet migrated) is logged but MUST NOT fail the 200.
      if (error && error.code !== '23505') {
        console.error('xero_webhook_events insert failed:', error.code, error.message);
      }
    }
  } catch (err) {
    console.error(
      'xero-webhook persist error (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
  }

  // 4. Always 200 once the signature is valid.
  return json({ ok: true }, 200);
});

/** base64(HMAC-SHA256(message, key)) — matches Xero's x-xero-signature scheme. */
async function hmacSha256Base64(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  const bytes = new Uint8Array(sig);
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

/** Constant-time string compare — no early exit on first differing byte. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
