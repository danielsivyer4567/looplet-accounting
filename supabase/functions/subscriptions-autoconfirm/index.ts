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
 *   2. observed_count >= MIN_OCCURRENCES — recurring across >= that many occurrences
 *      of the same supplier (merchant_canonical_key)
 *   3. cadence is a recognised regular cadence (not null)
 *   4. confidence >= MIN_CONFIDENCE — see the coupling note below.
 *   5. amount_cents > 0 — a real recurring amount was learned.
 *
 * Everything below the bar is left untouched for manual review.
 *
 * ── Coupling with subscriptions-detect's confidenceScore (IMPORTANT) ──────────
 * MIN_CONFIDENCE is NOT an independent dial: it is tightly coupled to the exact
 * score formula in subscriptions-detect/confidenceScore(), which is:
 *
 *     obsScore         = min(observed_count / 12, 1) * 0.5   // max 0.5 at 12+ obs
 *     consistencyScore = max(0, 1 - cv) * 0.5                // max 0.5, cv = stdev/mean of gaps
 *     confidence       = round((obsScore + consistencyScore) * 100) / 100
 *
 * Because consistencyScore is capped at 0.5, confidence can only reach 0.80 once
 * obsScore >= 0.30, i.e. observed_count >= ~8. Concretely, the lowest observed_count
 * that can EVER reach confidence 0.80 is 8 (and only with a near-perfect cadence,
 * cv <= 0.067); the cadence-regularity allowance loosens as observations grow:
 *     obs= 8 -> cv <= 0.067    obs=10 -> cv <= 0.233
 *     obs= 9 -> cv <= 0.150    obs=12+ -> cv <= 0.400
 * Anything with observed_count <= 7 mathematically CANNOT hit 0.80, so a lower
 * MIN_OCCURRENCES would be dead code. MIN_OCCURRENCES is therefore set to 8 to
 * match the real floor the confidence bar already implies (defence in depth +
 * honest intent). If you change confidenceScore's weights/caps in the detector,
 * RE-DERIVE both MIN_CONFIDENCE and MIN_OCCURRENCES here — they are a pair.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Idempotency: re-running only ever sees candidates still in 'detected'/'candidate'.
 * Once confirmed they no longer match the WHERE clause, so a second run is a no-op.
 *
 * Auth: service-role (raw service key only — NOT a self-asserted JWT role claim)
 *   bypasses the org check; any other token must be a real user whose access to
 *   the org is proven by an RLS-enforced read before we touch tenant data.
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

// Coupled to subscriptions-detect/confidenceScore() — see the module header.
// 0.80 is only reachable once observed_count >= 8 (consistencyScore caps at 0.5),
// so MIN_OCCURRENCES=8 makes the implied floor explicit rather than dead code.
const MIN_CONFIDENCE = 0.80;
const MIN_OCCURRENCES = 8;
// 'candidate' is the only unreviewed status in the subscription_status enum
// (candidate|confirmed|dismissed|cancelled). 'detected' was a phantom value.
const REVIEW_STATUSES = ['candidate'];

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

    // Service-role detection is by RAW KEY MATCH ONLY. We deliberately do NOT
    // decode the JWT and trust its `role` claim — an attacker controls the token
    // body, so a self-asserted role:'service_role' would be forgeable. The only
    // bearer we treat as service-role is the literal service key.
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    const isServiceRole = token === serviceKey;

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const body = (await req.json().catch(() => ({}))) as RequestBody;
    if (!body.organization_id) return json({ ok: false, error: 'organization_id required' }, 400);

    // Any non-service-role caller must be a REAL, verified user with access to the
    // org. We (a) verify the JWT identifies an actual user via getUser(), then
    // (b) prove org access through an RLS-enforced read with that same user JWT.
    if (!isServiceRole) {
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (userErr || !userData?.user) {
        return json({ ok: false, error: 'Unauthorized' }, 401);
      }
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
      // matches zero rows). organization_id is re-asserted as defence in depth.
      // confirmation_source='auto' (not an overloaded NULL confirmed_by) is the
      // authoritative marker that automation made this decision; confirmed_by
      // stays NULL because no human user confirmed it.
      const { data: updated, error: updErr } = await admin
        .from('subscriptions')
        .update({
          status: 'confirmed',
          auto_confirmed_at: nowIso,
          confirmed_at: nowIso,
          confirmed_by: null,
          confirmation_source: 'auto',
          confirmation_reason: reason,
          reviewed_at: nowIso,
          updated_at: nowIso,
        })
        .eq('id', c.id)
        .eq('organization_id', body.organization_id)
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
