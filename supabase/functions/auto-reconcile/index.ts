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
 * Matching uses the existing atomic RPCs reconcile_match_bill /
 * reconcile_match_invoice (single-tx, org-scoped). Auto-applied matches are
 * stamped manually_matched = false (see migration 0064, which adds the
 * p_manually_matched flag and a service_role escape hatch on the org gate).
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

// View scores: base 0.5 (amount+date within tolerance)
//   + up to 0.5 recency bonus
//   + 0.2 counterparty-name substring hit
//   + 0.3 invoice/reference-number substring hit
// STRONG_THRESHOLD = 0.9 demands the base match PLUS strong corroboration
// (good recency, or a name/number hit) before the bot will act unattended.
const STRONG_THRESHOLD = 0.9;
// Any OTHER candidate at/above this floor (the view's own emit floor) makes the
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
  | { kind: 'invoice'; txnId: string; score: number; invoiceId: string; amountCents: number };

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
    const url = new URL(req.url);
    const urlSecret = url.searchParams.get('secret');
    const authHeader = req.headers.get('Authorization') ?? '';
    const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();

    let isServiceRole = bearer === serviceKey;
    if (!isServiceRole && bearer) {
      try {
        const payloadB64 = (bearer.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
        const payload = JSON.parse(
          atob(payloadB64 + '='.repeat((4 - (payloadB64.length % 4)) % 4)),
        );
        isServiceRole = payload?.role === 'service_role';
      } catch {
        /* not a service-role JWT — treat as a normal user JWT below */
      }
    }
    const cronAuthorized = isServiceRole || (!!cronSecret && urlSecret === cronSecret);

    // A user JWT (non-service-role bearer) gets the RLS path; cron uses admin.
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
      // Settle against the bank inflow amount (what actually arrived).
      push(v.bank_transaction_id, {
        kind: 'invoice',
        txnId: v.bank_transaction_id,
        score: Number(v.score),
        invoiceId: v.invoice_id,
        amountCents: v.bt_amount_cents,
      });
    }

    const stats = {
      scanned: byTxn.size,
      matched_bills: 0,
      matched_invoices: 0,
      skipped_ambiguous: 0,
      errors: [] as Array<{ bank_transaction_id: string; error: string }>,
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

      const winner = strong[0]!;
      try {
        if (winner.kind === 'bill') {
          const { data, error } = await rpcClient.rpc('reconcile_match_bill', {
            p_bank_transaction_id: txnId,
            p_bill_id: winner.billId,
            p_match_confidence: winner.score,
            p_manually_matched: false,
          });
          if (error) throw error;
          const r = data as { ok: boolean; error?: string } | null;
          if (r && !r.ok) throw new Error(r.error ?? 'reconcile_match_bill failed');
          stats.matched_bills += 1;
        } else {
          if (winner.amountCents <= 0) throw new Error('non-positive inflow amount');
          const { data, error } = await rpcClient.rpc('reconcile_match_invoice', {
            p_bank_transaction_id: txnId,
            p_invoice_id: winner.invoiceId,
            p_amount_cents: winner.amountCents,
            p_match_confidence: winner.score,
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
