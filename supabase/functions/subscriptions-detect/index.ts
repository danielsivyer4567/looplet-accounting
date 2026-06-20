/**
 * subscriptions-detect — find recurring payments in bank_transactions and
 * upsert them into the subscriptions table. Idempotent.
 *
 * Triggered by:
 *   1. End of bank-sync (fire-and-forget) → keeps subs fresh as new txns land
 *   2. Manual "Refresh subscriptions" button in /subscriptions UI
 *   3. Future: end of gmail-classify-ai when subscription-like emails are seen
 *
 * Algorithm:
 *   1. Group debit (negative amount) bank_transactions by canonical merchant key
 *      (description lowercased + cleaned + first 32 chars).
 *   2. For groups with >=3 txns:
 *      a. Compute median amount.
 *      b. Filter to txns within ±5% of median (drop outliers).
 *      c. Compute the median gap-in-days between consecutive postings.
 *      d. Classify cadence:
 *           ≤8d  → weekly
 *           9-16d → fortnightly
 *           17-45d → monthly
 *           46-100d → quarterly
 *           101-200d → semi_annual
 *           201-400d → yearly
 *           else → null (not a sub)
 *   3. Upsert into subscriptions on (organization_id, merchant_canonical_key).
 *
 * Out of scope (future): email-only subs (Gmail trigger), variable-amount subs
 * (e.g. utility bills), upgrade/downgrade detection, currency normalisation.
 *
 * Input: { organization_id }
 * Output: { ok, scanned_txns, candidates, upserted, updated, skipped }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';

interface RequestBody {
  organization_id: string;
}

interface BankTxn {
  id: string;
  posted_at: string;
  description: string;
  amount_cents: number;
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
    if (!supabaseUrl || !serviceKey || !anonKey) return json({ ok: false, error: 'Server config missing' }, 500);

    // Tolerant auth: service-role bypasses; user JWTs must verify org membership
    // through RLS before we touch tenant data with the admin client.
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    let isServiceRole = token === serviceKey;
    if (!isServiceRole) {
      try {
        const payloadB64 = (token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
        const payload = JSON.parse(atob(payloadB64 + '='.repeat((4 - payloadB64.length % 4) % 4)));
        isServiceRole = payload?.role === 'service_role';
      } catch { /* fall through */ }
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const body = (await req.json()) as RequestBody;
    if (!body.organization_id) return json({ ok: false, error: 'organization_id required' }, 400);

    // Org membership check via user-JWT (RLS enforces). Service-role skips.
    if (!isServiceRole) {
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: org } = await userClient
        .from('organizations')
        .select('id')
        .eq('id', body.organization_id)
        .maybeSingle();
      if (!org) return json({ ok: false, error: 'Organisation not accessible' }, 403);
    }

    // Pull last 18 months of debit txns (+ a small buffer for yearly subs)
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 18);
    const cutoffIso = cutoff.toISOString();

    const { data: txns, error: txnErr } = await admin
      .from('bank_transactions')
      .select('id, posted_at, description, amount_cents')
      .eq('organization_id', body.organization_id)
      .lt('amount_cents', 0)
      .gte('posted_at', cutoffIso)
      .order('posted_at', { ascending: true });
    if (txnErr) return json({ ok: false, error: txnErr.message }, 500);

    const allTxns = (txns ?? []) as BankTxn[];
    const groups = groupByMerchant(allTxns);

    let upserted = 0;
    let updated = 0;
    let skipped = 0;
    const candidates: { key: string; merchant: string; reason: string }[] = [];

    for (const [key, list] of groups) {
      if (list.length < 3) { skipped += 1; continue; }

      const amounts = list.map((t) => -t.amount_cents); // make positive
      const median = medianOf(amounts);
      const filtered = list.filter((t) => Math.abs(-t.amount_cents - median) <= median * 0.05);
      if (filtered.length < 3) { skipped += 1; continue; }

      const sorted = [...filtered].sort((a, b) => a.posted_at.localeCompare(b.posted_at));
      const gaps: number[] = [];
      for (let i = 1; i < sorted.length; i += 1) {
        const d1 = new Date(sorted[i - 1].posted_at).getTime();
        const d2 = new Date(sorted[i].posted_at).getTime();
        gaps.push(Math.round((d2 - d1) / 86400000));
      }
      const medianGap = medianOf(gaps);
      const cadence = classifyCadence(medianGap);
      if (!cadence) { skipped += 1; continue; }

      const firstSeen = sorted[0].posted_at;
      const lastSeen = sorted[sorted.length - 1].posted_at;
      const totalSpent = filtered.reduce((acc, t) => acc + (-t.amount_cents), 0);
      const merchantName = prettifyMerchant(filtered[0].description);
      const nextExpected = nextExpectedDate(lastSeen, medianGap);

      // Upsert
      const { data: existing } = await admin
        .from('subscriptions')
        .select('id, observed_count, total_spent_cents, status')
        .eq('organization_id', body.organization_id)
        .eq('merchant_canonical_key', key)
        .maybeSingle();

      if (existing) {
        await admin.from('subscriptions').update({
          merchant_name: merchantName,
          cadence,
          amount_cents: median,
          last_seen_at: lastSeen,
          next_expected_at: nextExpected,
          observed_count: filtered.length,
          total_spent_cents: totalSpent,
          confidence: confidenceScore(filtered.length, gaps),
          updated_at: new Date().toISOString(),
        }).eq('id', existing.id);
        updated += 1;
      } else {
        await admin.from('subscriptions').insert({
          organization_id: body.organization_id,
          merchant_canonical_key: key,
          merchant_name: merchantName,
          cadence,
          amount_cents: median,
          currency_code: 'AUD',
          // 'candidate' is the unreviewed state in the subscription_status enum
          // ('detected' was never a real enum label — inserting it errored).
          status: 'candidate',
          confidence: confidenceScore(filtered.length, gaps),
          first_seen_at: firstSeen,
          last_seen_at: lastSeen,
          next_expected_at: nextExpected,
          observed_count: filtered.length,
          total_spent_cents: totalSpent,
          detection_reason: `bank-recurring: ${filtered.length}× ${cadence} (median gap ${medianGap}d, $${(median / 100).toFixed(2)})`,
          is_personal: false,
          is_business: false,
        });
        upserted += 1;
      }
      candidates.push({ key, merchant: merchantName, reason: `${cadence} ${filtered.length}× $${(median / 100).toFixed(2)}` });
    }

    return json({
      ok: true,
      scanned_txns: allTxns.length,
      grouped_into: groups.size,
      candidates: candidates.slice(0, 50),
      upserted,
      updated,
      skipped,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

function canonicaliseDescription(d: string): string {
  return d
    .toLowerCase()
    .replace(/\d{4,}/g, '')           // long numbers (card masks, refs)
    .replace(/[^a-z\s]/g, ' ')        // keep letters + spaces
    .replace(/\b(au|aus|australia|pty|ltd|llc|inc)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);
}

function prettifyMerchant(raw: string): string {
  // Strip common card-network noise + capitalise first words
  const cleaned = raw
    .replace(/\b(eftpos|visa|mastercard|debit|withdrawal|transfer|payment)\b/gi, '')
    .replace(/\d{4,}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : raw;
}

function groupByMerchant(txns: BankTxn[]): Map<string, BankTxn[]> {
  const map = new Map<string, BankTxn[]>();
  for (const t of txns) {
    const key = canonicaliseDescription(t.description);
    if (!key || key.length < 4) continue;
    const list = map.get(key) ?? [];
    list.push(t);
    map.set(key, list);
  }
  return map;
}

function medianOf(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

function classifyCadence(gapDays: number): string | null {
  if (gapDays >= 5 && gapDays <= 8) return 'weekly';
  if (gapDays >= 9 && gapDays <= 16) return 'fortnightly';
  if (gapDays >= 17 && gapDays <= 45) return 'monthly';
  if (gapDays >= 46 && gapDays <= 100) return 'quarterly';
  if (gapDays >= 101 && gapDays <= 200) return 'semi_annual';
  if (gapDays >= 201 && gapDays <= 400) return 'yearly';
  return null;
}

function nextExpectedDate(lastSeen: string, medianGap: number): string {
  const d = new Date(lastSeen);
  d.setDate(d.getDate() + medianGap);
  return d.toISOString().slice(0, 10);
}

function confidenceScore(observations: number, gaps: number[]): number {
  // More observations + tighter gap variance = higher confidence
  const obsScore = Math.min(observations / 12, 1) * 0.5; // 12+ obs maxes out
  if (gaps.length === 0) return Math.round(obsScore * 100) / 100;
  const m = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const variance = gaps.reduce((a, b) => a + (b - m) ** 2, 0) / gaps.length;
  const stdev = Math.sqrt(variance);
  const cv = m > 0 ? stdev / m : 1;
  const consistencyScore = Math.max(0, 1 - cv) * 0.5;
  return Math.round((obsScore + consistencyScore) * 100) / 100;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
