/**
 * ask-bot — Q&A bot grounded on the user's Looplet Accounting data + Sonar for AU tax knowledge.
 *
 * Flow:
 *   1. Router (Groq) classifies the question: data | knowledge | hybrid
 *   2. If data/hybrid: SQL agent (Groq) generates SELECT, RPC ask_bot_query executes it (RLS-protected)
 *   3. If knowledge/hybrid: Sonar agent fetches AU-tax/business knowledge with citations
 *   4. Synthesizer (Groq) merges into a natural-language answer
 *
 * Input:  { organization_id, question }
 * Output: { ok, answer, disclaimer, route, sql?, data_rows?, sonar_citations?, error? }
 *
 * Answers are general information, not tax advice; every response carries the disclaimer, and
 * the prompts (./prompts.ts) tell the model to recommend a registered tax agent where it matters.
 *
 * Cost per question: ~$0.0004 (Groq tiny + occasional Sonar).
 */

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { enforceAiQuota } from '../_shared/aiRateLimit.ts';
import { requireSignedInCaller } from '../_shared/authGuards.ts';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { basQuarterSql } from './basQuery.ts';
import { supabaseOrgAccessDeps } from '../_shared/orgRole.ts';
import { embedTexts } from '../_shared/ocr/openai.ts';
import {
  buildCitations,
  renderRetrievedLaw,
  type LegalCitation,
  type LegalMatchRow,
} from '../_shared/legal/citations.ts';
import {
  GENERAL_INFORMATION_NOTICE,
  sonarSystemPrompt,
  synthesisSystemPrompt,
  synthesisUserMessage,
} from './prompts.ts';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const SONAR_URL = 'https://api.perplexity.ai/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile'; // good NL→SQL
// sonar-pro = web-grounded with deeper retrieval. Worth ~5x cost for legal/tax grounding.
const SONAR_MODEL = 'sonar-pro';

type Route = 'data' | 'knowledge' | 'hybrid';

interface RequestBody {
  organization_id: string;
  question: string;
  response_rule?: string;
}

