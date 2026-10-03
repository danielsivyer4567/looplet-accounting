/**
 * notifications-cron — nightly notification generator.
 *
 * For every organization, walks the seven categories below and emits a
 * notification (via the SECURITY DEFINER `notify(...)` SQL fn) if the
 * triggering condition is met AND a notification with the same
 * (org, category, resource_id) hasn't already been emitted today.
 *
 *   bill_overdue          — bills past due_date and not paid
 *   invoice_overdue       — invoices past due_date and not paid
 *   bas_due               — current BAS quarter due_date within 14 days
 *   connection_expiring   — bank_connections.last_synced_at older than 7 days
 *   low_confidence_review — count(*) from v_low_confidence_bills > 0
 *   subscription_alert    — subs whose next_expected_at within 3 days AND
 *                            amount_cents up >5% from last month
 *   orchestrator_task     — optional handoff to accountant-orchestrator when
 *                            ACCOUNTANT_ORCHESTRATOR_CRON_SECRET is configured
 *   cron_failed           — emitted by the catch wrapper if a per-org block
 *                            errors out
 *
 * Idempotency: per (org, category, resource_id, today) — duplicate runs the
 * same day are no-ops.
 *
 * Trigger via pg_cron daily at 02:30 (server tz):
 *   SELECT cron.schedule(
 *     'notifications-cron',
 *     '30 2 * * *',
 *     $$ SELECT net.http_post(
 *          url := 'https://<project>.supabase.co/functions/v1/notifications-cron',
 *          headers := jsonb_build_object('Content-Type','application/json',
 *            'X-Cron-Secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'notifications_cron_secret' LIMIT 1)),
 *          body := '{}'::jsonb
 *        ); $$
 *   );
 *
 * Deployed with --no-verify-jwt because pg_cron drives it directly. Auth gate
 * is the same pattern as bank-sync-all: service-role bearer OR X-Cron-Secret header
 * matching NOTIFICATIONS_CRON_SECRET env (the ?secret= URL form is accepted for one release).
 */

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { CRON_SECRET_HEADER, presentedCronSecret } from '../_shared/cronSecret.ts';
import { isExactSecret, isExactServiceRoleBearer } from '../_shared/serviceRole.ts';

