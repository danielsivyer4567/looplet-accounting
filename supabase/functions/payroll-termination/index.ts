// Edge function: payroll-termination  (SC-3.L.01)
//
// CALCULATION-ONLY: estimates the withholding + net on a final pay (notice/ETP,
// genuine-redundancy tax-free cap, unused leave, ETP caps) for a human to review.
// It does NOT lodge anything — the STP termination event + the wizard are SC-3.L.02.
// The tax math lives in the pure, unit-tested ./calc.ts (no I/O); this handler only
// authenticates the caller, validates the body, and returns the breakdown.
//
// Request body: { organization_id: uuid, employee_id?: uuid, input: TerminationInput }
// (figures are supplied by the caller/wizard — unused leave comes from leave_balances
//  hours × the loaded rate, converted to cents UI-side.)
// Deploy with verify_jwt=false (self-auths via getUser + org membership, like the
// other payroll fns).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { authorizeOrgMember, supabaseOrgAccessDeps } from "../_shared/orgRole.ts";
import { calculateTermination, type TerminationInput, type TerminationReason } from "./calc.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const REASONS: TerminationReason[] = [
  "genuine_redundancy",
  "invalidity",
  "early_retirement",
  "resignation",
  "dismissal",
  "retirement",
  "contract_end",
];

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : NaN);

interface RequestBody {
  organization_id?: string;
  employee_id?: string;
  input?: Partial<TerminationInput>;
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceKey || !anonKey) {
    return json({ ok: false, error: "Server config missing" }, 500);
  }

  // Authenticate the caller (self-auth; verify_jwt=false on this fn).
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return json({ ok: false, error: "Unauthenticated" }, 401);

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  const organization_id = body.organization_id;
  const raw = body.input;
  if (!organization_id || !raw) {
    return json({ ok: false, error: "organization_id and input are required" }, 400);
  }

  const admin = createClient(supabaseUrl, serviceKey);
  // Termination pay is confidential employee pay data: an accepted admin or owner of this org (never trust the body alone).
  const access = await authorizeOrgMember(user.id, organization_id, supabaseOrgAccessDeps(admin, serviceKey), "admin");
  if (!access.ok) return json({ ok: false, error: access.error }, access.status);

  // Validate the calculation input.
  if (!raw.reason || !REASONS.includes(raw.reason)) {
    return json({ ok: false, error: `reason must be one of: ${REASONS.join(", ")}` }, 400);
  }
  const fields = {
    years_of_service: num(raw.years_of_service),
    unused_annual_leave_cents: num(raw.unused_annual_leave_cents),
    unused_long_service_leave_cents: num(raw.unused_long_service_leave_cents),
    redundancy_or_severance_cents: num(raw.redundancy_or_severance_cents),
    etp_other_cents: num(raw.etp_other_cents),
    other_taxable_income_cents: num(raw.other_taxable_income_cents),
    leave_marginal_rate: num(raw.leave_marginal_rate),
  };
  for (const [k, v] of Object.entries(fields)) {
    if (Number.isNaN(v) || v < 0) {
      return json({ ok: false, error: `${k} must be a non-negative number` }, 400);
    }
  }
  if (fields.leave_marginal_rate > 1) {
    return json({ ok: false, error: "leave_marginal_rate must be a fraction (0..1)" }, 400);
  }

  const input: TerminationInput = {
    reason: raw.reason,
    at_or_above_preservation_age: raw.at_or_above_preservation_age === true,
    ...fields,
    // constants omitted → calc uses DEFAULT_TAX_CONSTANTS (FY values, updated annually).
  };

  const result = calculateTermination(input);
  return json({ ok: true, employee_id: body.employee_id ?? null, result });
});
