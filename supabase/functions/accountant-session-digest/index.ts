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
 *
 * Deployed with verify_jwt=false because pg_cron calls cron mode with a scoped
 * ?secret=. On-demand/browser modes still verify the caller JWT in-function
 * before reading sessions or activity.
 */

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { isExactSecret, isExactServiceRoleBearer } from '../_shared/serviceRole.ts';

const RESEND_URL = 'https://api.resend.com/emails';
const FROM_ADDR = 'Looplet Accounting <noreply@loopletai.com.au>';

type SupabaseAdmin = SupabaseClient;

interface RequestBody {
  session_id?: string;
  proof_id?: string;
  organization_id?: string;
  since?: string; // ISO date for on-demand window
  recipient?: string; // override recipient
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const resendKey = Deno.env.get('RESEND_API_KEY');
    const cronSecret = Deno.env.get('ACCOUNTANT_SESSION_DIGEST_CRON_SECRET');
    if (!supabaseUrl || !serviceKey) {
      return json({ ok: false, error: 'Server config missing' }, 500);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // CRON MODE (no body or empty body): batch-send all pending digests
    let body: RequestBody = {};
    try {
      body = await req.json();
    } catch {
      // empty body is valid cron mode
    }

    const authHeader = req.headers.get('Authorization');
    const isCronMode = !body.session_id && !body.proof_id && !body.organization_id;

    if (isCronMode) {
      const url = new URL(req.url);
      const secretOk = cronSecret
        ? isExactSecret(url.searchParams.get('secret'), cronSecret)
        : false;
      const serviceRoleOk = isExactServiceRoleBearer(authHeader, serviceKey);
      if (!secretOk && !serviceRoleOk) {
        return json({ ok: false, error: 'forbidden' }, 403);
      }
      if (!resendKey) return json({ ok: false, error: 'RESEND_API_KEY not set' }, 500);
      return await batchSendDigests(admin, resendKey);
    }

    // ON-DEMAND MODES — verify the user's JWT ourselves because pg_cron requires
    // verify_jwt=false at the platform gateway.
    if (!resendKey) return json({ ok: false, error: 'RESEND_API_KEY not set' }, 500);
    if (!authHeader) return json({ ok: false, error: 'Unauthorized' }, 401);
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!anonKey) return json({ ok: false, error: 'SUPABASE_ANON_KEY not set' }, 500);
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: u } = await userClient.auth.getUser();
    if (!u?.user) return json({ ok: false, error: 'Unauthorized' }, 401);

    if (body.session_id) {
      const { data: visibleSession, error: visibleErr } = await userClient
        .from('accountant_sessions')
        .select('id')
        .eq('id', body.session_id)
        .maybeSingle();
      if (visibleErr) return json({ ok: false, error: visibleErr.message }, 403);
      if (!visibleSession) return json({ ok: false, error: 'Session not accessible' }, 403);
      return await sendSessionDigest(admin, resendKey, body.session_id);
    }

    if (body.proof_id) {
      const { data: visibleProof, error: visibleErr } = await userClient
        .from('advisor_work_proofs')
        .select('id')
        .eq('id', body.proof_id)
        .maybeSingle();
      if (visibleErr) return json({ ok: false, error: visibleErr.message }, 403);
      if (!visibleProof) return json({ ok: false, error: 'Proof not accessible' }, 403);
      return await sendWorkProofDigest(
        admin,
        resendKey,
        body.proof_id,
        body.recipient ?? u.user.email ?? '',
      );
    }

    if (!body.organization_id) {
      return json({ ok: false, error: 'organization_id required for on-demand log' }, 400);
    }
    const { data: visibleOrg, error: orgErr } = await userClient
      .from('organizations')
      .select('id')
      .eq('id', body.organization_id)
      .maybeSingle();
    if (orgErr) return json({ ok: false, error: orgErr.message }, 403);
    if (!visibleOrg) return json({ ok: false, error: 'Organisation not accessible' }, 403);

    return await sendOnDemandLog(
      admin,
      resendKey,
      body.organization_id,
      u.user.id,
      body.since,
      body.recipient ?? u.user.email ?? '',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

async function batchSendDigests(admin: SupabaseAdmin, resendKey: string): Promise<Response> {
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
  admin: SupabaseAdmin,
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
  admin: SupabaseAdmin,
  resendKey: string,
  orgId: string,
  userId: string,
  since: string | undefined,
  recipient: string,
): Promise<Response> {
  const cutoff = since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: org } = await admin
    .from('organizations')
    .select('name')
    .eq('id', orgId)
    .maybeSingle();
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
      pageview_count: (activity ?? []).filter((a: ActivityRow) => a.event_type === 'pageview')
        .length,
      action_count: (activity ?? []).filter((a: ActivityRow) =>
        ['action', 'comment'].includes(a.event_type),
      ).length,
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

async function sendWorkProofDigest(
  admin: SupabaseAdmin,
  resendKey: string,
  proofId: string,
  recipient: string,
): Promise<Response> {
  if (!recipient) return json({ ok: false, error: 'No recipient email' }, 400);

  const { data: proof } = await admin
    .from('advisor_work_proofs')
    .select('*, organization:organizations(name)')
    .eq('id', proofId)
    .maybeSingle();
  if (!proof) return json({ ok: false, error: 'Proof not found' }, 404);

  const html = renderWorkProofHtml(proof as WorkProofRow);
  const orgName = (proof.organization as { name?: string } | null)?.name ?? 'Client';
  const periodStart = new Date(String(proof.period_start)).toLocaleDateString('en-AU', {
    timeZone: 'Australia/Brisbane',
  });

  const resp = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendKey}` },
    body: JSON.stringify({
      from: FROM_ADDR,
      to: [recipient],
      subject: `Finished work proof for ${orgName} — ${periodStart}`,
      html,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    return json({ ok: false, error: `Resend ${resp.status}: ${t.slice(0, 300)}` }, 500);
  }

  await admin
    .from('advisor_work_proofs')
    .update({
      emailed_at: new Date().toISOString(),
      emailed_to: recipient,
      delivery_status: 'emailed',
    })
    .eq('id', proofId);

  return json({ ok: true, recipient, proof_id: proofId });
}

interface ActivityRow {
  occurred_at: string;
  event_type: string;
  path: string | null;
  description: string | null;
  duration_ms: number | null;
}

interface WorkProofRow {
  id: string;
  user_email: string | null;
  role_label: string;
  period_start: string;
  period_end: string;
  note: string | null;
  summary: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  snapshot_hash: string;
  created_at: string;
  organization?: { name?: string } | null;
}

function renderDigestHtml(session: Record<string, unknown>, activity: ActivityRow[]): string {
  const startStr = new Date(session.started_at as string).toLocaleString('en-AU', {
    timeZone: 'Australia/Brisbane',
  });
  const endStr = session.ended_at
    ? new Date(session.ended_at as string).toLocaleString('en-AU', {
        timeZone: 'Australia/Brisbane',
      })
    : '(open)';
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
    ${
      pages.length === 0
        ? '<tr><td colspan="3" style="color:#888;text-align:center">no pageviews recorded</td></tr>'
        : pages
            .map(
              ([path, p]) =>
                `<tr><td>${esc(path)}</td><td class="r">${p.count}</td><td class="r">${(p.ms / 1000 / 60).toFixed(1)}m</td></tr>`,
            )
            .join('')
    }
  </tbody>
</table>

<h2>Write actions (${writeOps.length})</h2>
<table>
  <thead><tr><th>When (Brisbane)</th><th>Type</th><th>Action</th></tr></thead>
  <tbody>
    ${
      writeOps.length === 0
        ? '<tr><td colspan="3" style="color:#888;text-align:center">no write actions</td></tr>'
        : writeOps
            .slice(0, 100)
            .map(
              (a) =>
                `<tr><td>${new Date(a.occurred_at).toLocaleTimeString('en-AU', { timeZone: 'Australia/Brisbane' })}</td><td>${esc(a.event_type)}</td><td>${esc(a.description ?? a.path ?? '')}</td></tr>`,
            )
            .join('')
    }
  </tbody>
</table>

<div class="footer">
  Auto-generated by Looplet Accounting on session close. Reply with questions or request a re-send anytime.
</div>
</body></html>`;
}

