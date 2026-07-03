# Deep-Profile Engine

**Status:** foundation landed (schema + write path); extraction pass is a spec (needs live Gmail).
**Guardrail:** READ + PREPARE only. The engine extracts *reviewable drafts* and flags what it
cannot determine. It never quotes, replies, prices, or acts. Same autonomy boundary as the rest
of the platform.

## What this is

`gmail-mine` already clusters *who* an org talks to (counterparties → `staged_entities`). The
deep-profile engine answers the next question: **what does this business actually do, and how does
it operate?** It reads the connected mailbox and distils atomic, evidence-backed *facts* — the
kind Daniel produced by hand from the AFGC (Australian Fencing & Gate Co) inbox: pricing policy,
win-rate, verbatim rules ("never give price breakdowns"), operational rhythms, customer types,
the supplier/subbie roster, service routes, and an honest list of things it could not figure out.

Those facts land in `public.business_profile_facts` (migration `20260701150000`) as **drafts**, are
mirrored into the universal `search_index` so the copilot/advisor can retrieve them, and roll up
into the single `public.business_profile` row (0051). A human confirms or dismisses each one.

```
mailbox ──► profile-extract (edge fn, per-category LLM pass)
              │  upserts via business_profile_fact_upsert (service_role)
              ▼
       business_profile_facts (drafts)  ──trigger/helper──►  search_index (entity_type='profile_fact')
              │                                                     │
        human confirm/dismiss (status)                      copilot / advisor retrieval
              │
              ▼
        business_profile roll-up (single curated row)
```

## The fact taxonomy

Each fact is one row. `fact_type` is CHECK-constrained to these nine values; keep this list and the
migration's CHECK in sync.

| fact_type       | What it captures                                                                 | `subject` (upsert key part) example | `detail` payload shape |
|-----------------|---------------------------------------------------------------------------------|-------------------------------------|------------------------|
| `pricing`       | Subcontractor cost curves, material costs, pricing **policy**, deposit terms.    | `deposit_policy`, `colorbond_per_m` | `{ policy, unit, amount_cents, tiers[] }` |
| `pipeline`      | Quotes accepted/declined/active, win-rate, repeat/best clients, version counts.  | `win_rate`, `best_client`           | `{ quotes_sent, accepted, declined, win_rate_pct, top_clients[] }` |
| `rule`          | **Verbatim** operating rules.                                                    | `no_price_breakdowns`, `terms_7day` | `{ quote, source_message_id }` |
| `pattern`       | Operational rhythms (enquiry→inspection same-day, order-by-Wed→Mon delivery).    | `enquiry_to_inspection`             | `{ pattern, cadence, seasonality }` |
| `customer_type` | Categorised client profiles + typical job value/terms.                          | `residential_homeowner`             | `{ typical_job_value_cents, terms, notes }` |
| `supplier`      | Supplier / carrier / subbie roster + their role.                                | `Premier Gates`, `subbie_roster`    | `{ role, products[], typical_lead_time }` |
| `contact`       | Named individuals + their role.                                                  | `Jackson Ryan`                      | `{ role, org, email }` |
| `service_route` | Where issues get routed.                                                         | `gate_warranty`                     | `{ trigger, route_to, channel }` |
| `gap`           | Known unknowns — **needs_human=true, the honest "ASK DANIEL".**                  | `asbestos_policy`                   | `{ question, why_unknown }` |

`needs_human` is auto-derived in `business_profile_fact_upsert` when the caller leaves it NULL:
always `true` for `gap`, and `true` for any non-gap fact with `confidence < 0.5`.

## Extraction flow — `profile-extract` edge fn

A new async edge fn (mirrors `gmail-mine`'s paging/auth; extends rather than duplicates its
helpers). One invocation processes one batch and returns a `next_page_token` for resumption.

1. **Auth + access.** Same as `gmail-mine`: load the integration via the **caller-scoped** client
   (RLS-gate the org — never load by id via service_role alone; see the edge-fn caller authz memo),
   then `loadAndRefreshGmail(admin, integration_id)` for the token.
2. **Page the mailbox** in batches (`after:YYYY/MM/DD in:inbox` + `in:sent`, `maxResults<=100`),
   pulling `format=full` so bodies are available for the LLM. Reuse `extractBodyText` /
   `stripHtml` from `gmail-mine`.
3. **Per-category LLM extraction.** For each `fact_type`, run one extraction pass over the batch's
   message texts with a category-specific JSON schema (`response_format: json_object`, same client
   plumbing as `_shared/ocr/openai.ts`). Splitting per category keeps each prompt focused and the
   output schema small/verifiable. Each returned fact carries `{subject, summary, detail,
   confidence, evidence:[{gmail_message_id, snippet}]}`.
4. **Gap detection.** The category prompts are instructed to emit a `gap` fact whenever the answer
   is not determinable from the corpus ("could not find asbestos-removal policy in any thread").
   These become `needs_human=true` rows.
5. **Upsert.** Each fact → `business_profile_fact_upsert(...)` (service_role). The helper computes
   `content_sha256` over subject+summary+detail; the extractor can read the existing sha first and
   **skip the write when unchanged**, so re-runs are cheap. Upsert is on `(org, fact_type, subject)`
   so a re-run *refreshes* a fact (new evidence/confidence) rather than duplicating it, and it
   **preserves a human's confirmed/dismissed status** across re-extraction.
