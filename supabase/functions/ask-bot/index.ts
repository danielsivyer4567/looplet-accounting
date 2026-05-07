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
 * Output: { ok, answer, route, sql?, data_rows?, sonar_citations?, error? }
 *
 * Cost per question: ~$0.0004 (Groq tiny + occasional Sonar).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const SONAR_URL = 'https://api.perplexity.ai/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile'; // good NL→SQL
// sonar-pro = web-grounded with deeper retrieval. Worth ~5x cost for legal/tax grounding.
const SONAR_MODEL = 'sonar-pro';

type Route = 'data' | 'knowledge' | 'hybrid';

interface RequestBody {
  organization_id: string;
  question: string;
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
v_bas_quarterly (organization_id, fy_start_year, quarter_num, quarter_start, quarter_end, due_date, sales_inc_gst_cents bigint, sales_ex_gst_cents bigint, gst_collected_cents bigint, purchases_inc_gst_cents bigint, purchases_ex_gst_cents bigint, gst_paid_cents bigint, net_gst_owed_cents bigint)
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

    if (!supabaseUrl || !anonKey) return json({ ok: false, error: 'Server config missing' }, 500);
    if (!groqKey) return json({ ok: false, error: 'GROQ_API_KEY not set' }, 500);

    const body = (await req.json()) as RequestBody;
    if (!body.organization_id) return json({ ok: false, error: 'organization_id required' }, 400);
    if (!body.question || body.question.trim().length === 0) return json({ ok: false, error: 'question required' }, 400);

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

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

    // 3. SONAR AGENT (knowledge + hybrid) — kicked off in parallel below would be ideal,
    // but for clarity we run sequentially. Sonar takes 2-4s typically.
    if ((route === 'knowledge' || route === 'hybrid') && sonarKey) {
      const sonarResult = await askSonar(body.question, sonarKey);
      sonarText = sonarResult.text;
      sonarCitations = sonarResult.citations;
    }

    // 4. SYNTHESIZE
    const answer = await synthesize(body.question, dataRows, sonarText, sqlError, route, groqKey);

    return json({
      ok: true,
      route,
      answer,
      sql: sqlUsed,
      sql_error: sqlError,
      data_rows: dataRows.slice(0, 50), // cap to keep response small
      data_row_count: dataRows.length,
      sonar_citations: sonarCitations,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

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
  client: ReturnType<typeof createClient>,
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

async function askSonar(question: string, sonarKey: string): Promise<{ text: string; citations: string[] }> {
  const system = `You are an Australian small-business compliance/tax research assistant. The user is a trades-business owner. Your job is to give a precise, web-grounded, LAW-BACKED answer.

ANSWER STRUCTURE (always):
1. **Direct answer** — yes/no/it depends, in one sentence.
2. **The rule** — name the actual law, ATO ruling, section, or determination that applies. Examples:
   - "ITAA 1997 §8-1" (general deduction)
   - "ITAA 1997 §40-82 / s328-180" (instant asset write-off)
   - "GST Act 1999 §11-5" (creditable acquisitions)
   - "ATO TR 95/14" (taxation ruling)
   - "ATO ID 2002/761" (interpretive decision)
   - "FBTAA 1986 §136"
   - "SGAA 1992" (super guarantee)
   - "Fair Work Act 2009 §90"
3. **Conditions / caveats** — what must be true for it to apply.
4. **Citations** — every factual claim must have an inline [n] marker tied to a URL. Prefer in this order: ato.gov.au, legislation.gov.au, business.gov.au, fairwork.gov.au, asic.gov.au, abr.business.gov.au, then reputable accounting firms (BDO, KPMG, RSM, etc.).

RULES:
- NEVER make up section numbers or ATO ruling IDs. If you can't find one, say "I couldn't find a specific ruling — general principle is..."
- Australian rules only. Don't cite IRS/HMRC.
- Use Australian dates (DD MMM YYYY).
- Trades-business context: utes, tools, fencing materials, subbies, BAS quarterly, PAYG instalments, FBT on private use of work vehicles.
- Be concise (5-10 sentences total) but don't skip the rule citation.
- If the question is genuinely ambiguous, identify the 2 most likely interpretations and answer both briefly.
- Never tell the user to "consult an accountant" as a cop-out. Give them the actual rule. They can decide if they need an accountant from there.`;

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

async function synthesize(
  question: string,
  dataRows: unknown[],
  sonarText: string | null,
  sqlError: string | null,
  route: Route,
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

  const system = `You are a paralegal-grade assistant for an Australian trades-business owner. Synthesize a single law-backed answer.

OUTPUT FORMAT:
- **Bold the direct answer** in the first sentence (yes / no / it depends).
- Then state the rule with the ATO ruling / ITAA section / GST Act section / Fair Work Act section that backs it. Use the exact citation marker [n] from the Sonar source — DO NOT renumber or invent markers.
- List 1-3 conditions/caveats as bullet points if applicable.
- If the user provided data, weave the actual numbers in.
- Format money as AUD with $ and thousand separators. Cents stored as bigint → divide by 100.
- Australian dates (DD MMM YYYY).

CRITICAL:
- NEVER invent section numbers, ATO IDs, or rulings. Only use what's in the Sonar block.
- NEVER renumber citations. Sonar gives them as [1], [2], etc. — KEEP those exact markers.
- NEVER say "consult your accountant" as the whole answer. Give the rule first.
- If Sonar didn't return a clear citation, say "I couldn't find a specific ruling for this exact case — general principle is..."
- No "Hello!" / "As an AI..." / "I'd be happy to..." preamble. Get straight to the answer.`;

  const user = `Question: ${question}\n\n${dataBlock}\n\n${sonarBlock}`;

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