const SCHEMA_HINT = `Schema reference (PostgreSQL, all tables have organization_id uuid):

-- Core financial data
bills (id, organization_id, supplier_id, invoice_number, invoice_date, due_date, total_inc_gst_cents bigint, gst_cents bigint, status, paid_at, is_personal bool, job_id, category_code text, deleted_at)
invoices (id, organization_id, customer_id, invoice_number, issued_at, due_date, total_inc_gst_cents bigint, amount_paid_cents bigint, balance_due_cents bigint, status, job_id, deleted_at)
jobs (id, organization_id, job_number, name, status, customer_id, start_date, end_date, budget_cents bigint, deleted_at)
customers (id, organization_id, name, email, abn, deleted_at)
suppliers (id, organization_id, name, email, abn, deleted_at)
bank_transactions (id, organization_id, posted_at, description, amount_cents bigint, matched_bill_id, matched_invoice_id, manually_matched bool)
subscriptions (id, organization_id, merchant_name, supplier_id, cadence, amount_cents bigint, status, is_personal bool, is_business bool)

-- Aggregated views (PREFER THESE for summaries)
v_bas_quarterly (organization_id, fy_start_year, quarter_num, quarter_start, quarter_end, due_date, sales_inc_gst_cents bigint, sales_ex_gst_cents bigint, gst_collected_cents bigint, purchases_inc_gst_cents bigint, purchases_ex_gst_cents bigint, gst_paid_cents bigint, net_gst_cents bigint)
v_organization_realtime_pnl (organization_id, organization_name, revenue_inc_gst_cents bigint, revenue_ex_gst_cents bigint, total_cost_cents bigint, gross_profit_cents bigint, gst_set_aside_cents bigint, tax_set_aside_cents bigint, really_yours_cents bigint)
v_job_pnl (job_id, organization_id, job_number, job_name, revenue_inc_gst_cents bigint, total_cost_cents bigint, gross_profit_cents bigint, budget_cents bigint, currency_code)
v_unpaid_bills_for_payment_run (id, organization_id, supplier_name, supplier_id, invoice_date, due_date, total_inc_gst_cents bigint, days_overdue int)

Money columns are BIGINT cents — divide by 100 for AUD. Always include WHERE organization_id = '<org>' (RLS will reject otherwise).
Status enums: bills.status: ('draft','attached','approved','paid','void'); invoices.status: ('draft','sent','partially_paid','paid','overdue','void'); jobs.status: ('draft','active','complete','cancelled').
Cadence on subscriptions: weekly, fortnightly, monthly, quarterly, yearly, irregular.
`;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ ok: false, error: 'Unauthorized' }, 401);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const groqKey = Deno.env.get('GROQ_API_KEY');
    const sonarKey = Deno.env.get('PERPLEXITY_API_KEY');

    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !anonKey || !serviceKey) return json({ ok: false, error: 'Server config missing' }, 500);
    if (!groqKey) return json({ ok: false, error: 'GROQ_API_KEY not set' }, 500);

    // Answering spends Groq (and sometimes Perplexity) credit, so the caller must be a signed-in user or the
    // service role. A header that is merely present, such as the public anon key, is not enough.
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const caller = await requireSignedInCaller(authHeader, supabaseOrgAccessDeps(admin, serviceKey));
    if (!caller.ok) return json({ ok: false, error: caller.error }, caller.status);

    const body = (await req.json()) as RequestBody;
    if (!body.organization_id) return json({ ok: false, error: 'organization_id required' }, 400);
    if (!body.question || body.question.trim().length === 0) return json({ ok: false, error: 'question required' }, 400);
    if (caller.caller.kind === 'user') {
      const limited = await enforceAiQuota(admin, caller.caller.userId, 'ask_bot', corsHeaders);
      if (limited) return limited;
    }

    const userClient: SupabaseClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    // 0. LOAD BUSINESS CONTEXT — feeds into Sonar + synthesizer prompts
    const businessContext = await loadBusinessContext(userClient, body.organization_id);

    // 1. ROUTE
    const route = await routeQuestion(body.question, groqKey);

    let dataRows: unknown[] = [];
    let sqlUsed: string | null = null;
    let sqlError: string | null = null;
    let sonarText: string | null = null;
    let sonarCitations: string[] = [];

    // 2. SQL AGENT (data + hybrid)
    if (route === 'data' || route === 'hybrid') {
      const sqlResult = await runSqlAgent(body.question, body.organization_id, userClient, groqKey);
      sqlUsed = sqlResult.sql;
      dataRows = sqlResult.rows;
      sqlError = sqlResult.error;
    }

    // 3. KNOWLEDGE GROUNDING (knowledge + hybrid) — Sonar (web-grounded research)
    // and the cited legal corpus are INDEPENDENT, so run them concurrently to keep
    // the user-facing latency down (Sonar alone is 2-4s). Corpus retrieval is
    // best-effort: its failures degrade to citations:[] + the Sonar-cited answer.
    let citations: LegalCitation[] = [];
    let retrievedLaw = '';
    if (route === 'knowledge' || route === 'hybrid') {
      const [sonarResult, corpus] = await Promise.all([
        sonarKey ? askSonar(body.question, businessContext, sonarKey) : Promise.resolve(null),
        retrieveLegalCorpus(body.question, userClient),
      ]);
      if (sonarResult) {
        sonarText = sonarResult.text;
        sonarCitations = sonarResult.citations;
      }
      citations = corpus.citations;
      retrievedLaw = corpus.retrievedLaw;
    }

    // 4. SYNTHESIZE
    const answer = await synthesize(body.question, dataRows, sonarText, sqlError, route, businessContext, retrievedLaw, groqKey);

    // 5. PROGRESSIVE EXPLAINER — author an ordered, node-by-node walkthrough of
    // the answer (or none). The UI owns the reveal; this only emits the breakdown.
    const visual = await designVisual(body.question, answer, groqKey);

    return json({
      ok: true,
      route,
      answer,
      disclaimer: GENERAL_INFORMATION_NOTICE,
      visual,
      sql: sqlUsed,
      sql_error: sqlError,
      data_rows: dataRows.slice(0, 50), // cap to keep response small
      data_row_count: dataRows.length,
      citations, // cited AU-law corpus chunks ([n] markers in `answer` resolve to these)
      sonar_citations: sonarCitations,
      business_context: businessContext,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

async function loadBusinessContext(
  client: SupabaseClient,
  orgId: string,
): Promise<string> {
  // Tax-calendar window: recent overdue (last 30 days) through upcoming (next 90 days).
  const calFrom = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const calTo = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10);

  // Run all the context queries in parallel for speed
  const [
    profileR,
    topSuppliersR,
    topCustomersR,
    apSnapshotR,
    arSnapshotR,
    subsR,
    categoriesR,
    recentR,
    pnlR,
    basR,
    taxCalR,
  ] = await Promise.all([
    client.from('v_business_context').select('*').eq('organization_id', orgId).maybeSingle(),
    // Top 5 suppliers by spend (lifetime — could refine to YTD)
    client.rpc('ask_bot_query', {
      p_sql: `SELECT s.name AS supplier, COUNT(b.id) AS bills_count, SUM(b.total_inc_gst_cents) AS total_cents
              FROM bills b JOIN suppliers s ON s.id = b.supplier_id
              WHERE b.organization_id = '${orgId}' AND b.deleted_at IS NULL
              GROUP BY s.name ORDER BY total_cents DESC NULLS LAST LIMIT 5`,
      p_max_rows: 5,
    }),
    client.rpc('ask_bot_query', {
      p_sql: `SELECT c.name AS customer, COUNT(i.id) AS invoices_count, SUM(i.total_inc_gst_cents) AS total_cents
              FROM invoices i JOIN customers c ON c.id = i.customer_id
              WHERE i.organization_id = '${orgId}' AND i.deleted_at IS NULL
              GROUP BY c.name ORDER BY total_cents DESC NULLS LAST LIMIT 5`,
      p_max_rows: 5,
    }),
    // AP snapshot (unpaid bills)
    client.rpc('ask_bot_query', {
      p_sql: `SELECT COUNT(*) AS unpaid_count, COALESCE(SUM(total_inc_gst_cents), 0) AS unpaid_cents,
                     COUNT(*) FILTER (WHERE due_date < CURRENT_DATE) AS overdue_count,
                     COALESCE(SUM(total_inc_gst_cents) FILTER (WHERE due_date < CURRENT_DATE), 0) AS overdue_cents
              FROM bills WHERE organization_id = '${orgId}' AND deleted_at IS NULL
                AND status NOT IN ('paid','void') AND total_inc_gst_cents IS NOT NULL`,
      p_max_rows: 1,
    }),
    // AR snapshot (unpaid invoices)
    client.rpc('ask_bot_query', {
      p_sql: `SELECT COUNT(*) AS unpaid_count, COALESCE(SUM(balance_due_cents), 0) AS unpaid_cents,
                     COUNT(*) FILTER (WHERE due_date < CURRENT_DATE) AS overdue_count,
                     COALESCE(SUM(balance_due_cents) FILTER (WHERE due_date < CURRENT_DATE), 0) AS overdue_cents
              FROM invoices WHERE organization_id = '${orgId}' AND deleted_at IS NULL
                AND status NOT IN ('paid','void') AND balance_due_cents > 0`,
      p_max_rows: 1,
    }),
    // Subscription burn — convert all cadences to monthly equivalent
    client.rpc('ask_bot_query', {
      p_sql: `SELECT
                COUNT(*) FILTER (WHERE status NOT IN ('cancelled','dismissed')) AS active_count,
                COALESCE(SUM(CASE
                  WHEN cadence = 'monthly' THEN amount_cents
                  WHEN cadence IN ('yearly','annual') THEN amount_cents / 12
                  WHEN cadence = 'weekly' THEN amount_cents * 433 / 100
                  WHEN cadence = 'fortnightly' THEN amount_cents * 217 / 100
                  WHEN cadence = 'quarterly' THEN amount_cents / 3
                  ELSE amount_cents
                END) FILTER (WHERE status NOT IN ('cancelled','dismissed')), 0) AS monthly_total_cents
              FROM subscriptions WHERE organization_id = '${orgId}'`,
      p_max_rows: 1,
    }),
    // Top spend categories
    client.rpc('ask_bot_query', {
      p_sql: `SELECT category_code, COUNT(*) AS bills_count, SUM(total_inc_gst_cents) AS total_cents
              FROM bills WHERE organization_id = '${orgId}' AND deleted_at IS NULL
                AND category_code IS NOT NULL
              GROUP BY category_code ORDER BY total_cents DESC NULLS LAST LIMIT 6`,
      p_max_rows: 6,
    }),
    // Recent 30 days activity
    client.rpc('ask_bot_query', {
      p_sql: `WITH r30 AS (SELECT (CURRENT_DATE - 30) AS cutoff)
              SELECT
                (SELECT COUNT(*) FROM bills b, r30 WHERE b.organization_id = '${orgId}' AND b.deleted_at IS NULL AND b.invoice_date >= r30.cutoff) AS bills_30d,
                (SELECT COALESCE(SUM(total_inc_gst_cents), 0) FROM bills b, r30 WHERE b.organization_id = '${orgId}' AND b.deleted_at IS NULL AND b.invoice_date >= r30.cutoff) AS bills_30d_cents,
                (SELECT COUNT(*) FROM invoices i, r30 WHERE i.organization_id = '${orgId}' AND i.deleted_at IS NULL AND i.issued_at >= r30.cutoff) AS invoices_30d,
                (SELECT COALESCE(SUM(total_inc_gst_cents), 0) FROM invoices i, r30 WHERE i.organization_id = '${orgId}' AND i.deleted_at IS NULL AND i.issued_at >= r30.cutoff) AS invoices_30d_cents
              FROM r30`,
      p_max_rows: 1,
    }),
    // Latest P&L snapshot
    client.from('v_organization_realtime_pnl').select('*').eq('organization_id', orgId).maybeSingle(),
    // Most recent BAS quarter
    client.rpc('ask_bot_query', {
      p_sql: basQuarterSql(orgId),
      p_max_rows: 1,
    }),
    // Tax calendar — personalized obligations (BAS, super, TPAR, FBT, income tax, EOFY,
    // WorkCover) gated by the org's registrations, with correct AU due dates.
    // Degrades gracefully (empty block) if the 0089 migration isn't deployed yet.
    client
      .from('v_tax_calendar')
      .select('title, category, due_date, stage, days_until_due')
      .eq('organization_id', orgId)
      .gte('due_date', calFrom)
      .lte('due_date', calTo)
      .order('due_date', { ascending: true })
      .limit(12),
  ]);

  const data = profileR.data as Record<string, unknown> | null;
  if (!data) return '(no business profile on file — answer for the common case)';

  const fmt = (cents: unknown): string => {
    if (cents == null || cents === 0) return '$0';
    const n = Number(cents);
    return `$${(n / 100).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  };

  const parts: string[] = [];

  // STATIC PROFILE
  parts.push('=== BUSINESS PROFILE ===');
  if (data.organization_name) parts.push(`Business: ${data.organization_name}`);
  if (data.entity_type) parts.push(`Entity: ${String(data.entity_type).replace('_', ' ')}`);
  if (data.industry_label) parts.push(`Industry: ${data.industry_label}${data.industry_code ? ` (ANZSIC ${data.industry_code})` : ''}`);
  if (data.state_code) parts.push(`State: ${data.state_code}`);
  if (data.is_gst_registered != null) parts.push(`GST registered: ${data.is_gst_registered ? 'YES' : 'NO'}${data.bas_frequency ? ` (BAS ${data.bas_frequency})` : ''}`);
  if (data.aggregated_turnover_bracket && data.aggregated_turnover_bracket !== 'unknown') {
    const bracketLabel: Record<string, string> = {
      under_2m: 'under $2M (small business entity, simplified depreciation eligible)',
      under_10m: 'under $10M (small business entity)',
      under_50m: 'under $50M (medium business)',
      over_50m: 'over $50M (large business)',
    };
    parts.push(`Aggregated turnover bracket: ${bracketLabel[String(data.aggregated_turnover_bracket)] ?? data.aggregated_turnover_bracket}`);
  }
  const regs: string[] = [];
  if (data.is_fbt_registered) regs.push('FBT');
  if (data.is_paygi_registered) regs.push('PAYG-I');
  if (data.is_paygw_registered) regs.push('PAYG-W');
  if (data.is_workcover_registered) regs.push('WorkCover');
  if (regs.length) parts.push(`Tax registrations: ${regs.join(', ')}`);
  if (data.is_tpar_required) parts.push(`TPAR required (pays subbies — annual TPAR lodgement obligation)`);
  if (data.employees_count != null) parts.push(`Employees: ${data.employees_count}, subbies: ${data.subbies_count ?? 0}`);
  if (data.vehicle_count) {
    const v = `${data.vehicle_count} vehicle${Number(data.vehicle_count) > 1 ? 's' : ''}`;
    const usePct = data.primary_vehicle_business_use_pct != null ? `, primary at ${data.primary_vehicle_business_use_pct}% business use` : '';
    const log = data.has_logbook != null ? `, ${data.has_logbook ? 'logbook kept' : 'NO logbook'}` : '';
    parts.push(`Vehicles: ${v}${usePct}${log}`);
  }
  if (data.office_setup) parts.push(`Office: ${String(data.office_setup).replace('_', ' ')}`);
  if (data.notes) parts.push(`Notes: ${data.notes}`);

  // LIVE FINANCIALS
  const pnl = pnlR.data as Record<string, unknown> | null;
  if (pnl) {
    const now = new Date();
    const fyStartYear = now.getUTCMonth() + 1 >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
    const fyStart = `${fyStartYear}-07-01`;
    const daysIntoFy = Math.floor((now.getTime() - Date.parse(fyStart)) / 86_400_000) + 1;
    parts.push('');
    parts.push(`=== LIVE FINANCIALS (current FY, from ${fyStart} — day ${daysIntoFy} of the financial year) ===`);
    if (daysIntoFy <= 31) {
      parts.push(
        `NOTE: the financial year just started, so near-zero figures here are expected and do NOT mean the business has no history. Prior-FY totals are excluded from this section by design — say so if the user asks about revenue/profit.`,
      );
    }
    parts.push(`Revenue (inc GST): ${fmt(pnl.revenue_inc_gst_cents)}`);
    parts.push(`Total cost: ${fmt(pnl.total_cost_cents)}`);
    parts.push(`Gross profit: ${fmt(pnl.gross_profit_cents)}`);
    parts.push(`GST collected − paid (set aside): ${fmt(pnl.gst_set_aside_cents)}`);
    parts.push(`Tax estimated to set aside: ${fmt(pnl.tax_set_aside_cents)}`);
    parts.push(`"Really yours" (after GST + tax set-aside): ${fmt(pnl.really_yours_cents)}`);
  }

  // BAS LATEST
  const bas = (basR.data as Record<string, unknown>[] | null)?.[0];
  if (bas) {
    parts.push('');
    parts.push('=== MOST RECENT BAS QUARTER ===');
    parts.push(`FY${bas.fy_start_year}-Q${bas.quarter_num} (${bas.quarter_start} to ${bas.quarter_end}, due ${bas.due_date})`);
    parts.push(`  Sales inc GST: ${fmt(bas.sales_inc_gst_cents)}, GST collected: ${fmt(bas.gst_collected_cents)}, GST paid: ${fmt(bas.gst_paid_cents)}, Net GST: ${fmt(bas.net_gst_cents)}`);
  }

  // TAX CALENDAR — time-aware obligations so the bot can be proactive about deadlines.
  const taxCal = (taxCalR.data as Record<string, unknown>[] | null) ?? [];
  if (taxCal.length > 0) {
    parts.push('');
    parts.push(`=== TAX CALENDAR (today ${new Date().toISOString().slice(0, 10)}; recent + next 90 days) ===`);
    taxCal.forEach((o) => {
      const days = Number(o.days_until_due);
      const when =
        o.stage === 'overdue'
          ? `OVERDUE by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}`
          : days === 0
            ? 'DUE TODAY'
            : `in ${days} day${days === 1 ? '' : 's'}`;
      parts.push(`- ${o.title} — due ${o.due_date} (${when})`);
    });
  }

  // AP / AR
  const ap = (apSnapshotR.data as Record<string, unknown>[] | null)?.[0];
  const ar = (arSnapshotR.data as Record<string, unknown>[] | null)?.[0];
  if (ap || ar) {
    parts.push('');
    parts.push('=== CASHFLOW POSITION ===');
    if (ap) parts.push(`Unpaid bills (AP): ${ap.unpaid_count} bills totalling ${fmt(ap.unpaid_cents)} (${ap.overdue_count} overdue, ${fmt(ap.overdue_cents)} past due)`);
    if (ar) parts.push(`Unpaid invoices (AR): ${ar.unpaid_count} invoices totalling ${fmt(ar.unpaid_cents)} (${ar.overdue_count} overdue, ${fmt(ar.overdue_cents)} past due)`);
  }

  // SPENDING HABITS
  const topSuppliers = (topSuppliersR.data as Record<string, unknown>[] | null) ?? [];
  if (topSuppliers.length > 0) {
    parts.push('');
    parts.push('=== TOP 5 SUPPLIERS BY SPEND ===');
    topSuppliers.forEach((s, i) => {
      parts.push(`${i + 1}. ${s.supplier} — ${fmt(s.total_cents)} across ${s.bills_count} bills`);
    });
  }

  const categories = (categoriesR.data as Record<string, unknown>[] | null) ?? [];
  if (categories.length > 0) {
    parts.push('');
    parts.push('=== TOP SPEND CATEGORIES ===');
    categories.forEach((c, i) => {
      parts.push(`${i + 1}. ${c.category_code}: ${fmt(c.total_cents)} (${c.bills_count} bills)`);
    });
  }

  // INCOME HABITS
  const topCustomers = (topCustomersR.data as Record<string, unknown>[] | null) ?? [];
  if (topCustomers.length > 0) {
    parts.push('');
    parts.push('=== TOP 5 CUSTOMERS BY REVENUE ===');
    topCustomers.forEach((c, i) => {
      parts.push(`${i + 1}. ${c.customer} — ${fmt(c.total_cents)} across ${c.invoices_count} invoices`);
    });
  }

  // SUBSCRIPTIONS
  const subs = (subsR.data as Record<string, unknown>[] | null)?.[0];
  if (subs && Number(subs.active_count) > 0) {
    const monthly = Number(subs.monthly_total_cents);
    const annual = monthly * 12;
    parts.push('');
    parts.push('=== SUBSCRIPTION BURN ===');
    parts.push(`${subs.active_count} active subs · ${fmt(monthly)}/mo · ${fmt(annual)}/yr`);
  }

  // RECENT 30 DAYS
  const recent = (recentR.data as Record<string, unknown>[] | null)?.[0];
  if (recent && (Number(recent.bills_30d) > 0 || Number(recent.invoices_30d) > 0)) {
    parts.push('');
    parts.push('=== LAST 30 DAYS ACTIVITY ===');
    parts.push(`Bills: ${recent.bills_30d} totalling ${fmt(recent.bills_30d_cents)}`);
    parts.push(`Invoices: ${recent.invoices_30d} totalling ${fmt(recent.invoices_30d_cents)}`);
  }

  if (data.live_active_jobs_count) {
    parts.push('');
    parts.push(`Active jobs in progress: ${data.live_active_jobs_count}`);
  }

  return parts.join('\n');
}

async function routeQuestion(question: string, groqKey: string): Promise<Route> {
  const system = `You are a router for a small-business accounting Q&A bot. Classify the user's question into ONE of:
- "data" — needs to query their actual books (specific numbers, lists, totals, filters by date/supplier/etc.)
- "knowledge" — general accounting/AU-tax knowledge question (deductibility, deadlines, GST rules, etc.) that doesn't need their data
- "hybrid" — needs BOTH (e.g. "is my Bunnings spend within ATO substantiation rules" = data + knowledge)

Output JSON ONLY: {"route": "data" | "knowledge" | "hybrid"}`;

  const resp = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: question }],
      temperature: 0.0,
      max_tokens: 30,
      response_format: { type: 'json_object' },
    }),
  });
  if (!resp.ok) return 'hybrid';
  const data = await resp.json();
  try {
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? '{}');
    return (parsed.route as Route) ?? 'hybrid';
  } catch { return 'hybrid'; }
}

async function runSqlAgent(
  question: string,
  orgId: string,
  client: SupabaseClient,
  groqKey: string,
): Promise<{ sql: string | null; rows: unknown[]; error: string | null }> {
  const system = `You are a SQL generator for a Postgres database. Given a user question and the schema below, generate a single SELECT (or WITH...SELECT) query.

CRITICAL RULES:
- Only SELECT or WITH ... SELECT (no INSERT/UPDATE/DELETE/DDL).
- Always include WHERE organization_id = '${orgId}' on every base table reference (RLS will reject otherwise — fail-fast). For multi-table joins, scope every table.
- Money columns are bigint cents — divide by 100.0 when presenting AUD.
- Always include ORDER BY and a LIMIT (default LIMIT 50).
- Use only relations from the schema. Don't invent columns.
- For "this quarter / last quarter / YTD" date math use Australian fiscal year (Jul 1 – Jun 30).
- Today's date: ${new Date().toISOString().slice(0, 10)}.

${SCHEMA_HINT}

Output JSON ONLY: {"sql": "SELECT ..."}`;

  const resp = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: question }],
      temperature: 0.0,
      max_tokens: 600,
      response_format: { type: 'json_object' },
    }),
  });
  if (!resp.ok) return { sql: null, rows: [], error: `groq ${resp.status}` };
  const data = await resp.json();
  let sql: string | null = null;
  try {
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? '{}');
    sql = parsed.sql ?? null;
  } catch { /* fallthrough */ }
  if (!sql) return { sql: null, rows: [], error: 'SQL generation failed' };

  const { data: rpcData, error: rpcErr } = await client.rpc('ask_bot_query', { p_sql: sql, p_max_rows: 50 });
  if (rpcErr) return { sql, rows: [], error: rpcErr.message };
  const rows = Array.isArray(rpcData) ? rpcData : [];
  return { sql, rows, error: null };
}

async function askSonar(
  question: string,
  businessContext: string,
  sonarKey: string,
): Promise<{ text: string; citations: string[] }> {
  const system = sonarSystemPrompt(businessContext);

  const resp = await fetch(SONAR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sonarKey}` },
    body: JSON.stringify({
      model: SONAR_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: question }],
      temperature: 0.1,
      max_tokens: 600,
    }),
  });
  if (!resp.ok) return { text: '', citations: [] };
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content ?? '';
  // Sonar exposes citations on the response — try a few shapes
  const citations: string[] =
    (data?.citations as string[] | undefined) ??
    (data?.choices?.[0]?.message?.citations as string[] | undefined) ??
    [];
  return { text, citations };
}

