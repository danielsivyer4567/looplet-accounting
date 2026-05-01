/**
 * gmail-pubsub-push — receives Pub/Sub push notifications from Google when
 * mail arrives for a watched mailbox. Decodes the payload (base64-wrapped
 * { emailAddress, historyId }), then for that integration:
 *   1. Pulls the history delta since last_history_id via users.history.list
 *   2. For each new INBOX message, fetches the full payload + attachments
 *   3. Filters by allowlist (if configured) + accepted MIME types
 *   4. Uploads attachments to Supabase Storage
 *   5. Inserts into `bills` (source='gmail', status='received')
 *   6. Invokes `bills-extract` for each bill (fire-and-forget)
 *   7. Bumps last_history_id
 *
 * Pub/Sub push payload shape:
 * {
 *   "message": {
 *     "data": "<base64 of { emailAddress, historyId }>",
 *     "messageId": "...",
 *     "publishTime": "..."
 *   },
 *   "subscription": "..."
 * }
 *
 * Auth: Pub/Sub signs push requests with an OIDC token. We verify the audience
 * matches our function URL. The simpler, equally-valid alternative used here
 * is a verification token in the subscription URL, e.g. ?token=<secret>.
 * (Set GMAIL_PUSH_VERIFY_TOKEN as a Supabase secret + same value as ?token=.)
 *
 * Deployed with --no-verify-jwt because Pub/Sub does not send a Supabase JWT.
 */

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { loadAndRefreshGmail } from '../_shared/gmail/auth.ts';

const ACCEPTED_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/heic',
  'image/heif',
  'image/webp',
]);

interface PubSubMessage {
  message: {
    data: string;
    messageId: string;
    publishTime?: string;
  };
  subscription?: string;
}