6. **Embeddings.** Postgres cannot call OpenAI. After upserting, the fn computes embeddings for the
   fact bodies with `embedTexts()` (1536-dim, text-embedding-3-small) and writes them via
   `search_index_set_embedding(org, 'profile_fact', fact_id, vector)` — same async pattern as
   `document_enrich`.

## Idle / deferred integration

Running an LLM pass per category over months of mail is heavy, so it is **deferred**, not inline:

- A new `automation_jobs` job kind **`profile_extract`** (job_kind is free-text — no CHECK — so no
  schema change is needed). Enqueue via the existing `enqueue_automation_job(...)` RPC with
  `p_source_kind='gmail_integration'`, `p_source_id=<integration_id>`, a low priority, and a
  `p_run_after` set to an off-peak window.
- `automation-worker` drains it by claiming `profile_extract` jobs and invoking `profile-extract`
  for one page, re-enqueuing the next page (with the `page_token` in the payload) until the mailbox
  is exhausted — the same batch-and-resume shape `gmail-backfill` uses.
- **Dependency:** this only runs when the worker cron (map node **B1**) is ON. The automation
  backbone is currently code-complete but not live on prod (see the "automation-backbone-not-live"
  memo), so treat this slice as **[blocked-on-deploy]** for live execution; the schema + helpers
  here are inert until then.

## How it feeds search + the profile roll-up

- **Search index:** every fact is mirrored into `public.search_index` with `entity_type='profile_fact'`,
  `title=subject`, `body=summary+detail`, `metadata={fact_type,confidence,needs_human,status,summary}`.
  This is guaranteed by the **single write path**: the upsert helper mirrors on insert/refresh, and a
  resilient AFTER UPDATE/DELETE trigger (`business_profile_facts_search_sync`) keeps the card's
  `metadata.status` current on human confirm/dismiss and removes the row on delete. The copilot/advisor
  retrieves facts through `public.search(...)` exactly like any other entity — lexical works standalone,
  semantic fuses in once the embedding lands.
- **business_profile roll-up:** a periodic roll-up reads **confirmed** facts and folds the structured
  ones into the single `business_profile` row / `v_business_context` view the /ask bot reads
  (e.g. `pricing:deposit_policy` → a notes/policy field, `rule` facts → the notes scratchpad,
  supplier/subbie counts → `subbies_count`). Facts remain the granular evidence layer; the profile
  row remains the one curated summary. Roll-up only ever consumes `status='confirmed'` facts — drafts
  never leak into the bot's context.

## Guardrail

Facts are **drafts**. `authenticated` can only `SELECT` and `UPDATE (status)` — a member flips
`draft → confirmed | dismissed`, but cannot rewrite `summary/detail/confidence/evidence` (those are
the extractor's, column-grant-locked). No `INSERT`/`DELETE` for users; inserts flow only through the
service_role definer helper. The engine reads and prepares; a human decides.

## Worked example — the AFGC dossier

Four facts as they would land from the AFGC inbox (one per shape, incl. a gap):

**1. `rule` — verbatim operating rule**
```json
{
  "fact_type": "rule",
  "subject": "no_price_breakdowns",
  "summary": "Never give itemised price breakdowns — quote the job total only, never per-metre.",
  "detail": { "quote": "we don't break it down, it's a job price", "policy": "job_total_only" },
  "confidence": 0.92,
  "needs_human": false,
  "evidence": [{ "gmail_message_id": "18e2...", "snippet": "just give them the total, we never itemise" }],
  "status": "draft"
}
```

**2. `pricing` — deposit policy**
```json
{
  "fact_type": "pricing",
  "subject": "deposit_policy",
  "summary": "50% deposit on acceptance, balance on completion; 7-day terms (not 14).",
  "detail": { "deposit_pct": 50, "balance_trigger": "completion", "terms_days": 7 },
  "confidence": 0.81,
  "needs_human": false,
  "evidence": [{ "gmail_message_id": "18d9...", "quote_no": "Q-1043" }],
  "status": "draft"
}
```

**3. `service_route` — warranty routing**
```json
{
  "fact_type": "service_route",
  "subject": "gate_warranty",
  "summary": "Automatic-gate warranty issues route to Premier Gates aftercare, not handled in-house.",
  "detail": { "trigger": "gate motor / warranty", "route_to": "Premier Gates", "channel": "aftercare@premiergates.example" },
  "confidence": 0.74,
  "needs_human": false,
  "evidence": [{ "gmail_message_id": "1902...", "snippet": "send them to Premier for the motor warranty" }],
  "status": "draft"
}
```

**4. `gap` — ASK DANIEL**
```json
{
  "fact_type": "gap",
  "subject": "asbestos_policy",
  "summary": "Could not determine the policy on asbestos removal — no thread mentions it.",
  "detail": { "question": "Do you take on jobs requiring asbestos removal, or decline/refer them?", "why_unknown": "no evidence in the scanned corpus" },
  "confidence": null,
  "needs_human": true,
  "evidence": [],
  "status": "draft"
}
```

The `gap` row is the point: the profile is honest about what it doesn't know, and surfaces it in the
`needs_human` review queue instead of guessing.
