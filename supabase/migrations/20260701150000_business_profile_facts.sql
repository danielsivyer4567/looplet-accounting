-- 20260701150000_business_profile_facts.sql
--
-- BUSINESS PROFILE FACTS — the granular, evidence-backed layer BENEATH the single
-- public.business_profile row (0051). Where business_profile holds ONE curated row
-- of structured tax context per org, this table holds MANY reviewable, atomic facts
-- the deep-profile engine extracts from the connected mailbox: pricing policies,
-- pipeline stats, verbatim operating rules, operational patterns, customer types,
-- supplier/contact roster, service routes, and — critically — the "gaps" the
-- extractor could NOT determine ("ASK DANIEL"). See docs/deep-profile-engine.md.
--
-- Conventions matched (identical to the search index, 0060, 0206):
--   * Every business table: organization_id uuid NOT NULL + id uuid PK.
--   * RLS org predicate: organization_id IN (SELECT public.get_accessible_org_ids()).
--   * SECURITY DEFINER writes pin `SET search_path = public, pg_temp`, are REVOKEd
--     from PUBLIC/anon/authenticated, and GRANTed only to service_role.
--   * User-facing read RPCs are SECURITY INVOKER so caller RLS is authoritative.
--   * Fully idempotent (IF NOT EXISTS / CREATE OR REPLACE / guarded); no
--     CONCURRENTLY so the whole file is one transaction.
--
-- SINGLE WRITE PATH: facts are inserted ONLY through business_profile_fact_upsert()
-- (service_role, from the extractor edge fn), which ALSO mirrors the fact into
-- public.search_index via search_index_upsert() so every fact is instantly
-- searchable by the copilot/advisor. authenticated may only SELECT and UPDATE the
-- review lifecycle (status) — the guardrail is that the engine READS + PREPARES
-- drafts; a human confirms/dismisses.

BEGIN;

-- ---------------------------------------------------------------------------
-- (a) The facts table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.business_profile_facts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- The taxonomy. A CHECK (not an enum) so adding a category later is a cheap
  -- ALTER, not a type migration. Kept in sync with docs/deep-profile-engine.md.
  fact_type       text NOT NULL CHECK (fact_type IN (
    'pricing',        -- cost curves, material costs, pricing POLICY, deposit terms
    'pipeline',       -- quotes accepted/declined/active, win-rate, repeat/best clients
    'rule',           -- VERBATIM operating rules ("never give price breakdowns")
    'pattern',        -- operational rhythms (enquiry->inspection same-day, seasonal)
    'customer_type',  -- categorised client profiles + typical job value/terms
    'supplier',       -- supplier / carrier / subbie roster + roles
    'contact',        -- named individuals + their role
    'service_route',  -- where issues get routed (warranty -> aftercare partner)
    'gap'             -- known unknowns: needs_human=true, the honest "ASK DANIEL"
  )),

  subject         text,                                  -- the thing the fact is about: 'payment_terms', 'Jackson Ryan', 'deposit_policy'
  summary         text NOT NULL,                         -- one-line human statement of the fact
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,    -- structured payload (numbers, quotes, per-type breakdown)
  confidence      numeric(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  needs_human     boolean NOT NULL DEFAULT false,        -- the "ASK DANIEL" flag: gaps + low-confidence facts
  evidence        jsonb NOT NULL DEFAULT '[]'::jsonb,    -- source refs: [{gmail_message_id, quote_no, snippet}]
  source          text,                                  -- extractor / run id (e.g. 'profile-extract:<run_uuid>')
  status          text NOT NULL DEFAULT 'draft'          -- human review lifecycle
                    CHECK (status IN ('draft','confirmed','dismissed')),
  content_sha256  text,                                  -- change-detection over subject+summary+detail; re-runs skip unchanged
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- Natural upsert key: one fact per (org, type, subject) so re-runs UPDATE the
  -- existing fact (refreshing evidence/confidence) instead of duplicating it.
  -- subject is part of the key, so it must never be NULL for an upsertable fact;
  -- the helper coerces NULL subject to '' (see below) to keep the key stable and
  -- avoid the "NULLs are distinct in a UNIQUE" trap that would let dupes through.
  CONSTRAINT business_profile_facts_natural_uniq UNIQUE (organization_id, fact_type, subject)
);

