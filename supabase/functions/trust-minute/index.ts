// Edge function: trust-minute  (SC-5.D.01)
//
// Renders a trustee distribution-resolution (minute) PDF for a trust + AU income
// year from the persisted trust_distributions rows (SC-5.C.04) joined to the trust
// + beneficiary registry (SC-5.A.01). Lays the resolution out via the shared PDF
// helper (_shared/pdf/worksheet.ts, SC-3.D.01) — the same renderer the BAS worksheet
// uses; Phase-5 statements reuse it rather than each function re-implementing pdf-lib.
// The pure doc-builder lives in ./minute.ts (so it is testable without booting this
// server); this file is just the HTTP handler + the DB reads.
//
// DOCUMENT GENERATION ONLY - no status change. The minute reads whatever the engine
// has persisted; it never finalises. Finalisation (draft -> finalised) is the
// approvals-gated slice SC-5.D.02. If finalised rows exist for the year they are
// rendered (the resolved entitlement); otherwise the current draft proposal is
// rendered, clearly stamped DRAFT.
//
// AUTH: user-invokable. Reads run through a CALLER-SCOPED client (the caller's JWT is
// forwarded), so RLS on trust_distributions / trusts / trust_beneficiaries scopes
// every row to the caller's orgs (per [[edge-fn-caller-org-authz]] - never a
// service-role load by id). A trust the caller can't access simply yields no rows
// (404), not a cross-tenant leak.
//
// Request body: { trust_id: uuid, fy_start_year: int }
// Response: application/pdf bytes (200) or a JSON error.
//
// DEPLOY: requires the 0151-0158 trust chain applied (trusts, trust_beneficiaries,
// trust_distributions). Deploy with verify_jwt=true (the gateway validates the JWT
// before the caller-scoped client re-applies RLS), and add a [functions.trust-minute]
// verify_jwt=true block to config.toml. Smoke-tested via minute.test.ts (the pure
// doc-builder + render); the end-to-end deploy->invoke->parse-back test rides the deploy.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { requireEnv } from "../_shared/env.ts";
import { renderWorksheetPdf } from "../_shared/pdf/worksheet.ts";
import { toMinuteDoc, type DistributionRow, type TrustRow } from "./minute.ts";

interface RequestBody {
  trust_id?: string;
  fy_start_year?: number;
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
    const trustId = (body.trust_id ?? "").trim();
    const fy = body.fy_start_year;
    if (!trustId) return json({ ok: false, error: "trust_id is required" }, 400);
    if (typeof fy !== "number" || !Number.isInteger(fy)) {
      return json({ ok: false, error: "fy_start_year (integer) is required" }, 400);
    }

    // Caller-scoped client: the user's JWT rides every request, so RLS scopes every
    // read (trust, beneficiaries, distributions) to the caller's orgs.
    const client = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });

    // Trust header + distributions in parallel (independent reads, RLS-scoped). The
    // distributions query fetches BOTH statuses in one round-trip; we prefer the
    // resolved (finalised) entitlement and fall back to the current draft in JS.
    const [trustRes, distRes] = await Promise.all([
      client
        .from("trusts")
        .select("name, trust_type, abn, trustee_name, trustee_abn, is_corporate_trustee")
        .eq("id", trustId)
        .is("deleted_at", null)
        .maybeSingle(),
      client
        .from("trust_distributions")
        .select(
          "beneficiary_id, amount_cents, capital_gain_cents, franked_dividend_cents, " +
            "other_cents, franking_credits_cents, status, " +
            "trust_beneficiaries ( name, beneficiary_type, relationship )",
        )
        .eq("trust_id", trustId)
        .eq("financial_year", fy)
        .in("status", ["finalised", "draft"])
        .is("deleted_at", null),
    ]);

    if (trustRes.error) return json({ ok: false, error: trustRes.error.message }, 500);
    if (!trustRes.data) return json({ ok: false, error: "trust not found" }, 404);
    if (distRes.error) return json({ ok: false, error: distRes.error.message }, 500);

    const all = (distRes.data ?? []) as unknown as DistributionRow[];
    const finalised = all.filter((r) => r.status === "finalised");
    const isDraft = finalised.length === 0;
    const rows = isDraft ? all.filter((r) => r.status === "draft") : finalised;

    if (rows.length === 0) {
      return json(
        { ok: false, error: "no distributions for this trust and year (run the optimiser/persist first)" },
        404,
      );
    }

    // Stable, human order: largest share first, then by name.
    rows.sort((a, b) =>
      b.amount_cents - a.amount_cents ||
      (a.trust_beneficiaries?.name ?? "").localeCompare(b.trust_beneficiaries?.name ?? ""),
    );

    const pdf = await renderWorksheetPdf(toMinuteDoc(trustRes.data as TrustRow, rows, fy, isDraft));

    // Copy into an ArrayBuffer-backed view so the body type is unambiguous (same
    // reason as bas-worksheet-pdf: pdf-lib returns Uint8Array<ArrayBufferLike>).
    const pdfBytes = new Uint8Array(pdf);
    return new Response(pdfBytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="trust-minute-FY${fy}.pdf"`,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});
