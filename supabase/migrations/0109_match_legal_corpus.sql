-- 0109: match_legal_corpus() — FY-scoped hybrid retrieval over the legal corpus.
--
-- Phase B of the legal-citation / RAG engine. THE retrieval primitive the advisor /
-- ask-bot call to ground answers in cited law. Semantic cosine ranking over the
-- pgvector embeddings, with optional exact-section pin, optional keyword (full-text)
-- filter, and — critically — FY scoping so it returns "the law as it applied in
-- year X", not just the latest. Embedding the QUERY is the caller's job (the edge
-- fns embed); this RPC takes a ready vector.
--
-- FY semantics (AU FY ends 30 June; FY2024 = 1 Jul 2023 .. 30 Jun 2024):
--   * p_fy NULL  -> current law (effective_to IS NULL).
--   * p_fy = Y   -> versions in force at any point during FY Y:
--                   effective_from <= 30-Jun-Y AND (effective_to IS NULL OR
--                   effective_to > 1-Jul-(Y-1)).  (Getting effective_from right —
--                   application vs commencement date — is the ingest's job.)
--
-- p_query_text is a HARD keyword filter (a tsv veto, not a rank blend) — when given,
-- only rows matching the keyword survive, then semantic distance ranks them.
-- Returns the effective dates too, so a citation can honestly state which VERSION
-- of the section it's quoting. STABLE SECURITY DEFINER + pinned search_path=public
-- (vector type + `<=>` live in public on this project); legal_corpus is world-
-- readable to authenticated, so DEFINER just guarantees a consistent answer.
--
-- NOTE: a function-level `SET hnsw.ef_search = 100` (a recall tweak — HNSW finds
-- candidates THEN the WHERE filters them, so a selective FY/section/keyword filter can
-- under-return < k at the default ef_search of 40) was REMOVED: the managed Supabase
-- migration role lacks permission to pin that GUC in a function (`permission denied to
-- set parameter "hnsw.ef_search"`). The fn is correct on the default ef_search; if a
-- heavily-filtered query under-returns once the corpus is large, raise ef_search per
-- session/role (`SET hnsw.ef_search = 100`) from the caller rather than in the fn.

CREATE OR REPLACE FUNCTION public.match_legal_corpus(
  p_query_embedding vector(1536),
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
SET search_path = public
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
    (1 - (lc.embedding <=> p_query_embedding))::real AS similarity
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
  ORDER BY lc.embedding <=> p_query_embedding
  LIMIT LEAST(GREATEST(p_top_k, 1), 50);
$$;

-- 0060 hardening: no implicit PUBLIC execute. Granted to authenticated (future UI)
-- and service_role (the ask-bot / advisor edge fns call it via the admin client).
REVOKE ALL ON FUNCTION public.match_legal_corpus(vector, int, int, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_legal_corpus(vector, int, int, text, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
