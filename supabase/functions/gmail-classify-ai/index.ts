/**
 * gmail-classify-ai — bulk LLM classification of staged_entities the heuristic
 * classifier left as 'unknown' or low-confidence. Uses Groq Llama-4 Scout
 * (model already configured in env). Cheap (~$0.0005/entity); processes in
 * batches of 25 entities per API call.
 *
 * Input:  { integration_id, batch_size?: 25, max_batches?: 20 }
 * Output: { ok, stats: { processed, classified, unchanged, errors }, remaining }
 *
 * The LLM is given the sender domain, name, and 3 sample subjects per entity
 * and asked to return a category code from the Auto Setup taxonomy. We never
 * trust the LLM blindly — confidence is capped at 0.85 (so the user still
 * sees these in triage but they're at least pre-categorised).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { enforceAiQuota } from '../_shared/aiRateLimit.ts';
import { requireSignedInCaller } from '../_shared/authGuards.ts';
import { corsHeaders, preflight } from '../_shared/cors.ts';
import { supabaseOrgAccessDeps } from '../_shared/orgRole.ts';
import {
  approveStagedEntity,
  isSafeStagedAutoApproval,
  toEntityKind,
  type StagedEntityForApproval,
} from '../_shared/onboarding/stagedEntityApproval.ts';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

interface RequestBody {
  integration_id?: string;
  organization_id?: string;
  batch_size?: number;
  max_batches?: number;
}

interface CandidateRow {
  id: string;
  organization_id: string;
  canonical_key: string;
  display_name: string;
  primary_email: string | null;
  abn: string | null;
  observed_domains: string[];
  sample_subjects: string[];
  predicted_kind: string;
  predicted_category: string | null;
  confidence: number;
  status: string;
  first_seen_at: string | null;
  last_seen_at: string | null;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ ok: false, error: 'Unauthorized' }, 401);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const groqKey = Deno.env.get('GROQ_API_KEY');
    const groqModel = Deno.env.get('GROQ_VISION_MODEL') ?? 'meta-llama/llama-4-scout-17b-16e-instruct';

    if (!supabaseUrl || !serviceKey || !anonKey || !groqKey) {
      return json({ ok: false, error: 'Server config missing' }, 500);
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    // Classification spends Groq credit: a signed-in user or the service role, not just any header.
    const caller = await requireSignedInCaller(authHeader, supabaseOrgAccessDeps(admin, serviceKey));
    if (!caller.ok) return json({ ok: false, error: caller.error }, caller.status);

    const body = (await req.json()) as RequestBody;
    const batch_size = Math.max(1, Math.min(50, body.batch_size ?? 25));
    const max_batches = Math.max(1, Math.min(40, body.max_batches ?? 20));

    // Resolve organization_id (RLS-checked)
    let organization_id: string;
    if (body.integration_id) {
      const { data: integ, error } = await userClient
        .from('gmail_integrations')
        .select('organization_id')
        .eq('id', body.integration_id)
        .maybeSingle();
      if (error || !integ) return json({ ok: false, error: 'Integration not accessible' }, 403);
      organization_id = integ.organization_id as string;
    } else if (body.organization_id) {
      const { data: org, error } = await userClient
        .from('organizations')
        .select('id')
        .eq('id', body.organization_id)
        .maybeSingle();
      if (error || !org) return json({ ok: false, error: 'Organisation not accessible' }, 403);
      organization_id = org.id as string;
    } else {
      return json({ ok: false, error: 'integration_id or organization_id required' }, 400);
    }
    if (caller.caller.kind === 'user') {
      const limited = await enforceAiQuota(admin, caller.caller.userId, 'gmail_classify_ai', corsHeaders);
      if (limited) return limited;
    }

    // Load category catalogue once (LLM uses these codes verbatim)
    const { data: cats } = await admin
      .from('intake_categories')
      .select('code, label, description')
      .order('sort_order');
    const catalogue = (cats ?? []) as { code: string; label: string; description: string | null }[];
    const validCodes = new Set(catalogue.map((c) => c.code));

    const stats = { processed: 0, classified: 0, auto_approved: 0, unchanged: 0, errors: 0 };
    let remaining = 0;

    for (let batch = 0; batch < max_batches; batch++) {
      // Pull a batch of candidates: 'unknown' kind, OR confidence < 0.5,
      // OR predicted_category = 'uncategorized'. Skip rows the user has
      // already touched.
      const { data: rows, error: rowsErr } = await admin
        .from('staged_entities')
        .select(
          'id, organization_id, canonical_key, display_name, primary_email, abn, observed_domains, sample_subjects, predicted_kind, predicted_category, confidence, status, first_seen_at, last_seen_at',
        )
        .eq('organization_id', organization_id)
        .in('status', ['pending', 'needs_review'])
        .or('predicted_kind.eq.unknown,confidence.lt.0.5')
        .limit(batch_size);

      if (rowsErr) {
        stats.errors += 1;
        break;
      }
      if (!rows || rows.length === 0) {
        remaining = 0;
        break;
      }

      const batchRows = rows as CandidateRow[];
      try {
        const updates = await classifyBatch(batchRows, catalogue, groqKey, groqModel);

        // Apply updates
        for (const u of updates) {
          if (!validCodes.has(u.category)) continue; // safety: never write a code we don't know
          const kind = toEntityKind(u.kind);
          if (!kind) continue;
          const entity = batchRows.find((row) => row.id === u.id);
          if (!entity) continue;
          const confidence = Math.min(0.85, u.confidence); // never trust LLM at 1.0

          const { error: updateErr } = await admin
            .from('staged_entities')
            .update({
              predicted_kind: u.kind,
              predicted_category: u.category,
              prediction_reason: `AI: ${u.reason}`,
              confidence,
              status: 'pending', // LLM-classified rows still need user touch
            })
            .eq('id', u.id);
          if (updateErr) {
            console.error('staged_entities classify update failed', u.id, updateErr.message);
            stats.errors += 1;
            continue;
          }
          stats.classified += 1;

          if (isSafeStagedAutoApproval(kind, u.category, confidence)) {
            try {
              await approveStagedEntity(admin, {
                ...(entity as StagedEntityForApproval),
                predicted_kind: kind,
                predicted_category: u.category,
                confidence,
              }, {
                kind,
                category: u.category,
                confidence,
                source: 'gmail-classify-ai',
              });
              stats.auto_approved += 1;
            } catch (err) {
              console.error('staged entity auto-approval failed', u.id, err);
              stats.errors += 1;
              await admin
                .from('staged_entities')
                .update({ status: 'needs_review' })
                .eq('id', u.id);
            }
          }
        }
        stats.processed += batchRows.length;
        stats.unchanged += batchRows.length - updates.length;
      } catch (err) {
        console.error('classify batch err', err);
        stats.errors += 1;
        break;
      }
    }

    // Count remaining
    const { count } = await admin
      .from('staged_entities')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', organization_id)
      .in('status', ['pending', 'needs_review'])
      .or('predicted_kind.eq.unknown,confidence.lt.0.5');
    remaining = count ?? 0;

    return json({ ok: true, stats, remaining });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});

interface BatchUpdate {
  id: string;
  kind: string;
  category: string;
  confidence: number;
  reason: string;
}

async function classifyBatch(
  rows: CandidateRow[],
  catalogue: { code: string; label: string; description: string | null }[],
  groqKey: string,
  groqModel: string,
): Promise<BatchUpdate[]> {
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
  subjects:
${subjects}`;
    })
    .join('\n\n');

  const system = `You are an Australian small-business accountant classifying email senders for a trades-business owner. Given a sender, return:
- kind: one of supplier, contractor, customer, personal, subscription, internal_admin, unknown
- category: a code from the catalogue below
- confidence: 0.0–1.0 (be honest; 0.5 if you're guessing)
- reason: one short sentence (under 15 words) explaining your call

Category catalogue:
${catBlock}

Rules:
- Only use category codes from the catalogue above. Never invent a code.
- "personal" kind => category MUST be "personal_expense".
- "internal_admin" => "ato_bas_super" or "professional_fees".
- "subscription" => "subscriptions_saas" usually.
- If the email is about a trade you're paying (Bunnings, Reece, plumbers, fencers) => kind "supplier", category "materials" or "subcontractor" or "plant_equipment".
- If the email is in the SENT folder context (already filtered by caller), it's likely a customer.
- If you genuinely can't tell, kind "unknown" + category "uncategorized" + confidence 0.2.
- Australian context: bigpond.com, optusnet.com.au are free-mail; .gov.au is government.

Output a JSON array, one object per [N] entity, in the same order. Schema:
[{"i": 0, "id": "...", "kind": "...", "category": "...", "confidence": 0.0, "reason": "..."}]`;

  const user = `Classify these ${rows.length} senders:\n\n${entityBlock}`;

  const resp = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${groqKey}`,
    },
    body: JSON.stringify({
      model: groqModel,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.1,
      max_tokens: 4000,
      response_format: { type: 'json_object' },
    }),
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Groq ${resp.status}: ${t.slice(0, 300)}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content as string | undefined;
  if (!content) throw new Error('Groq returned no content');

  // Extract JSON array — model may wrap in {"results":[...]} or return bare array
  const parsed = JSON.parse(content);
  const parsedObj = parsed as Record<string, unknown>;
  const arr: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsedObj.results)
      ? parsedObj.results
      : Array.isArray(parsedObj.classifications)
        ? parsedObj.classifications
        : (Object.values(parsedObj).find((v) => Array.isArray(v)) as unknown[] | undefined) ?? [];

  const updates: BatchUpdate[] = [];
  for (const raw of arr) {
    const item = raw as Record<string, unknown>;
    if (!item?.id || typeof item.kind !== 'string' || typeof item.category !== 'string') continue;
    const conf = typeof item.confidence === 'number' ? item.confidence : 0.5;
    updates.push({
      id: String(item.id),
      kind: item.kind,
      category: item.category,
      confidence: Math.max(0, Math.min(1, conf)),
      reason: String(item.reason ?? '').slice(0, 200),
    });
  }
  return updates;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
