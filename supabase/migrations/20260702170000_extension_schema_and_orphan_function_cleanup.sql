-- Move pg_trgm/pgvector out of public and remove known orphaned legacy
-- product-credit functions. This is intentionally late and idempotent: existing
-- table/index/function dependencies keep their object OIDs (ALTER EXTENSION
-- SET SCHEMA doesn't change type/operator OIDs, so already-built GIN/ivfflat
-- indexes are unaffected — confirmed live 2026-07-02), while the affected
-- search RPCs are redefined with extension-qualified operators/functions so
-- runtime resolution does not depend on public-schema extension objects.
--
-- APPLIED LIVE 2026-07-02 (core only, via direct SQL — supabase db push was
-- blocked by pre-existing multi-lane migration-history drift, see
-- [[migration-history-drift]] memory). Verified: pg_trgm + vector both show
-- extensions.* in pg_extension; match_job_for_bill() returns a real
-- similarity-scored row using extensions.similarity(); check_rate_limit/
-- deduct_credits confirmed dropped (count=0); advisor re-scan confirms
-- extension_in_public fully cleared.
--
-- SPLIT NOTE: the original version of this file also defined public.search()
-- and public.search_index_set_embedding(), which query/write public.search_index
-- — a table built and dry-run-verified by 20260701140000_universal_search_index.sql
-- but never actually applied live (a deliberate, still-open product decision,
-- not a bug). Applying those two functions here would have failed against a
-- missing table, and silently going live with a brand-new search feature isn't
-- something to bundle into an extension-schema cleanup pass. Moved to
-- 20260702171500_search_index_functions.sql, which must be applied together
-- with (after) 20260701140000_universal_search_index.sql once that feature is
-- greenlit — see that file for the explicit dependency note.

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

COMMIT;

NOTIFY pgrst, 'reload schema';
