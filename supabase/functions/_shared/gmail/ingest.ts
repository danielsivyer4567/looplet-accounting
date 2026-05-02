/**
 * Shared Gmail message → bill ingestion logic, used by both gmail-pubsub-push
 * (real-time) and gmail-backfill (historical sweep).
 *
 * Given a connected mailbox + a Gmail messageId, fetches the message, walks
 * the MIME parts for accepted attachments, uploads them to Supabase Storage,
 * inserts bill rows, and fires `bills-extract` (fire-and-forget). Dedup is via
 * `bills.intake_metadata->>'gmail_message_id'` index from migration 0006.
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ACCEPTED_MIME = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/heic',
  'image/heif',
  'image/webp',
]);

export interface GmailIntegrationRow {
  id: string;
  organization_id: string;
  gmail_address: string;
  allowlist: string[];
}

export interface IngestStats {
  bills: Array<{ bill_id: string; filename: string; gmail_message_id: string }>;
  rejected: Array<{ message_id: string; reason: string }>;
  duplicates: number;
}

/**
 * Ingest a single Gmail message. Skips if a bill already exists for this
 * gmail_message_id (re-delivery, backfill overlap).
 */
export async function ingestGmailMessage(
  admin: SupabaseClient,
  accessToken: string,
  integ: GmailIntegrationRow,
  messageId: string,
): Promise<IngestStats> {
  const result: IngestStats = { bills: [], rejected: [], duplicates: 0 };

  // Dedup: have we seen this messageId before?
  const { data: existing } = await admin
    .from('bills')
    .select('id')
    .eq('organization_id', integ.organization_id)
    .filter('intake_metadata->>gmail_message_id', 'eq', messageId)
    .limit(1)
    .maybeSingle();
  if (existing) {
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
    internalDate?: string;
  };

  const headers = headersToMap(msg.payload?.headers ?? []);
  const fromHeader = headers['from'] ?? '';
  const subject = headers['subject'] ?? '';
  const fromAddress = extractEmail(fromHeader);

  if (integ.allowlist?.length > 0) {
    const lower = fromAddress.toLowerCase();
    const ok = integ.allowlist.some((a: string) => {
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

  const NOISE_FILENAME = /(logo|icon|footer|header|signature|banner|outlook[-_]o|image00[0-9]|email[-_]\d|spacer)/i;
  const parts = flattenParts(msg.payload);
  const attachments = parts.filter((p) => {
    if (!p.body?.attachmentId || !p.mimeType) return false;
    if (!ACCEPTED_MIME.has(p.mimeType)) return false;
    const size = p.body.size ?? 0;
    if (size > 0 && size < 30_000) return false;
    if (p.filename && NOISE_FILENAME.test(p.filename)) return false;
    return true;
  });

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
    const dateForFolder = msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const rand = crypto.randomUUID().slice(0, 8);
    const storagePath = `org-${integ.organization_id}/${dateForFolder}/${rand}-${cleanName}`;

    const upErr = await admin.storage
      .from('bills')
      .upload(storagePath, bytes, {
        contentType: part.mimeType,
        cacheControl: '3600',
        upsert: false,
      });

    if (upErr.error) {
      result.rejected.push({
        message_id: messageId,
        reason: `storage ${upErr.error.message}`,
      });
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
          gmail_internal_date: msg.internalDate ?? null,
          from: fromAddress,
          subject,
        },
      })
      .select('id')
      .single();

    if (insErr || !bill) {
      result.rejected.push({
        message_id: messageId,
        reason: `bill insert ${insErr?.message}`,
      });
      continue;
    }

    // Fire bills-extract (no await — backfill needs to keep moving)
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

    result.bills.push({
      bill_id: bill.id as string,
      filename,
      gmail_message_id: messageId,
    });
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
  return (m ? m[1]! : fromHeader).trim().toLowerCase();
}

function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const raw = atob(b64 + pad);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
