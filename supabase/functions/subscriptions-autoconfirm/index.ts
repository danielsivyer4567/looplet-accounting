/**
 * subscriptions-autoconfirm — promote high-confidence subscription candidates
 * to status='confirmed' automatically, leaving weaker candidates for manual
 * review. Idempotent.
 *
 * Why a separate function (vs extending subscriptions-detect):
 *   - Detection is cheap and runs often (after every bank sync). Confirmation
 *     mutates *trusted* state and deserves its own audit trail + trigger so it
 *     can be run/re-run independently (e.g. nightly, or after a user tightens
 *     the bar) without re-running detection.
 *   - Keeps idempotency reasoning isolated: this fn only ever transitions
 *     unreviewed candidates → confirmed, never the reverse, and skips anything a
 *     human has already touched.
 *
 * High-confidence bar (a candidate is auto-confirmed only if ALL hold):
 *   1. status is 'detected' or 'candidate'  (unreviewed — never re-touch a human
 *      decision: 'confirmed' / 'cancelled' / 'dismissed' / 'paused' are left alone)
 *   2. observed_count >= MIN_OCCURRENCES (3)  — recurring across >=3 occurrences
 *      of the same supplier (merchant_canonical_key)
 *   3. cadence is a recognised regular cadence (not null)
 *   4. confidence >= MIN_CONFIDENCE (0.80) — the detector's confidence already
 *      blends observation count with gap-regularity (near-identical amount on a
 *      regular cadence), so a high score means both "many times" and "regular".
 *   5. amount_cents > 0 — a real recurring amount was learned.
 *
 * Everything below the bar is left untouched for manual review.
 *
 * Idempotency: re-running only ever sees candidates still in 'detected'/'candidate'.
 * Once confirmed they no longer match the WHERE clause, so a second run is a no-op.
 *
 * Auth: service_role bypasses; a user JWT must pass an RLS org-access check
 *   before we touch tenant data with the admin client.
 *
 * Input:  { organization_id }
 * Output: { ok, stats: { evaluated, auto_confirmed, left_for_review } }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';

interface RequestBody {
  organization_id?: string;
}

interface Candidate {
  id: string;
  merchant_name: string | null;
  cadence: string | null;
  amount_cents: number | null;
  confidence: number | null;
  observed_count: number | null;
  status: string;
}

const MIN_CONFIDENCE = 0.80;
const MIN_OCCURRENCES = 3;
const REVIEW_STATUSES = ['detected', 'candidate'];

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

    // Tolerant auth: service-role (raw key or service_role JWT) bypasses; user
    // JWTs must verify org membership through RLS before we touch tenant data.
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    let isServiceRole = token === serviceKey;
    if (!isServiceRole) {
      try {
        const payloadB64 = (token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
        const payload = JSON.parse(atob(payloadB64 + '='.repeat((4 - payloadB64.length % 4) % 4)));
        isServiceRole = payload?.role === 'service_role';
      } catch { /* fall through to RLS check */ }
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const body = (await req.json().catch(() => ({}))) as RequestBody;
    if (!body.organization_id) return json({ ok: false, error: 'organization_id required' }, 400);

    // Org membership check via user-JWT (RLS enforces). Service-role skips.
    if (!isServiceRole) {
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: org, error: orgErr } = await userClient
        .from('organizations')
        .select('id')
        .eq('id', body.organization_id)
        .maybeSingle();
      if (orgErr || !org) return json({ ok: false, error: 'Organisation not accessible' }, 403);
    }

    // Pull only unreviewed candidates for this org. Confirmed/cancelled/etc rows
    // never match this filter, which is what makes re-runs idempotent.
    const { data: rows, error: selErr } = await admin
      .from('subscriptions')
      .select('id, merchant_name, cadence, amount_cents, confidence, observed_count, status')
      .eq('organization_id', body.organization_id)
      .in('status', REVIEW_STATUSES);
    if (selErr) return json({ ok: false, error: selErr.message }, 500);

    const candidates = (rows ?? []) as Candidate[];

    const stats = { evaluated: 0, auto_confirmed: 0, left_for_review: 0 };
    const nowIso = new Date().toISOString();

    for (const c of candidates) {
      stats.evaluated += 1;

      if (!meetsBar(c)) {
        stats.left_for_review += 1;
        continue;
      }

      const reason =
        `auto-confirm: confidence ${(Number(c.confidence) * 100).toFixed(0)}% over ` +
        `${c.observed_count}× ${c.cadence} occurrences ` +
        `($${((c.amount_cents ?? 0) / 100).toFixed(2)})`;

      // Guarded update: re-assert the status precondition in the WHERE clause so
      // two concurrent runs can't both flip the same row (the second update
      // matches zero rows). confirmed_by stays NULL to mark this as automation.
      const { data: updated, error: updErr } = await admin
        .from('subscriptions')
        .update({
          status: 'confirmed',
          auto_confirmed_at: nowIso,
          confirmed_at: nowIso,
          confirmed_by: null,
          confirmation_reason: reason,
          reviewed_at: nowIso,
          updated_at: nowIso,
        })
        .eq('id', c.id)
        .in('status', REVIEW_STATUSES)
        .select('id');

      if (updErr) {
        // Treat a failed promotion as "left for review" rather than aborting the
        // whole batch — one bad row shouldn't block the rest.
        stats.left_for_review += 1;
        continue;
      }

      if (updated && updated.length > 0) {
        stats.auto_confirmed += 1;
      } else {
        // Lost the race / already moved out of a review status — count as review.
        stats.left_for_review += 1;
      }
    }

    return json({ ok: true, stats });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

function meetsBar(c: Candidate): boolean {
  if (!REVIEW_STATUSES.includes(c.status)) return false;
  if ((c.observed_count ?? 0) < MIN_OCCURRENCES) return false;
  if (!c.cadence) return false;
  if ((c.confidence ?? 0) < MIN_CONFIDENCE) return false;
  if ((c.amount_cents ?? 0) <= 0) return false;
  return true;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