// LEGAL-CORPUS RETRIEVAL — embed the question and pull the top-k currently-in-force
// sections from the cited corpus (match_legal_corpus, B.01; p_fy defaults to NULL =
// current FY). These become the authoritative [n] citations the synthesizer grounds
// on. Best-effort: no OPENAI_API_KEY / RPC or corpus not deployed / embed error all
// degrade to {citations:[], retrievedLaw:''} so the answer never fails over grounding.
async function retrieveLegalCorpus(
  question: string,
  client: SupabaseClient,
): Promise<{ citations: LegalCitation[]; retrievedLaw: string }> {
  const empty = { citations: [] as LegalCitation[], retrievedLaw: '' };
  if (!Deno.env.get('OPENAI_API_KEY')) return empty;
  try {
    const [qVec] = await embedTexts([question]);
    if (!qVec) return empty;
    const { data: matchRows, error: matchErr } = await client.rpc('match_legal_corpus', {
      p_query_embedding: vectorLiteral(qVec),
      p_top_k: 6,
    });
    if (matchErr || !Array.isArray(matchRows) || matchRows.length === 0) return empty;
    const citations = buildCitations(matchRows as LegalMatchRow[]);
    return { citations, retrievedLaw: renderRetrievedLaw(citations) };
  } catch {
    return empty; // best-effort grounding; never fail the answer over it
  }
}

