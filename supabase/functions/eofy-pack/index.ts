// Edge function: eofy-pack  (SC-4.C.01)
//
// Assembles an end-of-financial-year pack for an org + AU FY into ONE artifact:
// a structured-data JSON bundle (statutory statements + notes + readiness +
// advisory flags + working-paper links) AND a rendered PDF of the face statements.
// This is the deliverable that replaces "send the shoebox to the accountant" and
// the input to the Phase-4 return builder (SC-4.G/4.H).
//
// It composes the now-live SQL RPCs:
//   * generate_eofy_pack                       (SC-4.A.02) — brings the books to EOFY
//       state (closes the 12 FY months, trues up depreciation, finalises accruals) and
//       returns the readiness report. Run by DEFAULT; pass skip_true_up=true to assemble
//       a READ-ONLY preview from the current books without mutating anything.
//   * generate_statutory_statements            (SC-4.B.01) — P&L + Balance Sheet
//   * generate_equity_and_cashflow_statements  (SC-4.B.02) — equity + cash flow
//   * generate_statement_notes                 (SC-4.B.03) — policy + depreciation +
//       related-party notes
//   * eofy_advisory_checks                      (SC-4.A.03) — bad-debt / drawings flags
//
// AUTH: user-invokable. Every RPC is SECURITY INVOKER, so the caller's JWT is forwarded
// into a caller-scoped client and RLS scopes the pack to the caller's orgs (per
// [[edge-fn-caller-org-authz]] — never a service-role load by id). An org the caller
// can't access makes the orchestrator raise (403); the read-only statement fns return an
// empty pack. The mutating true-up posts only via post_journal_entry (re-checks org
// access under the caller's identity), so a member drives it; books-health blocking → 409.
//
// Request body: { organization_id: uuid, fy_start_year: int, skip_true_up?: bool }
// Response: { ok, bundle: {...}, pdf_base64 } (200) or a JSON error.
//
// DEPLOY: requires Phase-1..4 applied (0090-0137); deploy with verify_jwt=true.
// Reuses the shared PDF helper (_shared/pdf/worksheet.ts, SC-3.D.01).

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { requireEnv } from "../_shared/env.ts";
import {
  renderWorksheetPdf,
  type WorksheetDoc,
  type WorksheetSection,
} from "../_shared/pdf/worksheet.ts";

interface RequestBody {
  organization_id?: string;
  fy_start_year?: number;
  skip_true_up?: boolean;
}

