-- 20260701140000_universal_search_index.sql
--
-- UNIVERSAL SEARCH INDEX — the per-tenant, "Everything"-style instant search
-- surface. ONE denormalised, org-scoped table (public.search_index) that the
-- extraction / deferred-enrichment / deep-profile pipeline WRITES into and the
-- copilot + a future search UI READ from via a single hybrid RPC (public.search).
--
-- WHY one table (not per-entity search):
--   * Instant, cross-entity type-ahead ("show me anything matching 'Acme'")
--     needs a single index to scan, not a UNION over every business table.
--   * Hybrid retrieval (lexical tsvector + trigram + semantic pgvector) needs a
--     uniform shape (title/body/embedding) so rank fusion is trivial.
--   * RLS makes the ONE shared index feel private per user — the org predicate
--     (organization_id IN (SELECT get_accessible_org_ids())) is the same tenant
--     isolation invariant used on every business table in this codebase.
--
-- WRITE side: structured entities (bills/invoices/customers/suppliers/jobs) are
--   kept in sync by a resilient AFTER trigger NOW; documents + embeddings are
--   filled ASYNC by the deferred document_enrich job (service_role) via the
--   definer helpers. Indexing must NEVER block a base-table write, so the trigger
--   swallows all errors.
-- READ side: public.search() — lexical-only works standalone; when the edge fn
--   supplies a query embedding, semantic is fused in. Postgres cannot call
--   OpenAI, so the QUERY is embedded in the edge fn and passed INTO the RPC
--   (same contract as match_legal_corpus, 0109).
--
-- Conventions matched: pgvector vector(1536) + `<=>` cosine + HNSW
-- vector_cosine_ops (0108); DEFINER fns pin search_path (0060); service_role-only
-- DEFINER writes REVOKE from PUBLIC/anon/authenticated (0206-style / notify
-- hardening); RLS org predicate uses get_accessible_org_ids() (0086). Fully
-- idempotent (IF NOT EXISTS / CREATE OR REPLACE / guarded DO blocks); no
-- CREATE INDEX CONCURRENTLY so the whole thing is transaction-safe.

BEGIN;

-- (a) Extensions. Already installed on prod (pg_trgm 1.6, vector 0.8.0); kept
--     idempotent so a fresh clone / DR rebuild is self-contained.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- (b) The index table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.search_index (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  entity_type     text NOT NULL,      -- bill|invoice|customer|supplier|job|document|line_item
  entity_id       uuid NOT NULL,      -- PK of the source row (or synthetic id for facts/docs)
  title           text,               -- short, high-signal headline (trigram-indexed)
  body            text,               -- longer searchable text (full-text-indexed)
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- small curated payload for the UI (status, amount, dates…)
  content_sha256  text,               -- change-detection key: enrichment skips re-embedding unchanged content
  -- tsv uses a CONSTANT 'english' config so the expression is IMMUTABLE and thus
  -- valid in a STORED generated column (a regconfig-by-name lookup would not be).
  tsv             tsvector GENERATED ALWAYS AS
                    (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, ''))) STORED,
  -- embedding is NULL until the deferred enrichment job fills it (1536 =
  -- OpenAI text-embedding-3-small, matching legal_corpus so we share the embedder).
  embedding       vector(1536),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- One index row per source entity per tenant; the target of the upsert helper.
  CONSTRAINT search_index_entity_uniq UNIQUE (organization_id, entity_type, entity_id)
);

COMMENT ON TABLE public.search_index IS
  'Per-tenant universal ("Everything"-style) search index. Denormalised title/body/metadata + tsvector (lexical) + optional pgvector embedding (semantic) per business entity. Written by triggers (structured entities) and the deferred document_enrich job (documents + embeddings); read by public.search(). Org-scoped RLS makes the shared index feel private per tenant. Writes go through DEFINER helpers / triggers / service_role only.';

-- ---------------------------------------------------------------------------
-- (c) Indexes.
-- ---------------------------------------------------------------------------
-- Full-text over the generated tsvector (lexical ranking + ts_headline).
CREATE INDEX IF NOT EXISTS search_index_tsv_gin
  ON public.search_index USING gin (tsv);

-- Trigram on the SHORT high-signal title only (substring / type-ahead / fuzzy).
-- Deliberately NOT on body: trigram-indexing long bodies is huge and low-signal.
CREATE INDEX IF NOT EXISTS search_index_title_trgm
  ON public.search_index USING gin (title gin_trgm_ops);

-- Semantic ANN (cosine). Mirrors 0108's opclass; default HNSW build params.
CREATE INDEX IF NOT EXISTS search_index_embedding_hnsw
  ON public.search_index USING hnsw (embedding vector_cosine_ops);