function renderWorkProofHtml(proof: WorkProofRow): string {
  const snapshot = proof.snapshot ?? {};
  const summary = proof.summary ?? {};
  const activity = arrayValue(snapshot.activity) as Record<string, unknown>[];
  const auditLog = arrayValue(snapshot.audit_log) as Record<string, unknown>[];
  const sessions = arrayValue(snapshot.sessions) as Record<string, unknown>[];
  const orgName = proof.organization?.name ?? 'Client';
  const startStr = new Date(proof.period_start).toLocaleString('en-AU', {
    timeZone: 'Australia/Brisbane',
  });
  const endStr = new Date(proof.period_end).toLocaleString('en-AU', {
    timeZone: 'Australia/Brisbane',
  });
  const pages = activity.filter((row) => row.event_type === 'pageview').slice(0, 80);
  const writes = auditLog.slice(0, 100);

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { font: 14px/1.5 -apple-system, sans-serif; color: #333; max-width: 780px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 20px; color: #1c4868; margin: 0 0 4px; }
  .meta { color: #777; font-size: 12px; margin-bottom: 20px; }
  .hash { font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; color: #555; word-break: break-all; background: #f6f8fa; padding: 8px; border-radius: 6px; }
  .stats { display: flex; flex-wrap: wrap; gap: 14px; margin: 16px 0 24px; padding: 14px; background: #f5f9fd; border-radius: 6px; }
  .stat { min-width: 120px; font-size: 11px; color: #666; text-transform: uppercase; }
  .stat strong { display: block; font-size: 22px; color: #1c4868; font-weight: 700; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; margin: 8px 0 24px; }
  th { text-align: left; font-size: 10px; color: #888; text-transform: uppercase; padding: 6px 8px; border-bottom: 1px solid #e0e0e0; }
  td { padding: 6px 8px; border-bottom: 1px solid #f0f0f0; font-size: 12px; vertical-align: top; }
  h2 { font-size: 14px; color: #1c4868; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 28px; }
  .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e0e0e0; color: #888; font-size: 11px; }
</style></head><body>
<h1>Finished work proof — ${esc(orgName)}</h1>
<div class="meta">${startStr} → ${endStr} (Brisbane time)</div>
<div class="hash">Proof ID: ${esc(proof.id)}<br>Snapshot hash: ${esc(proof.snapshot_hash)}</div>

<div class="stats">
  <div class="stat">Sessions<strong>${summaryNumber(summary.session_count, sessions.length)}</strong></div>
  <div class="stat">Activity rows<strong>${summaryNumber(summary.activity_count, activity.length)}</strong></div>
  <div class="stat">Audit events<strong>${summaryNumber(summary.audit_event_count, auditLog.length)}</strong></div>
  <div class="stat">Pageviews<strong>${summaryNumber(summary.pageview_count, pages.length)}</strong></div>
</div>

${proof.note ? `<h2>Note</h2><p>${esc(proof.note)}</p>` : ''}

<h2>Path trail</h2>
<table>
  <thead><tr><th>When</th><th>Path</th><th>Description</th></tr></thead>
  <tbody>
    ${
      pages.length === 0
        ? '<tr><td colspan="3" style="color:#888;text-align:center">no pageviews recorded</td></tr>'
        : pages
            .map(
              (row) =>
                `<tr><td>${formatProofTime(row.occurred_at)}</td><td>${esc(String(row.path ?? ''))}</td><td>${esc(String(row.description ?? ''))}</td></tr>`,
            )
            .join('')
    }
  </tbody>
</table>

<h2>Write audit trail</h2>
<table>
  <thead><tr><th>When</th><th>Action</th><th>Resource</th><th>Record</th></tr></thead>
  <tbody>
    ${
      writes.length === 0
        ? '<tr><td colspan="4" style="color:#888;text-align:center">no write audit events</td></tr>'
        : writes
            .map(
              (row) =>
                `<tr><td>${formatProofTime(row.occurred_at)}</td><td>${esc(String(row.action ?? row.operation ?? ''))}</td><td>${esc(String(row.resource_type ?? row.table_name ?? ''))}</td><td>${esc(String(row.resource_id ?? row.record_id ?? ''))}</td></tr>`,
            )
            .join('')
    }
  </tbody>
</table>

<div class="footer">
  Saved inside Looplet Accounting and emailed on request. The hash is derived from the saved JSON snapshot.
</div>
</body></html>`;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function summaryNumber(value: unknown, fallback: number): string {
  return typeof value === 'number' ? String(value) : String(fallback);
}

function formatProofTime(value: unknown): string {
  if (typeof value !== 'string') return '';
  return new Date(value).toLocaleTimeString('en-AU', { timeZone: 'Australia/Brisbane' });
}

function esc(s: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return s.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
