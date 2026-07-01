/**
 * bank-transaction-classifier — autopilot GL coding for bank transactions.
 *
 * Processes unclassified bank_transactions for one organisation through a
 * 5-stage cascade (cheapest first, stop on first hit):
 *
 *   Stage 1 – Inherit from matched bill's coding_suggestion (free, instant)
 *   Stage 2 – bank_coding_rules pattern match (free, instant)
 *   Stage 3 – History match: majority-vote from same-merchant prior codings
 *             + auto-learn by writing a bank_coding_rule on first hit
 *   Stage 4 – LLM (Claude Haiku): description + 24-category taxonomy
 *             + auto-learn on confidence ≥ 0.88
 *   Stage 5 – Default: uncategorized / needs_review
 *
 * Parallel to the category cascade, job matching runs for every transaction:
 *   - Finds jobs whose date range contains the transaction's posted_at
 *   - Narrows by merchant description similarity to the supplier name
 *   - Writes suggested_job_id + suggested_job_score onto bank_transactions
 *
 * Confidence thresholds:
 *   ≥ AUTO_CODE_THRESHOLD  → auto_coded (no human needed)
 *   ≥ SUGGEST_THRESHOLD    → suggested  (one-click confirm)
 *   < SUGGEST_THRESHOLD    → needs_review (full queue)
 *
 * Human decision endpoint:
 *   POST { bank_transaction_id, decision: 'accept'|'override', category_code? }
 *   Accept  → flip to 'classified', no new rule written
 *   Override → flip to 'classified', write bank_coding_rule for future learning
 *
 * AUTH: service-role bearer OR ?secret=BANK_CLASSIFIER_CRON_SECRET (cron path)
 *       OR user JWT with org membership (interactive path).
 * Deployed --no-verify-jwt so pg_cron can drive it without a user token.
 *
 * DEPLOY PREREQUISITES:
 *   1. supabase functions deploy bank-transaction-classifier --no-verify-jwt
 *   2. supabase secrets set BANK_CLASSIFIER_CRON_SECRET=<random-32-char>
 *   3. Migration 0206 applied (tables + indexes)
 *   4. ANTHROPIC_API_KEY set (shared with OCR functions)
 */

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';

// ── Thresholds ────────────────────────────────────────────────────────────────
const AUTO_CODE_THRESHOLD = 0.88;  // silent auto-post
const SUGGEST_THRESHOLD   = 0.55;  // surfaces in quick-confirm queue
const HISTORY_AGREE_RATIO = 0.70;  // majority vote floor for history match
const BATCH_LIMIT         = 100;   // transactions per invocation
const MINIMAX_MODEL       = 'MiniMax-Text-01';
const MINIMAX_BASE_URL    = 'https://api.minimax.io/v1';

// ── Types ─────────────────────────────────────────────────────────────────────
interface BankTxn {
  id: string;
  organization_id: string;
  description: string;
  amount_cents: number;
  posted_at: string;
  reference: string | null;
  category_external: string | null;
  matched_bill_id: string | null;
  coding_status: string;
  is_personal: boolean;
}

interface IntakeCategory {
  code: string;
  label: string;
  description: string;
  side: string;
}

interface BankCodingRule {
  id: string;
  pattern: string;
  match_type: 'substring' | 'regex';
  category_code: string | null;
  job_id: string | null;
  is_personal: boolean;
  priority: number;
  hit_count: number;
}

interface ClassifyResult {
  category_code: string | null;
  confidence: number;
  rationale: Record<string, unknown>;
  rule_id: string | null;
  stage: string;
}

interface JobMatch {
  job_id: string;
  score: number;
}