-- Access-path btrees: entity-type filtering, recency scans, and sha lookups
-- (the enrichment job checks content_sha256 to decide whether to re-embed).
CREATE INDEX IF NOT EXISTS search_index_org_type_idx
  ON public.search_index (organization_id, entity_type);
CREATE INDEX IF NOT EXISTS search_index_org_updated_idx
  ON public.search_index (organization_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS search_index_sha_idx
  ON public.search_index (content_sha256);

-- ---------------------------------------------------------------------------
-- (d) RLS: shared table, private-per-tenant reads. No write policy — all writes
--     flow through DEFINER helpers / triggers / service_role.
-- ---------------------------------------------------------------------------
ALTER TABLE public.search_index ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS search_index_org_isolation_select ON public.search_index;
CREATE POLICY search_index_org_isolation_select ON public.search_index
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

-- Only SELECT is granted to authenticated; no INSERT/UPDATE/DELETE grant AND no
-- write policy => authenticated cannot mutate the index directly (defence in
-- depth over the blanket 0001 grants: revoke writes here explicitly).
REVOKE ALL ON public.search_index FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.search_index FROM authenticated;
GRANT SELECT ON public.search_index TO authenticated;

-- ---------------------------------------------------------------------------
-- (e) DEFINER write helpers. service_role-only (enrichment edge fn); triggers
--     run as the definer regardless of caller. Each pins search_path and is
--     REVOKEd from PUBLIC/anon/authenticated then GRANTed to service_role.
-- ---------------------------------------------------------------------------

-- Upsert on the unique key. Bumps updated_at. Deliberately does NOT touch
-- embedding — an upsert of freshly-changed content must not clobber a good
-- embedding; the enrichment job re-embeds and calls search_index_set_embedding.
CREATE OR REPLACE FUNCTION public.search_index_upsert(
  p_org            uuid,
  p_entity_type    text,
  p_entity_id      uuid,
  p_title          text,
  p_body           text,
  p_metadata       jsonb,
  p_content_sha256 text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_org IS NULL OR p_entity_type IS NULL OR p_entity_id IS NULL THEN
    RAISE EXCEPTION 'org, entity_type and entity_id are required'
      USING ERRCODE = '22004';
  END IF;

  INSERT INTO public.search_index
    (organization_id, entity_type, entity_id, title, body, metadata, content_sha256, updated_at)
  VALUES
    (p_org, p_entity_type, p_entity_id, p_title, p_body,
     COALESCE(p_metadata, '{}'::jsonb), p_content_sha256, now())
  ON CONFLICT (organization_id, entity_type, entity_id) DO UPDATE
    SET title          = EXCLUDED.title,
        body           = EXCLUDED.body,
        metadata       = EXCLUDED.metadata,
        content_sha256 = EXCLUDED.content_sha256,
        updated_at     = now()
        -- embedding intentionally NOT updated here.
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Async embedding write from the enrichment job.
CREATE OR REPLACE FUNCTION public.search_index_set_embedding(
  p_org         uuid,
  p_entity_type text,
  p_entity_id   uuid,
  p_embedding   vector
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.search_index
     SET embedding = p_embedding
   WHERE organization_id = p_org
     AND entity_type     = p_entity_type
     AND entity_id       = p_entity_id;
END;
$$;

-- Remove an index row (hard delete / soft-delete of the source entity).
CREATE OR REPLACE FUNCTION public.search_index_remove(
  p_org         uuid,
  p_entity_type text,
  p_entity_id   uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM public.search_index
   WHERE organization_id = p_org
     AND entity_type     = p_entity_type
     AND entity_id       = p_entity_id;
END;
$$;

-- Lock the three write helpers to service_role (the enrichment edge fn). Triggers
-- invoke them as the definer, so end-users never need EXECUTE.
REVOKE ALL ON FUNCTION public.search_index_upsert(uuid, text, uuid, text, text, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_index_upsert(uuid, text, uuid, text, text, jsonb, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.search_index_set_embedding(uuid, text, uuid, vector)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_index_set_embedding(uuid, text, uuid, vector)
  TO service_role;

REVOKE ALL ON FUNCTION public.search_index_remove(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_index_remove(uuid, text, uuid)
  TO service_role;

-- ---------------------------------------------------------------------------
-- (f) Generic sync trigger. Resilient: a failure here must NEVER abort the
--     base-table write (indexing is best-effort), so the whole body is wrapped
--     in EXCEPTION WHEN OTHERS THEN RETURN COALESCE(NEW, OLD).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_index_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row      jsonb;
  v_title    text;
  v_body     text;
  v_meta     jsonb;
  v_kv       record;
  v_soft_del boolean := false;
  -- Keys that are never useful search text: ids, timestamps, embeddings, blobs.
  v_skip     text[] := ARRAY[
    'id','organization_id','created_by','deleted_at','created_at','updated_at',
    'embedding','tsv','raw_extracted','metadata','storage_key','public_token',
    'crm_contact_id','crm_project_id','crm_customer_id',
    -- Sensitive identifiers: never sweep bank details / TFNs into the searchable
    -- body+tsv. They stay org-scoped by RLS regardless, but there is no reason to
    -- make a bank account number or tax file number free-text searchable.
    'payee_bsb','payee_account_number','payee_account_name','bsb','account_number',
    'account_name','bank_account_name','tfn'
  ];
BEGIN
  -- DELETE: drop the index row and finish.
  IF TG_OP = 'DELETE' THEN
    PERFORM public.search_index_remove(OLD.organization_id, TG_TABLE_NAME, OLD.id);
    RETURN OLD;
  END IF;

  v_row := to_jsonb(NEW);

  -- Soft-delete (when the base table has deleted_at): treat as removal.
  IF v_row ? 'deleted_at' AND (v_row->>'deleted_at') IS NOT NULL THEN
    v_soft_del := true;
  END IF;
  IF v_soft_del THEN
    PERFORM public.search_index_remove(NEW.organization_id, TG_TABLE_NAME, NEW.id);
    RETURN NEW;
  END IF;

  -- Human headline per entity type.
  v_title := CASE TG_TABLE_NAME
    WHEN 'bills' THEN
      concat_ws(' · ',
        NULLIF(COALESCE(v_row->>'invoice_number', ''), ''),
        NULLIF(COALESCE(v_row->>'supplier_name_raw', ''), ''))
    WHEN 'invoices' THEN
      concat_ws(' · ',
        'Invoice ' || COALESCE(v_row->>'invoice_number', ''),
        NULLIF(COALESCE(v_row->>'status', ''), ''))
    WHEN 'customers' THEN v_row->>'name'
    WHEN 'suppliers' THEN v_row->>'name'
    WHEN 'jobs' THEN
      concat_ws(' · ',
        NULLIF(COALESCE(v_row->>'job_number', ''), ''),
        NULLIF(COALESCE(v_row->>'name', ''), ''))
    ELSE COALESCE(v_row->>'name', v_row->>'title', TG_TABLE_NAME)
  END;
  v_title := NULLIF(btrim(COALESCE(v_title, '')), '');

  -- Body: concat every text-ish scalar value of the row, skipping the noise keys.
  -- Only string values are included (numbers/uuids/bools rarely help free-text
  -- search and would pollute the tsvector).
  v_body := '';
  FOR v_kv IN SELECT key, value FROM jsonb_each(v_row) LOOP
    IF v_kv.key = ANY(v_skip) THEN CONTINUE; END IF;
    IF jsonb_typeof(v_kv.value) = 'string' THEN
      v_body := v_body || ' ' || (v_kv.value #>> '{}');
    END IF;
  END LOOP;
  v_body := NULLIF(btrim(v_body), '');

  -- Small curated metadata for the result card. entity-specific but tiny.
  v_meta := jsonb_strip_nulls(jsonb_build_object(
    'status',    v_row->'status',
    'amount',    COALESCE(v_row->'total_inc_gst_cents', v_row->'budget_cents'),
    'currency',  v_row->'currency_code',
    'date',      COALESCE(v_row->'invoice_date', v_row->'issue_date', v_row->'start_date'),
    'due_date',  v_row->'due_date',
    'email',     v_row->'email',
    'abn',       v_row->'abn'
  ));

  PERFORM public.search_index_upsert(
    NEW.organization_id,
    TG_TABLE_NAME,
    NEW.id,
    v_title,
    v_body,
    v_meta,
    -- content hash over the searchable text so enrichment can skip re-embedding
    -- when nothing user-visible changed. pgcrypto's digest() lives in the
    -- `extensions` schema on this project, so it is fully qualified (the fn's
    -- search_path is public, pg_temp).
    encode(extensions.digest(COALESCE(v_title, '') || '|' || COALESCE(v_body, ''), 'sha256'), 'hex')
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Best-effort: indexing must never block a bill/invoice/etc. write.
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- search_index_sync calls the service_role-locked helpers; it runs as its own
-- owner (definer), so give it EXECUTE on them. Lock the trigger fn itself down.
REVOKE ALL ON FUNCTION public.search_index_sync() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- (g) Attach the sync trigger to the structured entities. Each guarded so the
--     migration is safe if a table is absent (fresh partial deploy).
-- ---------------------------------------------------------------------------
DO $attach$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bills','invoices','customers','suppliers','jobs'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_search_index ON public.%I;', t, t);
      EXECUTE format(
        'CREATE TRIGGER trg_%s_search_index
           AFTER INSERT OR UPDATE OR DELETE ON public.%I
           FOR EACH ROW EXECUTE FUNCTION public.search_index_sync();', t, t);
    ELSE
      RAISE NOTICE 'search_index: skipping trigger on % (table absent)', t;
    END IF;
  END LOOP;
END
$attach$;

-- ---------------------------------------------------------------------------
-- (h) The read RPC. SECURITY INVOKER + STABLE so base-table RLS applies to the
--     caller (the org predicate below is belt-and-braces; RLS is authoritative).
--     Hybrid rank fusion: lexical (ts_rank_cd) + trigram (title similarity) +
--     optional semantic (cosine). Lexical-only must work when no embedding is
--     supplied, so semantic contributes 0 in that case.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search(
  p_org             uuid,
  p_query           text,
  p_limit           int           DEFAULT 20,
  p_entity_types    text[]        DEFAULT NULL,
  p_query_embedding vector(1536)  DEFAULT NULL
) RETURNS TABLE (
  entity_type text,
  entity_id   uuid,
  title       text,
  snippet     text,
  score       double precision,
  metadata    jsonb
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH q AS (
    SELECT
      websearch_to_tsquery('english', COALESCE(p_query, '')) AS tsq,
      COALESCE(p_query, '')                                   AS raw
  )
  SELECT
    si.entity_type,
    si.entity_id,
    si.title,
    -- ts_headline over body (or title if body empty) for a highlighted snippet.
    ts_headline(
      'english',
      COALESCE(NULLIF(si.body, ''), COALESCE(si.title, '')),
      q.tsq,
      'MaxFragments=1, MaxWords=18, MinWords=5, StartSel=<mark>, StopSel=</mark>'
    ) AS snippet,
    -- Weighted fusion. Lexical (0.6) + trigram title (0.25) + semantic (0.15).
    -- Each term is robust to its input being absent: no tsq match => rank 0;
    -- no embedding => semantic 0. So lexical-only still ranks sensibly.
    (
        0.60 * COALESCE(ts_rank_cd(si.tsv, q.tsq), 0)
      + 0.25 * COALESCE(similarity(COALESCE(si.title, ''), q.raw), 0)
      + 0.15 * CASE
                 WHEN p_query_embedding IS NOT NULL AND si.embedding IS NOT NULL
                 THEN (1 - (si.embedding <=> p_query_embedding))
                 ELSE 0
               END
    )::double precision AS score,
    si.metadata
  FROM public.search_index si, q
  WHERE si.organization_id = p_org
    AND (p_entity_types IS NULL OR si.entity_type = ANY(p_entity_types))
    AND (
      -- keep a row if ANY signal fires (lexical OR fuzzy-title OR semantic).
      si.tsv @@ q.tsq
      OR (q.raw <> '' AND si.title % q.raw)                     -- pg_trgm % operator
      OR (p_query_embedding IS NOT NULL AND si.embedding IS NOT NULL)
    )
  ORDER BY score DESC, si.updated_at DESC
  LIMIT GREATEST(COALESCE(p_limit, 20), 1);
$$;

COMMENT ON FUNCTION public.search(uuid, text, int, text[], vector) IS
  'Hybrid per-tenant search over public.search_index: lexical (tsvector/ts_rank_cd) + fuzzy title (pg_trgm) + optional semantic (pgvector cosine) fused into one score. SECURITY INVOKER so caller RLS applies; the query embedding is computed in the edge fn and passed in (Postgres cannot call OpenAI). Lexical-only works when p_query_embedding is NULL.';

-- Users search; anon cannot.
REVOKE ALL ON FUNCTION public.search(uuid, text, int, text[], vector) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search(uuid, text, int, text[], vector) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- (i) BACKFILL — populate search_index from existing rows once (no embeddings;
--     those are filled later by the document_enrich job). Idempotent one-shot
--     DEFINER fn: re-running it just re-upserts current content. Run manually:
--         SELECT public.search_index_backfill();
--     (Not executed automatically — a full-table scan should be an explicit,
--     off-peak operator action, and prod schema is applied out-of-band anyway.)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_index_backfill()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  t         text;
  v_total   bigint := 0;
  v_count   bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY['bills','invoices','customers','suppliers','jobs'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;

    -- Reuse the exact per-entity derivation by simulating an UPDATE trigger:
    -- a no-op UPDATE fires trg_*_search_index which upserts the row. This keeps
    -- backfill and live-sync logic identical (single source of truth).
    EXECUTE format(
      'UPDATE public.%I SET updated_at = updated_at WHERE deleted_at IS NULL', t
    );
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_total := v_total + v_count;
  END LOOP;

  RETURN v_total;
END;
$$;

REVOKE ALL ON FUNCTION public.search_index_backfill() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_index_backfill() TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