// Minimal shapes of the RPC payloads — only the fields the PDF face reads. The full
// payloads are passed through verbatim into the JSON bundle regardless of these.
interface LineItem {
  account_code?: string;
  account_name?: string;
  amount_cents?: number;
}
interface Statements {
  profit_and_loss?: {
    revenue?: LineItem[];
    total_revenue_cents?: number;
    expenses?: LineItem[];
    total_expenses_cents?: number;
    net_profit_cents?: number;
  };
  balance_sheet?: {
    assets?: LineItem[];
    total_assets_cents?: number;
    liabilities?: LineItem[];
    total_liabilities_cents?: number;
    equity?: LineItem[];
    total_equity_cents?: number;
    current_year_earnings_cents?: number;
    balances?: boolean;
  };
}
interface EquityCashflow {
  statement_of_changes_in_equity?: {
    opening_equity_cents?: number;
    total_movement_cents?: number;
    closing_equity_cents?: number;
    reconciles?: boolean;
    retained_earnings?: { profit_for_year_cents?: number };
  };
  cash_flow_statement?: {
    operating_cents?: number;
    investing_cents?: number;
    financing_cents?: number;
    net_change_in_cash_cents?: number;
    opening_cash_cents?: number;
    closing_cash_cents?: number;
    ties_to_gl?: boolean;
  };
}
interface DepAsset {
  asset_name?: string;
  method?: string;
  period_depreciation_cents?: number;
}
interface Notes {
  notes?: {
    depreciation?: {
      by_asset?: DepAsset[];
      period_depreciation_total_cents?: number;
      ties_to_gl?: boolean;
    };
  };
}
interface Readiness {
  ready?: boolean;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Cents (any) -> "$1,234.00". */
function money(cents: unknown): string {
  const n = Number(cents ?? 0);
  return `$${(n / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const yesno = (b: unknown): string => (b ? "yes" : "no");

/** Base64 a byte array in chunks (spreading a whole PDF into fromCharCode overflows the arg limit). */
function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Call a (p_org, p_fy_start_year) RPC; throw on error (-> 500 unless caught earlier). */
async function rpc(client: SupabaseClient, fn: string, org: string, fy: number): Promise<unknown> {
  const { data, error } = await client.rpc(fn, { p_org: org, p_fy_start_year: fy });
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}

const lineRow = (l: LineItem): { label: string; value: string } => ({
  label: `  ${l.account_code ?? ""} ${l.account_name ?? ""}`.trim(),
  value: money(l.amount_cents),
});

/** Lay the face statements out as a generic worksheet doc for the PDF. */
function toWorksheetDoc(
  fy: number,
  stmts: Statements,
  ec: EquityCashflow,
  notes: Notes,
  ready: Readiness,
): WorksheetDoc {
  const pl = stmts.profit_and_loss ?? {};
  const bs = stmts.balance_sheet ?? {};
  const eq = ec.statement_of_changes_in_equity ?? {};
  const cf = ec.cash_flow_statement ?? {};

  const sections: WorksheetSection[] = [
    {
      heading: "Profit & Loss",
      caption: "From the general-ledger trial balance",
      rows: [
        ...(pl.revenue ?? []).map(lineRow),
        { label: "Total revenue", value: money(pl.total_revenue_cents) },
        ...(pl.expenses ?? []).map(lineRow),
        { label: "Total expenses", value: money(pl.total_expenses_cents) },
        { label: "Net profit", value: money(pl.net_profit_cents) },
      ],
    },
    {
      heading: "Balance Sheet",
      caption: `Assets = Liabilities + Equity + earnings (balances: ${yesno(bs.balances)})`,
      rows: [
        ...(bs.assets ?? []).map(lineRow),
        { label: "Total assets", value: money(bs.total_assets_cents) },
        ...(bs.liabilities ?? []).map(lineRow),
        { label: "Total liabilities", value: money(bs.total_liabilities_cents) },
        ...(bs.equity ?? []).map(lineRow),
        { label: "Total equity", value: money(bs.total_equity_cents) },
        { label: "Current-year earnings", value: money(bs.current_year_earnings_cents) },
      ],
    },
    {
      heading: "Statement of Changes in Equity",
      caption: `Opening + movements = closing (reconciles: ${yesno(eq.reconciles)})`,
      rows: [
        { label: "Opening equity", value: money(eq.opening_equity_cents) },
        { label: "  Profit for the year", value: money(eq.retained_earnings?.profit_for_year_cents) },
        { label: "Total movement", value: money(eq.total_movement_cents) },
        { label: "Closing equity", value: money(eq.closing_equity_cents) },
      ],
    },
    {
      heading: "Cash Flow Statement",
      caption: `Direct method; net change ties to GL cash movement (ties: ${yesno(cf.ties_to_gl)})`,
      rows: [
        { label: "Operating activities", value: money(cf.operating_cents) },
        { label: "Investing activities", value: money(cf.investing_cents) },
        { label: "Financing activities", value: money(cf.financing_cents) },
        { label: "Net change in cash", value: money(cf.net_change_in_cash_cents) },
        { label: "Opening cash", value: money(cf.opening_cash_cents) },
        { label: "Closing cash", value: money(cf.closing_cash_cents) },
      ],
    },
  ];

  // Depreciation note (per-asset). The accounting-policy + related-party prose is too
  // long for the label/value face; it travels in full in the JSON bundle, summarised here.
  const dep = notes.notes?.depreciation;
  if (dep) {
    sections.push({
      heading: "Note - Depreciation",
      caption: `Per-asset charge for the year (ties to GL: ${yesno(dep.ties_to_gl)})`,
      rows: [
        ...(dep.by_asset ?? []).map((a) => ({
          label: `  ${a.asset_name ?? "asset"} (${a.method ?? ""})`,
          value: money(a.period_depreciation_cents),
        })),
        { label: "Total depreciation for the year", value: money(dep.period_depreciation_total_cents) },
      ],
    });
  }

  return {
    title: "End-of-Financial-Year Statements",
    subtitle: `FY ${fy}-${fy + 1} - special purpose, ${ready.ready ? "READY" : "NOT YET READY"} - DRAFT, not lodged`,
    sections,
    footer:
      "Draft EOFY pack generated by Looplet Accounting. Verify against source records before lodging. Full notes and working papers travel in the accompanying data file.",
  };
}

/** Drill-down links into the working papers backing the statements. */
function workingPaperLinks(): Array<{ label: string; href: string }> {
  return [
    { label: "Books health & reconciliation", href: "/quality" },
    { label: "Fixed-asset register & depreciation", href: "/fixed-assets" },
    { label: "BAS / GST worksheets", href: "/reports/bas" },
    { label: "Reports (trial balance, P&L, balance sheet)", href: "/reports" },
  ];
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
    const org = (body.organization_id ?? "").trim();
    const fy = body.fy_start_year;
    const skipTrueUp = body.skip_true_up === true;
    if (!org) return json({ ok: false, error: "organization_id is required" }, 400);
    if (typeof fy !== "number" || !Number.isInteger(fy)) {
      return json({ ok: false, error: "fy_start_year (integer) is required" }, 400);
    }

    // Caller-scoped client: the user's JWT rides every request, so the SECURITY INVOKER
    // RPCs' RLS scopes the pack to the caller's orgs (never a service-role load by id).
    const client = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    // 1. Bring the books to EOFY state (mutating) unless a read-only preview is asked.
    //    `readiness` is surfaced top-level in either mode; `orchestration` (the full close
    //    + accrual summary) is present only when the true-up ran.
    let orchestration: { readiness?: Readiness } | null = null;
    let readiness: Readiness | null;
    if (!skipTrueUp) {
      const { data, error } = await client.rpc("generate_eofy_pack", {
        p_org: org,
        p_fy_start_year: fy,
      });
      if (error) {
        // Map generate_eofy_pack's RAISE messages (0137_eofy_orchestrate.sql): a missing
        // v_books_health row -> "...not found or not accessible"; a blocking score ->
        // "...books-health score N is blocking...". Keep these in sync with that file.
        const m = error.message || "";
        if (/not found or not accessible/i.test(m)) return json({ ok: false, error: m }, 403);
        if (/blocking/i.test(m)) {
          return json({ ok: false, error: m, reason: "books_health_blocking" }, 409);
        }
        return json({ ok: false, error: m }, 500);
      }
      orchestration = data as { readiness?: Readiness };
      readiness = orchestration.readiness ?? null;
    } else {
      readiness = (await rpc(client, "eofy_readiness", org, fy)) as Readiness;
    }

    // 2. The face statements + notes + advisory (read-only).
    const [statements, equityCashflow, notes, advisory] = await Promise.all([
      rpc(client, "generate_statutory_statements", org, fy),
      rpc(client, "generate_equity_and_cashflow_statements", org, fy),
      rpc(client, "generate_statement_notes", org, fy),
      rpc(client, "eofy_advisory_checks", org, fy),
    ]);

    // 3. One artifact: the structured bundle + a rendered PDF of the face statements.
    const bundle = {
      organization_id: org,
      fy_start_year: fy,
      generated_at: new Date().toISOString(),
      true_up_run: !skipTrueUp,
      readiness,
      orchestration,
      statements,
      equity_and_cash_flow: equityCashflow,
      notes,
      advisory,
      working_papers: workingPaperLinks(),
    };

    const pdf = await renderWorksheetPdf(
      toWorksheetDoc(
        fy,
        statements as Statements,
        equityCashflow as EquityCashflow,
        notes as Notes,
        readiness ?? {},
      ),
    );

    return json({ ok: true, bundle, pdf_base64: toBase64(pdf) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});
