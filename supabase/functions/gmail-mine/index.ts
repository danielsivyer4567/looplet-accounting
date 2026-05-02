/**
 * gmail-mine — Auto Setup's first-scrape data-mining function.
 *
 * Walks 6 months of INBOX + SENT, extracts sender entities (counterparties),
 * clusters them by canonical_key (lowercased domain or address), runs
 * heuristic classification, and upserts into `staged_entities`. The triage UI
 * then walks every row before Auto Setup is "complete" — gap-proof.
 *
 * Crucially: this does NOT download attachment bodies (cheap, fast). Heavy
 * OCR work is reserved for the user-approved entities later (or for the
 * existing gmail-backfill flow if the user wants attachments now).
 *
 * Input:  { integration_id, days?: 180, page_token?, max?: 100, folder?: 'inbox'|'sent' }
 * Output: { ok, stats, next_page_token, folder, query }
 *
 * Frontend calls this twice per folder loop: once for INBOX, once for SENT.
 * Each call processes up to 100 messages; returns next_page_token for resumption.
 */

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { loadAndRefreshGmail } from '../_shared/gmail/auth.ts';
import {
  classifyEntity,
  domainOf,
  extractAbn,
  extractTotalCents,
} from '../_shared/gmail/classify.ts';

interface RequestBody {
  integration_id: string;
  days?: number;
  page_token?: string;
  max?: number;
  folder?: 'inbox' | 'sent';
}

interface IntegRow {
  id: string;
  organization_id: string;
  gmail_address: string;
  allowlist: string[];
}

