/**
 * intake-routing-apply — auto-classification engine.
 *
 * Given a freshly-ingested bill or bank_transaction, walks `intake_rules` in
 * priority order and applies the first matching rule's non-null fields
 * (supplier_id, job_id, category_code, is_personal). Already-set fields on
 * the target are NEVER overwritten — the rule only fills blanks.
 *
 * Pure function. Idempotent. Designed to be invoked fire-and-forget at the
 * end of every intake pipeline:
 *   - bills-extract        (after OCR completes)
 *   - bank-csv-import      (after txns inserted)
 *   - bank-sync            (after Basiq pull, batch entry point)
 *
 * Triage UI seeds the rules; this function applies them. See migration 0036
 * for the active-rules-by-priority index that backs the lookup.
 *
 * For a single bill target, this function also chains into coding-classifier
 * (GL/GST coding + >= 0.9 auto-post) once routing is resolved, so callers only
 * need to invoke this one endpoint per bill rather than two. A coding-classifier
 * failure surfaces as a non-2xx response here (throw-on-failure, same contract
 * as the routing work itself) so it's as observable/retryable to the caller as
 * a routing failure, never silently dropped.
 *
 * Matcher types:
 *   email_sender      — exact match on bills.intake_metadata->>'from'
 *                       (or 'email_sender'). Highest specificity.
 *   sender_domain     — domain part of the same field, e.g. "reece.com.au".
 *   subject_regex     — case-insensitive regex on bills.intake_metadata->>'subject'.
 *   amount_range      — "minCents:maxCents" inclusive range against
 *                       total_inc_gst_cents (bill) or abs(amount_cents) (txn).
 *   descriptor_regex  — case-insensitive regex on bank_transactions.description.
 *
 * Bills: email_sender / sender_domain / subject_regex / amount_range apply.
 * Bank txns: descriptor_regex / amount_range apply. Mismatched matcher_types
 * for the target shape are silently skipped.
 *
 * Input (single):
 *   {
 *     organization_id: string,
 *     target: 'bill' | 'bank_transaction',
 *     target_id: string
 *   }
 *
 * Input (batch — used by bank-csv-import / bank-sync):
 *   {
 *     organization_id: string,
 *     target: 'bill' | 'bank_transaction',
 *     target_ids: string[]
 *   }
 *
 * Output (single):
 *   {
 *     ok: boolean,
 *     target,
 *     target_id,
 *     matches_applied: [{ rule_id, fields_set: {...} }],
 *     rules_evaluated: number,
 *     reason?: 'no_match' | 'all_fields_already_set' | 'target_not_found' | ...
 *   }
 *
 * Output (batch):
 *   {
 *     ok: true,
 *     target,
 *     processed: number,
 *     applied: number,         // count of targets that got at least one rule
 *     no_match: number,
 *     errors: number
 *   }
 *
 * Stops at the first applicable rule (priority order). Increments hit_count
 * and last_matched_at on the winning rule.
 *
 * Auth: service_role (called fire-and-forget by other edge fns). Defence-in-
 * depth: still verifies the target row's organization_id matches the request.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';

type Target = 'bill' | 'bank_transaction';

interface RequestBody {
  organization_id: string;
  target: Target;
  target_id?: string;
  target_ids?: string[];
}

interface CodingClassifierHandoff {
  endpoint: 'coding-classifier';
  ledger_path: 'coding_classifier_post_journal_entry';
  response: unknown;
}

interface IntakeRule {
  id: string;
  // Loose on purpose: the live CHECK constraint (0006) only permits
  // sender_address/sender_domain/sender_name/subject_pattern/attachment_name/
  // body_keyword for bill routing (matchBill below). matchBankTxn separately
  // recognises its own legacy set (descriptor_regex/amount_range/etc.) — a
  // narrow union here would make one switch's cases fail the other's type.
  matcher_type: string;
  matcher_value: string;
  matcher_priority: number;
  category_code: string | null;
  supplier_id: string | null;
  customer_id: string | null;
  job_id: string | null;
  xero_account_code_override: string | null;
  xero_tax_type_override: string | null;
  is_personal: boolean | null;
  skip_ocr: boolean | null;
}

interface BillRow {
  id: string;
  organization_id: string;
  supplier_id: string | null;
  job_id: string | null;
  suggested_job_id: string | null;
  total_inc_gst_cents: number | null;
  intake_metadata: Record<string, unknown> | null;
  applied_intake_rule_id: string | null;
  auto_category_code: string | null;
  is_personal: boolean | null;
  original_filename: string | null;
}

// The signals a bill-shaped matcher can test against (mirrors coding-classifier's
// MatchSignals so both functions read intake_metadata the same way).
interface BillSignals {
  sender: string;
  fromName: string;
  subject: string;
  filename: string;
  body: string;
}

interface BankTxnRow {
  id: string;
  organization_id: string;
  description: string;
  amount_cents: number;
  applied_intake_rule_id: string | null;
  is_personal: boolean | null;
  // The following may not exist on every deployment; we guard before writing.
  job_id?: string | null;
  supplier_id?: string | null;
  auto_category_code?: string | null;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ ok: false, error: 'Unauthorized' }, 401);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) {
      return json({ ok: false, error: 'Server config missing' }, 500);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const body = (await req.json()) as RequestBody;
    if (!body.organization_id) return json({ ok: false, error: 'organization_id required' }, 400);
    if (body.target !== 'bill' && body.target !== 'bank_transaction') {
      return json({ ok: false, error: "target must be 'bill' or 'bank_transaction'" }, 400);
    }

    // Batch path
    if (Array.isArray(body.target_ids) && body.target_ids.length > 0) {
      return await routeBatch(admin, body.organization_id, body.target, body.target_ids, supabaseUrl, serviceKey);
    }

    if (!body.target_id) return json({ ok: false, error: 'target_id or target_ids required' }, 400);

    if (body.target === 'bill') {
      return await routeBill(admin, body.organization_id, body.target_id, supabaseUrl, serviceKey);
    }
    return await routeBankTxn(admin, body.organization_id, body.target_id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

// ---------------------------------------------------------------------------
// Batch routing — loads rules once, walks each target in serial.
// Used by bank-csv-import and bank-sync after a bulk insert. Limited to
// a sane upper bound (1000) to keep the edge fn within wall-clock budget.
// ---------------------------------------------------------------------------

async function routeBatch(
  admin: SupabaseClient,
  orgId: string,
  target: Target,
  targetIds: string[],
  supabaseUrl: string,
  serviceKey: string,
): Promise<Response> {
  const ids = targetIds.slice(0, 1000);
  const rules = await loadRules(admin, orgId);

  let applied = 0;
  let noMatch = 0;
  let errors = 0;
  let ledgerHandoffs = 0;

  // Bank txns have no independent coding step, so with no active rules there's
  // truly nothing to do. Bills still need the coding-classifier chain below
  // (GL/GST coding + capital-purchase detection run independently of whether
  // any intake_rules matched), so they always enter the loop.
  if (rules.length === 0 && target !== 'bill') {
    return json({
      ok: true,
      target,
      processed: 0,
      applied: 0,
      no_match: ids.length,
      errors: 0,
      reason: 'no_active_rules',
    });
  }

  for (const id of ids) {
    try {
      let matched = false;
      if (target === 'bill') {
        const result = await applyFirstMatchingRuleForBill(admin, orgId, id, rules);
        matched = result.matched;
        // Chain into coding-classifier whenever the bill actually exists in this
        // org, mirroring routeBill's single-target contract — a throw here counts
        // as a batch error for this id without aborting the rest of the batch.
        if (result.found) {
          await runCodingClassify(supabaseUrl, serviceKey, id);
          ledgerHandoffs += 1;
        }
      } else {
        matched = await applyFirstMatchingRuleForBankTxn(admin, orgId, id, rules);
      }
      if (matched) applied += 1;
      else noMatch += 1;
    } catch (err) {
      console.error(`batch routing error for ${target} ${id}:`, err);
      errors += 1;
    }
  }

  return json({
    ok: true,
    target,
    processed: ids.length,
    applied,
    no_match: noMatch,
    errors,
    ledger_handoffs: ledgerHandoffs,
  });
}

// ---------------------------------------------------------------------------
// Bill routing
// ---------------------------------------------------------------------------

async function routeBill(
  admin: SupabaseClient,
  orgId: string,
  billId: string,
  supabaseUrl: string,
  serviceKey: string,
): Promise<Response> {
  const outcome = await routeBillCore(admin, orgId, billId);
  if (outcome.status !== 200) return json(outcome.payload, outcome.status);

  // The bill exists and is in this org — chain into coding-classifier
  // regardless of whether a routing rule matched this run (a rule may have
  // matched on a prior call, or none may ever match), so every bill that
  // reaches this endpoint also gets GL/GST coded exactly once. Throwing here
  // surfaces as a non-2xx response, same observable/retryable contract as
  // the routing work above.
  const ledgerHandoff = await runCodingClassify(supabaseUrl, serviceKey, billId);

  return json({ ...outcome.payload, ledger_handoff: ledgerHandoff });
}

interface RouteOutcome {
  status: number;
  payload: Record<string, unknown>;
}

async function routeBillCore(admin: SupabaseClient, orgId: string, billId: string): Promise<RouteOutcome> {
  const { data: bill, error } = await admin
    .from('bills')
    .select(
      'id, organization_id, supplier_id, job_id, suggested_job_id, total_inc_gst_cents, intake_metadata, applied_intake_rule_id, auto_category_code, is_personal, original_filename',
    )
    .eq('id', billId)
    .maybeSingle();

  if (error) return { status: 500, payload: { ok: false, error: `bill load: ${error.message}` } };
  if (!bill) {
    return {
      status: 200,
      payload: { ok: true, matches_applied: [], rules_evaluated: 0, reason: 'target_not_found' },
    };
  }

  // Defence-in-depth — caller asserted org but bill could be elsewhere.
  if ((bill as BillRow).organization_id !== orgId) {
    return { status: 403, payload: { ok: false, error: 'organization_id mismatch on target' } };
  }

  // Skip re-applying a rule (idempotent re-run safety) but still chain into
  // coding-classifier below — coding is independently idempotent per bill.
  if ((bill as BillRow).applied_intake_rule_id) {
    return {
      status: 200,
      payload: {
        ok: true,
        target: 'bill',
        target_id: billId,
        matches_applied: [],
        rules_evaluated: 0,
        reason: 'already_routed',
      },
    };
  }

  const rules = await loadRules(admin, orgId);
  const billRow = bill as BillRow;
  const signals = buildBillSignals(billRow);

  for (const rule of rules) {
    const matched = matchBill(rule, signals);
    if (!matched) continue;

    const fieldsSet = await applyRuleToBill(admin, billRow, rule);
    await recordRuleHit(admin, rule.id);

    return {
      status: 200,
      payload: {
        ok: true,
        target: 'bill',
        target_id: billId,
        matches_applied: [{ rule_id: rule.id, fields_set: fieldsSet }],
        rules_evaluated: rules.length,
        reason: Object.keys(fieldsSet).length === 0 ? 'matched_but_no_blank_fields' : undefined,
      },
    };
  }

  return {
    status: 200,
    payload: {
      ok: true,
      target: 'bill',
      target_id: billId,
      matches_applied: [],
      rules_evaluated: rules.length,
      reason: 'no_match',
    },
  };
}

// Call into coding-classifier (GL/GST coding + >= AUTO_POST_THRESHOLD
// auto-post) so a routed bill gets coded without callers needing to invoke a
// second endpoint. Mirrors bills-extract's own throw-on-failure fetch pattern.
async function runCodingClassify(
  supabaseUrl: string,
  serviceKey: string,
  billId: string,
): Promise<CodingClassifierHandoff> {
  const response = await fetch(`${supabaseUrl}/functions/v1/coding-classifier`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bill_id: billId }),
  });
  if (!response.ok) {
    throw new Error(
      `coding-classifier failed: ${response.status} ${await response.text().catch(() => '')}`.trim(),
    );
  }
  const body = await response.json().catch(() => null);
  return {
    endpoint: 'coding-classifier',
    ledger_path: 'coding_classifier_post_journal_entry',
    response: body,
  };
}

// Pulls the same intake_metadata keys coding-classifier reads, so a rule authored
// against one classifier's signals behaves identically in the other.
function buildBillSignals(bill: BillRow): BillSignals {
  const meta = bill.intake_metadata ?? {};
  return {
    sender: pickString(meta, ['email_sender', 'from', 'sender']) ?? '',
    fromName: pickString(meta, ['from_name', 'sender_name']) ?? '',
    subject: pickString(meta, ['email_subject', 'subject']) ?? '',
    filename: (bill.original_filename ?? '').toLowerCase(),
    body: pickString(meta, ['body_text', 'body', 'snippet']) ?? '',
  };
}

// Canonical matcher_type set (0006 CHECK constraint) — the ONLY values that can
// ever exist on a live intake_rules row. Mirrors coding-classifier's ruleMatches
// so both classifiers agree on what a rule means for a bill.
function matchBill(rule: IntakeRule, s: BillSignals): boolean {
  const v = rule.matcher_value.trim();
  if (v === '') return false;
  switch (rule.matcher_type) {
    case 'sender_address':
      // Exact, case-insensitive (email addresses are case-insensitive in the local part too,
      // per RFC norm).
      return s.sender !== '' && s.sender.toLowerCase() === v.toLowerCase();
    case 'sender_domain': {
      if (s.sender === '') return false;
      const domain = s.sender.split('@')[1]?.toLowerCase() ?? '';
      const want = v.toLowerCase().replace(/^@/, '');
      // "reece.com.au" matches sender "...@reece.com.au" or any subdomain "...@x.reece.com.au"
      return domain !== '' && (domain === want || domain.endsWith(`.${want}`));
    }
    case 'sender_name':
      return s.fromName !== '' && s.fromName.toLowerCase().includes(v.toLowerCase());
    case 'subject_pattern':
      return s.subject !== '' && safeRegexTest(v, s.subject);
    case 'attachment_name':
      return s.filename !== '' && s.filename.includes(v.toLowerCase());
    case 'body_keyword':
      return s.body !== '' && s.body.toLowerCase().includes(v.toLowerCase());
    default:
      return false;
  }
}

async function applyRuleToBill(
  admin: SupabaseClient,
  bill: BillRow,
  rule: IntakeRule,
): Promise<Record<string, unknown>> {
  // Only fill blanks. Don't overwrite anything the OCR or user already set.
  const update: Record<string, unknown> = {
    applied_intake_rule_id: rule.id,
  };

  if (!bill.supplier_id && rule.supplier_id) update.supplier_id = rule.supplier_id;
  if (!bill.job_id && !bill.suggested_job_id && rule.job_id) update.suggested_job_id = rule.job_id;
  if (!bill.auto_category_code && rule.category_code) update.auto_category_code = rule.category_code;
  if ((bill.is_personal == null || bill.is_personal === false) && rule.is_personal === true) {
    update.is_personal = true;
  }
  // Note: xero_account_code_override / xero_tax_type_override are read by the
  // Xero push step — they don't live on the bill row directly, so we don't
  // copy them here. They're consulted via applied_intake_rule_id at push time.

  update.updated_at = new Date().toISOString();

  // If literally nothing besides applied_intake_rule_id changed, still record
  // the rule (so analytics show which rule "would have" matched), but flag it.
  await admin.from('bills').update(update).eq('id', bill.id);

  // Strip applied_intake_rule_id + updated_at from the returned fields_set so
  // the caller sees just the user-visible fills.
  const userVisible = { ...update };
  delete userVisible.applied_intake_rule_id;
  delete userVisible.updated_at;
  return userVisible;
}

// ---------------------------------------------------------------------------
// Bank transaction routing
// ---------------------------------------------------------------------------

async function routeBankTxn(
  admin: SupabaseClient,
  orgId: string,
  txnId: string,
): Promise<Response> {
  // We select * to be tolerant of optional columns (job_id, supplier_id) that
  // may not exist on older deployments. Postgrest will return what's present.
  const { data: txn, error } = await admin
    .from('bank_transactions')
    .select('*')
    .eq('id', txnId)
    .maybeSingle();

  if (error) return json({ ok: false, error: `txn load: ${error.message}` }, 500);
  if (!txn) return json({ ok: true, matches_applied: [], rules_evaluated: 0, reason: 'target_not_found' });

  const txnRow = txn as BankTxnRow;
  if (txnRow.organization_id !== orgId) {
    return json({ ok: false, error: 'organization_id mismatch on target' }, 403);
  }

  if (txnRow.applied_intake_rule_id) {
    return json({
      ok: true,
      target: 'bank_transaction',
      target_id: txnId,
      matches_applied: [],
      rules_evaluated: 0,
      reason: 'already_routed',
    });
  }

  const rules = await loadRules(admin, orgId);
  const absAmount = Math.abs(txnRow.amount_cents);

  for (const rule of rules) {
    const matched = matchBankTxn(rule, txnRow.description, absAmount);
    if (!matched) continue;

    const fieldsSet = await applyRuleToBankTxn(admin, txnRow, rule);
    await recordRuleHit(admin, rule.id);

    return json({
      ok: true,
      target: 'bank_transaction',
      target_id: txnId,
      matches_applied: [{ rule_id: rule.id, fields_set: fieldsSet }],
      rules_evaluated: rules.length,
      reason: Object.keys(fieldsSet).length === 0 ? 'matched_but_no_blank_fields' : undefined,
    });
  }

  return json({
    ok: true,
    target: 'bank_transaction',
    target_id: txnId,
    matches_applied: [],
    rules_evaluated: rules.length,
    reason: 'no_match',
  });
}

function matchBankTxn(rule: IntakeRule, description: string, absAmountCents: number): boolean {
  switch (rule.matcher_type) {
    case 'descriptor_regex':
      return safeRegexTest(rule.matcher_value, description);
    case 'amount_range':
      return amountInRange(rule.matcher_value, absAmountCents);
    case 'email_sender':
    case 'sender_domain':
    case 'subject_regex':
      // Email-shaped matchers don't apply to bank transactions.
      return false;
    default:
      return false;
  }
}

async function applyRuleToBankTxn(
  admin: SupabaseClient,
  txn: BankTxnRow,
  rule: IntakeRule,
): Promise<Record<string, unknown>> {
  const update: Record<string, unknown> = {
    applied_intake_rule_id: rule.id,
  };

  // Optional columns — only set if the rule wants them AND the txn doesn't already have a value.
  if (!txn.supplier_id && rule.supplier_id) update.supplier_id = rule.supplier_id;
  if (!txn.job_id && rule.job_id) update.job_id = rule.job_id;
  if (!txn.auto_category_code && rule.category_code) update.auto_category_code = rule.category_code;
  if ((txn.is_personal == null || txn.is_personal === false) && rule.is_personal === true) {
    update.is_personal = true;
  }

  // Postgrest will reject unknown columns. Update in two passes so that if
  // optional cols (supplier_id/job_id/auto_category_code) don't exist on this
  // deployment, we still record applied_intake_rule_id + is_personal.
  const result = await admin.from('bank_transactions').update(update).eq('id', txn.id);
  if (result.error) {
    // Fall back to the safe minimal set
    const minimal: Record<string, unknown> = {
      applied_intake_rule_id: rule.id,
    };
    if (update.is_personal === true) minimal.is_personal = true;
    await admin.from('bank_transactions').update(minimal).eq('id', txn.id);
    const minimalVisible = { ...minimal };
    delete minimalVisible.applied_intake_rule_id;
    return minimalVisible;
  }

  const userVisible = { ...update };
  delete userVisible.applied_intake_rule_id;
  return userVisible;
}

// ---------------------------------------------------------------------------
// Per-row helpers shared by single + batch paths.
// Returns true if any rule applied, false if no rule matched.
// ---------------------------------------------------------------------------

interface BillRuleApplyResult {
  // Whether the bill exists in this org — batch routing uses this to decide
  // whether to chain into coding-classifier (never for a missing/foreign bill).
  found: boolean;
  matched: boolean;
}

async function applyFirstMatchingRuleForBill(
  admin: SupabaseClient,
  orgId: string,
  billId: string,
  rules: IntakeRule[],
): Promise<BillRuleApplyResult> {
  const { data: bill, error } = await admin
    .from('bills')
    .select(
      'id, organization_id, supplier_id, job_id, suggested_job_id, total_inc_gst_cents, intake_metadata, applied_intake_rule_id, auto_category_code, is_personal, original_filename',
    )
    .eq('id', billId)
    .maybeSingle();
  if (error || !bill) return { found: false, matched: false };
  const row = bill as BillRow;
  if (row.organization_id !== orgId) return { found: false, matched: false };
  if (row.applied_intake_rule_id) return { found: true, matched: false };

  const signals = buildBillSignals(row);

  for (const rule of rules) {
    if (matchBill(rule, signals)) {
      await applyRuleToBill(admin, row, rule);
      await recordRuleHit(admin, rule.id);
      return { found: true, matched: true };
    }
  }
  return { found: true, matched: false };
}

async function applyFirstMatchingRuleForBankTxn(
  admin: SupabaseClient,
  orgId: string,
  txnId: string,
  rules: IntakeRule[],
): Promise<boolean> {
  const { data: txn, error } = await admin
    .from('bank_transactions')
    .select('*')
    .eq('id', txnId)
    .maybeSingle();
  if (error || !txn) return false;
  const row = txn as BankTxnRow;
  if (row.organization_id !== orgId) return false;
  if (row.applied_intake_rule_id) return false;

  const absAmount = Math.abs(row.amount_cents);
  for (const rule of rules) {
    if (matchBankTxn(rule, row.description, absAmount)) {
      await applyRuleToBankTxn(admin, row, rule);
      await recordRuleHit(admin, rule.id);
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function loadRules(admin: SupabaseClient, orgId: string): Promise<IntakeRule[]> {
  const { data, error } = await admin
    .from('intake_rules')
    .select(
      'id, matcher_type, matcher_value, matcher_priority, category_code, supplier_id, customer_id, job_id, xero_account_code_override, xero_tax_type_override, is_personal, skip_ocr',
    )
    .eq('organization_id', orgId)
    .eq('is_active', true)
    .order('matcher_priority', { ascending: false });

  if (error) {
    console.error('intake_rules load failed:', error.message);
    return [];
  }
  return (data ?? []) as IntakeRule[];
}

async function recordRuleHit(admin: SupabaseClient, ruleId: string): Promise<void> {
  // Prefer the SQL helper if it exists (atomic increment), fall back to a
  // best-effort UPDATE otherwise. Either way, never bubble errors — analytics
  // are non-critical to the routing path.
  try {
    const { error: rpcErr } = await admin.rpc('record_intake_rule_hit', { p_rule_id: ruleId });
    if (!rpcErr) return;
  } catch { /* fall through */ }

  try {
    // Best-effort: bump last_matched_at + ++hit_count without a transaction.
    // Safe to race: PG handles concurrent UPDATEs; worst case is a missed +1.
    const { data: row } = await admin
      .from('intake_rules')
      .select('hit_count')
      .eq('id', ruleId)
      .maybeSingle();
    const next = ((row?.hit_count as number | null) ?? 0) + 1;
    await admin
      .from('intake_rules')
      .update({ hit_count: next, last_matched_at: new Date().toISOString() })
      .eq('id', ruleId);
  } catch { /* swallow */ }
}

function pickString(meta: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = meta[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

function safeRegexTest(pattern: string, input: string): boolean {
  try {
    // Case-insensitive to match Postgres ~* semantics.
    const re = new RegExp(pattern, 'i');
    return re.test(input);
  } catch (err) {
    console.warn(`bad regex in intake_rules.matcher_value: ${pattern} — ${err}`);
    return false;
  }
}

/**
 * Parse "minCents:maxCents" (or "min-max") and test inclusive membership.
 * Either bound may be omitted: ":50000" = ≤ $500.00, "10000:" = ≥ $100.00.
 */
function amountInRange(spec: string, value: number): boolean {
  const m = spec.match(/^\s*(-?\d+)?\s*[:-]\s*(-?\d+)?\s*$/);
  if (!m) return false;
  const min = m[1] !== undefined && m[1] !== '' ? parseInt(m[1], 10) : Number.NEGATIVE_INFINITY;
  const max = m[2] !== undefined && m[2] !== '' ? parseInt(m[2], 10) : Number.POSITIVE_INFINITY;
  if (Number.isNaN(min) || Number.isNaN(max)) return false;
  return value >= min && value <= max;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
