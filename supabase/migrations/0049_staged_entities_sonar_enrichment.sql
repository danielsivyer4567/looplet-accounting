-- 0049: Sonar (Perplexity) enrichment columns on staged_entities.
--
-- Why: gmail-classify-ai uses Groq Llama-4 Scout which has no web grounding.
-- For brand-name senders (Anthropic, Cloudflare, MYOB, etc.) Perplexity Sonar
-- can fact-check what the company actually does and produce a much better
-- category prediction with a citation source. Cost ~$0.00005/entity.

ALTER TABLE public.staged_entities
  ADD COLUMN IF NOT EXISTS sonar_summary text,
  ADD COLUMN IF NOT EXISTS sonar_suggested_kind staged_entity_kind,
  ADD COLUMN IF NOT EXISTS sonar_suggested_category text REFERENCES public.intake_categories(code),
  ADD COLUMN IF NOT EXISTS sonar_confidence numeric(3,2),
  ADD COLUMN IF NOT EXISTS sonar_evidence_url text,
  ADD COLUMN IF NOT EXISTS sonar_enriched_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_staged_entities_sonar_pending
  ON public.staged_entities (organization_id)
  WHERE sonar_enriched_at IS NULL AND status IN ('pending', 'needs_review');
