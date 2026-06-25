-- 0108: Legal corpus — the versioned, section-anchored RAG store for AU tax law.
--
-- Foundation of the legal-citation / RAG engine. One row per (instrument, section,
-- effective-date version) of the law, with a pgvector embedding for semantic search,
-- a tsvector for keyword/exact lookup, and the effective-date range that makes
-- "the law as it applied in FY X" a WHERE clause. Advice retrieves over this and
-- cites it (NotebookLM-style click-to-the-line).
--
-- GLOBAL REFERENCE DATA — the law is the same for every tenant, so this is NOT
-- org-scoped: RLS is SELECT-to-authenticated USING(true) (everyone reads the law);
-- all writes go through service_role / DEFINER backend fns (ingest SC-LC.C.02,
-- sync SC-LC.E.03). There is deliberately NO organization_id and therefore NO
-- audit_log_trigger_v2 (that trigger reads organization_id and would fail) — the
-- append-only effective-date versioning IS the change history.
--
-- pgvector lives in `public` on this project (v0.8.0); vector(1536) + the `<=>`
-- cosine operator + HNSW `vector_cosine_ops` all resolve under search_path=public.
-- 1536 dims = OpenAI text-embedding-3-small (the chosen model; fixing the model
-- later means a re-embed + ALTER).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS public.legal_corpus (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source          text NOT NULL,        -- registry source name (FK-by-convention to legal_sources, SC-LC.E.01)
  doc_ref         text NOT NULL,        -- the instrument, e.g. 'ITAA 1997'
  section_ref     text NOT NULL,        -- the pinpoint, e.g. 's 328-180' — the citation anchor
  heading         text,
  text            text NOT NULL,
  embedding       vector(1536),         -- nullable until the ingest embeds it
  embedding_model text,                 -- model that produced `embedding` (e.g. 'text-embedding-3-small');
                                        -- lets a same-dim model swap re-embed incrementally instead of all-at-once
  tsv             tsvector GENERATED ALWAYS AS
                    (to_tsvector('english', coalesce(heading, '') || ' ' || coalesce(text, ''))) STORED,
  effective_from  date NOT NULL,        -- when this version commenced
  effective_to    date,                 -- NULL = currently in force
  content_hash    text NOT NULL,        -- sha256 of text: dedup + change-detection key (SC-LC.E.03)
  citation_url    text,                 -- deep link to the source (FRL / ATO)
  citation_anchor text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES auth.users(id),
  deleted_at      timestamptz
);

-- One live version per (instrument, section, commencement date).
CREATE UNIQUE INDEX IF NOT EXISTS legal_corpus_version_uniq
  ON public.legal_corpus (doc_ref, section_ref, effective_from)
  WHERE deleted_at IS NULL;

-- Semantic search (cosine), keyword search, and exact section/FY lookup.
CREATE INDEX IF NOT EXISTS legal_corpus_embedding_hnsw
  ON public.legal_corpus USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS legal_corpus_tsv_gin
  ON public.legal_corpus USING gin (tsv);
CREATE INDEX IF NOT EXISTS legal_corpus_section_idx
  ON public.legal_corpus (section_ref, effective_from);

COMMENT ON TABLE public.legal_corpus IS
  'Versioned, section-anchored AU tax-law corpus for cited RAG. GLOBAL reference data (not org-scoped): SELECT to authenticated, writes via backend. effective_from/effective_to give the law as it applied in a given year; content_hash drives change-detection; embedding/tsv power hybrid retrieval (match_legal_corpus, SC-LC.B.01).';

DROP TRIGGER IF EXISTS trg_legal_corpus_updated_at ON public.legal_corpus;
CREATE TRIGGER trg_legal_corpus_updated_at
  BEFORE UPDATE ON public.legal_corpus
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- GLOBAL RLS: everyone reads the law; writes are backend-only (service_role).
ALTER TABLE public.legal_corpus ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS legal_corpus_select ON public.legal_corpus;
CREATE POLICY legal_corpus_select ON public.legal_corpus
  FOR SELECT TO authenticated
  USING (true);
GRANT SELECT ON public.legal_corpus TO authenticated;

NOTIFY pgrst, 'reload schema';
