// Edge function: smsf-audit-pack  (SC-5.M.01)
//
// Bundles, for the fund's independent approved SMSF auditor, a structured JSON pack + a rendered
// PDF cover composing:
//   - the SMSF financials: operating statement (SC-5.J.01), statement of financial position
//     (SC-5.J.02), member statements (SC-5.J.03);
//   - the compliance monitors: contribution caps (SC-5.L.01), minimum pension drawdown (SC-5.L.02);
//   - the per-holding investment evidence (smsf_investments at market value + cost base);
//   - the key reconciliation ties (balance sheet balances, members' funds tie to the member roll,
//     investment evidence sums to reported assets).
// The pure builders live in ./pack.ts (so they are testable without booting this server); this
// file is the caller-scoped HTTP handler that composes the RPCs + the holdings read.
//
// AUDIT STAYS LEGALLY EXTERNAL. This is hand-off PREPARATION only — it never signs, issues an
// opinion, or lodges anything. The approved SMSF auditor performs the audit.
//
// AUTH: user-invokable. Each RPC runs through a CALLER-SCOPED client (the caller's JWT is
// forwarded), and every composed RPC is SECURITY INVOKER, so RLS scopes the whole pack to the
// caller's orgs (per [[edge-fn-caller-org-authz]]). A fund the caller can't access yields an
// empty/zero pack, not a leak.
//
// Request body: { fund_id?: uuid, fy_start_year: int }   (fund_id optional — the RPCs resolve
//   the org's single fund when omitted)
// Response: { ok, bundle, sections_present, complete, pdf_base64 } (200) or a JSON error.
//
// DEPLOY: requires the SMSF chain applied (0162-0171). verify_jwt defaults to true (no config.toml
// override needed — matches trust-minute/div7a-agreement/eofy-pack). Smoke-tested via pack.test.ts
// (the pure builders + render); the end-to-end deploy->invoke->section-check test rides the deploy.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { requireEnv } from "../_shared/env.ts";
import { renderWorksheetPdf } from "../_shared/pdf/worksheet.ts";
import {
  type AuditPackBundle,
  buildReconciliations,
  type InvestmentEvidence,
  isComplete,
  sectionsPresent,
  toAuditPackDoc,
  toBase64,
} from "./pack.ts";

interface RequestBody {
  fund_id?: string;
  fy_start_year?: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Call a (p_org, p_fy_start_year, p_fund) SMSF RPC; null on error so one bad section doesn't sink the pack. */
async function rpc(
  client: SupabaseClient,
  fn: string,
  org: string,
  fy: number,
  fund: string | null,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await client.rpc(fn, {
    p_org: org,
    p_fy_start_year: fy,
    p_fund: fund,
  });
  if (error) return null;
  return data as Record<string, unknown> | null;
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ ok: false, error: "Unauthorized" }, 401);

    const supabaseUrl = requireEnv("SUPABASE_URL");
    const anonKey = requireEnv("SUPABASE_ANON_KEY");

    const body = (await req.json().catch(() => ({}))) as RequestBody;
    const fy = body.fy_start_year;
    const fund = (body.fund_id ?? "").trim() || null;
    if (typeof fy !== "number" || !Number.isInteger(fy)) {
      return json({ ok: false, error: "fy_start_year (integer) is required" }, 400);
    }

    // Caller-scoped client: the user's JWT rides every RPC, so RLS scopes the pack to the
    // caller's orgs. The composed RPCs are all SECURITY INVOKER.
    const client = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    // The caller's org is the one the auth context resolves; the RPCs themselves resolve the
    // fund (explicit fund_id, else the org's single fund). We pass the org from the first RPC's
    // echo. Get it from the operating statement (which echoes organization_id + fund_id).
    const operating = await rpc(client, "smsf_operating_statement", await callerOrg(client), fy, fund);
    if (!operating || operating.ok === false) {
      return json({ ok: false, error: (operating?.error as string) ?? "no SMSF fund for this org" }, 404);
    }
    const org = String(operating.organization_id);
    const fundId = String(operating.fund_id);

    // Compose the remaining sections + the per-holding investment evidence in parallel (all
    // RLS-scoped: the RPCs are INVOKER, the investments read rides the caller's client).
    const [financial, members, caps, drawdown, investments] = await Promise.all([
      rpc(client, "smsf_financial_position", org, fy, fundId),
      rpc(client, "smsf_member_statements", org, fy, fundId),
      rpc(client, "smsf_caps", org, fy, fundId),
      rpc(client, "smsf_pension_drawdown", org, fy, fundId),
      fetchInvestments(client, org, fundId),
    ]);

    const bundle: AuditPackBundle = {
      organization_id: org,
      fund_id: fundId,
      fy_start_year: fy,
      operating_statement: operating,
      financial_position: financial,
      member_statements: members,
      contribution_caps: caps,
      pension_drawdown: drawdown,
      investments,
      reconciliations: [],
    };
    // Reconciliations are derived from the fetched sections (assets/liabilities/members/holdings).
    bundle.reconciliations = buildReconciliations(bundle);

    const pdf = await renderWorksheetPdf(toAuditPackDoc(bundle));

    return json({
      ok: true,
      bundle,
      sections_present: sectionsPresent(bundle),
      complete: isComplete(bundle),
      pdf_base64: toBase64(pdf),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

/** The caller's accessible org id (the SMSF RPCs need p_org). One row via the org helper view. */
async function callerOrg(client: SupabaseClient): Promise<string> {
  // get_accessible_org_ids() returns the caller's org ids (RLS context); take the first.
  const { data } = await client.rpc("get_accessible_org_ids");
  const ids = (data ?? []) as string[];
  return ids[0] ?? "00000000-0000-0000-0000-000000000000";
}

/** Per-holding investment evidence (the SoFP backing detail). RLS-scoped via the caller's client. */
async function fetchInvestments(
  client: SupabaseClient,
  org: string,
  fundId: string,
): Promise<InvestmentEvidence[]> {
  const { data, error } = await client
    .from("smsf_investments")
    .select("name, asset_class, units, cost_base_cents, market_value_cents, acquisition_date")
    .eq("organization_id", org)
    .eq("fund_id", fundId)
    .is("deleted_at", null)
    .order("name");
  if (error) return [];
  return (data ?? []) as InvestmentEvidence[];
}