COMMENT ON TABLE public.business_profile_facts IS
  'Granular, evidence-backed facts the deep-profile engine extracts from the connected mailbox (pricing/pipeline/rule/pattern/customer_type/supplier/contact/service_route/gap). The atomic layer beneath the single business_profile row (0051). Facts are DRAFTS: extracted by service_role via business_profile_fact_upsert (which mirrors them into search_index), confirmed/dismissed by a human (authenticated UPDATE of status only). Read+prepare guardrail — the engine never acts.';

COMMENT ON COLUMN public.business_profile_facts.needs_human IS
  'ASK DANIEL flag. true for fact_type=gap and any fact the extractor was not confident about — surfaces in the review queue so the profile is honest about what it does not know.';

-- ---------------------------------------------------------------------------
-- (b) Indexes. The three access paths the review UI + rollup use.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS business_profile_facts_org_type_idx
  ON public.business_profile_facts (organization_id, fact_type);

-- Partial index: the "ASK DANIEL" review queue is a hot, small subset.
CREATE INDEX IF NOT EXISTS business_profile_facts_needs_human_idx
  ON public.business_profile_facts (organization_id, needs_human)
  WHERE needs_human;

CREATE INDEX IF NOT EXISTS business_profile_facts_org_status_idx
  ON public.business_profile_facts (organization_id, status);

-- ---------------------------------------------------------------------------
-- (c) updated_at trigger (reuse the shared helper used by business_profile, 0051).
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_business_profile_facts_updated ON public.business_profile_facts;
CREATE TRIGGER trg_business_profile_facts_updated
  BEFORE UPDATE ON public.business_profile_facts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- (d) RLS. SELECT + a NARROW UPDATE (status only) for org members; NO insert /
--     delete for authenticated (those flow through the definer helper /
--     service_role). Mirrors the search_index defence-in-depth: revoke the
--     blanket write grants explicitly, grant back only what the review UI needs.
-- ---------------------------------------------------------------------------
ALTER TABLE public.business_profile_facts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS business_profile_facts_select ON public.business_profile_facts;
CREATE POLICY business_profile_facts_select ON public.business_profile_facts
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

-- UPDATE is for the human confirm/dismiss action. RLS cannot restrict WHICH
-- columns change, so we allow the UPDATE (scoped to the caller's org on both the
-- USING old-row and WITH CHECK new-row so the org cannot be re-parented) and rely
-- on the column-level grant below to limit it to `status`.
DROP POLICY IF EXISTS business_profile_facts_update ON public.business_profile_facts;
CREATE POLICY business_profile_facts_update ON public.business_profile_facts
  FOR UPDATE TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()))
  WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));

