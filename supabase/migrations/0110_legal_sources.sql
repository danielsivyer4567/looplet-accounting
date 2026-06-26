-- 0110: legal_sources — registry of the AU tax-law sources the auto-updater polls.
--
-- Phase E of the legal-citation / RAG engine. Drives the corpus-sync's "what to
-- poll + when": each row is an instrument (or feed) to re-fetch on a cadence; the
-- sync (SC-LC.E.03) re-chunks/re-embeds it, version-bumps changed sections in
-- legal_corpus (0108), and stamps last_checked_at / last_version_ref here.
--
-- GLOBAL REFERENCE DATA — the sources are the same for every tenant, so this is
-- NOT org-scoped: RLS is SELECT-to-authenticated USING(true) (everyone may read
-- the registry); all writes go through service_role / the sync edge fn. No
-- organization_id and therefore no audit_log_trigger_v2 (matches legal_corpus 0108
-- and the intake_categories global-table shape).
--
-- LICENSING: Federal Register of Legislation (legislation.gov.au) content is
-- published under CC-BY 4.0 — free to reuse with attribution — so the corpus may
-- ingest and re-serve the Acts below. ATO public rulings are likewise reusable.
--
-- canonical_url is the FRL landing page for the instrument; SC-LC.E.03 resolves
-- the current in-force COMPILATION (whose date anchors effective_from) from it.

CREATE TABLE IF NOT EXISTS public.legal_sources (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,                 -- the instrument / feed, e.g. 'Income Tax Assessment Act 1997'
  kind             text NOT NULL CHECK (kind IN ('act', 'ato_ruling', 'rate_page', 'case')),
  canonical_url    text NOT NULL,                 -- FRL / ATO landing page the sync resolves the current version from
  check_method     text NOT NULL CHECK (check_method IN ('frl_api', 'ato_feed', 'scrape')),
  check_frequency  interval NOT NULL DEFAULT '7 days',  -- how often to poll; a source is due when last_checked_at + this <= now()
  last_checked_at  timestamptz,                   -- NULL = never polled yet (always due)
  last_version_ref text,                          -- opaque change-detection cursor; per-source format (FRL: compilation no.; ATO: feed cursor)
  is_active        boolean NOT NULL DEFAULT true,  -- operator pause switch (suspend polling) — distinct from deleted_at (permanent removal); the E.03 due-scan uses `WHERE is_active AND deleted_at IS NULL`
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES auth.users(id),
  deleted_at       timestamptz
);

-- One live registry row per source name (also makes the seed re-runnable).
CREATE UNIQUE INDEX IF NOT EXISTS legal_sources_name_uniq
  ON public.legal_sources (name)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE public.legal_sources IS
  'Registry of AU tax-law sources the auto-updater (legal-corpus-sync, SC-LC.E.03) polls. GLOBAL reference data (not org-scoped): SELECT to authenticated, writes via backend. check_frequency + last_checked_at drive the due-source scan; FRL content is CC-BY.';

DROP TRIGGER IF EXISTS trg_legal_sources_updated_at ON public.legal_sources;
CREATE TRIGGER trg_legal_sources_updated_at
  BEFORE UPDATE ON public.legal_sources
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- GLOBAL RLS: everyone reads the registry; writes are backend-only (service_role).
ALTER TABLE public.legal_sources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS legal_sources_select ON public.legal_sources;
CREATE POLICY legal_sources_select ON public.legal_sources
  FOR SELECT TO authenticated
  USING (true);
GRANT SELECT ON public.legal_sources TO authenticated;

-- Seed the core corpus: the five Acts + GST Act on FRL (weekly), and the ATO legal
-- database feed for rulings/determinations (daily). ON CONFLICT keeps the seed
-- idempotent if the migration is replayed. canonical_url = FRL/ATO landing page;
-- the exact in-force compilation endpoint is E.03's job to resolve.
INSERT INTO public.legal_sources (name, kind, canonical_url, check_method, check_frequency)
VALUES
  ('Income Tax Assessment Act 1997',                       'act', 'https://www.legislation.gov.au/C2004A05138', 'frl_api', '7 days'),
  ('Income Tax Assessment Act 1936',                       'act', 'https://www.legislation.gov.au/C1936A00027', 'frl_api', '7 days'),
  ('A New Tax System (Goods and Services Tax) Act 1999',   'act', 'https://www.legislation.gov.au/C2004A00446', 'frl_api', '7 days'),
  ('Taxation Administration Act 1953',                     'act', 'https://www.legislation.gov.au/C2004A07377', 'frl_api', '7 days'),
  ('Fringe Benefits Tax Assessment Act 1986',              'act', 'https://www.legislation.gov.au/C2004A03280', 'frl_api', '7 days'),
  ('Superannuation Industry (Supervision) Act 1993',       'act', 'https://www.legislation.gov.au/C2004A04633', 'frl_api', '7 days'),
  ('ATO Legal Database (rulings & determinations)', 'ato_ruling', 'https://www.ato.gov.au/law/',                 'ato_feed', '1 day')
ON CONFLICT (name) WHERE deleted_at IS NULL DO NOTHING;  -- arbiter = the partial-unique index above; replay-safe

NOTIFY pgrst, 'reload schema';
