/**
 * gmail-pubsub-push — receives Pub/Sub push notifications from Google when
 * mail arrives for a watched mailbox. Decodes the payload (base64-wrapped
 * { emailAddress, historyId }), then for that integration:
 *   1. Acknowledges Pub/Sub immediately (204) to prevent retry storms.
 *   2. In the background (EdgeRuntime.waitUntil):
 *      a. Bumps last_history_id so the next push picks up from here.
 *      b. Pulls the history delta since last_history_id via users.history.list.
 *      c. For each new INBOX message, fetches the full payload + attachments.
 *      d. Filters by allowlist (if configured) + accepted MIME types.
 *      e. Uploads attachments to Supabase Storage.
 *      f. Inserts into `bills` (source='gmail', status='received').
 *      g. Invokes `bills-extract` for each bill (fire-and-forget).
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

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { hasExistingGmailBill } from '../_shared/gmail/dedupe.ts';
import {
  flagGmailConnectionError,
  isFatalGmailAuthError,
  loadAndRefreshGmail,
} from '../_shared/gmail/auth.ts';
import { hasRetryableGmailIngestFailure } from '../_shared/gmail/pubsub.ts';

// Deno / Supabase Edge Runtime global — used to keep the isolate alive after
// we return the 204 response to Pub/Sub.
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

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
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });

  // 1. Token gate (Pub/Sub subscription URL includes ?token=...) — FAIL CLOSED.
  // This function is deployed --no-verify-jwt (Pub/Sub sends no Supabase JWT),
  // so the shared secret is the ONLY gate. An unset token previously skipped
  // verification entirely, leaving a fully-unauthenticated endpoint that could
  // be driven with attacker-chosen emailAddress/historyId. Require it.
  const expectedToken = Deno.env.get('GMAIL_PUSH_VERIFY_TOKEN');
  if (!expectedToken) {
    return new Response('Server misconfigured: GMAIL_PUSH_VERIFY_TOKEN not set', { status: 500 });
  }
  {
    const url = new URL(req.url);
    const got = url.searchParams.get('token');
    if (got !== expectedToken) {
      // Return 401 — Pub/Sub will retry, but that's intentional: a mismatch
      // means the subscription URL is wrong, not a transient error.
      return new Response('Invalid push verification token', { status: 401 });
    }
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) {
    // Return 200 so Pub/Sub doesn't retry on a config error we can't fix live.
    console.error('gmail-pubsub-push: server config missing');
    return new Response('', { status: 200 });
  }

  // 2. Parse body before returning — we need emailAddress to look up the integration.
  let notif: GmailNotification;
  try {
    const env = (await req.json()) as PubSubMessage;
    if (!env?.message?.data) {
      // Nothing to process; ack so Pub/Sub doesn't retry.
      return new Response('', { status: 204 });
    }
    const decoded = atob(env.message.data);
    notif = JSON.parse(decoded) as GmailNotification;
  } catch (e) {
    // Malformed envelope — ack to avoid infinite retry.
    console.error('gmail-pubsub-push: parse error:', e);
    return new Response('', { status: 204 });
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 3. Look up the integration synchronously so we can ack quickly but still
  //    verify we have something to process before spinning up background work.
  const { data: integ, error: integErr } = await admin
    .from('gmail_integrations')
    .select('*')
    .eq('gmail_address', notif.emailAddress)
    .eq('is_active', true)
    .maybeSingle();

  if (integErr || !integ) {
    console.warn(`gmail-pubsub-push: no active integration for ${notif.emailAddress}`);
    // Ack — retrying won't help until an integration row exists.
    return new Response('', { status: 204 });
  }

  // 4. Ack Pub/Sub immediately (204) then process in background.
  //    This prevents Pub/Sub from retrying on slow attachment downloads.
  const workPromise = processNotification(admin, supabaseUrl, serviceKey, integ, notif);

  if (typeof EdgeRuntime !== 'undefined') {
    EdgeRuntime.waitUntil(workPromise);
  } else {
    // Fallback for local/test environments where EdgeRuntime is absent.
    workPromise.catch((e) => console.error('gmail-pubsub-push background error:', e));
  }

  return new Response('', { status: 204 });
});

async function processNotification(
  admin: SupabaseClient,
  supabaseUrl: string,
  serviceKey: string,
  integ: IntegRow,
  notif: GmailNotification,
): Promise<void> {
  try {
    // Refresh access token if needed.
    const { accessToken } = await loadAndRefreshGmail(admin, integ.id);

    const startHistoryId = integ.last_history_id ?? notif.historyId;

    // Pull history delta — what messages are new since startHistoryId?
    const histResp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=${startHistoryId}&historyTypes=messageAdded&labelId=INBOX`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );

    if (!histResp.ok) {
      const t = await histResp.text();
      const detail = `history.list ${histResp.status}: ${t.slice(0, 200)}`;
      // A 401/403 here means the access token was rejected even though refresh
      // succeeded — treat it the same as a dead grant: disable + notify so the
      // mailbox stops silently dropping mail. Other statuses (404 stale history,
      // 5xx) are transient — record last_error only, keep the integration active.
      await flagGmailConnectionError(admin, integ, detail, isFatalGmailAuthError(detail));
      return;
    }

    const hist = (await histResp.json()) as {
      history?: { messagesAdded?: { message: { id: string } }[] }[];
      historyId?: string;
    };

    const newHistoryId = hist.historyId ?? notif.historyId;
    const messageIds = new Set<string>();
    for (const h of hist.history ?? []) {
      for (const m of h.messagesAdded ?? []) {
        if (m.message?.id) messageIds.add(m.message.id);
      }
    }

    if (messageIds.size === 0) {
      await markHistoryProcessed(admin, integ.id, newHistoryId);
      return;
    }

    let hasIngestFailure = false;
    for (const msgId of messageIds) {
      try {
        const result = await ingestMessage(
          admin,
          supabaseUrl,
          serviceKey,
          accessToken,
          integ,
          msgId,
        );
        if (hasRetryableGmailIngestFailure(result)) {
          hasIngestFailure = true;
          console.warn('gmail-pubsub-push: retryable ingest rejection', msgId, result.rejected);
        }
      } catch (err) {
        hasIngestFailure = true;
        console.error('gmail-pubsub-push: ingestMessage error', msgId, err);
      }
    }

    if (hasIngestFailure) {
      await admin
        .from('gmail_integrations')
        .update({
          last_synced_at: new Date().toISOString(),
          last_error:
            `pubsub ingest failed after history ${newHistoryId}; ` +
            `left last_history_id at ${startHistoryId} for replay`,
        })
        .eq('id', integ.id);
      return;
    }

    await markHistoryProcessed(admin, integ.id, newHistoryId);
  } catch (err) {
    console.error('gmail-pubsub-push: processNotification error:', err);
  }
}

async function markHistoryProcessed(
  admin: SupabaseClient,
  integrationId: string,
  historyId: string,
): Promise<void> {
  await admin
    .from('gmail_integrations')
    .update({
      last_history_id: historyId,
      last_synced_at: new Date().toISOString(),
      last_error: null,
    })
    .eq('id', integrationId);
}

interface IngestResult {
  bills: { bill_id: string; filename: string }[];
  rejected: { message_id: string; reason: string }[];
  duplicates: number;
}

interface IntegRow {
  id: string;
  organization_id: string;
  gmail_address?: string | null;
  last_history_id?: string | null;
  allowlist?: string[] | null;
}

interface IntakeRuleMatch {
  rule_id?: string | null;
  is_personal?: boolean | null;
  skip_ocr?: boolean | null;
  category_code?: string | null;
  supplier_id?: string | null;
  job_id?: string | null;
}

async function ingestMessage(
  admin: SupabaseClient,
  supabaseUrl: string,
  serviceKey: string,
  accessToken: string,
  integ: IntegRow,
  messageId: string,
): Promise<IngestResult> {
  const result: IngestResult = { bills: [], rejected: [], duplicates: 0 };

  if (await hasExistingGmailBill(admin, integ.organization_id, messageId)) {
    result.duplicates = 1;
    return result;
  }

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
  if ((integ.allowlist?.length ?? 0) > 0) {
    const lower = fromAddress.toLowerCase();
    const ok = (integ.allowlist ?? []).some((a: string) => {
      const allow = a.toLowerCase();
      return lower === allow || lower.endsWith('@' + allow.replace(/^@/, ''));
    });
    if (!ok) {
      result.rejected.push({
        message_id: messageId,
        reason: `sender ${fromAddress} not in allowlist`,
      });
      return result;
    }
  }

  // Match against intake_rules (user-curated classification rules from triage).
  // If a rule matches and is_personal=true → skip the email entirely.
  // If a rule matches with category info → pre-fill on the bill so bills-extract can skip OCR.
  const { data: ruleRows } = await admin.rpc('match_intake_rule', {
    p_org_id: integ.organization_id,
    p_sender_email: fromAddress,
    p_subject: subject,
  });
  const rule = (ruleRows as IntakeRuleMatch[] | null)?.[0];

  if (rule?.is_personal) {
    result.rejected.push({ message_id: messageId, reason: `intake_rule says personal — skipped` });
    if (rule.rule_id) await admin.rpc('record_intake_rule_hit', { p_rule_id: rule.rule_id });
    return result;
  }

  // Walk parts looking for accepted attachments. Filter out obvious email
  // assets (logos, icons, footers) BEFORE we even download them.
  const NOISE_FILENAME =
    /(logo|icon|footer|header|signature|banner|outlook[-_]o|image00[0-9]|email[-_]\d|spacer)/i;
  const parts = flattenParts(msg.payload);
  const attachments = parts.filter((p) => {
    if (!p.body?.attachmentId || !p.mimeType) return false;
    if (!ACCEPTED_MIME.has(p.mimeType)) return false;
    // Skip files < 30KB (almost always email signature assets)
    const size = p.body.size ?? 0;
    if (size > 0 && size < 30_000) return false;
    // Skip obvious asset filenames
    if (p.filename && NOISE_FILENAME.test(p.filename)) return false;
    return true;
  });

  if (attachments.length === 0) {
    result.rejected.push({
      message_id: messageId,
      reason: 'no real PDF/image invoice attachments (filtered logos/icons)',
    });
    return result;
  }

  for (const part of attachments) {
    const attachmentId = part.body?.attachmentId;
    if (!attachmentId) continue;
    const attResp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!attResp.ok) {
      result.rejected.push({ message_id: messageId, reason: `attachment fetch ${attResp.status}` });
      continue;
    }
    const att = (await attResp.json()) as { data: string; size: number };
    const bytes = base64UrlDecode(att.data);

    const filename = part.filename || `attachment-${part.body?.attachmentId}.bin`;
    const cleanName = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
    const today = new Date().toISOString().slice(0, 10);
    const rand = crypto.randomUUID().slice(0, 8);
    const storagePath = `org-${integ.organization_id}/${today}/${rand}-${cleanName}`;

    const upErr = await admin.storage.from('bills').upload(storagePath, bytes, {
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
        applied_intake_rule_id: rule?.rule_id ?? null,
        auto_category_code: rule?.category_code ?? null,
        supplier_id: rule?.supplier_id ?? null,
        suggested_job_id: rule?.job_id ?? null,
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

    // Record rule hit for analytics.
    if (rule?.rule_id) {
      admin.rpc('record_intake_rule_hit', { p_rule_id: rule.rule_id }).then(() => undefined);
    }

    // Skip OCR entirely if rule says we already know the answer.
    if (rule?.skip_ocr) {
      await admin.from('bills').update({ status: 'verified' }).eq('id', bill.id);
      result.bills.push({ bill_id: bill.id as string, filename });
      continue;
    }

    // Fire-and-forget extract.
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
  headers?: { name: string; value: string }[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

function flattenParts(payload: GmailPart): GmailPart[] {
  const out: GmailPart[] = [payload];
  for (const p of payload.parts ?? []) out.push(...flattenParts(p));
  return out;
}

function headersToMap(headers: { name: string; value: string }[]): Record<string, string> {
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