async function synthesize(
  question: string,
  dataRows: unknown[],
  sonarText: string | null,
  sqlError: string | null,
  route: Route,
  businessContext: string,
  retrievedLaw: string,
  groqKey: string,
): Promise<string> {
  const dataBlock = dataRows.length > 0
    ? `Data from user's books (JSON):\n${JSON.stringify(dataRows.slice(0, 30), null, 2)}`
    : sqlError
      ? `Tried to query the user's data but failed: ${sqlError}. Tell them gracefully.`
      : route === 'data' || route === 'hybrid'
        ? `No matching data found in user's books for this question.`
        : '';

  const sonarBlock = sonarText
    ? `Sonar (web-grounded AU-tax/law research with citations):\n${sonarText}`
    : '';

  // When the legal corpus returned sections, THEY are the authoritative [n]
  // citations (verbatim, click-to-the-line) and the mandatory-citation guard
  // applies; otherwise fall back to the pre-existing Sonar [n] behaviour.
  const hasCorpus = retrievedLaw.length > 0;
  const citationPolicy = hasCorpus
    ? `CITATION POLICY — a RETRIEVED AU LAW block (verbatim corpus sections) is provided:
- Ground every legal claim in that block and tag it with the matching [n] marker — those become clickable citations to the exact text of the law. Use each [n] EXACTLY as given; never renumber or invent markers.
- MANDATORY-CITATION GUARD: if you state any legal rule, section, ruling, or rate that is NOT supported by an item in the RETRIEVED AU LAW block, you MUST append "(model assertion — verify)" to that claim. Never present an uncited legal claim as settled law.
- The Sonar block (if any) is supplementary web context only — do NOT attach [n] markers to it; fold any useful fact in plainly.`
    : `CITATION POLICY:
- Use the exact citation marker [n] from the Sonar source — DO NOT renumber or invent markers.
- NEVER invent section numbers, ATO IDs, or rulings. Only cite what's in the Sonar block.
- If Sonar didn't return a clear citation, say "I couldn't find a specific ruling for this exact case — general principle is...".`;

  const system = synthesisSystemPrompt(citationPolicy);

  const user = synthesisUserMessage({ businessContext, question, dataBlock, sonarBlock, retrievedLaw });

  const resp = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.2,
      max_tokens: 500,
    }),
  });
  if (!resp.ok) return `Error generating answer: ${resp.status}`;
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content ?? 'No answer generated.';
}