interface GmailNotification {
  emailAddress: string;
  historyId: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  try {
    // 1. Light token gate (Pub/Sub subscription includes ?token=... in URL)
    const expectedToken = Deno.env.get('GMAIL_PUSH_VERIFY_TOKEN');
    if (expectedToken) {
      const url = new URL(req.url);
      const got = url.searchParams.get('token');
      if (got !== expectedToken) {
        return json({ ok: false, error: 'Invalid push verification token' }, 401);
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

    // 2. Decode Pub/Sub envelope
    const env = (await req.json()) as PubSubMessage;
    if (!env?.message?.data) {
      return json({ ok: true, ignored: 'no data' }); // ack so Pub/Sub doesn't retry
    }

    const decoded = atob(env.message.data);
    const notif = JSON.parse(decoded) as GmailNotification;

    // 3. Locate the integration
    const { data: integ, error: integErr } = await admin
      .from('gmail_integrations')
      .select('*')
      .eq('gmail_address', notif.emailAddress)
      .eq('is_active', true)
      .maybeSingle();

    if (integErr || !integ) {
      console.warn(`No active gmail_integration for ${notif.emailAddress}`);
      return json({ ok: true, ignored: 'no integration' });
    }

    // 4. Refresh access token if needed
    const { accessToken } = await loadAndRefreshGmail(admin, integ.id);

    const startHistoryId = integ.last_history_id ?? notif.historyId;

    // 5. Pull history delta — what messages are new since startHistoryId?
    const histResp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${startHistoryId}&historyTypes=messageAdded&labelId=INBOX`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!histResp.ok) {
      const t = await histResp.text();
      await admin
        .from('gmail_integrations')
        .update({ last_error: `history.list ${histResp.status}: ${t.slice(0, 200)}` })
        .eq('id', integ.id);
      // 200 OK back to Pub/Sub so it doesn't retry-storm us on persistent errors
      return json({ ok: false, error: `history.list failed: ${histResp.status}` });
    }

    const hist = (await histResp.json()) as {
      history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>;
      historyId?: string;
    };

    const messageIds = new Set<string>();
    for (const h of hist.history ?? []) {
      for (const m of h.messagesAdded ?? []) {
        if (m.message?.id) messageIds.add(m.message.id);
      }
    }

    const acceptedBills: Array<{ bill_id: string; filename: string }> = [];
    const rejected: Array<{ message_id: string; reason: string }> = [];

    for (const msgId of messageIds) {
      try {
        const result = await ingestMessage(admin, accessToken, integ, msgId);
        acceptedBills.push(...result.bills);
        rejected.push(...result.rejected);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        rejected.push({ message_id: msgId, reason: msg });
      }
    }

    // 6. Bump last_history_id so next push picks up from here
    const newHistoryId = hist.historyId ?? notif.historyId;
    await admin
      .from('gmail_integrations')
      .update({
        last_history_id: newHistoryId,
        last_synced_at: new Date().toISOString(),
        last_error: null,
      })
      .eq('id', integ.id);

    return json({
      ok: true,
      processed: messageIds.size,
      bills_created: acceptedBills.length,
      rejected: rejected.length,
      details: { bills: acceptedBills, rejected: rejected.slice(0, 10) },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('gmail-pubsub-push error:', msg);
    // Always return 200 to Pub/Sub for non-transient errors so it doesn't retry-storm
    return json({ ok: false, error: msg });
  }
});

interface IngestResult {
  bills: Array<{ bill_id: string; filename: string }>;
  rejected: Array<{ message_id: string; reason: string }>;
}

async function ingestMessage(
  admin: SupabaseClient,
  accessToken: string,
  integ: any,
  messageId: string,
): Promise<IngestResult> {
  const result: IngestResult = { bills: [], rejected: [] };

  const msgResp = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!msgResp.ok) {
    result.rejected.push({ message_id: messageId, reason: `fetch ${msgResp.status}` });
    return result;
  }

  const msg = (await msgResp.json()) as {
    id: string;
    threadId: string;
    payload: GmailPart;
  };

  const headers = headersToMap(msg.payload?.headers ?? []);
  const fromHeader = headers['from'] ?? '';
  const subject = headers['subject'] ?? '';
  const fromAddress = extractEmail(fromHeader);

  // Allowlist filter (skip if list is empty == allow all)
  if (integ.allowlist?.length > 0) {
    const lower = fromAddress.toLowerCase();
    const ok = integ.allowlist.some((a: string) => {
      const allow = a.toLowerCase();
      return lower === allow || lower.endsWith('@' + allow.replace(/^@/, ''));
    });
    if (!ok) {
      result.rejected.push({ message_id: messageId, reason: `sender ${fromAddress} not in allowlist` });
      return result;
    }
  }

  // Walk parts looking for accepted attachments
  const parts = flattenParts(msg.payload);
  const attachments = parts.filter(
    (p) => p.body?.attachmentId && p.mimeType && ACCEPTED_MIME.has(p.mimeType),
  );

  if (attachments.length === 0) {
    result.rejected.push({ message_id: messageId, reason: 'no PDF/image attachments' });
    return result;
  }

  for (const part of attachments) {
    const attResp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${part.body!.attachmentId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!attResp.ok) {
      result.rejected.push({ message_id: messageId, reason: `attachment ${attResp.status}` });
      continue;
    }
    const att = (await attResp.json()) as { data: string; size: number };
    const bytes = base64UrlDecode(att.data);

    const filename = part.filename || `attachment-${part.body?.attachmentId}.bin`;
    const cleanName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
    const today = new Date().toISOString().slice(0, 10);
    const rand = crypto.randomUUID().slice(0, 8);
    const storagePath = `org-${integ.organization_id}/${today}/${rand}-${cleanName}`;

    const upErr = await admin.storage
      .from('bills')
      .upload(storagePath, bytes, {
        contentType: part.mimeType,
        cacheControl: '3600',
        upsert: false,
      });

    if (upErr.error) {
      result.rejected.push({ message_id: messageId, reason: `storage ${upErr.error.message}` });
      continue;
    }

    const { data: bill, error: insErr } = await admin
      .from('bills')
      .insert({
        organization_id: integ.organization_id,
        source: 'gmail',
        status: 'received',
        storage_key: storagePath,
        original_filename: filename,
        mime_type: part.mimeType,
        file_size_bytes: bytes.length,
        currency_code: 'AUD',
        intake_metadata: {
          gmail_message_id: messageId,
          gmail_thread_id: msg.threadId,
          from: fromAddress,
          subject,
        },
      })
      .select('id')
      .single();

    if (insErr || !bill) {
      result.rejected.push({ message_id: messageId, reason: `bill insert ${insErr?.message}` });
      continue;
    }

    // Fire-and-forget extract (don't block the Pub/Sub ack)
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    fetch(`${supabaseUrl}/functions/v1/bills-extract`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ bill_id: bill.id }),
    }).catch((e) => console.error('bills-extract dispatch failed:', e));

    result.bills.push({ bill_id: bill.id as string, filename });
  }

  return result;
}

interface GmailPart {
  partId?: string;
  filename?: string;
  mimeType?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

function flattenParts(payload: GmailPart): GmailPart[] {
  const out: GmailPart[] = [payload];
  for (const p of payload.parts ?? []) out.push(...flattenParts(p));
  return out;
}

function headersToMap(headers: Array<{ name: string; value: string }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) out[h.name.toLowerCase()] = h.value;
  return out;
}

function extractEmail(fromHeader: string): string {
  const m = fromHeader.match(/<([^>]+)>/);
  return (m ? m[1] : fromHeader).trim().toLowerCase();
}

function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const raw = atob(b64 + pad);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
