-- Move pg_trgm/pgvector out of public and remove known orphaned legacy
-- product-credit functions. This is intentionally late and idempotent: existing
-- table/index/function dependencies keep their object OIDs, while the affected
-- search RPCs are redefined with extension-qualified operators/functions so
-- runtime resolution does not depend on public-schema extension objects.

BEGIN;

CREATE SCHEMA IF NOT EXISTS extensions;
GRANT USAGE ON SCHEMA extensions TO authenticated, service_role;

DO $$
DECLARE
  v_schema text;
BEGIN
  SELECT n.nspname
    INTO v_schema
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'pg_trgm';

  IF v_schema IS NULL THEN
    CREATE EXTENSION pg_trgm WITH SCHEMA extensions;
  ELSIF v_schema <> 'extensions' THEN
    ALTER EXTENSION pg_trgm SET SCHEMA extensions;
  END IF;

  SELECT n.nspname
    INTO v_schema
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'vector';

  IF v_schema IS NULL THEN
    CREATE EXTENSION vector WITH SCHEMA extensions;
  ELSIF v_schema <> 'extensions' THEN
    ALTER EXTENSION vector SET SCHEMA extensions;
  END IF;
END $$;

-- These signatures are not defined by the source migrations. They were
-- inherited live drift from an older product surface and reference tables this
-- app does not own. No CASCADE: if anything depends on them, stop the migration.
DROP FUNCTION IF EXISTS public.check_rate_limit(text, integer, integer);
DROP FUNCTION IF EXISTS public.deduct_credits(uuid, integer);

CREATE OR REPLACE FUNCTION public.match_job_for_bill(
  p_org_id uuid,
  p_job_ref text
) RETURNS TABLE(matched_job_id uuid, score real, job_number text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $func$
  SELECT
    j.id,
    GREATEST(
      CASE WHEN UPPER(j.job_number) = UPPER(p_job_ref) THEN 1.0 ELSE 0.0 END,
      CASE WHEN regexp_replace(UPPER(j.job_number), '[\s-]', '', 'g')
              = regexp_replace(UPPER(p_job_ref),    '[\s-]', '', 'g')
           THEN 0.99 ELSE 0.0 END,
      extensions.similarity(j.job_number, p_job_ref)
    )::real AS score,
    j.job_number
  FROM public.jobs j
  WHERE j.organization_id = p_org_id
    AND j.deleted_at IS NULL
    AND j.status IN ('draft', 'active', 'paused')
    AND p_job_ref IS NOT NULL
    AND length(trim(p_job_ref)) > 0
  ORDER BY score DESC, j.created_at DESC
  LIMIT 5;
$func$;

GRANT EXECUTE ON FUNCTION public.match_job_for_bill(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.match_legal_corpus(
  p_query_embedding extensions.vector(1536),
  p_fy              int  DEFAULT NULL,
  p_top_k           int  DEFAULT 8,
  p_section_ref     text DEFAULT NULL,
  p_query_text      text DEFAULT NULL
) RETURNS TABLE (
  chunk_id       uuid,
  doc_ref        text,
  section_ref    text,
  heading        text,
  text           text,
  citation_url   text,
  effective_from date,
  effective_to   date,
  similarity     real
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT
    lc.id,
    lc.doc_ref,
    lc.section_ref,
    lc.heading,
    lc.text,
    lc.citation_url,
    lc.effective_from,
    lc.effective_to,
    (1 - (lc.embedding OPERATOR(extensions.<=>) p_query_embedding))::real AS similarity
  FROM public.legal_corpus lc
  WHERE lc.deleted_at IS NULL
    AND lc.embedding IS NOT NULL
    AND (p_section_ref IS NULL OR lc.section_ref = p_section_ref)
    AND (p_query_text  IS NULL OR lc.tsv @@ websearch_to_tsquery('english', p_query_text))
    AND CASE
          WHEN p_fy IS NULL THEN lc.effective_to IS NULL
          ELSE lc.effective_from <= make_date(p_fy, 6, 30)
               AND (lc.effective_to IS NULL OR lc.effective_to > make_date(p_fy - 1, 7, 1))
        END
  ORDER BY lc.embedding OPERATOR(extensions.<=>) p_query_embedding
  LIMIT LEAST(GREATEST(p_top_k, 1), 50);
$$;

REVOKE ALL ON FUNCTION public.match_legal_corpus(extensions.vector, int, int, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_legal_corpus(extensions.vector, int, int, text, text)
  TO authenticated, service_role;

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
