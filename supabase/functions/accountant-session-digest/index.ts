/**
 * accountant-session-digest — generates + emails a digest for closed
 * accountant sessions. Two modes:
 *
 *   1. Cron mode (no body): finds all sessions where ended_at is set and
 *      digest_sent_at is null; emails each.
 *   2. On-demand: { session_id } — re-send a specific session digest.
 *   3. On-demand "send my activity log so far" (open session): { organization_id, since }
 *      — generates a digest of activity in date range and emails to caller.
 *
 * Email delivery via Resend (RESEND_API_KEY required).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';

const RESEND_URL = 'https://api.resend.com/emails';
const FROM_ADDR = 'Looplet Accounting <noreply@loopletai.com.au>';

interface RequestBody {
  session_id?: string;
  organization_id?: string;
  since?: string;     // ISO date for on-demand window
  recipient?: string; // override recipient
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const resendKey = Deno.env.get('RESEND_API_KEY');
    if (!supabaseUrl || !serviceKey) return json({ ok: false, error: 'Server config missing' }, 500);
    if (!resendKey) return json({ ok: false, error: 'RESEND_API_KEY not set' }, 500);

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // CRON MODE (no body or empty body): batch-send all pending digests
    let body: RequestBody = {};
    try { body = await req.json(); } catch { /* empty */ }

    if (!body.session_id && !body.organization_id) {
      return await batchSendDigests(admin, resendKey);
    }

    // ON-DEMAND MODE
    if (body.session_id) {
      return await sendSessionDigest(admin, resendKey, body.session_id, body.recipient);
    }

    // OPEN-SESSION ACTIVITY LOG MODE — needs auth header to identify the caller
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !body.organization_id) {
      return json({ ok: false, error: 'organization_id + auth required for on-demand log' }, 400);
    }
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: u } = await userClient.auth.getUser();
    if (!u?.user) return json({ ok: false, error: 'Unauthorized' }, 401);

    return await sendOnDemandLog(admin, resendKey, body.organization_id, u.user.id, body.since, body.recipient ?? u.user.email ?? '');

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

async function batchSendDigests(admin: ReturnType<typeof createClient>, resendKey: string): Promise<Response> {
  const { data: sessions } = await admin
    .from('accountant_sessions')
    .select('id')
    .not('ended_at', 'is', null)
    .is('digest_sent_at', null)
    .limit(50);

  let sent = 0;
  let failed = 0;
  for (const s of (sessions ?? []) as { id: string }[]) {
    const r = await sendSessionDigest(admin, resendKey, s.id);
    if (r.status === 200) sent++;
    else failed++;
  }
  return json({ ok: true, sent, failed });
}

