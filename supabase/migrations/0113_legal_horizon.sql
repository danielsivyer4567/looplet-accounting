-- 0113: legal_horizon — the radar of UPCOMING AU tax changes (the horizon scanner).
--
-- Phase F of the legal-citation / RAG engine. legal_corpus (0108) is enacted law you
-- cite; legal_horizon is what's ABOUT to change — announced measures, exposure drafts,
-- bills before parliament — so the app can plan ahead. The Sonar scanner (SC-LC.F.02)
-- upserts items here every few hours; the reconcile (SC-LC.F.03) flips an item to
-- 'enacted' once a matching corpus version lands, linking reconciled_corpus_id.
--
-- These rows are NEVER a citation source: they are PROPOSED, stage-labelled, and
-- carry a confidence — advice may say "a change is coming (proposed)" but must never
-- present them as settled law. GLOBAL reference data (the legislative pipeline is the
-- same for every tenant): NOT org-scoped, RLS = SELECT-to-authenticated USING(true),
-- writes via the scanner / service_role. Per-org relevance ("does this affect ME?") is
-- computed at READ time by joining the org's profile — never stored here.
--
-- `stage` is a named enum (legal_change_stage) because the reconcile fn (F.03) types
-- against it and flips it; `status` is an inline CHECK (single-table lifecycle flag).

DO $$ BEGIN
  CREATE TYPE public.legal_change_stage AS ENUM (
    'announced',             -- flagged in a budget / press release / policy statement
    'exposure_draft',        -- draft legislation or regulations out for consultation
    'before_parliament',     -- a bill introduced / progressing through parliament
    'passed_pending_assent', -- passed both houses, awaiting Royal Assent
    'enacted',               -- now law (reconciled to a legal_corpus version)
    'abandoned'              -- dropped / lapsed / withdrawn
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.legal_horizon (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title                text NOT NULL,
  summary              text,
  topic                text,                         -- e.g. 'instant asset write-off', 'Division 7A', 'super guarantee'
  stage                legal_change_stage NOT NULL,
  confidence           numeric NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  proposed_effective_from date,                       -- when the change is proposed to take effect (may be null/uncertain)
  source_url           text,
  source_excerpt       text,
  fingerprint          text NOT NULL,                -- stable hash of (topic + normalized title) — dedupe key across scans
  status               text NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open', 'superseded', 'reconciled', 'dismissed')),
  reconciled_corpus_id uuid,                          -- the legal_corpus version that enacted this (NO FK — global, re-seedable)
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES auth.users(id),
  deleted_at           timestamptz
);

-- At most ONE open item per fingerprint → the 3-hourly scan is idempotent (no dup
-- spam). A reconciled/superseded/dismissed item with the same fingerprint may coexist
-- (it's history); only the LIVE open item is unique.
CREATE UNIQUE INDEX IF NOT EXISTS legal_horizon_open_fingerprint_uniq
  ON public.legal_horizon (fingerprint)
  WHERE status = 'open' AND deleted_at IS NULL;

-- The open-items read path: F.03 reconcile scans open items, F.04 renders "upcoming
-- changes" soonest-effective-first.
CREATE INDEX IF NOT EXISTS legal_horizon_open_idx
  ON public.legal_horizon (proposed_effective_from, stage)
  WHERE status = 'open' AND deleted_at IS NULL;

COMMENT ON TABLE public.legal_horizon IS
  'Radar of UPCOMING AU tax changes (announced → exposure_draft → before_parliament → passed_pending_assent → enacted/abandoned), upserted by the Sonar scanner (F.02) and reconciled to legal_corpus by F.03. GLOBAL reference data: SELECT to authenticated, writes via the scanner/service_role. NEVER a citation source — stage-labelled, confidence-scored PROPOSALS, not settled law.';

DROP TRIGGER IF EXISTS trg_legal_horizon_updated_at ON public.legal_horizon;
CREATE TRIGGER trg_legal_horizon_updated_at
  BEFORE UPDATE ON public.legal_horizon
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- GLOBAL RLS: everyone reads the horizon; writes are backend-only (scanner/service_role).
ALTER TABLE public.legal_horizon ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS legal_horizon_select ON public.legal_horizon;
CREATE POLICY legal_horizon_select ON public.legal_horizon
  FOR SELECT TO authenticated
  USING (true);
GRANT SELECT ON public.legal_horizon TO authenticated;

NOTIFY pgrst, 'reload schema';