interface MessageHeader { name: string; value: string; }
interface MessageMeta {
  id: string;
  threadId: string;
  internalDate?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: { headers?: MessageHeader[]; mimeType?: string; parts?: any[]; body?: any };
  sizeEstimate?: number;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ ok: false, error: 'Unauthorized' }, 401);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!supabaseUrl || !serviceKey || !anonKey) {
      return json({ ok: false, error: 'Server config missing' }, 500);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const body = (await req.json()) as RequestBody;
    if (!body.integration_id) {
      return json({ ok: false, error: 'integration_id required' }, 400);
    }

    const days = Math.max(1, Math.min(365, body.days ?? 180));
    const max = Math.max(1, Math.min(200, body.max ?? 100));
    const folder = body.folder === 'sent' ? 'sent' : 'inbox';

    // RLS-checked access
    const { data: integForUser, error: integErr } = await userClient
      .from('gmail_integrations')
      .select('id, organization_id, gmail_address, allowlist')
      .eq('id', body.integration_id)
      .maybeSingle();
    if (integErr || !integForUser) {
      return json({ ok: false, error: 'Integration not accessible' }, 403);
    }
    const integ = integForUser as IntegRow;

    const { accessToken } = await loadAndRefreshGmail(admin, integ.id);

    // Build query: last `days` from the chosen folder
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const yyyy = cutoff.getUTCFullYear();
    const mm = String(cutoff.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(cutoff.getUTCDate()).padStart(2, '0');
    const query = `after:${yyyy}/${mm}/${dd} in:${folder}`;

    const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    listUrl.searchParams.set('q', query);
    listUrl.searchParams.set('maxResults', String(Math.min(max, 100)));
    if (body.page_token) listUrl.searchParams.set('pageToken', body.page_token);

    const listResp = await fetch(listUrl.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!listResp.ok) {
      const t = await listResp.text();
      return json({ ok: false, error: `messages.list ${listResp.status}: ${t.slice(0, 300)}` }, 502);
    }

    const list = (await listResp.json()) as {
      messages?: Array<{ id: string; threadId: string }>;
      nextPageToken?: string;
    };

    const stats = {
      fetched: list.messages?.length ?? 0,
      entities_upserted: 0,
      attachments_seen: 0,
      errors: 0,
    };

    // We aggregate per-cluster across this batch, then upsert at the end.
    const clusters = new Map<string, ClusterAccumulator>();
    const isOutbound = folder === 'sent';

    for (const m of list.messages ?? []) {
      try {
        await processMessage(accessToken, m.id, clusters, integ, isOutbound, stats);
      } catch (err) {
        stats.errors += 1;
        console.error('mine err', m.id, err);
      }
    }

    for (const [canonical_key, c] of clusters) {
      try {
        await upsertCluster(admin, integ.organization_id, canonical_key, c);
        stats.entities_upserted += 1;
      } catch (err) {
        stats.errors += 1;
        console.error('upsert err', canonical_key, err);
      }
    }

    return json({
      ok: true,
      stats,
      next_page_token: list.nextPageToken ?? null,
      folder,
      query,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

interface ClusterAccumulator {
  display_name: string;
  primary_email: string;
  observed_emails: Set<string>;
  observed_domains: Set<string>;
  message_count: number;
  attachment_count: number;
  total_amount_seen_cents: number;
  first_seen_at?: Date;
  last_seen_at?: Date;
  sample_subjects: string[];
  sample_message_ids: string[];
  is_outbound: boolean;       // any message from this cluster came from SENT
  abn?: string;
}

async function processMessage(
  accessToken: string,
  messageId: string,
  clusters: Map<string, ClusterAccumulator>,
  _integ: IntegRow,
  isOutbound: boolean,
  stats: { attachments_seen: number },
) {
  // Use format=metadata + headers we care about; cheap (no attachment bytes).
  const wanted = ['From', 'To', 'Subject', 'Date'];
  const url = new URL(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`,
  );
  url.searchParams.set('format', 'full');
  // We use 'full' (not 'metadata') because our scope is gmail.readonly which
  // allows full bodies; we need the snippet/body for ABN + total extraction.

  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new Error(`message fetch ${resp.status}`);
  const m = (await resp.json()) as MessageMeta;

  const headers = (m.payload?.headers ?? []).reduce<Record<string, string>>((acc, h) => {
    acc[h.name.toLowerCase()] = h.value;
    return acc;
  }, {});

  // Pick the relevant party: if outbound → "to" is the customer; else → "from"
  const partyHeader = isOutbound ? headers['to'] : headers['from'];
  if (!partyHeader) return;

  const { email, name } = parseAddressHeader(partyHeader);
  if (!email) return;
  const domain = domainOf(email);
  const canonical_key = canonicalize(domain, email);

  const subject = headers['subject'] ?? '';
  const internalDate = m.internalDate ? new Date(Number(m.internalDate)) : undefined;

  // Detect attachments without downloading them — just scan parts for filename.
  const attachmentCount = countAttachments(m.payload);
  if (attachmentCount > 0) stats.attachments_seen += attachmentCount;

  // Body / snippet for ABN + total mining
  const bodyExcerpt = extractBodyText(m.payload, 4000) || (m.snippet ?? '');
  const abn = extractAbn(bodyExcerpt);
  const totalCents = extractTotalCents(bodyExcerpt);

  let acc = clusters.get(canonical_key);
  if (!acc) {
    acc = {
      display_name: name || prettyFromDomain(domain),
      primary_email: email,
      observed_emails: new Set([email]),
      observed_domains: new Set([domain]),
      message_count: 0,
      attachment_count: 0,
      total_amount_seen_cents: 0,
      sample_subjects: [],
      sample_message_ids: [],
      is_outbound: isOutbound,
    };
    clusters.set(canonical_key, acc);
  }

  acc.observed_emails.add(email);
  acc.observed_domains.add(domain);
  acc.message_count += 1;
  acc.attachment_count += attachmentCount;
  if (totalCents) acc.total_amount_seen_cents += totalCents;
  if (internalDate) {
    if (!acc.first_seen_at || internalDate < acc.first_seen_at) acc.first_seen_at = internalDate;
    if (!acc.last_seen_at || internalDate > acc.last_seen_at) acc.last_seen_at = internalDate;
  }
  if (acc.sample_subjects.length < 5 && subject && !acc.sample_subjects.includes(subject)) {
    acc.sample_subjects.push(subject.slice(0, 200));
  }
  if (acc.sample_message_ids.length < 10) acc.sample_message_ids.push(messageId);
  if (abn && !acc.abn) acc.abn = abn;
  if (isOutbound) acc.is_outbound = true; // any outbound = customer signal
  if (name && acc.display_name === acc.primary_email) acc.display_name = name;
}

async function upsertCluster(
  admin: SupabaseClient,
  organization_id: string,
  canonical_key: string,
  c: ClusterAccumulator,
) {
  // Run classifier with the cluster's accumulated context
  const sampleEmail = c.primary_email;
  const domain = [...c.observed_domains][0] ?? domainOf(sampleEmail);
  const cls = classifyEntity({
    sender_address: sampleEmail,
    sender_domain: domain,
    sender_name: c.display_name,
    recent_subjects: c.sample_subjects,
    is_outbound: c.is_outbound,
  });

  const status = cls.confidence >= 0.6 ? 'pending'
    : cls.confidence >= 0.3 ? 'pending'
    : 'needs_review';

  // Read existing row (if any) so we merge stats instead of overwriting
  const { data: existing } = await admin
    .from('staged_entities')
    .select('observed_emails, observed_domains, message_count, attachment_count, total_amount_seen_cents, first_seen_at, last_seen_at, sample_subjects, sample_message_ids, status')
    .eq('organization_id', organization_id)
    .eq('canonical_key', canonical_key)
    .maybeSingle();

  const merged_emails = mergeArrays(existing?.observed_emails as string[] | undefined, [...c.observed_emails]);
  const merged_domains = mergeArrays(existing?.observed_domains as string[] | undefined, [...c.observed_domains]);
  const merged_subjects = mergeArrays(existing?.sample_subjects as string[] | undefined, c.sample_subjects).slice(0, 10);
  const merged_msg_ids = mergeArrays(existing?.sample_message_ids as string[] | undefined, c.sample_message_ids).slice(0, 25);

  const new_msg_count = (existing?.message_count ?? 0) + c.message_count;
  const new_att_count = (existing?.attachment_count ?? 0) + c.attachment_count;
  const new_total = (existing?.total_amount_seen_cents ?? 0) + c.total_amount_seen_cents;
  const first_seen_at = pickEarlier(existing?.first_seen_at as string | undefined, c.first_seen_at);
  const last_seen_at = pickLater(existing?.last_seen_at as string | undefined, c.last_seen_at);

  // Don't downgrade a row the user has already approved/dismissed
  const final_status = existing?.status === 'approved' || existing?.status === 'dismissed'
    ? existing.status
    : status;

  const { error } = await admin
    .from('staged_entities')
    .upsert({
      organization_id,
      canonical_key,
      display_name: cls.display_name || c.display_name,
      primary_email: c.primary_email,
      observed_emails: merged_emails,
      observed_domains: merged_domains,
      abn: c.abn ?? null,
      message_count: new_msg_count,
      attachment_count: new_att_count,
      total_amount_seen_cents: new_total > 0 ? new_total : null,
      first_seen_at,
      last_seen_at,
      sample_subjects: merged_subjects,
      sample_message_ids: merged_msg_ids,
      predicted_kind: cls.kind,
      predicted_category: cls.category,
      prediction_reason: cls.reason,
      confidence: cls.confidence,
      status: final_status,
    }, { onConflict: 'organization_id,canonical_key' });

  if (error) throw new Error(`staged_entities upsert: ${error.message}`);
}

function parseAddressHeader(h: string): { email: string; name?: string } {
  // "Name <email@x>" | "<email@x>" | "email@x"
  const m = h.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: (m[1] ?? '').trim() || undefined, email: m[2]!.trim().toLowerCase() };
  return { email: h.trim().toLowerCase() };
}

function canonicalize(domain: string, email: string): string {
  // Free-mail providers can't cluster by domain (every gmail.com user would
  // collapse). Use full email as the key in that case.
  const FREE = new Set([
    'gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'yahoo.com.au',
    'icloud.com', 'me.com', 'live.com', 'live.com.au', 'msn.com',
    'bigpond.com', 'bigpond.net.au', 'optusnet.com.au', 'tpg.com.au', 'iinet.net.au',
  ]);
  return FREE.has(domain) ? `email:${email}` : `domain:${domain}`;
}

function countAttachments(payload: any): number {
  if (!payload) return 0;
  let n = 0;
  const stack = [payload];
  while (stack.length) {
    const p = stack.pop();
    if (p?.body?.attachmentId) n += 1;
    if (Array.isArray(p?.parts)) stack.push(...p.parts);
  }
  return n;
}

function extractBodyText(payload: any, maxLen: number): string {
  if (!payload) return '';
  const stack = [payload];
  let out = '';
  while (stack.length && out.length < maxLen) {
    const p = stack.pop();
    if (!p) continue;
    if (p.mimeType === 'text/plain' && p.body?.data) {
      out += '\n' + base64UrlDecodeStr(p.body.data).slice(0, maxLen - out.length);
    } else if (p.mimeType === 'text/html' && p.body?.data && out.length < maxLen / 2) {
      out += '\n' + stripHtml(base64UrlDecodeStr(p.body.data)).slice(0, maxLen - out.length);
    }
    if (Array.isArray(p.parts)) stack.push(...p.parts);
  }
  return out;
}

function base64UrlDecodeStr(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  try {
    return atob(b64 + pad);
  } catch {
    return '';
  }
}

function stripHtml(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function mergeArrays(a: string[] | undefined, b: string[]): string[] {
  const set = new Set<string>();
  for (const x of a ?? []) set.add(x);
  for (const x of b) set.add(x);
  return [...set];
}

function pickEarlier(a: string | undefined, b: Date | undefined): string | null {
  if (!a && !b) return null;
  if (!a) return b!.toISOString();
  if (!b) return a;
  return new Date(a) < b ? a : b.toISOString();
}

function pickLater(a: string | undefined, b: Date | undefined): string | null {
  if (!a && !b) return null;
  if (!a) return b!.toISOString();
  if (!b) return a;
  return new Date(a) > b ? a : b.toISOString();
}

function prettyFromDomain(domain: string): string {
  const parts = domain.split('.');
  const head = parts[0] ?? domain;
  return head.charAt(0).toUpperCase() + head.slice(1);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
