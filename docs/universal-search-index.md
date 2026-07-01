# Universal Search Index

The per-tenant, "Everything"-style instant search surface. One denormalised,
org-scoped table (`public.search_index`) that the extraction / deferred-enrichment
/ deep-profile pipeline **writes** into and the copilot + a future search UI
**read** from through a single hybrid RPC (`public.search`).

Migration: `supabase/migrations/20260701140000_universal_search_index.sql`.

## Why one shared table (not per-entity search)

Instant, cross-entity type-ahead ("show me anything matching *Acme*") needs a
single thing to scan, not a `UNION` over every business table with a different
shape. Collapsing bills / invoices / customers / suppliers / jobs / documents /
facts into one uniform `(title, body, metadata, tsv, embedding)` row means:

- **type-ahead + fuzzy** comes from one trigram index on `title`;
- **keyword ranking** comes from one GIN index on the generated `tsv`;
- **semantic** comes from one HNSW index on `embedding`;
- **rank fusion** is a trivial weighted sum of three comparable signals.

RLS turns the one shared table into something that *feels private per tenant*:
the SELECT policy is `organization_id IN (SELECT get_accessible_org_ids())` — the
exact tenant-isolation predicate used on every business table in this codebase.
Tenant isolation is the #1 invariant, and it is enforced here identically.

## Hybrid retrieval (lexical + semantic, fused)

`public.search(p_org, p_query, p_limit, p_entity_types, p_query_embedding)`:

- **Lexical** — `websearch_to_tsquery('english', …)` matched against the STORED
  generated `tsv`, ranked by `ts_rank_cd`. Weight 0.60.
- **Fuzzy title** — `pg_trgm` `similarity(title, query)` / the `%` operator, so
  substrings and typos on the short high-signal title still hit. Weight 0.25.
- **Semantic** — cosine `1 - (embedding <=> query_embedding)`, contributed ONLY
  when a query embedding is supplied *and* the row has an embedding. Weight 0.15.

The fusion is robust to either side being absent. A row survives if **any** signal
fires (`tsv @@ tsq` OR fuzzy-title OR — when an embedding is present on both sides
— semantic). **Lexical-only works standalone** (`p_query_embedding = NULL`), which
is the common path; semantic is layered on when the edge fn has embedded the
query. A `ts_headline` snippet with `<mark>` highlights is returned for the UI.

Postgres cannot call OpenAI, so — exactly like `match_legal_corpus` (0109) — the
**query is embedded in the edge function** (`embedTexts()` in
`supabase/functions/_shared/ocr/openai.ts`, `text-embedding-3-small`, 1536-dim,
matching `legal_corpus`) and the ready vector is passed *into* the RPC.

## Write side

- **Structured entities, now** — a resilient generic `AFTER INSERT OR UPDATE OR
  DELETE` trigger (`search_index_sync`) on bills, invoices, customers, suppliers
  and jobs derives a human `title`, a `body` (all text-ish scalars of the row,
  minus ids/timestamps/blobs), a small curated `metadata`, and a `content_sha256`,
  then calls the `search_index_upsert` DEFINER helper. **It never blocks the base
  write**: the whole body is wrapped in `EXCEPTION WHEN OTHERS THEN RETURN
  COALESCE(NEW, OLD)`, so a broken index can never fail a bill/invoice insert.
  DELETE and soft-delete (`deleted_at IS NOT NULL`) remove the index row.
- **Documents + embeddings, deferred** — the `document_enrich` job (service_role)
  fills `body`/`embedding` for documents and back-fills embeddings for structured
  rows via `search_index_set_embedding`. `content_sha256` lets it skip re-embedding
  unchanged content. `search_index_upsert` deliberately **does not touch
  `embedding`**, so a content refresh never clobbers a good vector.
- **Deep-profile facts** — synthesised facts land as their own `entity_type` rows
  through the same `search_index_upsert` path.

All three write helpers are `SECURITY DEFINER`, pin `search_path`, and are
`REVOKE`d from `PUBLIC, anon, authenticated` then `GRANT`ed to `service_role`
only — end users can never mutate the index directly. There is **no write RLS
policy** and no write grant to `authenticated`; writes flow exclusively through
these helpers / triggers / service_role.

## Read side

`public.search` is `SECURITY INVOKER` + `STABLE` so base-table RLS applies to the
caller (the `organization_id = p_org` filter is belt-and-braces; RLS is
authoritative). Granted to `authenticated` + `service_role`; revoked from `anon`.
Consumers: the copilot (grounding retrieval) and the search UI (instant palette).

## Backfill

`search_index_backfill()` (DEFINER, service_role) is a one-shot to populate the
index from existing rows without embeddings. It issues a no-op `UPDATE` per table
so the live sync trigger produces each row — backfill and live-sync share one
derivation, no drift. Run manually off-peak: `SELECT public.search_index_backfill();`.

## How it ties to the automation spine

`search_index` is the **read surface the automation pipeline feeds**. The
extraction / enrichment / deep-profile stages are the producers; the copilot and
search UI are the consumers. It is the "what do we know about this tenant, right
now, searchably" layer the rest of the spine writes toward.

## When to graduate to Meilisearch / Typesense

Not yet. Postgres (`tsvector` + `pg_trgm` + `pgvector`/HNSW) comfortably covers
instant search at current scale with zero extra infrastructure, one consistency
domain, and RLS-enforced isolation for free. Graduate to a dedicated engine only
when you *outgrow Postgres* — e.g. millions of rows per tenant with sub-50ms
type-ahead SLAs, heavy typo-tolerant faceting, or ranking tuning that outstrips
`ts_rank_cd`. At that point `search_index` becomes the source of truth you stream
into the external index; the `search()` RPC contract stays the seam so callers
don't change.