async function sendSessionDigest(
  admin: ReturnType<typeof createClient>,
  resendKey: string,
  sessionId: string,
  recipientOverride?: string,
): Promise<Response> {
  // Load session + activity
  const { data: session } = await admin
    .from('accountant_sessions')
    .select('*, organization:organizations(name)')
    .eq('id', sessionId)
    .maybeSingle();
  if (!session) return json({ ok: false, error: 'Session not found' }, 404);

  const { data: activity } = await admin
    .from('accountant_activity_log')
    .select('*')
    .eq('session_id', sessionId)
    .order('occurred_at', { ascending: true });

  // Get accountant email
  let recipient = recipientOverride;
  if (!recipient) {
    const { data: user } = await admin.auth.admin.getUserById(session.user_id);
    recipient = user?.user?.email ?? '';
  }
  if (!recipient) return json({ ok: false, error: 'No recipient email' }, 400);

  const html = renderDigestHtml(session, (activity ?? []) as ActivityRow[]);
  const subject = `Activity log for ${session.organization?.name ?? 'your client'} — ${new Date(session.started_at).toLocaleDateString('en-AU')}`;

  const resp = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
    body: JSON.stringify({
      from: FROM_ADDR,
      to: [recipient],
      subject,
      html,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    return json({ ok: false, error: `Resend ${resp.status}: ${t.slice(0, 300)}` }, 500);
  }

  await admin
    .from('accountant_sessions')
    .update({ digest_sent_at: new Date().toISOString(), digest_recipient_email: recipient })
    .eq('id', sessionId);

  return json({ ok: true, recipient, session_id: sessionId });
}

async function sendOnDemandLog(
  admin: ReturnType<typeof createClient>,
  resendKey: string,
  orgId: string,
  userId: string,
  since: string | undefined,
  recipient: string,
): Promise<Response> {
  const cutoff = since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: org } = await admin.from('organizations').select('name').eq('id', orgId).maybeSingle();
  const { data: activity } = await admin
    .from('accountant_activity_log')
    .select('*')
    .eq('organization_id', orgId)
    .eq('user_id', userId)
    .gte('occurred_at', cutoff)
    .order('occurred_at', { ascending: true });

  const html = renderDigestHtml(
    {
      organization: { name: org?.name ?? 'Client' },
      started_at: cutoff,
      ended_at: new Date().toISOString(),
      total_seconds: null,
      pageview_count: (activity ?? []).filter((a: ActivityRow) => a.event_type === 'pageview').length,
      action_count: (activity ?? []).filter((a: ActivityRow) => ['action', 'comment'].includes(a.event_type)).length,
      end_reason: 'manual',
    },
    (activity ?? []) as ActivityRow[],
  );

  const resp = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
    body: JSON.stringify({
      from: FROM_ADDR,
      to: [recipient],
      subject: `Activity log for ${org?.name ?? 'your client'} — on demand`,
      html,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    return json({ ok: false, error: `Resend ${resp.status}: ${t.slice(0, 300)}` }, 500);
  }
  return json({ ok: true, recipient, rows: (activity ?? []).length });
}

interface ActivityRow {
  occurred_at: string;
  event_type: string;
  path: string | null;
  description: string | null;
  duration_ms: number | null;
}

function renderDigestHtml(session: Record<string, unknown>, activity: ActivityRow[]): string {
  const startStr = new Date(session.started_at as string).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });
  const endStr = session.ended_at ? new Date(session.ended_at as string).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }) : '(open)';
  const totalSec = (session.total_seconds as number | null) ?? 0;
  const totalH = Math.floor(totalSec / 3600);
  const totalM = Math.floor((totalSec % 3600) / 60);
  const orgName = (session.organization as { name?: string })?.name ?? 'Client';

  // Group activity by path
  const byPath = new Map<string, { count: number; ms: number; firstAt: string }>();
  for (const a of activity) {
    if (!a.path) continue;
    const existing = byPath.get(a.path) ?? { count: 0, ms: 0, firstAt: a.occurred_at };
    existing.count += 1;
    existing.ms += a.duration_ms ?? 0;
    byPath.set(a.path, existing);
  }
  const pages = Array.from(byPath.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 25);

  const writeOps = activity.filter((a) => ['action', 'comment'].includes(a.event_type));

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { font: 14px/1.5 -apple-system, sans-serif; color: #333; max-width: 720px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 20px; color: #1c4868; margin: 0 0 4px; }
  .meta { color: #888; font-size: 12px; margin-bottom: 24px; }
  .stats { display: flex; gap: 24px; margin: 16px 0 24px; padding: 14px; background: #f5f9fd; border-radius: 6px; }
  .stat { font-size: 11px; color: #666; text-transform: uppercase; }
  .stat strong { display: block; font-size: 22px; color: #1c4868; font-weight: 700; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 24px; }
  th { text-align: left; font-size: 10px; color: #888; text-transform: uppercase; padding: 6px 8px; border-bottom: 1px solid #e0e0e0; }
  td { padding: 6px 8px; border-bottom: 1px solid #f0f0f0; font-size: 12px; }
  td.r { text-align: right; }
  h2 { font-size: 14px; color: #1c4868; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 28px; }
  .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e0e0e0; color: #888; font-size: 11px; }
</style></head><body>
<h1>Activity log — ${orgName}</h1>
<div class="meta">${startStr} → ${endStr} (Brisbane time)</div>

<div class="stats">
  <div class="stat">Time on site<strong>${totalH}h ${totalM}m</strong></div>
  <div class="stat">Pages viewed<strong>${session.pageview_count ?? 0}</strong></div>
  <div class="stat">Write actions<strong>${session.action_count ?? 0}</strong></div>
  <div class="stat">End reason<strong style="font-size:14px">${session.end_reason ?? '—'}</strong></div>
</div>

<h2>Pages visited</h2>
<table>
  <thead><tr><th>Path</th><th class="r">Visits</th><th class="r">Time on page</th></tr></thead>
  <tbody>
    ${pages.length === 0 ? '<tr><td colspan="3" style="color:#888;text-align:center">no pageviews recorded</td></tr>' :
      pages.map(([path, p]) => `<tr><td>${esc(path)}</td><td class="r">${p.count}</td><td class="r">${(p.ms / 1000 / 60).toFixed(1)}m</td></tr>`).join('')}
  </tbody>
</table>

<h2>Write actions (${writeOps.length})</h2>
<table>
  <thead><tr><th>When (Brisbane)</th><th>Type</th><th>Action</th></tr></thead>
  <tbody>
    ${writeOps.length === 0 ? '<tr><td colspan="3" style="color:#888;text-align:center">no write actions</td></tr>' :
      writeOps.slice(0, 100).map((a) =>
        `<tr><td>${new Date(a.occurred_at).toLocaleTimeString('en-AU', { timeZone: 'Australia/Brisbane' })}</td><td>${esc(a.event_type)}</td><td>${esc(a.description ?? a.path ?? '')}</td></tr>`,
      ).join('')}
  </tbody>
</table>

<div class="footer">
  Auto-generated by Looplet Accounting on session close. Reply with questions or request a re-send anytime.
</div>
</body></html>`;
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