-- Defence in depth over the blanket 0001 grants: strip everything from anon, and
-- from authenticated strip INSERT/DELETE + all UPDATE, then grant back SELECT and
-- a COLUMN-LEVEL UPDATE on `status` only. So a member can flip
-- draft->confirmed/dismissed but cannot rewrite summary/detail/confidence/evidence
-- (those are the extractor's, immutable to end users).
REVOKE ALL ON public.business_profile_facts FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.business_profile_facts FROM authenticated;
GRANT SELECT ON public.business_profile_facts TO authenticated;
GRANT UPDATE (status) ON public.business_profile_facts TO authenticated;

-- ---------------------------------------------------------------------------
-- (e) DEFINER upsert helper — the ONLY insert path. Upserts a fact AND mirrors
--     it into search_index (single write path => facts are always searchable).
--     service_role only (the profile-extract edge fn).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_profile_fact_upsert(
  p_org         uuid,
  p_fact_type   text,
  p_subject     text,
  p_summary     text,
  p_detail      jsonb   DEFAULT '{}'::jsonb,
  p_confidence  numeric DEFAULT NULL,
  p_needs_human boolean DEFAULT NULL,   -- NULL => derive from fact_type/confidence
  p_evidence    jsonb   DEFAULT '[]'::jsonb,
  p_source      text    DEFAULT NULL,
  p_status      text    DEFAULT NULL    -- NULL => keep existing on update / 'draft' on insert
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id          uuid;
  v_status      text;   -- effective post-upsert status (so the search card matches the fact row)
  v_subject     text := COALESCE(p_subject, '');   -- keep the unique key stable (NULLs are distinct)
  v_detail      jsonb := COALESCE(p_detail, '{}'::jsonb);
  v_evidence    jsonb := COALESCE(p_evidence, '[]'::jsonb);
  v_needs_human boolean;
  v_sha         text;
  v_body        text;
BEGIN
  IF p_org IS NULL OR p_fact_type IS NULL OR p_summary IS NULL THEN
    RAISE EXCEPTION 'org, fact_type and summary are required'
      USING ERRCODE = '22004';
  END IF;

  -- Derive the ASK-DANIEL flag if the caller left it NULL: always true for gaps,
  -- true for any low-confidence (<0.5) non-gap fact.
  v_needs_human := COALESCE(
    p_needs_human,
    p_fact_type = 'gap' OR (p_confidence IS NOT NULL AND p_confidence < 0.5)
  );

  -- Change-detection hash over the semantically meaningful fields. The extractor
  -- can compare this against the stored value to decide whether a re-run needs to
  -- touch the row at all (cheap re-runs). digest() lives in the `extensions`
  -- schema on this project (same as search_index_sync).
  v_sha := encode(
    extensions.digest(
      v_subject || '|' || p_summary || '|' || v_detail::text, 'sha256'
    ), 'hex'
  );

  INSERT INTO public.business_profile_facts AS f
    (organization_id, fact_type, subject, summary, detail, confidence,
     needs_human, evidence, source, status, content_sha256)
  VALUES
    (p_org, p_fact_type, v_subject, p_summary, v_detail, p_confidence,
     v_needs_human, v_evidence, p_source, COALESCE(p_status, 'draft'), v_sha)
  ON CONFLICT (organization_id, fact_type, subject) DO UPDATE
    SET summary        = EXCLUDED.summary,
        detail         = EXCLUDED.detail,
        confidence     = EXCLUDED.confidence,
        needs_human    = EXCLUDED.needs_human,
        evidence       = EXCLUDED.evidence,
        source         = EXCLUDED.source,
        content_sha256 = EXCLUDED.content_sha256,
        -- Preserve a human's review decision across re-extraction: only take the
        -- caller's status when they explicitly passed one; otherwise keep the
        -- existing status so a re-run does NOT reset a confirmed/dismissed fact
        -- back to draft.
        status         = COALESCE(p_status, f.status),
        updated_at     = now()
  RETURNING f.id, f.status INTO v_id, v_status;

  -- Mirror into the universal search index so the copilot/advisor can retrieve
  -- this fact. Body is summary + a flattened detail so semantic + lexical search
  -- both hit. Title is subject (falls back to summary). metadata is the small
  -- curated payload the search UI shows on the result card.
  v_body := p_summary
    || CASE WHEN v_detail <> '{}'::jsonb THEN E'\n' || v_detail::text ELSE '' END;

  PERFORM public.search_index_upsert(
    p_org,
    'profile_fact',
    v_id,
    NULLIF(v_subject, ''),   -- title: prefer subject, NULL if blank (search fn falls back to body)
    v_body,
    jsonb_build_object(
      'fact_type',   p_fact_type,
      'confidence',  p_confidence,
      'needs_human', v_needs_human,
      'status',      v_status,   -- effective status (preserves a human confirm/dismiss across extractor re-runs)
      'summary',     p_summary
    ),
    v_sha
  );

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.business_profile_fact_upsert(uuid, text, text, text, jsonb, numeric, boolean, jsonb, text, text) IS
  'Single write path for business_profile_facts. Upserts on (org, fact_type, subject), derives needs_human when NULL, preserves a human status decision on re-extraction, and mirrors the fact into public.search_index (entity_type=profile_fact) so it is instantly searchable. service_role only (profile-extract edge fn).';

REVOKE ALL ON FUNCTION public.business_profile_fact_upsert(uuid, text, text, text, jsonb, numeric, boolean, jsonb, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.business_profile_fact_upsert(uuid, text, text, text, jsonb, numeric, boolean, jsonb, text, text)
  TO service_role;

-- ---------------------------------------------------------------------------
-- (f) Keep search_index in sync on the human review lifecycle + on delete.
--     The upsert helper already covers extractor writes; this trigger catches
--     the OTHER two mutation paths: (1) an authenticated status UPDATE, so the
--     search card's metadata.status stays current; (2) a DELETE (or org cascade),
--     so the fact leaves the index. Resilient: NEVER abort the base write.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_profile_facts_search_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_body text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.search_index_remove(OLD.organization_id, 'profile_fact', OLD.id);
    RETURN OLD;
  END IF;

  -- Re-mirror the current row. Reuses the same title/body/metadata shape as the
  -- upsert helper so the two write paths produce identical index rows.
  v_body := NEW.summary
    || CASE WHEN NEW.detail <> '{}'::jsonb THEN E'\n' || NEW.detail::text ELSE '' END;

  PERFORM public.search_index_upsert(
    NEW.organization_id,
    'profile_fact',
    NEW.id,
    NULLIF(COALESCE(NEW.subject, ''), ''),
    v_body,
    jsonb_build_object(
      'fact_type',   NEW.fact_type,
      'confidence',  NEW.confidence,
      'needs_human', NEW.needs_human,
      'status',      NEW.status,
      'summary',     NEW.summary
    ),
    NEW.content_sha256
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Best-effort: keeping the index in sync must never block a confirm/dismiss.
  RETURN COALESCE(NEW, OLD);
END;
$$;

REVOKE ALL ON FUNCTION public.business_profile_facts_search_sync() FROM PUBLIC, anon, authenticated;

-- Only UPDATE + DELETE: INSERTs come exclusively through the upsert helper which
-- already mirrors to search_index (attaching to INSERT too would double-write).
DROP TRIGGER IF EXISTS trg_business_profile_facts_search_sync ON public.business_profile_facts;
CREATE TRIGGER trg_business_profile_facts_search_sync
  AFTER UPDATE OR DELETE ON public.business_profile_facts
  FOR EACH ROW EXECUTE FUNCTION public.business_profile_facts_search_sync();

-- ---------------------------------------------------------------------------
-- (g) Convenience read RPC for the profile UI. SECURITY INVOKER so base-table
--     RLS applies to the caller (the org predicate is belt-and-braces).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.business_profile_facts_for(
  p_org       uuid,
  p_fact_type text DEFAULT NULL
) RETURNS SETOF public.business_profile_facts
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT *
    FROM public.business_profile_facts
   WHERE organization_id = p_org
     AND organization_id IN (SELECT public.get_accessible_org_ids())
     AND (p_fact_type IS NULL OR fact_type = p_fact_type)
   ORDER BY needs_human DESC, fact_type, updated_at DESC;
$$;

COMMENT ON FUNCTION public.business_profile_facts_for(uuid, text) IS
  'Profile UI read RPC: facts for an org, optionally filtered by fact_type, ASK-DANIEL (needs_human) first. SECURITY INVOKER — caller RLS is authoritative.';

REVOKE ALL ON FUNCTION public.business_profile_facts_for(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.business_profile_facts_for(uuid, text) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
