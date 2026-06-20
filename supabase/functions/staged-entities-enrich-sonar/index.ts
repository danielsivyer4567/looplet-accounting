/**
 * staged-entities-enrich-sonar — Perplexity Sonar enrichment for staged entities.
 *
 * Why: Groq Llama-4 Scout (used by gmail-classify-ai) has no web grounding.
 * For brand-name senders (Anthropic, Cloudflare, MYOB, Stripe, ALDI Mobile…)
 * Sonar's online retrieval lets us fact-check what the company actually does
 * and produce a much better category prediction with a citation source.
 *
 * Input: { organization_id, batch_size?: 15, max_batches?: 4, only_unenriched?: true }
 * Output: { ok, stats: { processed, enriched, unchanged, errors }, remaining }
 *
 * Cost: ~$0.00005 per entity at sonar pricing (~200 in / 200 out tokens).
 * AFGC's 458 entities = ~$0.025 total per full run.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders, preflight } from '../_shared/cors.ts';

const SONAR_URL = 'https://api.perplexity.ai/chat/completions';
// 'sonar' = small online model. 'sonar-pro' is more expensive. Small is plenty for this.
const SONAR_MODEL = 'sonar';

const ENTITY_KINDS = ['supplier', 'contractor', 'customer', 'personal', 'subscription', 'internal_admin', 'unknown'] as const;

interface RequestBody {
  organization_id: string;
  batch_size?: number;
  max_batches?: number;
  only_unenriched?: boolean;
}

interface CandidateRow {
  id: string;
  display_name: string;
  primary_email: string | null;
  observed_domains: string[];
  sample_subjects: string[];
  predicted_kind: string;
  predicted_category: string | null;
}

interface SonarResult {
  i: number;
  id: string;
  is_real_business: boolean;
  summary: string;
  kind: string;
  category: string;
  confidence: number;
  evidence_url: string | null;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const sonarKey = Deno.env.get('PERPLEXITY_API_KEY');

    if (!supabaseUrl || !serviceKey) return json({ ok: false, error: 'Server config missing' }, 500);
    if (!sonarKey) return json({ ok: false, error: 'PERPLEXITY_API_KEY not set' }, 500);

    const body = (await req.json()) as RequestBody;
    if (!body.organization_id) return json({ ok: false, error: 'organization_id required' }, 400);

    const batchSize = body.batch_size ?? 15;
    const maxBatches = body.max_batches ?? 4;
    const onlyUnenriched = body.only_unenriched !== false; // default true

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Load category catalogue (Sonar must pick from these)
    const { data: cats, error: catErr } = await admin
      .from('intake_categories')
      .select('code, label, description')
      .order('code');
    if (catErr) return json({ ok: false, error: `categories: ${catErr.message}` }, 500);

    const catalogue = (cats ?? []) as { code: string; label: string; description: string | null }[];

    let processed = 0;
    let enriched = 0;
    let unchanged = 0;
    let errors = 0;

    for (let batchIdx = 0; batchIdx < maxBatches; batchIdx++) {
      let q = admin
        .from('staged_entities')
        .select('id, display_name, primary_email, observed_domains, sample_subjects, predicted_kind, predicted_category')
        .eq('organization_id', body.organization_id)
        .in('status', ['pending', 'needs_review'])
        .order('confidence', { ascending: true }) // enrich the worst predictions first
        .limit(batchSize);

      if (onlyUnenriched) q = q.is('sonar_enriched_at', null);

      const { data: rows, error: fetchErr } = await q;
      if (fetchErr) return json({ ok: false, error: `fetch: ${fetchErr.message}` }, 500);
      if (!rows || rows.length === 0) break;

      processed += rows.length;

      try {
        const results = await classifyWithSonar(rows as CandidateRow[], catalogue, sonarKey);

        // Persist results
        for (const r of results) {
          const validKind = ENTITY_KINDS.includes(r.kind as typeof ENTITY_KINDS[number]) ? r.kind : null;
          const validCategory = catalogue.find((c) => c.code === r.category)?.code ?? null;

          const update: Record<string, unknown> = {
            sonar_summary: r.summary,
            sonar_suggested_kind: validKind,
            sonar_suggested_category: validCategory,
            sonar_confidence: Math.max(0, Math.min(1, r.confidence)),
            sonar_evidence_url: r.evidence_url,
            sonar_enriched_at: new Date().toISOString(),
          };

          const { error: upErr } = await admin
            .from('staged_entities')
            .update(update)
            .eq('id', r.id);

          if (upErr) {
            errors += 1;
            console.error(`update ${r.id}: ${upErr.message}`);
          } else {
            enriched += 1;
          }
        }
      } catch (err) {
        // Mark this batch as enriched-attempted so we don't retry forever, but with no result
        const ids = rows.map((r) => r.id);
        await admin
          .from('staged_entities')
          .update({
            sonar_summary: `Enrichment error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 280),
            sonar_enriched_at: new Date().toISOString(),
          })
          .in('id', ids);
        errors += rows.length;
        unchanged += rows.length;
      }
    }

    // How many remain
    const { count: remainingCount } = await admin
      .from('staged_entities')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', body.organization_id)
      .in('status', ['pending', 'needs_review'])
      .is('sonar_enriched_at', null);

    return json({
      ok: true,
      stats: { processed, enriched, unchanged, errors },
      remaining: remainingCount ?? 0,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

async function classifyWithSonar(
  rows: CandidateRow[],
  catalogue: { code: string; label: string; description: string | null }[],
  sonarKey: string,
): Promise<SonarResult[]> {
  const catBlock = catalogue
    .map((c) => `  ${c.code} — ${c.label}${c.description ? `: ${c.description}` : ''}`)
    .join('\n');

  const entityBlock = rows
    .map((r, i) => {
      const subjects = (r.sample_subjects ?? []).slice(0, 3).map((s) => `    "${s.replace(/"/g, "'")}"`).join('\n');
      const domains = (r.observed_domains ?? []).join(', ');
      return `[${i}] id=${r.id}
  display_name: ${r.display_name}
  email: ${r.primary_email ?? '(unknown)'}
  domains: ${domains}
  predicted_kind: ${r.predicted_kind}
  predicted_category: ${r.predicted_category ?? '(none)'}
  subjects:
${subjects}`;
    })
    .join('\n\n');

  const system = `You are an Australian small-business accountant fact-checking email-sender classifications for a trades-business owner.

For each sender below, use web search to verify what the business actually does, then return:
- is_real_business: true if it's a real registered business or government body, false if junk/personal
- summary: 1 sentence (under 20 words) describing what they do, e.g. "AI safety lab; sells Claude API access" or "QLD government licensing for builders"
- kind: one of supplier, contractor, customer, personal, subscription, internal_admin, unknown
- category: a code from the catalogue below (NEVER invent a code)
- confidence: 0.0-1.0
- evidence_url: a single source URL (Wikipedia, official site, etc.) you used to verify

Category catalogue (use these codes only):
${catBlock}

Australian context tips:
- ASIC, ATO, QBCC, WorkCover are government/regulatory → kind=internal_admin, category=ato_bas_super or professional_fees
- Trades-business suppliers (Bunnings, Reece, fencing/building materials) → kind=supplier, category=materials
- SaaS / software billing emails (Anthropic, Cloudflare, Stripe, GitHub, MYOB, Tradify, Vercel) → kind=subscription, category=subscriptions_saas
- Telco/Internet (Aussie Broadband, ALDI Mobile, Optus) → kind=subscription, category=telephone_internet
- Energy/utilities (Origin Energy, AGL) → kind=supplier, category=utilities
- Insurance (Youi, Budget Direct, Shielded) → kind=supplier, category=insurance

Output JSON ONLY, in this exact shape:
{"results":[{"i":0,"id":"<uuid>","is_real_business":true,"summary":"...","kind":"...","category":"...","confidence":0.92,"evidence_url":"https://..."}]}`;

  const user = `Fact-check and classify these ${rows.length} senders:\n\n${entityBlock}`;

  const resp = await fetch(SONAR_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${sonarKey}`,
    },
    body: JSON.stringify({
      model: SONAR_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.1,
      max_tokens: 4000,
    }),
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Sonar ${resp.status}: ${t.slice(0, 300)}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content as string | undefined;
  if (!content) throw new Error('Sonar returned no content');

  // Sonar wraps citations differently; extract the JSON object from content
  const parsed = extractJsonObject(content);
  const results: unknown = parsed?.results ?? parsed;
  if (!Array.isArray(results)) throw new Error('Sonar response missing results array');

  return (results as SonarResult[]).map((r, idx) => ({
    i: r.i ?? idx,
    id: r.id ?? rows[idx]?.id ?? '',
    is_real_business: Boolean(r.is_real_business),
    summary: String(r.summary ?? ''),
    kind: String(r.kind ?? 'unknown'),
    category: String(r.category ?? 'uncategorized'),
    confidence: Number(r.confidence ?? 0.5),
    evidence_url: r.evidence_url ?? null,
  }));
}

function extractJsonObject(s: string): { results?: unknown } | null {
  // Sonar may prepend prose; strip to first '{' through last '}'
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < 0) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
