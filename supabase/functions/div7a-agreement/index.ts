// Edge function: div7a-agreement  (SC-5.F.01)
//
// Renders a Division 7A complying-loan agreement PDF + the s109E minimum-yearly-repayment
// schedule from a div7a_loans row (SC-5.E.01) and div7a_min_repayment (SC-5.E.02). Lays it
// out via the shared PDF helper (_shared/pdf/worksheet.ts, SC-3.D.01) — the same renderer
// the BAS worksheet and trust minute use. The pure doc-builder lives in ./agreement.ts (so
// it is testable without booting this server); this file is the caller-scoped HTTP handler.
//
// DOCUMENT GENERATION ONLY - drafts an agreement for the parties to review and sign. It
// does not execute, lodge, or change any state. "Complying" means the document sets out the
// terms a complying loan requires (minimum benchmark rate, maximum term, security for 25yr);
// whether the loan actually complies (repayments met) is the breach engine's concern (SC-5.E.03).
//
// AUTH: user-invokable. The loan read runs through a CALLER-SCOPED client (the caller's JWT
// is forwarded), so RLS on div7a_loans scopes it to the caller's orgs (per
// [[edge-fn-caller-org-authz]] - never a service-role load by id). The org is then taken
// from the RLS-approved loan row and passed to div7a_min_repayment (itself SECURITY INVOKER,
// so it re-applies RLS). A loan the caller can't access yields 404, not a leak.
//
// Request body: { loan_id: uuid }
// Response: application/pdf bytes (200) or a JSON error.
//
// DEPLOY: requires the Div 7A chain applied (div7a_loans 0159, div7a_benchmark_rates +
// div7a_min_repayment 0160). Deploy with verify_jwt=true (the gateway validates the JWT
// before the caller-scoped client re-applies RLS), and add a [functions.div7a-agreement]
// verify_jwt=true block to config.toml. Smoke-tested via agreement.test.ts (the pure
// doc-builder + render); the end-to-end deploy->invoke->parse-back test rides the deploy.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { requireEnv } from "../_shared/env.ts";
import { renderWorksheetPdf } from "../_shared/pdf/worksheet.ts";
import { toAgreementDoc, type LoanRow, type ScheduleLine } from "./agreement.ts";

interface RequestBody {
  loan_id?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
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
    const loanId = (body.loan_id ?? "").trim();
    if (!loanId) return json({ ok: false, error: "loan_id is required" }, 400);

    // Caller-scoped client: the user's JWT rides every request, so RLS scopes the loan
    // read (and div7a_min_repayment's reads) to the caller's orgs.
    const client = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    // The loan (RLS-scoped). organization_id comes from the RLS-approved row, then drives
    // the schedule RPC. Inaccessible/absent -> 404, never a leak.
    const { data: loan, error: loanErr } = await client
      .from("div7a_loans")
      .select(
        "organization_id, lender_company_name, lender_company_abn, borrower_name, " +
          "loan_year, principal_cents, term_years, benchmark_rate_basis_points, has_complying_agreement",
      )
      .eq("id", loanId)
      .is("deleted_at", null)
      .maybeSingle();
    if (loanErr) return json({ ok: false, error: loanErr.message }, 500);
    if (!loan) return json({ ok: false, error: "loan not found" }, 404);

    // The RLS-approved row carries organization_id (trustworthy: RLS already gated it) plus
    // the LoanRow fields. Cast through unknown once (the supabase-js row type is a union).
    const loanRow = loan as unknown as LoanRow & { organization_id: string };

    // The s109E minimum-repayment schedule (SECURITY INVOKER -> re-applies RLS).
    const { data: sched, error: schedErr } = await client.rpc("div7a_min_repayment", {
      p_org: loanRow.organization_id,
      p_loan_id: loanId,
    });
    if (schedErr) return json({ ok: false, error: schedErr.message }, 500);

    const schedule = ((sched as { schedule?: ScheduleLine[] } | null)?.schedule ?? []) as ScheduleLine[];

    const pdf = await renderWorksheetPdf(toAgreementDoc(loanRow, schedule));

    // Copy into an ArrayBuffer-backed view so the body type is unambiguous (same reason as
    // bas-worksheet-pdf / trust-minute: pdf-lib returns Uint8Array<ArrayBufferLike>).
    const pdfBytes = new Uint8Array(pdf);
    return new Response(pdfBytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="div7a-loan-agreement-${loanId}.pdf"`,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});