// ---------------------------------------------------------------------------
// PROGRESSIVE EXPLAINER — the authoring layer. Emits an ordered, node-by-node
// breakdown the front-end reveals one step at a time. Always falls back to none.
// The model never animates anything; the reveal lives entirely in the renderer.
// ---------------------------------------------------------------------------

interface ExplainerNode { id: string; num?: string; title: string; tag?: string; caption?: string }
interface ExplainerEdge { from: string; to: string; label?: string }
interface Explainer { title?: string; intro?: string; nodes?: ExplainerNode[]; edges?: ExplainerEdge[]; none?: boolean }

function asLabel(v: unknown, max = 80): string {
  return typeof v === 'string' ? v.replace(/\[\d+\]/g, '').trim().slice(0, max) : '';
}

function sanitizeExplainer(raw: unknown): Explainer {
  const p = (raw ?? {}) as Record<string, unknown>;
  if (!Array.isArray(p.nodes)) return { none: true };

  const nodes: ExplainerNode[] = (p.nodes as Record<string, unknown>[])
    .slice(0, 6)
    .map((n, i) => {
      const node: ExplainerNode = {
        id: String(n?.id ?? `n${i}`),
        num: n?.num ? asLabel(n.num, 4) : String(i + 1).padStart(2, '0'),
        title: asLabel(n?.title, 42),
      };
      if (n?.tag) node.tag = asLabel(n.tag, 36);
      if (n?.caption) node.caption = asLabel(n.caption, 200);
      return node;
    })
    .filter((n) => n.title);

  if (nodes.length < 2) return { none: true };

  const ids = new Set(nodes.map((n) => n.id));
  const edges: ExplainerEdge[] = Array.isArray(p.edges)
    ? (p.edges as Record<string, unknown>[])
        .map((e) => {
          const edge: ExplainerEdge = { from: String(e?.from ?? ''), to: String(e?.to ?? '') };
          if (e?.label) edge.label = asLabel(e.label, 16);
          return edge;
        })
        .filter((e) => ids.has(e.from) && ids.has(e.to))
        .slice(0, 24)
    : [];

  const out: Explainer = { nodes, edges };
  if (p.title) out.title = asLabel(p.title, 48);
  if (p.intro) out.intro = asLabel(p.intro, 160);
  return out;
}

