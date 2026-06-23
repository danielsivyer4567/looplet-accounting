/**
 * auto-reconcile — autopilot bank reconciliation (EPIC C2).
 *
 * For one organization, reads the two scored candidate views
 *   - v_bank_match_candidates         (bank debit  -> outstanding bill,  AP)
 *   - v_bank_invoice_match_candidates (bank inflow  -> outstanding invoice, AR)
 * and auto-applies a match ONLY when a bank transaction has exactly one
 * candidate (across both views) at/above STRONG_THRESHOLD. If two or more
 * candidates clear the (lower) AMBIGUITY_FLOOR the transaction is left
 * untouched for a human to resolve — we never guess between plausible matches.
 *
 * Candidate views: v_bank_match_candidates (AP) is defined in migration 0063;
 * v_bank_invoice_match_candidates (AR) in 0035. Both are security_invoker=on.
 *
 * Matching uses the atomic RPCs reconcile_match_bill / reconcile_match_invoice
 * (single-tx, org-scoped). Auto-applied matches are stamped
 * manually_matched = false (see migration 0064, which adds the
 * p_manually_matched flag, a service_role escape hatch on the org gate, and an
 * amount-tolerance guard on reconcile_match_bill). Invoice settlements record
 * min(inflow, balance_due) so an over-payment never posts a negative balance.
 *
 * Input:  { organization_id }
 * Output: { ok, stats: { scanned, matched_bills, matched_invoices,
 *                         skipped_ambiguous, errors[] } }
 *
 * Auth (mirrors bills-extract-batch + notifications-cron):
 *   - user JWT  -> RLS org-access check, then RPCs called as that user.
 *   - service-role bearer OR ?secret=<AUTO_RECONCILE_CRON_SECRET> -> cron path,
 *     RPCs called via the admin client (org gate bypassed by service_role).
 *
 * Deployed with --no-verify-jwt so pg_cron can drive it (see migration 0065).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';

interface RequestBody {
  organization_id?: string;
}

// View scores (confirmed against live pg_get_viewdef — both views are
// security_invoker=on; AP = 0063 v_bank_match_candidates, AR = 0035
// v_bank_invoice_match_candidates):
//
//   AP (bill)    : 0.5 base + up to 0.5 recency (over a 14-day window)
//                  + 0.2 supplier-name hit            -> MAX 1.2
//   AR (invoice) : 0.5 base + up to 0.5 recency (over a 60-day window)
//                  + 0.2 customer-name hit + 0.3 invoice-number hit -> MAX 1.5
//
// The two formulas differ (date windows, and only AR has the number bonus), so
// a single normalised threshold isn't meaningful. We gate on raw score:
//
// STRONG_THRESHOLD = 1.0 demands the full base match PLUS strong corroboration —
// either an essentially same-day posting (base 0.5 + ~full 0.5 recency) or a
// name/number substring hit. A loosely-dated match with no name/number hit
// (e.g. AP 7 days out, no supplier hit = 0.5 + 0.25 = 0.75) stays below the bar
// and is left for a human.
const STRONG_THRESHOLD = 1.0;
// Any OTHER candidate at/above this floor (the views' own emit floor) makes the
// transaction ambiguous, so we decline to auto-match it.
const AMBIGUITY_FLOOR = 0.5;

interface BillCandidate {
  bank_transaction_id: string;
  bill_id: string;
  bill_amount_cents: number;
  score: number;
}

interface InvoiceCandidate {
  bank_transaction_id: string;
  invoice_id: string;
  bt_amount_cents: number;
  invoice_balance_due_cents: number;
  score: number;
}

type Candidate =
  | { kind: 'bill'; txnId: string; score: number; billId: string; amountCents: number }
  | {
      kind: 'invoice';
      txnId: string;
      score: number;
      invoiceId: string;
      amountCents: number;
      balanceDueCents: number;
    };

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const cronSecret = Deno.env.get('AUTO_RECONCILE_CRON_SECRET');
    if (!supabaseUrl || !serviceKey || !anonKey) {
      return json({ ok: false, error: 'Server config missing' }, 500);
    }

    // --- Auth gate: service-role bearer OR ?secret= OR user JWT --------------
    // SECURITY: the previous "base64-decode the bearer and trust its UNSIGNED
    // role claim" path was forgeable — this function is deployed --no-verify-jwt,
    // so an attacker-minted token (payload {"role":"service_role"}) reached the
    // handler and got the admin/cron path. Removed. Service-role is now ONLY an
    // exact constant-time match against the real key; the cron secret is
    // likewise constant-time and unavailable when unset (fail closed). A forged
    // token falls through to the user-JWT path below, where PostgREST verifies
    // the signature against the project secret and rejects it. See AUDIT.md §3d
    // (same fix already applied to bank-sync-all / notifications-cron).
    const url = new URL(req.url);
    const urlSecret = url.searchParams.get('secret');
    const authHeader = req.headers.get('Authorization') ?? '';
    const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();

    const isServiceRole = safeEqual(bearer, serviceKey);
    const secretOk = !!cronSecret && safeEqual(urlSecret ?? '', cronSecret);
    const cronAuthorized = isServiceRole || secretOk;

    // A user JWT (any non-service-role bearer) gets the RLS path; cron uses admin.
    const hasUserJwt = !!bearer && !isServiceRole;
    if (!cronAuthorized && !hasUserJwt) {
      return json({ ok: false, error: 'Unauthorized' }, 401);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // userClient carries the caller's JWT so the RPC org-gate (auth.uid())
    // resolves. For the cron/service-role path we drive the RPCs via admin.
    const rpcClient = hasUserJwt
      ? createClient(supabaseUrl, anonKey, {
          global: { headers: { Authorization: authHeader } },
        })
      : admin;

    const body = (await req.json().catch(() => ({}))) as RequestBody;
    if (!body.organization_id) {
      return json({ ok: false, error: 'organization_id required' }, 400);
    }
    const orgId = body.organization_id;

    // RLS org-access check for user-JWT callers (same as bills-extract-batch).
    if (hasUserJwt) {
      const { data: org, error: orgErr } = await rpcClient
        .from('organizations')
        .select('id')
        .eq('id', orgId)
        .maybeSingle();
      if (orgErr || !org) {
        return json({ ok: false, error: 'Organisation not accessible' }, 403);
      }
    }

    // --- Read both candidate views (admin: views are SECURITY INVOKER but we
    //     filter by org explicitly; admin avoids RLS surprises on the cron path).
    const [billRes, invoiceRes] = await Promise.all([
      admin
        .from('v_bank_match_candidates')
        .select('bank_transaction_id, bill_id, bill_amount_cents, score')
        .eq('organization_id', orgId)
        .gte('score', AMBIGUITY_FLOOR),
      admin
        .from('v_bank_invoice_match_candidates')
        .select('bank_transaction_id, invoice_id, bt_amount_cents, invoice_balance_due_cents, score')
        .eq('organization_id', orgId)
        .gte('score', AMBIGUITY_FLOOR),
    ]);

    if (billRes.error) return json({ ok: false, error: `bill candidates: ${billRes.error.message}` }, 500);
    if (invoiceRes.error) {
      return json({ ok: false, error: `invoice candidates: ${invoiceRes.error.message}` }, 500);
    }

    // Group every candidate by bank transaction.
    const byTxn = new Map<string, Candidate[]>();
    const push = (txnId: string, c: Candidate) => {
      const list = byTxn.get(txnId) ?? [];
      list.push(c);
      byTxn.set(txnId, list);
    };

    for (const b of (billRes.data ?? []) as BillCandidate[]) {
      push(b.bank_transaction_id, {
        kind: 'bill',
        txnId: b.bank_transaction_id,
        score: Number(b.score),
        billId: b.bill_id,
        amountCents: b.bill_amount_cents,
      });
    }
    for (const v of (invoiceRes.data ?? []) as InvoiceCandidate[]) {
      // Carry both the bank inflow and the invoice balance; the settlement
      // amount is min(inflow, balance_due), computed at apply time.
      push(v.bank_transaction_id, {
        kind: 'invoice',
        txnId: v.bank_transaction_id,
        score: Number(v.score),
        invoiceId: v.invoice_id,
        amountCents: v.bt_amount_cents,
        balanceDueCents: v.invoice_balance_due_cents,
      });
    }

    const stats = {
      scanned: byTxn.size,
      matched_bills: 0,
      matched_invoices: 0,
      skipped_ambiguous: 0,
      errors: [] as { bank_transaction_id: string; error: string }[],
    };

    for (const [txnId, candidates] of byTxn) {
      const strong = candidates.filter((c) => c.score >= STRONG_THRESHOLD);

      // Auto-match only when there is exactly ONE strong candidate AND it is the
      // sole candidate at all (no other rival cleared AMBIGUITY_FLOOR). Anything
      // else is left for a human:
      //   - 0 strong            -> nothing confident enough (not counted as skip)
      //   - 2+ strong           -> ambiguous
      //   - 1 strong + a rival  -> ambiguous
      if (strong.length !== 1 || candidates.length > 1) {
        if (strong.length >= 1) stats.skipped_ambiguous += 1;
        continue;
      }

      const winner = strong[0];
      if (!winner) continue;
      // match_confidence is stored on bank_transactions and surfaced in the UI;
      // raw view scores can exceed 1.0 (AP max 1.2, AR max 1.5), so clamp to
      // [0, 1] before persisting.
      const confidence = clamp01(winner.score);
      try {
        if (winner.kind === 'bill') {
          // The RPC enforces the amount tolerance, but assert here too so the
          // unattended path never even attempts a mismatched settlement.
          const { data, error } = await rpcClient.rpc('reconcile_match_bill', {
            p_bank_transaction_id: txnId,
            p_bill_id: winner.billId,
            p_match_confidence: confidence,
            p_manually_matched: false,
          });
          if (error) throw error;
          const r = data as { ok: boolean; error?: string } | null;
          if (r && !r.ok) throw new Error(r.error ?? 'reconcile_match_bill failed');
          stats.matched_bills += 1;
        } else {
          if (winner.amountCents <= 0) throw new Error('non-positive inflow amount');
          // Over/under-payment guard for the unattended path: never record more
          // than the outstanding balance. Settle min(inflow, balance_due) so a
          // larger inflow doesn't post a negative balance, and a partial inflow
          // is recorded at face value (leaving a residual balance for a human).
          const settleCents = Math.min(winner.amountCents, winner.balanceDueCents);
          if (settleCents <= 0) throw new Error('non-positive settlement amount');
          const { data, error } = await rpcClient.rpc('reconcile_match_invoice', {
            p_bank_transaction_id: txnId,
            p_invoice_id: winner.invoiceId,
            p_amount_cents: settleCents,
            p_match_confidence: confidence,
            p_manually_matched: false,
          });
          if (error) throw error;
          const r = data as { ok: boolean; error?: string } | null;
          if (r && !r.ok) throw new Error(r.error ?? 'reconcile_match_invoice failed');
          stats.matched_invoices += 1;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stats.errors.push({ bank_transaction_id: txnId, error: msg });
      }
    }

    return json({ ok: true, stats });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Constant-time string compare; false on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
