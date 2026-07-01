// Edge function: coding-classifier  (SC-1.C.02)
//
// Continuous AP coding for ONE bill: reuse the intake-routing matcher signals to
// propose a GL account_code + GST tax_code, derive a [0,1] confidence, and write
// EXACTLY ONE live coding_suggestions row (idempotent per bill). A bill that is
// both high-confidence (>= AUTO_POST_THRESHOLD) AND safely postable gets a
// balanced draft journal posted via the SOLE sanctioned path post_journal_entry()
// and the suggestion flips to 'auto_posted' (Tier-0 silent). Everything else stays
// 'needs_review' with NO journal and surfaces in coding_review_queue for a human
// (SC-1.D).
//
// AUTH / POSTING MECHANICS:
//   - All reads/writes use the service-role admin client. coding_suggestions has
//     no write policy by design (backend-written, RLS bypassed by service_role).
//   - post_journal_entry() is SECURITY DEFINER and re-checks
//     organization_id IN (SELECT get_accessible_org_ids()). For a backend caller
//     with no auth.uid(), that helper resolves the org from the integration
//     `organization_id` JWT claim (migration 0069). So we post through a
//     short-lived org-scoped HS256 token minted exactly like api-gateway does
//     (CONNECTOR_JWT_SECRET). If the secret is absent or the post fails, we fail
//     CLOSED to 'needs_review' — never an 'auto_posted' row without a real journal.
//
// DEPLOY PREREQUISITES (see ledger SC-1.C.02 + migration-history drift):
//   - migrations 0090-0092 applied live (coding_suggestions / enum / queue view)
//   - chart_of_accounts seeded for the org (seed_default_chart_of_accounts) so the
//     proposed codes resolve; until then auto-post falls back to needs_review
//   - secret CONNECTOR_JWT_SECRET set (already required by api-gateway)
//   - deploy: `supabase functions deploy coding-classifier` (verify_jwt default)

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { create, getNumericDate } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { requireEnv } from "../_shared/env.ts";

const AUTO_POST_THRESHOLD = 0.9; // plan §A.1

// Reserved chart-of-accounts codes from seed_default_chart_of_accounts (0073).
// NOTE: this couples auto-post to the seeded COA template. A custom/renamed AP or
// GST account simply won't resolve below and the bill falls back to needs_review
// (safe). A future per-org system-account map (see ledger SC-3.B GST control
// accounts) should replace these literals with a type→account lookup.
const GST_INPUT_CODE = "1200"; // GST receivable (input credits) — the PURCHASE GST side
const ACCOUNTS_PAYABLE_CODE = "2000";
const BANK_CODE = "1000";

// Canonical live intake_rules.matcher_type values (0006 CHECK constraint). NOTE:
// the older intake-routing-apply switches on stale names ('email_sender' etc.) and
// silently misses the live 'sender_address' rules — we match the canonical set.
type MatcherType =
  | "sender_address"
  | "sender_domain"
  | "sender_name"
  | "subject_pattern"
  | "attachment_name"
  | "body_keyword";

// Per-type base confidence, ranked by how specifically the signal identifies a supplier.
const BASE_CONFIDENCE: Record<MatcherType, number> = {
  sender_address: 0.95,
  sender_domain: 0.85,
  attachment_name: 0.8,
  subject_pattern: 0.7,
  body_keyword: 0.65,
  sender_name: 0.6,
};

interface IntakeRule {
  id: string;
  matcher_type: string;
  matcher_value: string;
  matcher_priority: number;
  category_code: string | null;
  xero_account_code_override: string | null;
  xero_tax_type_override: string | null;
  hit_count: number;
}

interface CategoryMap {
  code: string;
  xero_account_code: string | null;
  xero_tax_type: string | null;
}

