// Edge function: legal-horizon-scan  (SC-LC.F.02)
//
// The horizon scanner. Runs targeted Perplexity Sonar (web-grounded) queries for
// UPCOMING Australian tax/superannuation changes — budget announcements, exposure
// drafts open for consultation, bills before Parliament, measures awaiting Royal
// Assent — classifies each into the legislative lifecycle (legal_change_stage) with
// a confidence, extracts a proposed effective date + source, and upserts OPEN items
// into legal_horizon (F.01).
//
// IDEMPOTENT across the 3-hourly cron (SC-LC.F.03): every item is keyed by a stable
// fingerprint = sha256(normalize(topic)|normalize(title)). A later scan of the same
// measure REFRESHES last_seen_at + the mutable fields (stage may have progressed) on
// the existing open row — never a duplicate (the partial-unique index allows one open
// row per fingerprint). A fingerprint that has already reached a TERMINAL state
// (reconciled by F.03 / dismissed by an operator / superseded) is NOT re-opened.
//
// These rows are NEVER cited as law — they are stage-labelled, confidence-scored
// PROPOSALS. legal_horizon is GLOBAL reference data → writes via service_role only.
//
// AUTH: operator/back-end only, NO user-JWT path (mirrors legal-corpus-sync):
// service-role bearer OR an X-Cron-Secret header matching LEGAL_SCAN_SECRET (constant-time); else 401.
// SC-LC.F.03 makes this cron-driven every 3h (verify_jwt=false + the cron secret).
//
// Request body (all optional):
//   { items?: RawItem[],   // operator/test: SKIP Sonar, upsert these classified items
//     topics?: string[],   // override the default per-topic query list for this scan
//     dry_run?: boolean }  // scan + classify but DON'T write — returns the items
//
// DEPLOY PREREQUISITES (post-slice): 0113 applied; PERPLEXITY_API_KEY set (the secret
// ask-bot / staged-entities-enrich-sonar already use); LEGAL_SCAN_SECRET set for the
// cron; deploy via Supabase MCP. Production tuning of the topic list / query prompts
// (and the within-batch dedupe key) is a deploy-time refinement.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, preflight } from "../_shared/cors.ts";
import { presentedCronSecret } from "../_shared/cronSecret.ts";
import { requireEnv } from "../_shared/env.ts";
import { sha256Hex } from "../_shared/apiKeys.ts";

const SONAR_URL = "https://api.perplexity.ai/chat/completions";
// sonar-pro = deeper web-grounded retrieval — worth the extra cost for legal/tax
// accuracy (matches ask-bot's choice; this runs only 3-hourly so cost is bounded).
const SONAR_MODEL = "sonar-pro";

// The legislative lifecycle (matches legal_change_stage in 0113). An off-list stage
// from the model means the item is dropped — we never coerce a fabricated stage.
const STAGES = [
  "announced",
  "exposure_draft",
  "before_parliament",
  "passed_pending_assent",
  "enacted",
  "abandoned",
] as const;
type Stage = (typeof STAGES)[number];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Default per-topic sweeps (the key AU tax areas the corpus covers). A broad pipeline
// query runs first; these add depth per topic — a topic search surfaces measures a
// single broad query can miss (multi-angle coverage), all merged + deduped.
const DEFAULT_TOPICS = [
  "company & small business tax — instant asset write-off, capital allowances, Division 7A",
  "individual income tax rates, thresholds, offsets and the Medicare levy",
  "superannuation — super guarantee rate, contribution caps, payday super",
  "fringe benefits tax (FBT)",
  "GST and other indirect taxes",
  "capital gains tax and the small business CGT concessions",
  "tax administration & reporting — BAS, STP, TPAR, ATO compliance measures",
];

// Shape the model returns / the operator-or-test injection path supplies.
interface RawItem {
  title?: string;
  summary?: string | null;
  topic?: string | null;
  stage?: string;
  confidence?: number;
  proposed_effective_from?: string | null;
  source_url?: string | null;
  source_excerpt?: string | null;
}

// Validated, fingerprinted item ready to upsert.
interface HorizonItem {
  title: string;
  summary: string | null;
  topic: string | null;
  stage: Stage;
  confidence: number;
  proposed_effective_from: string | null;
  source_url: string | null;
  source_excerpt: string | null;
  fingerprint: string;
}

interface RequestBody {
  items?: RawItem[];
  topics?: string[];
  dry_run?: boolean;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Constant-time string compare; false on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/** Trim to a non-empty string, else null (defensive: model fields may be any type). */
function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s || null;
}

/** Clamp a confidence into [0,1]; neutral 0.5 when the model omits/garbles it. */
function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
}