interface RequestBody {
  organization_id?: string;
  limit?: number;
  // Human decision path
  bank_transaction_id?: string;
  decision?: 'accept' | 'override';
  category_code?: string;
  job_id?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/** Extract the leading "merchant token" from a bank description.
 *  e.g. "BUNNINGS WAREHOUSE #123 MELBOURNE" → "BUNNINGS"
 *  Used for history lookup and rule learning (avoids branch-specific noise). */
function merchantToken(description: string): string {
  return description.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
}

function patternMatches(rule: BankCodingRule, description: string): boolean {
  const desc = description.toLowerCase();
  if (rule.match_type === 'regex') {
    try { return new RegExp(rule.pattern, 'i').test(description); }
    catch { return false; }
  }
  return desc.includes(rule.pattern.toLowerCase());
}

// ── Stage 1: Inherit from matched bill ────────────────────────────────────────
async function stageInheritBill(
  admin: SupabaseClient,
  txn: BankTxn,
): Promise<ClassifyResult | null> {
  if (!txn.matched_bill_id) return null;

  const { data: suggestion } = await admin
    .from('coding_suggestions')
    .select('account_code, confidence, status')
    .eq('bill_id', txn.matched_bill_id)
    .is('deleted_at', null)
    .in('status', ['auto_posted', 'accepted', 'overridden'])
    .maybeSingle();

  if (!suggestion?.account_code) return null;

  // Map bill account_code (chart_of_accounts.code) back to an intake category.
  // The intake_categories.xero_account_code is the Xero code, not the COA code,
  // so we do a loose match by finding a category whose xero_account_code ≈ the
  // bill's account_code. If none maps, still inherit with medium confidence.
  const { data: cat } = await admin
    .from('intake_categories')
    .select('code')
    .eq('xero_account_code', suggestion.account_code)
    .maybeSingle();

  return {
    category_code: cat?.code ?? null,
    confidence: 0.95,
    rationale: {
      stage: 'inherit_bill',
      bill_id: txn.matched_bill_id,
      bill_account_code: suggestion.account_code,
      bill_coding_status: suggestion.status,
    },
    rule_id: null,
    stage: 'inherit_bill',
  };
}

// ── Stage 2: bank_coding_rules pattern match ──────────────────────────────────
async function stageRulesMatch(
  admin: SupabaseClient,
  orgId: string,
  txn: BankTxn,
  rules: BankCodingRule[],
): Promise<ClassifyResult | null> {
  for (const rule of rules) {
    if (!patternMatches(rule, txn.description)) continue;
    // Bump hit metrics (fire-and-forget; don't block classification)
    admin.from('bank_coding_rules').update({
      hit_count: rule.hit_count + 1,
      last_hit_at: new Date().toISOString(),
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    }).eq('id', rule.id).then(() => {});

    return {
      category_code: rule.category_code,
      confidence: 0.92,
      rationale: {
        stage: 'bank_coding_rule',
        rule_id: rule.id,
        pattern: rule.pattern,
        match_type: rule.match_type,
      },
      rule_id: rule.id,
      stage: 'bank_coding_rule',
    };
  }
  return null;
}

// ── Stage 3: History match ────────────────────────────────────────────────────
async function stageHistory(
  admin: SupabaseClient,
  orgId: string,
  txn: BankTxn,
): Promise<ClassifyResult | null> {
  const token = merchantToken(txn.description);
  if (!token || token.length < 3) return null;

  // Find recent coded transactions with same leading merchant token.
  const { data: similar } = await admin
    .from('bank_transactions')
    .select('auto_category_code')
    .eq('organization_id', orgId)
    .ilike('description', `${token}%`)
    .not('auto_category_code', 'is', null)
    .in('coding_status', ['auto_coded', 'classified'])
    .order('posted_at', { ascending: false })
    .limit(30);

  if (!similar?.length) return null;

  // Majority vote
  const counts: Record<string, number> = {};
  for (const row of similar) {
    const code = row.auto_category_code as string;
    counts[code] = (counts[code] ?? 0) + 1;
  }
  const [winner, topCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] ?? [];
  if (!winner || topCount / similar.length < HISTORY_AGREE_RATIO) return null;

  // Auto-learn: write a bank_coding_rule so future transactions skip this stage
  const { data: inserted } = await admin
    .from('bank_coding_rules')
    .insert({
      organization_id: orgId,
      pattern: token,
      match_type: 'substring',
      category_code: winner,
      is_personal: false,
      priority: 10,
      source: 'auto_learn',
    })
    .select('id')
    .maybeSingle();

  return {
    category_code: winner,
    confidence: 0.82,
    rationale: {
      stage: 'history_match',
      merchant_token: token,
      sample_size: similar.length,
      agree_ratio: topCount / similar.length,
      auto_rule_created: inserted?.id ?? null,
    },
    rule_id: inserted?.id ?? null,
    stage: 'history_match',
  };
}

// ── Stage 4: LLM (Claude Haiku) ───────────────────────────────────────────────
async function stageLlm(
  orgId: string,
  txn: BankTxn,
  categories: IntakeCategory[],
  admin: SupabaseClient,
): Promise<ClassifyResult | null> {
  const apiKey = Deno.env.get('MINIMAX_API_KEY');
  if (!apiKey) {
    return {
      category_code: 'uncategorized', confidence: 0.1,
      rationale: { stage: 'llm_no_api_key' }, rule_id: null, stage: 'llm_no_api_key',
    };
  }

  const side = txn.amount_cents < 0 ? 'expense/debit' : 'income/credit';
  const absAmount = Math.abs(txn.amount_cents / 100).toFixed(2);

  // Only include expense categories for debits, income categories for credits
  const sideFilter = txn.amount_cents < 0 ? 'expense' : 'income';
  const relevantCats = categories.filter(c => c.side === sideFilter || c.code === 'uncategorized');

  const categoryList = relevantCats
    .map(c => `- ${c.code}: ${c.label} — ${c.description}`)
    .join('\n');

  const prompt = `You are an Australian accounting classifier for a trades/construction business.
Classify this bank transaction into exactly one category from the list below.

Categories:
${categoryList}

Transaction:
Description: "${txn.description}"
Amount: $${absAmount} (${side})
Date: ${txn.posted_at.slice(0, 10)}${txn.reference ? `\nReference: "${txn.reference}"` : ''}${txn.category_external ? `\nBank category: "${txn.category_external}"` : ''}

Rules:
- Use "personal_expense" only if clearly personal (e.g. groceries, Netflix, gym)
- Use "uncategorized" only if genuinely ambiguous
- ATO/tax payments → "ato_bas_super"
- Fuel/petrol → "fuel"
- Bunnings/hardware → "materials"

Respond with JSON only, no other text:
{"category_code": "<code>", "confidence": <0.0-1.0>, "reasoning": "<one sentence>"}`;

  try {
    const res = await fetch(`${MINIMAX_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MINIMAX_MODEL,
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      return {
        category_code: 'uncategorized', confidence: 0.1,
        rationale: { stage: 'llm_api_error', http_status: res.status, body: errBody.slice(0, 300) },
        rule_id: null, stage: 'llm_api_error',
      };
    }

    const body = await res.json();
    // OpenAI-compatible response format
    const text = (body.choices?.[0]?.message?.content ?? '').trim();

    // Extract JSON — use a greedy match from first { to last } to handle nested content
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1) {
      return {
        category_code: 'uncategorized', confidence: 0.1,
        rationale: { stage: 'llm_no_json', raw_text: text.slice(0, 300) },
        rule_id: null, stage: 'llm_no_json',
      };
    }
    const jsonSlice = text.slice(firstBrace, lastBrace + 1);
    let parsed: { category_code?: string; confidence?: number; reasoning?: string };
    try {
      parsed = JSON.parse(jsonSlice);
    } catch {
      return {
        category_code: 'uncategorized', confidence: 0.1,
        rationale: { stage: 'llm_json_parse_error', slice: jsonSlice.slice(0, 300) },
        rule_id: null, stage: 'llm_json_parse_error',
      };
    }

    const categoryCode = String(parsed.category_code ?? '').trim();
    const confidence = Math.min(1, Math.max(0, Number(parsed.confidence ?? 0)));
    const reasoning = String(parsed.reasoning ?? '');

    if (!categoryCode || !relevantCats.find(c => c.code === categoryCode)) {
      // Surface the raw LLM output so we can diagnose from the DB rationale
      return {
        category_code: 'uncategorized',
        confidence: 0.1,
        rationale: {
          stage: 'llm_validation_failed',
          returned_code: categoryCode,
          returned_confidence: confidence,
          returned_reasoning: reasoning,
          valid_codes: relevantCats.map(c => c.code),
        },
        rule_id: null,
        stage: 'llm_validation_failed',
      };
    }

    // Auto-learn: write a rule if confidence is high enough
    let ruleId: string | null = null;
    if (confidence >= AUTO_CODE_THRESHOLD) {
      const token = merchantToken(txn.description);
      if (token.length >= 3) {
        const { data: inserted } = await admin
          .from('bank_coding_rules')
          .insert({
            organization_id: orgId,
            pattern: token,
            match_type: 'substring',
            category_code: categoryCode,
            is_personal: categoryCode === 'personal_expense',
            priority: 5,
            source: 'auto_learn',
          })
          .select('id')
          .maybeSingle();
        ruleId = inserted?.id ?? null;
      }
    }

    return {
      category_code: categoryCode,
      confidence,
      rationale: {
        stage: 'llm',
        model: MINIMAX_MODEL,
        reasoning,
        auto_rule_created: ruleId,
      },
      rule_id: ruleId,
      stage: 'llm',
    };
  } catch {
    return null;
  }
}

// ── Job matching ──────────────────────────────────────────────────────────────
async function matchJob(
  admin: SupabaseClient,
  orgId: string,
  txn: BankTxn,
): Promise<JobMatch | null> {
  // Find jobs active on the transaction date
  const { data: jobs } = await admin
    .from('jobs')
    .select('id, job_number, title, start_date, end_date')
    .eq('organization_id', orgId)
    .eq('status', 'active')
    .lte('start_date', txn.posted_at.slice(0, 10))
    .or(`end_date.is.null,end_date.gte.${txn.posted_at.slice(0, 10)}`);

  if (!jobs?.length) return null;

  // If exactly one active job → high confidence match
  if (jobs.length === 1) {
    return { job_id: jobs[0].id as string, score: 0.75 };
  }

  // Multiple jobs: try description similarity to job title
  const desc = txn.description.toLowerCase();
  const scored = (jobs as { id: string; title: string | null; job_number: string }[])
    .map(j => {
      const title = (j.title ?? j.job_number ?? '').toLowerCase();
      // Simple token overlap score
      const titleWords = title.split(/\s+/).filter(w => w.length > 2);
      const descWords = desc.split(/\s+/);
      const overlap = titleWords.filter(w => descWords.some(d => d.includes(w))).length;
      return { job_id: j.id, score: titleWords.length > 0 ? overlap / titleWords.length : 0 };
    })
    .filter(j => j.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length || scored[0].score < 0.3) return null;
  // Only suggest if clear winner
  if (scored.length > 1 && scored[0].score - scored[1].score < 0.2) return null;

  return { job_id: scored[0].job_id, score: Math.min(0.85, 0.5 + scored[0].score * 0.4) };
}

// ── Upsert suggestion ─────────────────────────────────────────────────────────
async function upsertSuggestion(
  admin: SupabaseClient,
  txn: BankTxn,
  result: ClassifyResult,
  jobId: string | null,
): Promise<string> {
  const row = {
    organization_id: txn.organization_id,
    bank_transaction_id: txn.id,
    category_code: result.category_code,
    job_id: jobId,
    confidence: result.confidence,
    status: 'needs_review' as const,
    rationale: result.rationale,
    applied_rule_id: result.rule_id,
  };

  const { data: existing } = await admin
    .from('bank_tx_coding_suggestions')
    .select('id')
    .eq('bank_transaction_id', txn.id)
    .is('deleted_at', null)
    .maybeSingle();

  if (existing) {
    const { error } = await admin.from('bank_tx_coding_suggestions').update(row).eq('id', existing.id);
    if (error) throw new Error(`update suggestion: ${error.message}`);
    return existing.id as string;
  }
  const { data, error } = await admin
    .from('bank_tx_coding_suggestions')
    .insert(row)
    .select('id')
    .single();
  if (error || !data) throw new Error(`insert suggestion: ${error?.message ?? 'no row'}`);
  return data.id as string;
}

// ── Classify one transaction ───────────────────────────────────────────────────
async function classifyOne(
  admin: SupabaseClient,
  txn: BankTxn,
  rules: BankCodingRule[],
  categories: IntakeCategory[],
): Promise<{ status: string; category_code: string | null; confidence: number }> {
  // Run category cascade + job matching concurrently
  const [jobMatch, stage1] = await Promise.all([
    matchJob(admin, txn.organization_id, txn),
    stageInheritBill(admin, txn),
  ]);

  let result: ClassifyResult | null = stage1;

  if (!result) {
    result = await stageRulesMatch(admin, txn.organization_id, txn, rules);
  }
  if (!result) {
    result = await stageHistory(admin, txn.organization_id, txn);
  }
  if (!result) {
    result = await stageLlm(txn.organization_id, txn, categories, admin);
  }

  // Fallback: uncategorized needs review
  if (!result) {
    result = {
      category_code: 'uncategorized',
      confidence: 0.1,
      rationale: { stage: 'fallback', reason: 'no_stage_matched' },
      rule_id: null,
      stage: 'fallback',
    };
  }

  const jobId = jobMatch?.job_id ?? null;
  const jobScore = jobMatch?.score ?? null;

  if (result.confidence >= AUTO_CODE_THRESHOLD && result.category_code !== 'uncategorized') {
    // Auto-code: write directly onto the bank_transactions row, no human needed
    const { error } = await admin.from('bank_transactions').update({
      auto_category_code: result.category_code,
      coding_status: 'auto_coded',
      ...(jobId ? { suggested_job_id: jobId, suggested_job_score: jobScore } : {}),
    }).eq('id', txn.id);
    if (error) throw new Error(`auto-code bank transaction: ${error.message}`);

    const { error: cleanupError } = await admin
      .from('bank_tx_coding_suggestions')
      .update({ deleted_at: new Date().toISOString() })
      .eq('bank_transaction_id', txn.id)
      .is('deleted_at', null);
    if (cleanupError) throw new Error(`cleanup auto-coded suggestion: ${cleanupError.message}`);

    return { status: 'auto_coded', category_code: result.category_code, confidence: result.confidence };
  }

  // Write suggestion + set coding_status
  await upsertSuggestion(admin, txn, result, jobId);

  const newStatus = result.confidence >= SUGGEST_THRESHOLD ? 'suggested' : 'needs_review';
  const { error: txnUpdateError } = await admin.from('bank_transactions').update({
    coding_status: newStatus,
    ...(jobId ? { suggested_job_id: jobId, suggested_job_score: jobScore } : {}),
  }).eq('id', txn.id);
  if (txnUpdateError) throw new Error(`update bank transaction coding status: ${txnUpdateError.message}`);

  return { status: newStatus, category_code: result.category_code, confidence: result.confidence };
}

// ── Human decision handler ────────────────────────────────────────────────────
async function handleDecision(
  admin: SupabaseClient,
  body: RequestBody,
  orgId: string,
): Promise<Response> {
  const { bank_transaction_id, decision, category_code } = body;
  if (!bank_transaction_id || !decision) {
    return json({ ok: false, error: 'bank_transaction_id and decision required' }, 400);
  }

  const { data: txn } = await admin
    .from('bank_transactions')
    .select('id, organization_id, description, amount_cents')
    .eq('id', bank_transaction_id)
    .eq('organization_id', orgId)
    .maybeSingle();

  if (!txn) return json({ ok: false, error: 'transaction not found' }, 404);

  const { data: suggestion } = await admin
    .from('bank_tx_coding_suggestions')
    .select('id, category_code')
    .eq('bank_transaction_id', bank_transaction_id)
    .is('deleted_at', null)
    .maybeSingle();

  const finalCode = decision === 'override'
    ? (category_code?.trim() || null)
    : (suggestion?.category_code ?? null);

  if (!finalCode) {
    return json({ ok: false, error: 'category_code required for override' }, 400);
  }

  const newStatus = decision === 'override' ? 'overridden' : 'accepted';

  // Update suggestion status
  if (suggestion) {
    await admin.from('bank_tx_coding_suggestions')
      .update({ status: newStatus })
      .eq('id', suggestion.id);
  }

  // Apply the category to the bank transaction
  await admin.from('bank_transactions').update({
    auto_category_code: finalCode,
    coding_status: 'classified',
  }).eq('id', bank_transaction_id);

  // On override: write a bank_coding_rule for future learning
  if (decision === 'override' && finalCode) {
    const token = merchantToken(txn.description as string);
    if (token.length >= 3) {
      await admin.from('bank_coding_rules').insert({
        organization_id: orgId,
        pattern: token,
        match_type: 'substring',
        category_code: finalCode,
        is_personal: finalCode === 'personal_expense',
        priority: 50,  // human overrides get highest priority
        source: 'human_override',
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      }).then(() => {});
    }
  }

  return json({
    ok: true,
    bank_transaction_id,
    status: 'classified',
    category_code: finalCode,
    decision,
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const anonKey     = Deno.env.get('SUPABASE_ANON_KEY');
    const cronSecret  = Deno.env.get('BANK_CLASSIFIER_CRON_SECRET');

    if (!supabaseUrl || !serviceKey || !anonKey) {
      return json({ ok: false, error: 'Server config missing' }, 500);
    }

    // Auth gate (same pattern as auto-reconcile)
    const url       = new URL(req.url);
    const urlSecret = url.searchParams.get('secret');
    const authHeader = req.headers.get('Authorization') ?? '';
    const bearer    = authHeader.replace(/^Bearer\s+/i, '').trim();

    const isServiceRole  = safeEqual(bearer, serviceKey);
    const secretOk       = !!cronSecret && safeEqual(urlSecret ?? '', cronSecret);
    const cronAuthorized = isServiceRole || secretOk;
    const hasUserJwt     = !!bearer && !isServiceRole;

    if (!cronAuthorized && !hasUserJwt) {
      return json({ ok: false, error: 'Unauthorized' }, 401);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const userClient = hasUserJwt
      ? createClient(supabaseUrl, anonKey, {
          global: { headers: { Authorization: authHeader } },
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : admin;

    const body = (await req.json().catch(() => ({}))) as RequestBody;

    // ── Human decision path ────────────────────────────────────────────────
    if (body.decision) {
      // Resolve orgId for the transaction (user path: RLS scopes automatically)
      if (!body.bank_transaction_id) {
        return json({ ok: false, error: 'bank_transaction_id required' }, 400);
      }
      const { data: txnOrg } = await userClient
        .from('bank_transactions')
        .select('organization_id')
        .eq('id', body.bank_transaction_id)
        .maybeSingle();
      if (!txnOrg) return json({ ok: false, error: 'transaction not found' }, 404);
      return handleDecision(admin, body, txnOrg.organization_id as string);
    }

    // ── Batch classification path ──────────────────────────────────────────
    if (!body.organization_id) {
      return json({ ok: false, error: 'organization_id required' }, 400);
    }
    const orgId = body.organization_id;
    const limit = Math.min(Number(body.limit ?? BATCH_LIMIT), 500);

    // Org access check for user-JWT callers
    if (hasUserJwt) {
      const { data: org } = await userClient
        .from('organizations')
        .select('id')
        .eq('id', orgId)
        .maybeSingle();
      if (!org) return json({ ok: false, error: 'Organisation not accessible' }, 403);
    }

    // Fetch unclassified transactions + shared lookup data in parallel
    const [txnRes, rulesRes, catRes] = await Promise.all([
      admin
        .from('bank_transactions')
        .select('id, organization_id, description, amount_cents, posted_at, reference, category_external, matched_bill_id, coding_status, is_personal')
        .eq('organization_id', orgId)
        .in('coding_status', ['unclassified', 'needs_review'])
        .order('posted_at', { ascending: false })
        .limit(limit),
      admin
        .from('bank_coding_rules')
        .select('id, pattern, match_type, category_code, job_id, is_personal, priority, hit_count')
        .eq('organization_id', orgId)
        .eq('is_active', true)
        .is('deleted_at', null)
        .order('priority', { ascending: false }),
      admin
        .from('intake_categories')
        .select('code, label, description, side'),
    ]);

    if (txnRes.error)  return json({ ok: false, error: txnRes.error.message }, 500);
    if (rulesRes.error) return json({ ok: false, error: rulesRes.error.message }, 500);
    if (catRes.error)  return json({ ok: false, error: catRes.error.message }, 500);

    const transactions = (txnRes.data ?? []) as BankTxn[];
    const rules        = (rulesRes.data ?? []) as BankCodingRule[];
    const categories   = (catRes.data ?? []) as IntakeCategory[];

    const stats = {
      scanned: transactions.length,
      auto_coded: 0,
      suggested: 0,
      needs_review: 0,
      errors: [] as { id: string; error: string }[],
    };

    // Classify sequentially to avoid hammering the LLM API concurrently
    for (const txn of transactions) {
      try {
        const outcome = await classifyOne(admin, txn, rules, categories);
        if      (outcome.status === 'auto_coded')   stats.auto_coded++;
        else if (outcome.status === 'suggested')    stats.suggested++;
        else                                         stats.needs_review++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stats.errors.push({ id: txn.id, error: msg });
      }
    }

    return json({ ok: true, organization_id: orgId, stats });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});
