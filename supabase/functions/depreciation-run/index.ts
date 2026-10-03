// Edge function: depreciation-run  (SC-1.G.02)
//
// Monthly depreciation posting. For every ACTIVE depreciation_schedules row
// (parent fixed_assets.status = 'active'), compute the depreciation expense for
// the target month via compute_depreciation(schedule, period) (SC-1.G.01) and,
// when it is > 0 and not already posted for that (schedule, period), post a
// balanced journal:  Dr Depreciation expense  /  Cr Accumulated depreciation
// through the SOLE sanctioned path post_journal_entry() (0073; GL immutable, 0075).
//
// IDEMPOTENT per (schedule, period): the posting is stamped on the journal as
// source_type='depreciation_schedule', source_id=<schedule>, entry_date=<last day
// of the period month>. A re-run (cron firing twice, or a manual replay) finds the
// existing POSTED entry for that (schedule, month) and skips it — never a
// double-post. (Concurrency note: this is a check-then-insert like the coding
// classifier; pg_cron serialises a job's runs so a same-instant double-fire does
// not occur in practice. A future hard guard would be a partial unique index on
// journal_entries(source_type, source_id, entry_date).)
//
// AUTH (cron, mirrors auto-reconcile): service-role bearer OR
// an X-Cron-Secret header matching DEPRECIATION_RUN_CRON_SECRET, both constant-time compared. Deployed
// verify_jwt=false (config.toml) so pg_cron can drive it (SC-1.G.03). A
// forged/non-matching bearer is rejected (no unsigned-claim trust).
//
// POSTING MECHANICS (mirrors coding-classifier): all reads/writes use the
// service-role admin client; post_journal_entry() is SECURITY DEFINER and
// re-checks organization_id IN get_accessible_org_ids(), which for a backend
// caller with no auth.uid() resolves the org ONLY from the integration
// `organization_id` JWT claim (0069). So each post goes through a short-lived
// org-scoped HS256 token minted exactly like api-gateway (CONNECTOR_JWT_SECRET).
// Fails CLOSED — the still-draft entry is unwound and nothing posts — if the
// secret is unset, the 6700/1900 accounts are missing/inactive, or the post errors.
//
// Request body (all optional):
//   { organization_id?: uuid,   // scope to one org; default = all accessible orgs
//     period?: 'YYYY-MM-DD' }    // any date in the target month; default = last day
//                                // of the PREVIOUS calendar month (post the month
//                                // that just closed). compute_depreciation keys on
//                                // the calendar MONTH, so any day in it is equivalent.
//
// DEPLOY PREREQUISITES (migration-history drift — see ledger SC-1.G.02):
//   - migrations 0093 (fixed_assets/depreciation_schedules) + 0095 (compute_depreciation)
//     + 0097 (6700/1900 depreciation accounts in the COA seed) applied live
//   - chart_of_accounts seeded per org (seed_default_chart_of_accounts) so 6700/1900
//     resolve; until then the run fails closed (records an error, posts no journal)
//   - secret CONNECTOR_JWT_SECRET set (already required by api-gateway)
//   - secret DEPRECIATION_RUN_CRON_SECRET set if driving via the X-Cron-Secret header (cron, SC-1.G.03)
//   - deploy: `supabase functions deploy depreciation-run` (verify_jwt=false)

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { create, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { presentedCronSecret } from "../_shared/cronSecret.ts";
import { requireEnv } from "../_shared/env.ts";
import { isExactSecret, isExactServiceRoleBearer } from "../_shared/serviceRole.ts";
import { assetName, resolveTargetDate, type ScheduleRow } from "./logic.ts";

// Reserved chart-of-accounts codes seeded by 0097 (extends seed_default_chart_of_accounts).
// NOTE: like coding-classifier (0073's 1000/1200/2000), this couples posting to the
// seeded COA template. A custom/renamed depreciation account simply won't resolve
// below and the schedule is skipped (fail-closed, no journal). A future per-org
// system-account map (ledger SC-3.B GST control accounts) should replace these
// literals with a type->account lookup.
const DEPRECIATION_EXPENSE_CODE = "6700"; // Depreciation expense (P&L)
const ACCUM_DEPRECIATION_CODE = "1900"; // Accumulated depreciation (contra-asset)

interface RequestBody {
  organization_id?: string;
  period?: string;
}

interface PostResult {
  posted: boolean;
  journalEntryId: string | null;
  reason: string | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function resolveAccounts(admin: SupabaseClient, orgId: string, codes: string[]): Promise<Map<string, string>> {
  const { data, error } = await admin
    .from("chart_of_accounts")
    .select("id, code")
    .eq("organization_id", orgId)
    .eq("is_active", true)
    .in("code", codes);
  if (error) throw new Error(`resolve accounts: ${error.message}`);
  const map = new Map<string, string>();
  for (const r of (data ?? []) as { id: string; code: string }[]) map.set(r.code, r.id);
  return map;
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

// Post ONE schedule's depreciation for the target month: build the balanced draft
// (Dr depreciation expense / Cr accumulated depreciation) and post via
// post_journal_entry. Unwinds the still-draft entry on any pre-post failure (0075
// freezes posted rows only, so a draft delete is always allowed).
async function postDepreciation(
  admin: SupabaseClient,
  orgClient: SupabaseClient | null,
  sched: ScheduleRow,
  entryDate: string,
  amountCents: number,
  expenseId: string,
  accumId: string,
): Promise<PostResult> {
  const name = assetName(sched);
  const memo = `Depreciation ${entryDate}${name ? ` — ${name}` : ""}`;

  const { data: entry, error: entryErr } = await admin
    .from("journal_entries")
    .insert({
      organization_id: sched.organization_id,
      entry_date: entryDate,
      memo,
      source_type: "depreciation_schedule",
      source_id: sched.id,
      status: "draft",
    })
    .select("id")
    .single();
  if (entryErr || !entry) {
    return { posted: false, journalEntryId: null, reason: `create entry: ${entryErr?.message ?? "no row"}` };
  }
  const entryId = entry.id as string;

  const cleanupAndFail = async (reason: string): Promise<PostResult> => {
    await admin.from("journal_entries").delete().eq("id", entryId);
    return { posted: false, journalEntryId: null, reason };
  };

  const { error: linesErr } = await admin.from("journal_lines").insert([
    { journal_entry_id: entryId, account_id: expenseId, debit_cents: amountCents, credit_cents: 0, description: memo },
    { journal_entry_id: entryId, account_id: accumId, debit_cents: 0, credit_cents: amountCents, description: memo },
  ]);
  if (linesErr) return cleanupAndFail(`create lines: ${linesErr.message}`);

  // orgClient is the short-lived org-scoped post client (minted once per org per
  // run by the caller); null means CONNECTOR_JWT_SECRET is unset — fail closed.
  if (!orgClient) return cleanupAndFail("CONNECTOR_JWT_SECRET unset; cannot post");
  const { error: postErr } = await orgClient.rpc("post_journal_entry", { p_entry_id: entryId });
  if (postErr) return cleanupAndFail(`post_journal_entry: ${postErr.message}`);

  return { posted: true, journalEntryId: entryId, reason: null };
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  try {
    const supabaseUrl = requireEnv("SUPABASE_URL");
    const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const anonKey = requireEnv("SUPABASE_ANON_KEY");
    const cronSecret = Deno.env.get("DEPRECIATION_RUN_CRON_SECRET");

    // Auth gate: service-role bearer OR the X-Cron-Secret header (cron). Both constant-time; the
    // cron secret is unavailable when unset (fail closed). No user-JWT path — this
    // function is cron/admin-driven only.
    const givenSecret = presentedCronSecret(req);
    const isServiceRole = isExactServiceRoleBearer(req.headers.get("Authorization"), serviceKey);
    const secretOk = !!cronSecret && isExactSecret(givenSecret, cronSecret);
    if (!isServiceRole && !secretOk) return json({ ok: false, error: "Unauthorized" }, 401);

    const body = (await req.json().catch(() => ({}))) as RequestBody;

    let targetDate: string;
    try {
      targetDate = resolveTargetDate(body.period);
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Active schedules = live schedules whose parent asset is active. Inner join on
    // fixed_assets so the status filter prunes the parent rows. Optional org scope.
    // status/deleted_at on the embed only drive the inner-join filter (PostgREST
    // applies them to the join regardless of projection), so project only the name
    // the memo needs.
    let query = admin
      .from("depreciation_schedules")
      .select("id, organization_id, fixed_asset_id, fixed_assets!inner(name)")
      .is("deleted_at", null)
      .eq("fixed_assets.status", "active")
      .is("fixed_assets.deleted_at", null);
    if (body.organization_id) query = query.eq("organization_id", body.organization_id);

    const { data: schedules, error: schedErr } = await query;
    if (schedErr) return json({ ok: false, error: `load schedules: ${schedErr.message}` }, 500);

    const rows = (schedules ?? []) as unknown as ScheduleRow[];
    const stats = {
      scanned: rows.length,
      posted: 0,
      skipped_zero: 0,
      skipped_existing: 0,
      errors: [] as { schedule_id: string; error: string }[],
    };

    // The two depreciation account ids and the org-scoped post client are pure
    // functions of organization_id, so resolve each at most once per org per run
    // (an org with many assets would otherwise repeat the same query + JWT sign).
    const acctCache = new Map<string, Map<string, string>>();
    const orgClientCache = new Map<string, SupabaseClient | null>();
    const getAccounts = async (orgId: string): Promise<Map<string, string>> => {
      let m = acctCache.get(orgId);
      if (!m) {
        m = await resolveAccounts(admin, orgId, [DEPRECIATION_EXPENSE_CODE, ACCUM_DEPRECIATION_CODE]);
        acctCache.set(orgId, m);
      }
      return m;
    };
    const getOrgClient = async (orgId: string): Promise<SupabaseClient | null> => {
      if (orgClientCache.has(orgId)) return orgClientCache.get(orgId) ?? null;
      const token = await mintOrgToken(orgId); // null when CONNECTOR_JWT_SECRET is unset
      const client = token
        ? createClient(supabaseUrl, anonKey, {
            global: { headers: { Authorization: `Bearer ${token}` } },
            auth: { persistSession: false, autoRefreshToken: false },
          })
        : null;
      orgClientCache.set(orgId, client);
      return client;
    };

    for (const sched of rows) {
      try {
        // Amount for the target month (self-contained calc; 0 once fully depreciated
        // or before the schedule start_date).
        const { data: amt, error: amtErr } = await admin.rpc("compute_depreciation", {
          p_schedule_id: sched.id,
          p_period: targetDate,
        });
        if (amtErr) throw new Error(`compute_depreciation: ${amtErr.message}`);
        const amountCents = Number(amt ?? 0);
        if (!Number.isFinite(amountCents) || amountCents <= 0) {
          stats.skipped_zero += 1;
          continue;
        }

        // Idempotency: an entry already exists for this (schedule, month). Treat a
        // VOID entry as handled too — if an operator reversed (posted -> void, 0075)
        // the month's depreciation, the next run must not silently re-post it.
        const { data: existing, error: exErr } = await admin
          .from("journal_entries")
          .select("id")
          .eq("source_type", "depreciation_schedule")
          .eq("source_id", sched.id)
          .eq("entry_date", targetDate)
          .in("status", ["posted", "void"])
          .limit(1)
          .maybeSingle();
        if (exErr) throw new Error(`check existing journal: ${exErr.message}`);
        if (existing) {
          stats.skipped_existing += 1;
          continue;
        }

        const accounts = await getAccounts(sched.organization_id);
        const expenseId = accounts.get(DEPRECIATION_EXPENSE_CODE);
        const accumId = accounts.get(ACCUM_DEPRECIATION_CODE);
        if (!expenseId || !accumId) {
          stats.errors.push({
            schedule_id: sched.id,
            error: `depreciation accounts not active for org (need ${DEPRECIATION_EXPENSE_CODE} + ${ACCUM_DEPRECIATION_CODE})`,
          });
          continue;
        }

        const orgClient = await getOrgClient(sched.organization_id);
        const result = await postDepreciation(
          admin,
          orgClient,
          sched,
          targetDate,
          amountCents,
          expenseId,
          accumId,
        );
        if (result.posted) stats.posted += 1;
        else stats.errors.push({ schedule_id: sched.id, error: result.reason ?? "post failed" });
      } catch (err) {
        stats.errors.push({ schedule_id: sched.id, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return json({ ok: true, period: targetDate, stats });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});
