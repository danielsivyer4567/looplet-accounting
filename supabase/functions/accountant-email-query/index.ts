/**
 * accountant-email-query — inbound email webhook for accountants.
 *
 * The accountant emails a request like:
 *   To:      logs@accounting.looplet.com.au
 *   Subject: display logs from 2026-05-01 to 2026-05-07
 *   Body:    (optional)
 *
 * This edge fn (called by an inbound-email provider webhook):
 *   1. Parses the inbound email — supports Mailgun multipart, Postmark JSON,
 *      CloudMailin JSON, and a generic {from, subject, text} shape.
 *   2. Looks up the sender's user_id by email. Confirms they have role
 *      'accountant' on at least one org.
 *   3. Uses Groq to extract intent + date range from subject/body.
 *   4. Generates the activity digest for that range.
 *   5. Replies via Resend with the digest as HTML.
 *
 * To wire up:
 *   - Set EMAIL_INBOUND_SECRET in Supabase secrets (any random string)
 *   - Set MX record on accounting.looplet.com.au → your inbound provider
 *   - Configure provider webhook URL:
 *       https://dxoikltymmknxqpkpyhi.supabase.co/functions/v1/accountant-email-query
 *     with header: x-inbound-secret: <EMAIL_INBOUND_SECRET>
 *   - Provider handles MX delivery + parses the message + POSTs here.
 *
 * Public webhook — verify_jwt: false (the secret header is the auth).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const RESEND_URL = 'https://api.resend.com/emails';
const FROM_ADDR = 'Looplet Accounting <noreply@app.looplet.com.au>';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

interface ParsedEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
}

interface QueryIntent {
  action: 'display_logs' | 'session_summary' | 'unknown';
  since_iso: string;
  until_iso: string;
  organization_hint: string | null;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    // Auth: shared secret in header (since this is a public webhook)
    const expectedSecret = Deno.env.get('EMAIL_INBOUND_SECRET');
    if (expectedSecret) {
      const got = req.headers.get('x-inbound-secret');
      if (got !== expectedSecret) return json({ ok: false, error: 'Forbidden' }, 403);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const groqKey = Deno.env.get('GROQ_API_KEY');
    const resendKey = Deno.env.get('RESEND_API_KEY');
    if (!supabaseUrl || !serviceKey) return json({ ok: false, error: 'Server config missing' }, 500);
    if (!groqKey) return json({ ok: false, error: 'GROQ_API_KEY not set' }, 500);
    if (!resendKey) return json({ ok: false, error: 'RESEND_API_KEY not set' }, 500);

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Parse inbound (provider-agnostic)
    const email = await parseInbound(req);
    if (!email.from || !email.subject) {
      return json({ ok: false, error: 'Missing from/subject' }, 400);
    }

    // Look up sender by email (case-insensitive)
    const senderEmail = extractEmailAddress(email.from).toLowerCase();
    const { data: userRow } = await admin
      .from('organization_memberships')
      .select('user_id, organization_id, role, organizations(name)')
      .eq('role', 'accountant')
      .limit(50);

    // Get auth.users info to match by email
    const { data: authUsers } = await admin.auth.admin.listUsers();
    const matched = authUsers?.users?.find((u) => (u.email ?? '').toLowerCase() === senderEmail);
    if (!matched) {
      await sendReply(resendKey, email.from, 'Looplet Accounting — sender not recognised',
        `<p>Hi,</p><p>The email address <code>${esc(senderEmail)}</code> isn't registered as an accountant on any Looplet Accounting org. Please ask your client to invite you via Settings → Team.</p>`);
      return json({ ok: true, status: 'unknown_sender' });
    }

    // Find which orgs they're an accountant for
    const memberships = (userRow ?? []).filter((m) => m.user_id === matched.id);
    if (memberships.length === 0) {
      await sendReply(resendKey, email.from, 'Looplet Accounting — no accountant access',
        `<p>Hi,</p><p>You're registered but don't have <strong>accountant</strong> role on any organisation. Please ask the org owner to upgrade your role.</p>`);
      return json({ ok: true, status: 'no_accountant_role' });
    }

    // Parse intent from subject + body via Groq
    const intent = await parseIntent(email.subject, email.text, groqKey);

    // Pick org: explicit hint match, else first
    const targetOrg = memberships.find((m) =>
      intent.organization_hint &&
      String((m.organizations as { name?: string } | null)?.name ?? '').toLowerCase().includes(intent.organization_hint.toLowerCase())
    ) ?? memberships[0]!;

    // Fetch activity for that range
    const { data: activity } = await admin
      .from('accountant_activity_log')
      .select('*')
      .eq('organization_id', targetOrg.organization_id)
      .eq('user_id', matched.id)
      .gte('occurred_at', intent.since_iso)
      .lte('occurred_at', intent.until_iso)
      .order('occurred_at', { ascending: true })
      .limit(500);

    const orgName = (targetOrg.organizations as { name?: string } | null)?.name ?? 'Client';
    const html = renderReplyHtml({
      org_name: orgName,
      since_iso: intent.since_iso,
      until_iso: intent.until_iso,
      activity: (activity ?? []) as ActivityRow[],
      original_subject: email.subject,
    });
    const subject = `Re: ${email.subject}`;

    await sendReply(resendKey, email.from, subject, html);

    return json({
      ok: true,
      sender: senderEmail,
      org: orgName,
      since: intent.since_iso,
      until: intent.until_iso,
      rows: (activity ?? []).length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

async function parseInbound(req: Request): Promise<ParsedEmail> {
  const ct = req.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    const j = await req.json();
    // Postmark: {From, To, Subject, TextBody}; CloudMailin: {envelope, headers, plain}
    return {
      from: String(j.From ?? j.from ?? j.envelope?.from ?? ''),
      to: String(j.To ?? j.to ?? j.envelope?.to ?? ''),
      subject: String(j.Subject ?? j.subject ?? j.headers?.Subject ?? ''),
      text: String(j.TextBody ?? j.text ?? j.plain ?? ''),
    };
  }
  if (ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')) {
    // Mailgun multipart: from, to, subject, body-plain
    const form = await req.formData();
    return {
      from: String(form.get('from') ?? form.get('From') ?? ''),
      to: String(form.get('to') ?? form.get('To') ?? ''),
      subject: String(form.get('subject') ?? form.get('Subject') ?? ''),
      text: String(form.get('body-plain') ?? form.get('text') ?? ''),
    };
  }
  // Fallback: try JSON
  try {
    const j = await req.json();
    return {
      from: String(j.from ?? ''),
      to: String(j.to ?? ''),
      subject: String(j.subject ?? ''),
      text: String(j.text ?? ''),
    };
  } catch {
    return { from: '', to: '', subject: '', text: '' };
  }
}

function extractEmailAddress(s: string): string {
  // "Name <email@x.com>" or "email@x.com"
  const m = /<([^>]+)>/.exec(s);
  return (m ? m[1]! : s).trim();
}

async function parseIntent(subject: string, body: string, groqKey: string): Promise<QueryIntent> {
  const today = new Date().toISOString().slice(0, 10);
  const system = `Parse the user's email request into a date range + intent. Respond with JSON only.

Today's date: ${today}.

Schema: {"action": "display_logs" | "session_summary" | "unknown", "since_iso": "<ISO8601 datetime>", "until_iso": "<ISO8601 datetime>", "organization_hint": null | "<short org name>"}

Examples:
- "display logs from 2026-05-01 to 2026-05-07" → since=2026-05-01T00:00:00Z, until=2026-05-07T23:59:59Z
- "what did I do today" → since=<today midnight UTC>, until=<today end of day UTC>
- "send last 7 days" → since=<7 days ago>, until=<now>
- "logs for AFGC last month" → since=<first day of last month>, until=<last day of last month>, organization_hint="AFGC"
- ambiguous → action="unknown" but still pick a sensible default (last 24h)`;

  const resp = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: `Subject: ${subject}\n\nBody: ${body.slice(0, 1000)}` },
      ],
      temperature: 0.0,
      max_tokens: 200,
      response_format: { type: 'json_object' },
    }),
  });
  if (!resp.ok) {
    return defaultIntent();
  }
  const data = await resp.json();
  try {
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? '{}');
    return {
      action: parsed.action ?? 'unknown',
      since_iso: parsed.since_iso ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      until_iso: parsed.until_iso ?? new Date().toISOString(),
      organization_hint: parsed.organization_hint ?? null,
    };
  } catch { return defaultIntent(); }
}

function defaultIntent(): QueryIntent {
  return {
    action: 'unknown',
    since_iso: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
    until_iso: new Date().toISOString(),
    organization_hint: null,
  };
}

interface ActivityRow {
  occurred_at: string;
  event_type: string;
  path: string | null;
  description: string | null;
  duration_ms: number | null;
}

interface ReplyContext {
  org_name: string;
  since_iso: string;
  until_iso: string;
  activity: ActivityRow[];
  original_subject: string;
}

function renderReplyHtml(ctx: ReplyContext): string {
  const sinceStr = new Date(ctx.since_iso).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });
  const untilStr = new Date(ctx.until_iso).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });

  const totalMs = ctx.activity.reduce((s, a) => s + (a.duration_ms ?? 0), 0);
  const totalMin = Math.round(totalMs / 60000);

  const byPath = new Map<string, { count: number; ms: number }>();
  for (const a of ctx.activity) {
    if (!a.path) continue;
    const e = byPath.get(a.path) ?? { count: 0, ms: 0 };
    e.count += 1;
    e.ms += a.duration_ms ?? 0;
    byPath.set(a.path, e);
  }
  const pages = Array.from(byPath.entries()).sort((a, b) => b[1].count - a[1].count).slice(0, 30);

  return `<!DOCTYPE html>
<html><body style="font: 14px/1.5 -apple-system, sans-serif; color: #333; max-width: 720px; margin: 24px auto; padding: 0 16px;">
<h1 style="font-size: 18px; color: #1c4868; margin: 0 0 4px;">Activity log — ${esc(ctx.org_name)}</h1>
<p style="color: #888; font-size: 12px; margin: 0 0 20px;">${esc(sinceStr)} → ${esc(untilStr)} (Brisbane time) · ${ctx.activity.length} entries · ~${totalMin}m total</p>

<h2 style="font-size: 13px; color: #1c4868; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 24px;">Pages visited</h2>
<table style="width: 100%; border-collapse: collapse; font-size: 12px;">
  <thead><tr><th style="text-align:left; font-size:10px; color:#888; padding:6px 8px; border-bottom:1px solid #e0e0e0;">Path</th><th style="text-align:right; font-size:10px; color:#888; padding:6px 8px; border-bottom:1px solid #e0e0e0;">Visits</th><th style="text-align:right; font-size:10px; color:#888; padding:6px 8px; border-bottom:1px solid #e0e0e0;">Time</th></tr></thead>
  <tbody>
    ${pages.length === 0 ? '<tr><td colspan="3" style="color:#888; text-align:center; padding:12px;">no pageviews in this window</td></tr>' :
      pages.map(([p, x]) => `<tr><td style="padding:6px 8px; border-bottom:1px solid #f0f0f0;">${esc(p)}</td><td style="padding:6px 8px; border-bottom:1px solid #f0f0f0; text-align:right;">${x.count}</td><td style="padding:6px 8px; border-bottom:1px solid #f0f0f0; text-align:right;">${(x.ms / 60000).toFixed(1)}m</td></tr>`).join('')}
  </tbody>
</table>

<h2 style="font-size: 13px; color: #1c4868; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 28px;">Write actions</h2>
<table style="width: 100%; border-collapse: collapse; font-size: 12px;">
  <thead><tr><th style="text-align:left; font-size:10px; color:#888; padding:6px 8px; border-bottom:1px solid #e0e0e0;">When (Brisbane)</th><th style="text-align:left; font-size:10px; color:#888; padding:6px 8px; border-bottom:1px solid #e0e0e0;">Type</th><th style="text-align:left; font-size:10px; color:#888; padding:6px 8px; border-bottom:1px solid #e0e0e0;">Action</th></tr></thead>
  <tbody>
    ${(() => {
      const writes = ctx.activity.filter((a) => ['action', 'comment'].includes(a.event_type));
      if (writes.length === 0) return '<tr><td colspan="3" style="color:#888; text-align:center; padding:12px;">no write actions in this window</td></tr>';
      return writes.slice(0, 100).map((a) =>
        `<tr><td style="padding:6px 8px; border-bottom:1px solid #f0f0f0;">${new Date(a.occurred_at).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })}</td><td style="padding:6px 8px; border-bottom:1px solid #f0f0f0;">${esc(a.event_type)}</td><td style="padding:6px 8px; border-bottom:1px solid #f0f0f0;">${esc(a.description ?? a.path ?? '')}</td></tr>`,
      ).join('');
    })()}
  </tbody>
</table>

<p style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #e0e0e0; color: #888; font-size: 11px;">
  In reply to: <em>${esc(ctx.original_subject)}</em><br>
  Reply with another query like "logs from 2026-05-01 to 2026-05-07" or "what did I do today" any time.
</p>
</body></html>`;
}

async function sendReply(resendKey: string, to: string, subject: string, html: string): Promise<void> {
  await fetch(RESEND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
    body: JSON.stringify({
      from: FROM_ADDR,
      to: [to],
      subject,
      html,
    }),
  });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
