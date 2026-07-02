-- Split out of 20260702170000_extension_schema_and_orphan_function_cleanup.sql
-- 2026-07-02 — see that file's header for why.
--
-- ⚠️ DO NOT APPLY THIS FILE until 20260701140000_universal_search_index.sql
-- has been applied first (creates public.search_index, which both functions
-- below query/write). That migration is written, dry-run-verified, tenant-
-- isolation-proven — but deliberately NOT yet live, because shipping a new
-- cross-entity search feature is a product decision for the owner, not
-- something to bundle silently into an extension-schema/dead-code cleanup
-- pass. Applying this file against a missing search_index table will fail
-- outright (confirmed live 2026-07-02 — this exact error is why the split
-- happened).
--
-- Once the owner greenlights universal search: apply
-- 20260701140000_universal_search_index.sql, then this file, in that order.

BEGIN;

CREATE OR REPLACE FUNCTION public.search_index_set_embedding(
  p_org         uuid,
  p_entity_type text,
  p_entity_id   uuid,
  p_embedding   extensions.vector
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

REVOKE ALL ON FUNCTION public.search_index_set_embedding(uuid, text, uuid, extensions.vector)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_index_set_embedding(uuid, text, uuid, extensions.vector)
  TO service_role;

CREATE OR REPLACE FUNCTION public.search(
  p_org             uuid,
  p_query           text,
  p_limit           int                 DEFAULT 20,
  p_entity_types    text[]              DEFAULT NULL,
  p_query_embedding extensions.vector(1536) DEFAULT NULL
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
SET search_path = public, extensions, pg_temp
AS $$
  WITH q AS (
    SELECT
      websearch_to_tsquery('english', COALESCE(p_query, '')) AS tsq,
      COALESCE(p_query, '')                                  AS raw
  )
  SELECT
    si.entity_type,
    si.entity_id,
    si.title,
    ts_headline(
      'english',
      COALESCE(NULLIF(si.body, ''), COALESCE(si.title, '')),
      q.tsq,
      'MaxFragments=1, MaxWords=18, MinWords=5, StartSel=<mark>, StopSel=</mark>'
    ) AS snippet,
    (
        0.60 * COALESCE(ts_rank_cd(si.tsv, q.tsq), 0)
      + 0.25 * COALESCE(extensions.similarity(COALESCE(si.title, ''), q.raw), 0)
      + 0.15 * CASE
                 WHEN p_query_embedding IS NOT NULL AND si.embedding IS NOT NULL
                 THEN (1 - (si.embedding OPERATOR(extensions.<=>) p_query_embedding))
                 ELSE 0
               END
    )::double precision AS score,
    si.metadata
  FROM public.search_index si, q
  WHERE si.organization_id = p_org
    AND (p_entity_types IS NULL OR si.entity_type = ANY(p_entity_types))
    AND (
      si.tsv @@ q.tsq
      OR (q.raw <> '' AND si.title OPERATOR(extensions.%) q.raw)
      OR (p_query_embedding IS NOT NULL AND si.embedding IS NOT NULL)
    )
  ORDER BY score DESC, si.updated_at DESC
  LIMIT GREATEST(COALESCE(p_limit, 20), 1);
$$;

REVOKE ALL ON FUNCTION public.search(uuid, text, int, text[], extensions.vector)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search(uuid, text, int, text[], extensions.vector)
  TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