interface Bill {
  id: string;
  organization_id: string;
  status: string;
  supplier_name_raw: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  original_filename: string | null;
  total_inc_gst_cents: number | null;
  gst_cents: number | null;
  subtotal_ex_gst_cents: number | null;
  gst_estimated: boolean;
  intake_metadata: Record<string, unknown> | null;
}

interface RequestBody {
  bill_id?: string;
  // Human review decision (SC-1.D.02). Absent → the automatic classify path.
  //   accept   → post using the suggestion's already-proposed codes.
  //   override → post using the human-corrected account_code/tax_code below.
  // Either way the human is the posting gate, so the >= AUTO_POST_THRESHOLD
  // confidence bar does not apply.
  decision?: "accept" | "override";
  account_code?: string;
  tax_code?: string | null;
}

interface Classification {
  accountCode: string | null;
  taxCode: string | null;
  confidence: number;
  rationale: Record<string, unknown>;
}

// One row from detect_capital_purchases (0094) — only used to test candidacy
// (p_bill_id restricts it to this one bill, so a non-empty result IS the answer).
interface CapitalCandidateRow {
  bill_id: string;
  suggested_asset_account_code: string | null;
}

interface JournalLine {
  account_id: string;
  debit_cents: number;
  credit_cents: number;
  description: string;
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function pickString(obj: Record<string, unknown> | null, keys: string[]): string {
  if (!obj) return "";
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return "";
}

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : "";
}

function isMatcherType(t: string): t is MatcherType {
  return (
    t === "sender_address" ||
    t === "sender_domain" ||
    t === "sender_name" ||
    t === "subject_pattern" ||
    t === "attachment_name" ||
    t === "body_keyword"
  );
}

function matchPattern(pattern: string, text: string): boolean {
  if (text === "") return false;
  try {
    return new RegExp(pattern, "i").test(text);
  } catch {
    return text.toLowerCase().includes(pattern.toLowerCase());
  }
}

interface MatchSignals {
  sender: string;
  fromName: string;
  subject: string;
  filename: string;
  body: string;
}

function ruleMatches(type: MatcherType, value: string, s: MatchSignals): boolean {
  const v = value.trim().toLowerCase();
  if (v === "") return false;
  switch (type) {
    case "sender_address":
      return s.sender !== "" && s.sender.toLowerCase() === v;
    case "sender_domain": {
      const d = domainOf(s.sender);
      const want = v.replace(/^@/, "");
      return d !== "" && (d === want || d.endsWith("." + want));
    }
    case "sender_name":
      return s.fromName !== "" && s.fromName.toLowerCase().includes(v);
    case "subject_pattern":
      return matchPattern(value, s.subject);
    case "attachment_name":
      return s.filename !== "" && s.filename.toLowerCase().includes(v);
    case "body_keyword":
      return s.body !== "" && s.body.toLowerCase().includes(v);
  }
}

