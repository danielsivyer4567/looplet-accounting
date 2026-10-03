-- ============================================================================
-- 20261003153000_known_senders_org_scoped.sql  (SEED-01)
--
-- intake_known_senders was a global table and 0015 seeded it with the pilot
-- business's 723 known senders (a snapshot of Affordable Fencing Gold Coast's
-- own classifications: its customers, its suppliers, which shops it treats as
-- personal). lookup_known_sender() read every row for every organisation, so
-- each new tenant's Gmail intake was classified with the pilot's data, and
-- any signed-in user could read the pilot's list (SELECT policy USING (true)).
--
-- Now:
--   * intake_known_senders.organization_id says whose list a row belongs to.
--   * lookup_known_sender(p_email, p_org) matches only that organisation's
--     rows. Rows with no organisation are never used, so new organisations
--     inherit nothing. Called without p_org it returns no row.
--   * Members can read only their own organisations' rows.
--   * The pilot keeps its rows: when the pilot organisation exists in this
--     database (production), every row without an organisation (the 0015 seed
--     and anything added before this migration, when the pilot was the only
--     tenant) is assigned to it. Nothing is deleted. Where the pilot does not
--     exist (fresh or test databases) the seed rows stay unowned and unused;
--     claim_unowned_known_senders() can assign them later.
--   * Uniqueness is per organisation.
--
-- The pilot id is the one recorded in docs/runbook-spine-activation-afgc-2026-07.md
-- and docs/handover-live-proof-2026-07-02.md ("Affordable Fencing Gold Coast").
-- 0015's ON CONFLICT target is the old global index, so 0015 cannot be re-run
-- after this migration; it is only ever applied once, in order.
-- ============================================================================

BEGIN;

ALTER TABLE public.intake_known_senders
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE;

COMMENT ON COLUMN public.intake_known_senders.organization_id IS
  'Organisation whose known-sender list this row belongs to. Rows without one are not '
  'used by lookup_known_sender (no tenant inherits another tenant''s classifications).';

DROP INDEX IF EXISTS public.idx_known_senders_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_known_senders_org_unique
  ON public.intake_known_senders (
    COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    domain,
    COALESCE(sender_pattern, ''::text)
  );
CREATE INDEX IF NOT EXISTS idx_known_senders_org_domain
  ON public.intake_known_senders (organization_id, domain)
  WHERE organization_id IS NOT NULL;

-- Members read only their own organisations' lists.
DROP POLICY IF EXISTS known_senders_select ON public.intake_known_senders;
CREATE POLICY known_senders_select ON public.intake_known_senders
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

-- Assign rows that have no organisation to one organisation. Service role only.
CREATE OR REPLACE FUNCTION public.claim_unowned_known_senders(p_org uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_org IS NULL OR NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = p_org) THEN
    RAISE EXCEPTION 'organization % does not exist', p_org
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  UPDATE public.intake_known_senders
     SET organization_id = p_org
   WHERE organization_id IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.claim_unowned_known_senders(uuid) IS
  'Assigns every known-sender row without an organisation to p_org and returns the '
  'count. Used once for the pilot business whose list 0015 seeded. Service role only.';

REVOKE ALL ON FUNCTION public.claim_unowned_known_senders(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_unowned_known_senders(uuid) TO service_role;

DO $$
DECLARE
  v_pilot constant uuid := '9d5c9b9a-a576-458d-913a-fa822d33320d';
  v_count integer;
BEGIN
  IF EXISTS (SELECT 1 FROM public.organizations WHERE id = v_pilot) THEN
    v_count := public.claim_unowned_known_senders(v_pilot);
    RAISE NOTICE 'SEED-01: assigned % known senders to the pilot organisation', v_count;
  ELSE
    RAISE NOTICE 'SEED-01: pilot organisation not present; % unowned known senders left unused',
      (SELECT count(*) FROM public.intake_known_senders WHERE organization_id IS NULL);
  END IF;
END $$;

-- Org-scoped lookup. The old one-argument signature is replaced; p_org has a
-- default so a caller that has not been updated gets no match instead of an error.
DROP FUNCTION IF EXISTS public.lookup_known_sender(text);

CREATE OR REPLACE FUNCTION public.lookup_known_sender(p_email text, p_org uuid DEFAULT NULL)
RETURNS TABLE(domain text, brand_name text, parent_brand text, kind public.staged_entity_kind, category_code text,
              arm text, is_marketing boolean, confidence numeric, match_specificity integer)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $function$
  WITH RECURSIVE
    parts AS (
      SELECT
        LOWER(p_email) AS email,
        LOWER(split_part(p_email, '@', 2)) AS full_domain
    ),
    candidates AS (
      SELECT full_domain AS d, 0 AS depth FROM parts
      UNION ALL
      SELECT
        substring(d FROM position('.' IN d) + 1) AS d,
        depth + 1
      FROM candidates
      WHERE position('.' IN d) > 0 AND depth < 5
    )
  SELECT s.domain, s.brand_name, s.parent_brand, s.kind, s.category_code,
         s.arm, s.is_marketing, s.confidence, c.depth
  FROM candidates c
  JOIN intake_known_senders s ON s.domain = c.d
  WHERE s.organization_id = p_org
    AND (s.sender_pattern IS NULL
         OR (SELECT email FROM parts) ~ s.sender_pattern)
  ORDER BY c.depth ASC, s.confidence DESC
  LIMIT 1;
$function$;

COMMENT ON FUNCTION public.lookup_known_sender(text, uuid) IS
  'Best known-sender match for an email address in one organisation''s list (most specific '
  'domain first). Rows without an organisation are never matched. SECURITY INVOKER.';

REVOKE ALL ON FUNCTION public.lookup_known_sender(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lookup_known_sender(text, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