/** Stable dedupe key component: lowercase, non-alphanumerics → single space, trim. */
function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Sonar may wrap the JSON object in prose — slice the first '{' … last '}'. */
function extractJsonObject(s: string): Record<string, unknown> | null {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end < 0) return null;
  try {
    return JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildSystemPrompt(today: string): string {
  return `You are an Australian tax-law analyst maintaining a radar of UPCOMING changes to Australian Federal tax and superannuation law. Today is ${today}.

Using web search, find measures that are PENDING or RECENTLY ANNOUNCED — not long-standing settled law. For each measure, classify where it sits in the legislative lifecycle:
- announced: flagged in a budget, press release or policy statement (not yet drafted)
- exposure_draft: draft legislation or regulations released for public consultation
- before_parliament: a bill has been introduced and is progressing through Parliament
- passed_pending_assent: passed both houses, awaiting Royal Assent
- enacted: now law (received assent / registered) but very recent
- abandoned: dropped, lapsed or withdrawn

Rules:
- ONLY include items you can ground in a real source you actually found via search (Treasury, the Federal Register of Legislation, the Parliament of Australia (APH), the ATO, or a reputable report). NEVER invent a measure, a date, or a URL.
- If you are unsure of the stage or whether it is genuine, LOWER the confidence — signal uncertainty rather than omitting the item.
- Exclude settled, unchanging law.
- "stage" MUST be exactly one of the six values above.
- "proposed_effective_from": the date the change is proposed to take effect, as YYYY-MM-DD, or null if unknown.
- "confidence": 0.0–1.0 — how sure you are this is a real, correctly-staged pending measure.

Output JSON ONLY, no prose, in EXACTLY this shape:
{"items":[{"title":"...","summary":"...","topic":"...","stage":"before_parliament","confidence":0.8,"proposed_effective_from":"2025-07-01","source_url":"https://...","source_excerpt":"..."}]}
Return {"items":[]} if you find nothing pending.`;
}

/** One Sonar call → its parsed items array (throws on transport/parse failure). */
async function sonarQuery(sonarKey: string, system: string, user: string): Promise<RawItem[]> {
  const resp = await fetch(SONAR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${sonarKey}` },
    body: JSON.stringify({
      model: SONAR_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.1,
      max_tokens: 4000,
    }),
  });
  if (!resp.ok) throw new Error(`Sonar ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content as string | undefined;
  if (!content) throw new Error("Sonar returned no content");
  const parsed = extractJsonObject(content);
  const items = parsed?.["items"];
  return Array.isArray(items) ? (items as RawItem[]) : [];
}

/**
 * Run the broad pipeline sweep + one query per topic. Sequential (rate-limit safety,
 * matching the house Sonar pattern); a single query's failure is logged and skipped
 * so one bad topic never sinks the whole scan.
 */
async function runScan(sonarKey: string, topics: string[], today: string): Promise<RawItem[]> {
  const system = buildSystemPrompt(today);
  const queries = [
    "Find ALL currently pending or recently announced Australian Federal tax and superannuation law changes across the whole pipeline — budget measures, Treasury announcements, exposure drafts open for consultation, bills before Parliament, and measures passed but awaiting Royal Assent.",
    ...topics.map((t) => `Find pending, announced, or in-progress Australian tax/superannuation changes specifically about: ${t}.`),
  ];
  const out: RawItem[] = [];
  for (const user of queries) {
    try {
      out.push(...(await sonarQuery(sonarKey, system, user)));
    } catch (err) {
      console.error(`[legal-horizon-scan] query failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/**
 * Validate, fingerprint, and within-batch dedupe raw items. Items missing a title or
 * carrying an off-list stage are DROPPED (never coerced). When the same fingerprint
 * appears twice in one batch the highest-confidence sighting wins.
 */
async function normalizeItems(raw: RawItem[]): Promise<{ items: HorizonItem[]; dropped: number }> {
  const byFp = new Map<string, HorizonItem>();
  let dropped = 0;
  for (const r of raw) {
    const title = str(r.title);
    const stageRaw = String(r.stage ?? "");
    if (!title || !(STAGES as readonly string[]).includes(stageRaw)) {
      dropped += 1;
      continue;
    }
    const topic = str(r.topic);
    const eff = typeof r.proposed_effective_from === "string" && DATE_RE.test(r.proposed_effective_from)
      ? r.proposed_effective_from
      : null;
    const fingerprint = await sha256Hex(`${normKey(topic ?? "")}|${normKey(title)}`);
    const item: HorizonItem = {
      title,
      summary: str(r.summary),
      topic,
      stage: stageRaw as Stage,
      confidence: clamp01(Number(r.confidence)),
      proposed_effective_from: eff,
      source_url: str(r.source_url),
      source_excerpt: str(r.source_excerpt),
      fingerprint,
    };
    const prev = byFp.get(fingerprint);
    if (!prev || item.confidence > prev.confidence) byFp.set(fingerprint, item);
  }
  return { items: [...byFp.values()], dropped };
}

/** Mutable columns written on both insert and the idempotent refresh. */
function writableCols(it: HorizonItem): Record<string, unknown> {
  return {
    title: it.title,
    summary: it.summary,
    topic: it.topic,
    stage: it.stage,
    confidence: it.confidence,
    proposed_effective_from: it.proposed_effective_from,
    source_url: it.source_url,
    source_excerpt: it.source_excerpt,
  };
}

/**
 * Upsert open horizon items. For each fingerprint: refresh the existing OPEN row
 * (last_seen_at + mutable fields), skip if it has already reached a terminal state
 * (don't re-open a reconciled/dismissed/superseded measure), else insert a new open
 * row. New rows batch into one insert; refreshes are per-row (distinct values).
 */
async function upsertHorizon(
  admin: SupabaseClient,
  items: HorizonItem[],
): Promise<{ inserted: number; updated: number; skipped: number }> {
  if (items.length === 0) return { inserted: 0, updated: 0, skipped: 0 };

  const fps = items.map((i) => i.fingerprint);
  const { data: existing, error } = await admin
    .from("legal_horizon")
    .select("id, fingerprint, status")
    .is("deleted_at", null)
    .in("fingerprint", fps);
  if (error) throw new Error(`load horizon: ${error.message}`);

  const openByFp = new Map<string, string>(); // fingerprint -> open row id
  const terminalFps = new Set<string>(); // fingerprint with a non-open (terminal) row
  for (const row of (existing ?? []) as { id: string; fingerprint: string; status: string }[]) {
    if (row.status === "open") openByFp.set(row.fingerprint, row.id);
    else terminalFps.add(row.fingerprint);
  }

  const now = new Date().toISOString();
  const toInsert: Record<string, unknown>[] = [];
  const toUpdate: Record<string, unknown>[] = [];
  let skipped = 0;

  for (const it of items) {
    const openId = openByFp.get(it.fingerprint);
    if (openId) {
      // Refresh the existing open row (carry id + fingerprint so the upsert below
      // resolves to a DO UPDATE on the PK rather than a fresh insert).
      toUpdate.push({ id: openId, ...writableCols(it), fingerprint: it.fingerprint, last_seen_at: now });
    } else if (terminalFps.has(it.fingerprint)) {
      // Already reconciled / dismissed / superseded — respect the terminal state.
      skipped += 1;
    } else {
      toInsert.push({ ...writableCols(it), fingerprint: it.fingerprint, status: "open" });
    }
  }

  // One round-trip each. Refreshes batch through a PK upsert (PostgREST has no
  // multi-row update-with-distinct-values primitive); new rows batch-insert.
  let updated = 0;
  if (toUpdate.length > 0) {
    const { error: upErr } = await admin
      .from("legal_horizon")
      .upsert(toUpdate, { onConflict: "id" });
    if (upErr) throw new Error(`update horizon: ${upErr.message}`);
    updated = toUpdate.length;
  }

  let inserted = 0;
  if (toInsert.length > 0) {
    const { error: insErr, count } = await admin
      .from("legal_horizon")
      .insert(toInsert, { count: "exact" });
    if (insErr) throw new Error(`insert horizon: ${insErr.message}`);
    inserted = count ?? toInsert.length;
  }
  return { inserted, updated, skipped };
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  try {
    const supabaseUrl = requireEnv("SUPABASE_URL");
    const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
    const scanSecret = Deno.env.get("LEGAL_SCAN_SECRET");

    // Auth: service-role bearer OR the X-Cron-Secret header (cron/operator). No user-JWT path.
    const givenSecret = presentedCronSecret(req);
    const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const isServiceRole = safeEqual(bearer, serviceKey);
    const secretOk = !!scanSecret && safeEqual(givenSecret ?? "", scanSecret);
    if (!isServiceRole && !secretOk) return json({ ok: false, error: "Unauthorized" }, 401);

    const body = (await req.json().catch(() => ({}))) as RequestBody;
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Source the raw items: operator/test injection (skip Sonar) OR a live scan.
    let raw: RawItem[];
    if (Array.isArray(body.items)) {
      raw = body.items;
    } else {
      const sonarKey = requireEnv("PERPLEXITY_API_KEY");
      const topics = Array.isArray(body.topics) && body.topics.length > 0 ? body.topics : DEFAULT_TOPICS;
      const today = new Date().toISOString().slice(0, 10);
      raw = await runScan(sonarKey, topics, today);
    }

    const { items, dropped } = await normalizeItems(raw);

    if (body.dry_run) {
      return json({ ok: true, dry_run: true, stats: { scanned: items.length, dropped }, items });
    }

    const { inserted, updated, skipped } = await upsertHorizon(admin, items);
    return json({ ok: true, stats: { scanned: items.length, inserted, updated, skipped, dropped } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: msg }, 500);
  }
});