type SupabaseAdmin = SupabaseClient;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const cronSecret = Deno.env.get('NOTIFICATIONS_CRON_SECRET');
    const orchestratorSecret = Deno.env.get('ACCOUNTANT_ORCHESTRATOR_CRON_SECRET');
    if (!supabaseUrl || !serviceKey || !cronSecret) {
      return json(
        { ok: false, error: 'Server config missing (need NOTIFICATIONS_CRON_SECRET)' },
        500,
      );
    }

    // Auth gate: the X-Cron-Secret header OR service-role bearer.
    const givenSecret = presentedCronSecret(req);
    const authHeader = req.headers.get('Authorization') ?? '';
    // Exact service-role key OR the X-Cron-Secret header — both constant-time. The previous
    // "base64-decode the JWT and trust its role claim" path was forgeable. Removed.
    // See AUDIT.md §3d.
    const isServiceRole = isExactServiceRoleBearer(authHeader, serviceKey);
    const secretOk = isExactSecret(givenSecret, cronSecret);
    if (!isServiceRole && !secretOk) {
      return json({ ok: false, error: 'forbidden' }, 403);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Walk every non-deleted org.
    const { data: orgs, error: orgsErr } = await admin
      .from('organizations')
      .select('id, name')
      .is('deleted_at', null);
    if (orgsErr) return json({ ok: false, error: orgsErr.message }, 500);

    const summary: { org: string; emitted: number; errors: string[] }[] = [];

    for (const org of orgs ?? []) {
      const orgId = org.id as string;
      const errors: string[] = [];
      let emitted = 0;

      try {
        emitted += await checkBillsOverdue(admin, orgId, errors);
        emitted += await checkInvoicesOverdue(admin, orgId, errors);
        emitted += await checkBasDue(admin, orgId, errors);
        emitted += await checkConnectionsExpiring(admin, orgId, errors);
        emitted += await checkLowConfidence(admin, orgId, errors);
        emitted += await checkSubscriptionAlerts(admin, orgId, errors);
        emitted += await checkAccountantOrchestrator(
          supabaseUrl,
          serviceKey,
          orchestratorSecret,
          orgId,
          errors,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`fatal: ${msg}`);
        await emitOnce(admin, orgId, {
          category: 'cron_failed',
          severity: 'error',
          title: 'Notifications cron failed',
          body: msg,
          link: null,
          resource_id: null,
        }).catch(() => undefined);
      }

      summary.push({ org: orgId, emitted, errors });
    }

    return json({ ok: true, orgs: summary.length, summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

// ---------------------------------------------------------------------------
// Idempotent emit helper
// ---------------------------------------------------------------------------

interface EmitInput {
  category: string;
  severity: 'info' | 'warning' | 'error';
  title: string;
  body: string | null;
  link: string | null;
  resource_id: string | null;
  resource_type?: string | null;
  metadata?: Record<string, unknown>;
  user_id?: string | null;
}

/**
 * Insert a notification only if there isn't already a row for
 * (org, category, resource_id) created today. Returns 1 if emitted, 0 if skipped.
 */
async function emitOnce(admin: SupabaseAdmin, orgId: string, input: EmitInput): Promise<number> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  let q = admin
    .from('notifications')
    .select('id')
    .eq('organization_id', orgId)
    .eq('category', input.category)
    .gte('created_at', todayStart.toISOString())
    .limit(1);
  if (input.resource_id == null) {
    q = q.is('resource_id', null);
  } else {
    q = q.eq('resource_id', input.resource_id);
  }
  const { data: existing, error: existingErr } = await q;
  if (existingErr) throw existingErr;
  if ((existing ?? []).length > 0) return 0;

  const { error: rpcErr } = await admin.rpc('notify', {
    p_org: orgId,
    p_category: input.category,
    p_title: input.title,
    p_body: input.body,
    p_link: input.link,
    p_severity: input.severity,
    p_user_id: input.user_id ?? null,
    p_resource_type: input.resource_type ?? null,
    p_resource_id: input.resource_id,
    p_metadata: input.metadata ?? {},
  });
  if (rpcErr) throw rpcErr;

  return 1;
}

// ---------------------------------------------------------------------------
// Category checks — each returns # of notifications emitted
// ---------------------------------------------------------------------------

async function checkBillsOverdue(
  admin: SupabaseAdmin,
  orgId: string,
  errors: string[],
): Promise<number> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await admin
      .from('bills')
      .select('id')
      .eq('organization_id', orgId)
      .is('deleted_at', null)
      .eq('is_personal', false)
      .not('status', 'in', '("paid","void")')
      .not('due_date', 'is', null)
      .lt('due_date', today);
    if (error) throw error;

    const count = (data ?? []).length;
    if (count === 0) return 0;

    return await emitOnce(admin, orgId, {
      category: 'bill_overdue',
      severity: 'warning',
      title: count === 1 ? '1 overdue bill' : `${count} overdue bills`,
      body: `Past due_date and not paid. Review and pay or void.`,
      link: '/bills?status=attached',
      resource_id: null,
      metadata: { count },
    });
  } catch (err) {
    errors.push(`bill_overdue: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

async function checkInvoicesOverdue(
  admin: SupabaseAdmin,
  orgId: string,
  errors: string[],
): Promise<number> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await admin
      .from('invoices')
      .select('id')
      .eq('organization_id', orgId)
      .is('deleted_at', null)
      .not('status', 'in', '("paid","void")')
      .lt('due_date', today);
    if (error) throw error;

    const count = (data ?? []).length;
    if (count === 0) return 0;

    return await emitOnce(admin, orgId, {
      category: 'invoice_overdue',
      severity: 'warning',
      title: count === 1 ? '1 overdue invoice' : `${count} overdue invoices`,
      body: 'Customers past their due date. Consider chasing payment.',
      link: '/invoices',
      resource_id: null,
      metadata: { count },
    });
  } catch (err) {
    errors.push(`invoice_overdue: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

async function checkBasDue(admin: SupabaseAdmin, orgId: string, errors: string[]): Promise<number> {
  try {
    const { data, error } = await admin
      .from('v_bas_quarterly')
      .select('fy_start_year, quarter_num, due_date, net_gst_cents')
      .eq('organization_id', orgId);
    if (error) throw error;

    const today = new Date();
    const in14 = new Date();
    in14.setDate(today.getDate() + 14);

    interface BasRow {
      fy_start_year: number;
      quarter_num: number;
      due_date: string | null;
      net_gst_cents: number | null;
    }
    const upcoming = ((data ?? []) as BasRow[]).filter((row) => {
      if (!row.due_date) return false;
      const d = new Date(row.due_date);
      return d >= today && d <= in14;
    });
    if (upcoming.length === 0) return 0;

    let emitted = 0;
    for (const row of upcoming) {
      emitted += await emitOnce(admin, orgId, {
        category: 'bas_due',
        severity: 'warning',
        title: `BAS Q${row.quarter_num} FY${row.fy_start_year}-${(row.fy_start_year + 1).toString().slice(2)} due ${row.due_date}`,
        body: `Net GST: ${(Number(row.net_gst_cents) / 100).toFixed(2)} AUD.`,
        link: '/reports/bas',
        resource_id: null,
        metadata: {
          fy_start_year: row.fy_start_year,
          quarter_num: row.quarter_num,
          due_date: row.due_date,
        },
      });
    }
    return emitted;
  } catch (err) {
    errors.push(`bas_due: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

async function checkConnectionsExpiring(
  admin: SupabaseAdmin,
  orgId: string,
  errors: string[],
): Promise<number> {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const cutoff = sevenDaysAgo.toISOString();

    const { data, error } = await admin
      .from('bank_connections')
      .select('id, institution_name, last_synced_at, status, provider')
      .eq('organization_id', orgId)
      .neq('provider', 'manual');
    if (error) throw error;

    interface ConnRow {
      id: string;
      institution_name: string | null;
      last_synced_at: string | null;
      status: string | null;
      provider: string | null;
    }
    const stale = ((data ?? []) as ConnRow[]).filter((c) => {
      if (c.last_synced_at == null) return true; // never synced
      return new Date(c.last_synced_at).toISOString() < cutoff;
    });

    let emitted = 0;
    for (const c of stale) {
      emitted += await emitOnce(admin, orgId, {
        category: 'connection_expiring',
        severity: 'warning',
        title: `Bank connection stale: ${c.institution_name ?? '(unnamed)'}`,
        body: c.last_synced_at
          ? `Last synced ${c.last_synced_at}. Reconnect from Settings.`
          : 'Never synced. Check the connection and re-link if needed.',
        link: '/settings',
        resource_id: c.id,
        resource_type: 'bank_connection',
      });
    }
    return emitted;
  } catch (err) {
    errors.push(`connection_expiring: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

async function checkLowConfidence(
  admin: SupabaseAdmin,
  orgId: string,
  errors: string[],
): Promise<number> {
  try {
    const { data, error } = await admin
      .from('v_low_confidence_bills')
      .select('id', { count: 'exact', head: false })
      .eq('organization_id', orgId);
    if (error) throw error;

    const count = (data ?? []).length;
    if (count === 0) return 0;

    return await emitOnce(admin, orgId, {
      category: 'low_confidence_review',
      severity: 'info',
      title: count === 1 ? '1 bill needs review' : `${count} bills need review`,
      body: 'OCR confidence low or missing fields. Confirm manually.',
      link: '/quality',
      resource_id: null,
      metadata: { count },
    });
  } catch (err) {
    errors.push(`low_confidence_review: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

async function checkSubscriptionAlerts(
  admin: SupabaseAdmin,
  orgId: string,
  errors: string[],
): Promise<number> {
  try {
    const today = new Date();
    const in3 = new Date();
    in3.setDate(today.getDate() + 3);
    const todayIso = today.toISOString().slice(0, 10);
    const in3Iso = in3.toISOString().slice(0, 10);

    const { data, error } = await admin
      .from('subscriptions')
      .select('id, merchant_name, amount_cents, amount_variance_pct, next_expected_at, status')
      .eq('organization_id', orgId)
      .gte('next_expected_at', todayIso)
      .lte('next_expected_at', in3Iso);
    if (error) throw error;

    let emitted = 0;
    for (const s of data ?? []) {
      // amount_variance_pct on subscription rows is a stored monthly delta;
      // fire only if up >5% from prior month (positive only).
      const variance = Number(s.amount_variance_pct ?? 0);
      if (variance <= 5) continue;
      if (s.amount_cents == null) continue;

      emitted += await emitOnce(admin, orgId, {
        category: 'subscription_alert',
        severity: 'info',
        title: `${s.merchant_name} price up ${variance.toFixed(1)}%`,
        body: `Charging ${(Number(s.amount_cents) / 100).toFixed(2)} on ${s.next_expected_at}. Up >5% from last month.`,
        link: `/subscriptions/${s.id}`,
        resource_id: s.id,
        resource_type: 'subscription',
        metadata: { variance_pct: variance, amount_cents: s.amount_cents },
      });
    }
    return emitted;
  } catch (err) {
    errors.push(`subscription_alert: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

async function checkAccountantOrchestrator(
  supabaseUrl: string,
  serviceKey: string,
  orchestratorSecret: string | undefined,
  orgId: string,
  errors: string[],
): Promise<number> {
  if (!orchestratorSecret) return 0;

  try {
    const today = new Date().toISOString().slice(0, 10);
    const response = await fetch(`${supabaseUrl}/functions/v1/accountant-orchestrator`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        [CRON_SECRET_HEADER]: orchestratorSecret,
      },
      body: JSON.stringify({ organization_id: orgId, as_at_date: today }),
    });
    const detail = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || detail.ok === false) {
      errors.push(
        `accountant_orchestrator: ${response.status} ${String(
          detail.error ?? response.statusText,
        )}`,
      );
      return 0;
    }

    const direct = Number(detail.emitted ?? Number.NaN);
    if (Number.isFinite(direct)) return direct;

    const results = Array.isArray(detail.results) ? detail.results : [];
    return results.reduce((sum, row) => {
      if (!row || typeof row !== 'object') return sum;
      const emitted = Number((row as { emitted?: unknown }).emitted ?? 0);
      return Number.isFinite(emitted) ? sum + emitted : sum;
    }, 0);
  } catch (err) {
    errors.push(`accountant_orchestrator: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
