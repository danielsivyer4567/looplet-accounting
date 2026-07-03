// Edge function: accruals-run  (SC-1.I.03)
//
// Scheduled DRIVER for straight-line reversing accruals. For every org (or one
// scoped org) it detects recurring bill series via detect_recurring_bills
// (SC-1.I.01) and, for each series whose cadence spans MORE THAN ONE month
// (quarterly / semi-annual / yearly — a lump billed in advance that should be
// spread), calls accrue_recurring_bill (SC-1.I.02) on the series' MOST-RECENT bill
// with an explicit period count. The RPC builds + posts the self-cancelling
// accrual / reversal journal pairs through the sole sanctioned path
// post_journal_entry() (0073; GL immutable, 0075); each pair nets to zero across
// the window. The reversing pair for the CURRENT period is the first pair posted.
//
// This function COMPUTES and POSTS nothing itself — all journal work lives in
// accrue_recurring_bill. The driver only: (1) detects series per org, (2) selects
// the bill + period count, (3) calls the RPC through an org-scoped token. The
// RPC owns idempotency (per source_type + bill + entry_date): a re-run reuses any
// prior posting and never double-posts, so the monthly cron is safe to re-fire.
//
// WHY only cadences > monthly (SC-1.I.02 forward note c): a monthly / fortnightly /
// weekly series derives N=1 — a single self-cancelling pair in the bill's own
// month, i.e. no real spread. Accruing it is pure churn, so those are skipped.
//
// WHY explicit p_periods (SC-1.I.02 forward note b): a NULL p_periods makes the RPC
// re-run detect_recurring_bills for every bill. We detect ONCE per org and map the
// cadence to N ourselves, using the SAME mapping the RPC applies internally.
//
// EXPENSE ACCOUNT (SC-1.I.02 forward note d): the accrual's interim expense leg
// should use the bill's mapped expense code, not the bare '6900' default. We reuse
// the code the coding-classifier already resolved into coding_suggestions
// (account_code); a bill with no suggestion falls back to the RPC default. A bad /
// inactive code makes the RPC fail closed for that bill (recorded, no journal).
//
// AUTH (cron, mirrors depreciation-run / auto-reconcile): service-role bearer OR
// ?secret=<ACCRUALS_RUN_CRON_SECRET>, both constant-time compared. Deployed
// verify_jwt=false (config.toml) so pg_cron can drive it (0099 cron migration). A
// forged / non-matching bearer is rejected (no unsigned-claim trust).
//
// POSTING MECHANICS (mirrors depreciation-run / coding-classifier): reads use the
// service-role admin client; accrue_recurring_bill is SECURITY INVOKER and its
// post_journal_entry() call (SECURITY DEFINER) re-checks organization_id IN
// get_accessible_org_ids(), which for a backend caller with no auth.uid() resolves
// the org ONLY from the integration `organization_id` JWT claim (0069). So each
// org's accrual goes through a short-lived org-scoped HS256 token minted exactly
// like api-gateway (CONNECTOR_JWT_SECRET). Fails CLOSED per bill — the RPC raises
// and we record the error, posting nothing — if the secret is unset, the
// 6900/2600 accounts are missing/inactive, or a period is locked.
//
// Request body (all optional):
//   { organization_id?: uuid }   // scope to one org; default = every org
//
// DEPLOY PREREQUISITES (migration-history drift — see ledger SC-1.I.03):
//   - migrations 0090-0098 applied live (esp. 0098: detect_recurring_bills +
//     accrue_recurring_bill + 2600 Accrued expenses in the COA seed)
//   - chart_of_accounts seeded per org (seed_default_chart_of_accounts) so the
//     expense leg + 2600 resolve; until then each bill fails closed (records an
//     error, posts no journal)
//   - secret CONNECTOR_JWT_SECRET set (already required by api-gateway)
//   - secret ACCRUALS_RUN_CRON_SECRET set if driving via ?secret= (cron, 0099)
//   - deploy: `supabase functions deploy accruals-run` (verify_jwt=false)

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { create, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { requireEnv } from "../_shared/env.ts";
import { isExactSecret, isExactServiceRoleBearer } from "../_shared/serviceRole.ts";
import { planAccrualJobs, type RecurringSeries } from "./logic.ts";

// Default expense leg when a bill has no coding suggestion to source a code from.
// Matches accrue_recurring_bill's own p_expense_account_code default (0098).
const DEFAULT_EXPENSE_CODE = "6900";

interface RequestBody {
  organization_id?: string;
}

// One row of accrue_recurring_bill's RETURNS TABLE (SC-1.I.02); we only read reused.
interface AccrualLeg {
  reused: boolean;
}

interface Stats {
  orgs_scanned: number;
  series_detected: number;
  skipped_short_cadence: number;
  accrued_bills: number;
  posted_entries: number;
  reused_entries: number;
  errors: { organization_id: string; bill_id?: string; error: string }[];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// The HMAC signing key is static per deployment; import it once per isolate.
let cachedSigningKey: CryptoKey | null = null;
async function signingKey(): Promise<CryptoKey | null> {
  if (cachedSigningKey) return cachedSigningKey;
  const secret = Deno.env.get("CONNECTOR_JWT_SECRET");
  if (!secret) return null;
  cachedSigningKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return cachedSigningKey;
}

// Mint a short-lived org-scoped token so get_accessible_org_ids() authorises the
// backend caller of post_journal_entry() (integration org claim, migration 0069).
async function mintOrgToken(orgId: string): Promise<string | null> {
  const key = await signingKey();
  if (!key) return null;
  return await create(
    { alg: "HS256", typ: "JWT" },
    { role: "authenticated", aud: "authenticated", organization_id: orgId, exp: getNumericDate(300) },
    key,
  );
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  try {
    const supabaseUrl = requireEnv("SUPABASE_URL");
    const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const anonKey = requireEnv("SUPABASE_ANON_KEY");
    const cronSecret = Deno.env.get("ACCRUALS_RUN_CRON_SECRET");

    // Auth gate: service-role bearer OR ?secret= (cron). Both constant-time; the
    // cron secret is unavailable when unset (fail closed). No user-JWT path — this
    // function is cron/admin-driven only.
    const url = new URL(req.url);
    const urlSecret = url.searchParams.get("secret");
    const isServiceRole = isExactServiceRoleBearer(req.headers.get("Authorization"), serviceKey);
    const secretOk = !!cronSecret && isExactSecret(urlSecret, cronSecret);
    if (!isServiceRole && !secretOk) return json({ ok: false, error: "Unauthorized" }, 401);

    const body = (await req.json().catch(() => ({}))) as RequestBody;

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Org scope: one org from the body, else every org (the driver sweeps them
    // itself, like depreciation-run). An org with no qualifying recurring series
    // costs one detect call and is otherwise a no-op.
    let orgIds: string[];
    if (body.organization_id) {
      orgIds = [body.organization_id];
    } else {
      const { data, error } = await admin.from("organizations").select("id");
      if (error) return json({ ok: false, error: `load organizations: ${error.message}` }, 500);
      orgIds = ((data ?? []) as { id: string }[]).map((o) => o.id);
    }

    const stats: Stats = {
      orgs_scanned: orgIds.length,
      series_detected: 0,
      skipped_short_cadence: 0,
      accrued_bills: 0,
      posted_entries: 0,
      reused_entries: 0,
      errors: [],
    };

    // The org-scoped post client is a pure function of organization_id, so mint it
    // at most once per org per run (null when CONNECTOR_JWT_SECRET is unset).
    const orgClientCache = new Map<string, SupabaseClient | null>();
    const getOrgClient = async (orgId: string): Promise<SupabaseClient | null> => {
      if (orgClientCache.has(orgId)) return orgClientCache.get(orgId) ?? null;
      const token = await mintOrgToken(orgId);
      const client = token
        ? createClient(supabaseUrl, anonKey, {
            global: { headers: { Authorization: `Bearer ${token}` } },
            auth: { persistSession: false, autoRefreshToken: false },
          })
        : null;
      orgClientCache.set(orgId, client);
      return client;
    };

    for (const orgId of orgIds) {
      // Detect via the admin client: detect_recurring_bills is SECURITY INVOKER and
      // service_role bypasses RLS, so the p_org filter scopes the read.
      const { data: series, error: detErr } = await admin.rpc("detect_recurring_bills", { p_org: orgId });
      if (detErr) {
        stats.errors.push({ organization_id: orgId, error: `detect_recurring_bills: ${detErr.message}` });
        continue;
      }
      const rows = (series ?? []) as RecurringSeries[];
      stats.series_detected += rows.length;

      // Qualifying series = cadence > monthly. Take each series' MOST-RECENT bill
      // (bill_ids is chronological asc, 0098) — the current lump to spread.
      //
      // SELECTION POLICY (forward note, see logic.ts): only the most-recent bill is
      // accrued, never the whole back-catalogue. Accruals are forward-facing — they
      // spread the current lump from the bill's own month onward (accrue_recurring_
      // bill's p_start_period default). Older bills in a multi-year series would
      // backdate accrual journals into already-closed/locked periods (post_journal_
      // entry would reject them) for no benefit. The monthly cron is idempotent and
      // extends a series forward as new lumps arrive; it never backdates. A rare
      // historical backfill is a manual accrue_recurring_bill call with an explicit
      // p_periods/p_start_period, not this driver's job.
      const { jobs, skippedShortCadence } = planAccrualJobs(rows);
      stats.skipped_short_cadence += skippedShortCadence;
      if (jobs.length === 0) continue;

      // Expense code per bill (forward note d): reuse the coding-classifier's
      // resolved account_code; fall back to the default where there's no suggestion.
      const billIds = jobs.map((j) => j.billId);
      const { data: suggestions, error: sugErr } = await admin
        .from("coding_suggestions")
        .select("bill_id, account_code")
        .in("bill_id", billIds)
        .is("deleted_at", null);
      if (sugErr) {
        // Non-fatal: proceed with the default expense code for every bill.
        stats.errors.push({ organization_id: orgId, error: `load coding_suggestions: ${sugErr.message}` });
      }
      const expenseByBill = new Map<string, string>();
      for (const r of (suggestions ?? []) as { bill_id: string; account_code: string | null }[]) {
        if (r.account_code) expenseByBill.set(r.bill_id, r.account_code);
      }

      const orgClient = await getOrgClient(orgId);

      for (const job of jobs) {
        if (!orgClient) {
          stats.errors.push({
            organization_id: orgId,
            bill_id: job.billId,
            error: "CONNECTOR_JWT_SECRET unset; cannot post",
          });
          continue;
        }
        const expenseCode = expenseByBill.get(job.billId) ?? DEFAULT_EXPENSE_CODE;
        const { data: legs, error: accErr } = await orgClient.rpc("accrue_recurring_bill", {
          p_bill_id: job.billId,
          p_periods: job.periods,
          p_expense_account_code: expenseCode,
        });
        if (accErr) {
          stats.errors.push({ organization_id: orgId, bill_id: job.billId, error: `accrue_recurring_bill: ${accErr.message}` });
          continue;
        }
        const legRows = (legs ?? []) as AccrualLeg[];
        const posted = legRows.filter((l) => !l.reused).length;
        stats.posted_entries += posted;
        stats.reused_entries += legRows.length - posted;
        stats.accrued_bills += 1;
      }
    }

    return json({ ok: true, scope: body.organization_id ?? "all", stats });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});