async function designVisual(question: string, answer: string, groqKey: string): Promise<Explainer> {
  const system = `You produce PROGRESSIVE EXPLAINERS for an Australian small-business accounting assistant: an ordered breakdown of the concept in the answer that a renderer reveals one node at a time. You do not write paragraphs and you do not draw anything. You emit ONE JSON object matching the schema below and nothing else.

FIRST — DETECT: only build an explainer when the answer has a shape worth walking through — a process, an eligibility / decision chain, or a concept that breaks into parts. If the answer is a flat fact (a single number, a one-line yes/no, a short definition), return {"none": true} and nothing else.

Authoring rules:
1. Decompose, don't dump. 3-6 nodes. One idea per node. If a node would need more than two sentences of caption, it is two nodes.
2. Order is an argument. Sequence the nodes so each only makes sense once the previous has landed. Node 2 builds on node 1. This ordering is what turns a reveal into a walkthrough.
3. title <=5 words, tag <=5 words, caption 1-2 sentences. Sentence case everywhere. No title case, no all-caps, no emoji.
4. The caption is narration, not a definition — the line a guide would say as this node appears (why it follows the last one, what it does).
5. Only branch when the concept branches. Default to a linear chain (omit "edges"). Add "edges" with from/to/optional label only for real decisions, forks, or loops.
6. Never put citation markers like [1] in any field. Use Australian terms, money, and dates.

Schema (output ONLY this object, no prose, no markdown fences):
{"title":"2-5 words, sentence case","intro":"one sentence framing the whole thing","nodes":[{"id":"slug","num":"01","title":"<=5 words","tag":"<=5 words","caption":"1-2 sentence narration"}],"edges":[{"from":"id","to":"id","label":"<=3 words, optional"}]}

If a visual does not help, return {"none": true}.`;

  const user = `Question: ${question}\n\nAnswer given:\n${answer}\n\nBuild the progressive explainer for this answer (or {"none": true}).`;

  try {
    const resp = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0.2,
        max_tokens: 700,
        response_format: { type: 'json_object' },
      }),
    });
    if (!resp.ok) return { none: true };
    const data = await resp.json();
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? '{}');
    return sanitizeExplainer(parsed);
  } catch {
    return { none: true };
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/** A query embedding as the pgvector text literal match_legal_corpus casts to vector(1536). */
function vectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}