// Reuse the intake matcher signals to choose the first matching active rule
// (rules arrive ordered by matcher_priority DESC; first match wins, like routing).
function classify(bill: Bill, rules: IntakeRule[], categories: Map<string, CategoryMap>): Classification {
  const meta = bill.intake_metadata;
  const signals: MatchSignals = {
    sender: pickString(meta, ["email_sender", "from", "sender"]),
    fromName: pickString(meta, ["from_name", "sender_name"]),
    subject: pickString(meta, ["email_subject", "subject"]),
    body: pickString(meta, ["body_text", "body", "snippet"]),
    filename: (bill.original_filename ?? "").toLowerCase(),
  };

  for (const rule of rules) {
    if (!isMatcherType(rule.matcher_type)) continue;
    if (!ruleMatches(rule.matcher_type, rule.matcher_value, signals)) continue;

    const cat = rule.category_code ? categories.get(rule.category_code) ?? null : null;
    const accountOverride = rule.xero_account_code_override?.trim();
    const taxOverride = rule.xero_tax_type_override?.trim();
    const accountCode = (accountOverride || cat?.xero_account_code) ?? null;
    const taxCode = (taxOverride || cat?.xero_tax_type) ?? null;

    let confidence = BASE_CONFIDENCE[rule.matcher_type];
    if (accountOverride) confidence += 0.03; // an explicit account override is more authoritative
    if (rule.hit_count >= 3) confidence += 0.03; // a historically reliable rule
    if (!accountCode) confidence = Math.min(confidence, 0.4); // nothing to post to → force review
    confidence = Math.max(0, Math.min(0.99, confidence));

    return {
      accountCode,
      taxCode,
      confidence: round2(confidence),
      rationale: {
        matched: true,
        rule_id: rule.id,
        matcher_type: rule.matcher_type,
        matcher_value: rule.matcher_value,
        matcher_priority: rule.matcher_priority,
        hit_count: rule.hit_count,
        category_code: rule.category_code,
        account_source: accountOverride ? "rule_override" : cat ? "category" : "none",
        tax_source: taxOverride ? "rule_override" : cat ? "category" : "none",
      },
    };
  }

  return {
    accountCode: null,
    taxCode: null,
    confidence: 0,
    rationale: { matched: false, reason: "no_matching_intake_rule" },
  };
}

