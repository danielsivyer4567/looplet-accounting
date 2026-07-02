-- ============================================================================
-- 0203_accepted_membership_access.sql  (P0-01: pending-membership access gate)
--
-- GAP THIS CLOSES: get_accessible_org_ids() — the helper every tenant RLS policy
-- calls — grants access on the mere EXISTENCE of an organization_memberships row,
-- regardless of whether the user has accepted. After SC-1A (0199) a brand-new
-- invitee gets a *pending* membership (accepted_at IS NULL) created the moment
-- they are invited; they then see (and can read) the org's data BEFORE they have
-- accepted the invite. accepted_at is the accept gate (0039 added the column and
-- backfilled existing memberships with accepted_at = joined_at, so every already-
-- accepted membership is non-null; only un-accepted invites are NULL).
--
-- FIX: redefine get_accessible_org_ids() so a membership only grants access when
-- accepted_at IS NOT NULL. This applies to BOTH branches that read memberships:
--   * the caller's own direct memberships, and
--   * the agency-admin → sub-account expansion (the admin's membership on the
--     agency must itself be accepted to inherit the sub-accounts).
-- ALL accepted memberships keep access regardless of role — including
-- role_enum = 'accountant' (an accepted accountant still sees their client orgs).
--
-- INTEGRATION TOKENS ARE UNTOUCHED: machine tokens carry an organization_id JWT
-- claim and no auth.uid()/membership row (see 0069). That branch is preserved
-- byte-for-byte — it returns the single pinned org and never reads memberships,
-- so accepted_at does not apply to it.
--
-- DEFINER hardening matches 0069/0060: SECURITY DEFINER, STABLE, pinned
-- search_path = pg_catalog, public, schema-qualified refs. The function is used
-- inside RLS USING clauses (evaluated as the calling role), so authenticated +
-- service_role must retain EXECUTE — re-asserted defensively below.
--
-- Idempotent: CREATE OR REPLACE + guarded REVOKE/GRANT are all re-runnable.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_accessible_org_ids() RETURNS SETOF uuid
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user_id     uuid := auth.uid();
  v_integration uuid := public.integration_org_id();
BEGIN
  -- Integration token: scope strictly to the single pinned org. These tokens
  -- have no auth.uid(); they must NEVER inherit a human's broader access.
  -- (Unchanged from 0069; no membership row is involved, so accepted_at N/A.)
  IF v_user_id IS NULL AND v_integration IS NOT NULL THEN
    RETURN NEXT v_integration;
    RETURN;
  END IF;

  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  -- Direct memberships — ACCEPTED ONLY. A pending invite (accepted_at IS NULL)
  -- must not grant any access to the org's data.
  RETURN QUERY
    SELECT m.organization_id
      FROM public.organization_memberships m
     WHERE m.user_id     = v_user_id
       AND m.accepted_at IS NOT NULL;

  -- Sub-accounts of agencies the user admins — the admin's membership on the
  -- agency must itself be ACCEPTED to inherit the agency's sub-accounts.
  RETURN QUERY
    SELECT sa.id
      FROM public.organizations sa
      JOIN public.organizations agency
        ON sa.parent_organization_id = agency.id
      JOIN public.organization_memberships m
        ON m.organization_id = agency.id
     WHERE agency.organization_type = 'agency'
       AND sa.organization_type     = 'sub_account'
       AND m.user_id                = v_user_id
       AND m.accepted_at            IS NOT NULL
       AND m.role IN ('owner', 'admin');
END;
$$;

-- Re-assert the pinned search_path and the intended grants (DEFINER fn used in
-- RLS USING clauses → caller role needs EXECUTE). Revoke the implicit PUBLIC
-- grant; keep authenticated + service_role. Guarded so a missing signature
-- never aborts the migration.
DO $harden$
DECLARE
  sig text := 'public.get_accessible_org_ids()';
BEGIN
  IF to_regprocedure(sig) IS NOT NULL THEN
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public;', sig);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC;', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role;', sig);
  ELSE
    RAISE NOTICE 'Skipping % (not found in this database)', sig;
  END IF;
END
$harden$;

COMMENT ON FUNCTION public.get_accessible_org_ids() IS
  'Returns every organization id the current caller can access. Human sessions: '
  'orgs where the caller has an ACCEPTED membership (accepted_at IS NOT NULL), '
  'plus sub-accounts of any agency they admin via an accepted membership. Pending '
  'invites (accepted_at IS NULL) grant NO access. Integration tokens return only '
  'the single pinned organization_id claim. SECURITY DEFINER, pinned search_path.';

COMMIT;