// Write exactly one LIVE suggestion per bill (partial unique index is WHERE
// deleted_at IS NULL, so we select-then-update/insert rather than upsert).
async function upsertSuggestion(
  admin: SupabaseClient,
  bill: Bill,
  c: Classification,
  status: string,
): Promise<string> {
  const row = {
    organization_id: bill.organization_id,
    bill_id: bill.id,
    account_code: c.accountCode,
    tax_code: c.taxCode,
    confidence: c.confidence,
    status,
    rationale: c.rationale,
  };
  const { data: existing, error: selErr } = await admin
    .from("coding_suggestions")
    .select("id")
    .eq("bill_id", bill.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (selErr) throw new Error(`load suggestion: ${selErr.message}`);

  if (existing) {
    const { error } = await admin.from("coding_suggestions").update(row).eq("id", existing.id);
    if (error) throw new Error(`update suggestion: ${error.message}`);
    return existing.id as string;
  }
  const { data, error } = await admin.from("coding_suggestions").insert(row).select("id").single();
  if (error || !data) throw new Error(`insert suggestion: ${error?.message ?? "no row"}`);
  return data.id as string;
}

async function setRationaleStatus(
  admin: SupabaseClient,
  suggestionId: string,
  status: string,
  rationale: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin.from("coding_suggestions").update({ status, rationale }).eq("id", suggestionId);
  if (error) throw new Error(`update suggestion status: ${error.message}`);
}

// Capital-purchase detection (0094 SC-1.F.01/.F.02): a bill that looks like an
// asset purchase (material cost base, not already expense-coded, not already
// capitalised) must never silently auto-post as a period expense — it needs a
// human to confirm the asset in the Fixed Assets register instead. This checks
// candidacy with the single-bill fast path (p_bill_id) and, if eligible, drafts
// the `proposed` fixed_assets row via propose_capitalisation (idempotent on
// source_bill_id — safe to call on every classify run). Both RPCs are SECURITY
// INVOKER; the service-role admin client bypasses RLS (rolbypassrls) exactly
// like every other write in this function. Best-effort: a detection/propose
// failure must never block the ordinary coding path, so errors are logged and
// swallowed rather than surfaced to the caller.
async function detectAndProposeCapitalAsset(
  admin: SupabaseClient,
  bill: Bill,
): Promise<{ isCandidate: boolean; fixedAssetId: string | null }> {
  const { data, error } = await admin.rpc("detect_capital_purchases", {
    p_org: bill.organization_id,
    p_bill_id: bill.id,
  });
  if (error) {
    console.error(`detect_capital_purchases failed for bill ${bill.id}: ${error.message}`);
    return { isCandidate: false, fixedAssetId: null };
  }
  const rows = (data ?? []) as CapitalCandidateRow[];
  if (rows.length === 0) return { isCandidate: false, fixedAssetId: null };

  const { data: assetId, error: proposeErr } = await admin.rpc("propose_capitalisation", {
    p_bill_id: bill.id,
  });
  if (proposeErr) {
    console.error(`propose_capitalisation failed for bill ${bill.id}: ${proposeErr.message}`);
    // Still a capital candidate even though the draft write failed — the auto-post
    // guard below must hold regardless, so a transient write failure can't let a
    // capital purchase slip through as an auto-posted expense.
    return { isCandidate: true, fixedAssetId: null };
  }
  return { isCandidate: true, fixedAssetId: (assetId as string) ?? null };
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

// Build a balanced expense journal in cents. Standard AU GST-registered purchase:
//   GST > 0  → Dr expense (net), Dr GST input (gst), Cr AP/bank (total)
//   GST == 0 → Dr expense (total), Cr AP/bank (total)
// The journal_lines one_side CHECK forbids zero/both-sided lines, so guard net > 0.
function buildLines(
  bill: Bill,
  accounts: Map<string, string>,
  expenseCode: string,
): { lines: JournalLine[] } | { error: string } {
  const total = bill.total_inc_gst_cents ?? 0;
  const gst = bill.gst_cents ?? 0;
  const net = bill.subtotal_ex_gst_cents ?? total - gst;
  if (total <= 0) return { error: "bill total is zero or missing" };
  if (net + gst !== total) return { error: "bill amounts do not reconcile (net + gst != total)" };

  const expenseId = accounts.get(expenseCode);
  if (!expenseId) return { error: `expense account ${expenseCode} not active for org` };

  const creditCode = bill.status === "paid" ? BANK_CODE : ACCOUNTS_PAYABLE_CODE;
  const creditId = accounts.get(creditCode);
  if (!creditId) return { error: `credit account ${creditCode} not active for org` };

  const desc = `${bill.supplier_name_raw ?? "Bill"}${bill.invoice_number ? ` #${bill.invoice_number}` : ""}`;

  if (gst > 0) {
    if (net <= 0) return { error: "GST present but net is zero" };
    const gstId = accounts.get(GST_INPUT_CODE);
    if (!gstId) return { error: `GST account ${GST_INPUT_CODE} not active for org` };
    return {
      lines: [
        { account_id: expenseId, debit_cents: net, credit_cents: 0, description: desc },
        { account_id: gstId, debit_cents: gst, credit_cents: 0, description: "GST (input credit)" },
        { account_id: creditId, debit_cents: 0, credit_cents: total, description: desc },
      ],
    };
  }
  return {
    lines: [
      { account_id: expenseId, debit_cents: total, credit_cents: 0, description: desc },
      { account_id: creditId, debit_cents: 0, credit_cents: total, description: desc },
    ],
  };
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

// Posts the bill's expense journal. allowEstimatedGst is the human-review escape
// hatch: the auto path refuses gst_estimated bills (the GST split is unreliable),
// but a human reviewing the bill in the queue is the gate and may clear them — the
// net+gst==total reconciliation guard in buildLines still protects journal balance.
async function postBillJournal(
  admin: SupabaseClient,
  supabaseUrl: string,
  anonKey: string,
  bill: Bill,
  expenseCode: string,
  allowEstimatedGst = false,
): Promise<PostResult> {
  // Idempotency: a posted journal already linked to this bill → done, never re-post.
  const { data: existingEntry, error: exErr } = await admin
    .from("journal_entries")
    .select("id")
    .eq("source_type", "bill")
    .eq("source_id", bill.id)
    .eq("status", "posted")
    .maybeSingle();
  if (exErr) return { posted: false, journalEntryId: null, reason: `check existing journal: ${exErr.message}` };
  if (existingEntry) return { posted: true, journalEntryId: existingEntry.id as string, reason: "already_posted" };

  if (bill.gst_estimated && !allowEstimatedGst) {
    return { posted: false, journalEntryId: null, reason: "gst_estimated; needs human review" };
  }

  const accounts = await resolveAccounts(admin, bill.organization_id, [
    expenseCode,
    GST_INPUT_CODE,
    ACCOUNTS_PAYABLE_CODE,
    BANK_CODE,
  ]);
  const built = buildLines(bill, accounts, expenseCode);
  if ("error" in built) return { posted: false, journalEntryId: null, reason: built.error };

  // Insert the DRAFT entry + lines (service-role bypasses RLS).
  const entryPayload: Record<string, unknown> = {
    organization_id: bill.organization_id,
    memo: `Auto-coded bill ${bill.invoice_number ?? bill.id}`,
    source_type: "bill",
    source_id: bill.id,
    status: "draft",
  };
  if (bill.invoice_date) entryPayload.entry_date = bill.invoice_date;

  const { data: entry, error: entryErr } = await admin
    .from("journal_entries")
    .insert(entryPayload)
    .select("id")
    .single();
  if (entryErr || !entry) {
    return { posted: false, journalEntryId: null, reason: `create entry: ${entryErr?.message ?? "no row"}` };
  }
  const entryId = entry.id as string;

  // Unwind the still-draft entry on any failure before it posts (0075 freezes
  // posted rows only, so a draft delete is always allowed).
  const cleanupAndFail = async (reason: string): Promise<PostResult> => {
    await admin.from("journal_entries").delete().eq("id", entryId);
    return { posted: false, journalEntryId: null, reason };
  };

  const { error: linesErr } = await admin
    .from("journal_lines")
    .insert(built.lines.map((l) => ({ ...l, journal_entry_id: entryId })));
  if (linesErr) return cleanupAndFail(`create lines: ${linesErr.message}`);

  const token = await mintOrgToken(bill.organization_id);
  if (!token) return cleanupAndFail("CONNECTOR_JWT_SECRET unset; cannot post");
  const orgClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: postErr } = await orgClient.rpc("post_journal_entry", { p_entry_id: entryId });
  if (postErr) return cleanupAndFail(`post_journal_entry: ${postErr.message}`);

  return { posted: true, journalEntryId: entryId, reason: null };
}

interface DecisionRow {
  id: string;
  account_code: string | null;
  tax_code: string | null;
  rationale: Record<string, unknown>;
}

// Human review decision (SC-1.D.02): the reviewer accepts the proposed codes or
// overrides them, and we post the journal NOW regardless of confidence. The human
// is the gate (no approvals/Tier-2 here — coding is Tier-0/Tier-1), so we force the
// post via postBillJournal(allowEstimatedGst=true) and flip the suggestion to the
// terminal 'accepted'/'overridden' state so it leaves coding_review_queue. Posting
// stays idempotent (a journal already linked to the bill is reused, never doubled).
async function handleDecision(
  admin: SupabaseClient,
  supabaseUrl: string,
  anonKey: string,
  bill: Bill,
  decision: "accept" | "override",
  body: RequestBody,
  jwt: string,
): Promise<Response> {
  // Load the suggestion the human reviewed and resolve who decided in parallel — the
  // auth round-trip is non-essential provenance, so don't serialize it ahead of the
  // posting work.
  const [{ data: existing, error: selErr }, { data: userData }] = await Promise.all([
    admin
      .from("coding_suggestions")
      .select("id, account_code, tax_code, rationale")
      .eq("bill_id", bill.id)
      .is("deleted_at", null)
      .maybeSingle(),
    admin.auth.getUser(jwt),
  ]);
  if (selErr) return json({ ok: false, error: `load suggestion: ${selErr.message}` }, 500);
  if (!existing) return json({ ok: false, error: "no coding suggestion for this bill" }, 404);
  const row = existing as DecisionRow;
  const decidedBy = userData?.user?.id ?? null;

  // Resolve the codes to post with: override takes them from the request, accept
  // reuses the suggestion's proposal. Either way an account is required to post.
  const accountCode = (decision === "override" ? body.account_code : row.account_code)?.trim() || null;
  if (!accountCode) {
    return json(
      {
        ok: false,
        error:
          decision === "override"
            ? "account_code required for override"
            : "suggestion has no proposed account to accept — override instead",
      },
      400,
    );
  }
  const taxCode = decision === "override" ? body.tax_code?.trim() || null : row.tax_code;

  const result = await postBillJournal(admin, supabaseUrl, anonKey, bill, accountCode, true);
  if (!result.posted) {
    // Could not post (bad/inactive account, amounts don't reconcile, secret unset).
    // Leave the row in the queue and record why so the reviewer can fix the bill.
    await admin
      .from("coding_suggestions")
      .update({ rationale: { ...row.rationale, decision_skipped: { decision, reason: result.reason } } })
      .eq("id", row.id);
    // 200 + ok:false (not 4xx): the caller's hook surfaces the reason verbatim only
    // on the 2xx path; a non-2xx collapses to a generic message and the reviewer
    // never sees WHY (e.g. "GST account 1200 not active for org").
    return json({ ok: false, error: result.reason ?? "could not post journal", suggestion_id: row.id });
  }

  const newStatus = decision === "override" ? "overridden" : "accepted";
  const { error: updErr } = await admin
    .from("coding_suggestions")
    .update({
      status: newStatus,
      account_code: accountCode,
      tax_code: taxCode,
      rationale: {
        ...row.rationale,
        decision: { type: decision, journal_entry_id: result.journalEntryId, decided_by: decidedBy },
      },
    })
    .eq("id", row.id);
  if (updErr) return json({ ok: false, error: `update suggestion: ${updErr.message}` }, 500);

  return json({
    ok: true,
    bill_id: bill.id,
    suggestion_id: row.id,
    status: newStatus,
    account_code: accountCode,
    tax_code: taxCode,
    journal_entry_id: result.journalEntryId,
  });
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  try {
    if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
    if (!req.headers.get("Authorization")) return json({ ok: false, error: "Unauthorized" }, 401);

    const supabaseUrl = requireEnv("SUPABASE_URL");
    const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const anonKey = requireEnv("SUPABASE_ANON_KEY");

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const body = (await req.json().catch(() => ({}))) as RequestBody;
    if (!body.bill_id) return json({ ok: false, error: "bill_id required" }, 400);

    // AUTHORIZATION (cross-tenant guard): load the bill through a CALLER-SCOPED client
    // (anon key + the caller's own Authorization), so RLS on `bills`
    // (organization_id IN get_accessible_org_ids()) decides visibility. An
    // authenticated user only sees bills in orgs they belong to → a bill in another
    // tenant returns no row (404). This closes the IDOR where any logged-in user could
    // code/force-post into another org's ledger just by knowing a bill_id. A trusted
    // backend caller presenting the service-role bearer still bypasses RLS exactly as
    // before — the role travels in the JWT, so no key comparison is needed. The org is
    // still derived from the bill (never trusted from the caller); all subsequent
    // reads/writes stay on the service-role `admin` client, safe because access is now
    // proven. (This fn isn't in config.toml, so verify_jwt defaults to true — but that
    // only proves the JWT is a valid user, NOT org membership, so this RLS-scoped load
    // is the actual tenant gate.)
    const caller = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: bill, error: billErr } = await caller
      .from("bills")
      .select(
        "id, organization_id, status, supplier_name_raw, invoice_number, invoice_date, original_filename, total_inc_gst_cents, gst_cents, subtotal_ex_gst_cents, gst_estimated, intake_metadata",
      )
      .eq("id", body.bill_id)
      .is("deleted_at", null)
      .maybeSingle();
    if (billErr) return json({ ok: false, error: billErr.message }, 500);
    if (!bill) return json({ ok: false, error: "bill not found or not accessible" }, 404);
    const typedBill = bill as Bill;

    // Human review decision (SC-1.D.02) short-circuits the classify path: accept or
    // override the proposed codes and post now. The reviewer (for provenance) is
    // resolved inside handleDecision — service-role writes leave audit_log's
    // auth.uid() null, so provenance lives in the suggestion's rationale.
    if (body.decision === "accept" || body.decision === "override") {
      const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      return await handleDecision(admin, supabaseUrl, anonKey, typedBill, body.decision, body, jwt);
    }

    // Independent queries — the org-scoped active rules, the global category map,
    // and capital-purchase candidacy (0094). Capital detection runs alongside the
    // coding rules lookup since it only reads/writes fixed_assets, never bills.
    const [rulesRes, catRes, capital] = await Promise.all([
      admin
        .from("intake_rules")
        .select(
          "id, matcher_type, matcher_value, matcher_priority, category_code, xero_account_code_override, xero_tax_type_override, hit_count",
        )
        .eq("organization_id", typedBill.organization_id)
        .eq("is_active", true)
        .order("matcher_priority", { ascending: false }),
      admin.from("intake_categories").select("code, xero_account_code, xero_tax_type"),
      detectAndProposeCapitalAsset(admin, typedBill),
    ]);
    if (rulesRes.error) return json({ ok: false, error: rulesRes.error.message }, 500);
    if (catRes.error) return json({ ok: false, error: catRes.error.message }, 500);

    const categories = new Map<string, CategoryMap>();
    for (const c of (catRes.data ?? []) as CategoryMap[]) categories.set(c.code, c);

    const classification = classify(typedBill, (rulesRes.data ?? []) as IntakeRule[], categories);

    // Always record exactly one live suggestion first (needs_review); only flip to
    // auto_posted after a journal is actually posted.
    const suggestionId = await upsertSuggestion(admin, typedBill, classification, "needs_review");

    let status = "needs_review";
    let journalEntryId: string | null = null;

    // A capital-purchase candidate NEVER auto-posts as a period expense, even at
    // >= AUTO_POST_THRESHOLD confidence — it needs a human to confirm the asset in
    // the Fixed Assets register (propose_capitalisation already drafted the
    // `proposed` row above). Coding stays in the review queue with the capital
    // rationale so the reviewer knows to look there instead of accepting the
    // expense coding.
    if (capital.isCandidate) {
      await setRationaleStatus(admin, suggestionId, "needs_review", {
        ...classification.rationale,
        capital_purchase: { candidate: true, fixed_asset_id: capital.fixedAssetId },
      });
    } else if (classification.confidence >= AUTO_POST_THRESHOLD && classification.accountCode) {
      const result = await postBillJournal(admin, supabaseUrl, anonKey, typedBill, classification.accountCode);
      if (result.posted) {
        status = "auto_posted";
        journalEntryId = result.journalEntryId;
        await setRationaleStatus(admin, suggestionId, "auto_posted", {
          ...classification.rationale,
          auto_post: { threshold: AUTO_POST_THRESHOLD, journal_entry_id: journalEntryId },
        });
      } else {
        // Eligible but not safely postable → stay in the review queue with the reason.
        await setRationaleStatus(admin, suggestionId, "needs_review", {
          ...classification.rationale,
          auto_post_skipped: result.reason,
        });
      }
    }

    return json({
      ok: true,
      bill_id: typedBill.id,
      suggestion_id: suggestionId,
      status,
      confidence: classification.confidence,
      account_code: classification.accountCode,
      tax_code: classification.taxCode,
      journal_entry_id: journalEntryId,
      capital_purchase_candidate: capital.isCandidate,
      fixed_asset_id: capital.fixedAssetId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});
