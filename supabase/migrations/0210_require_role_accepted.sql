-- ============================================================================
-- 0210_require_role_accepted.sql  (P1-14: require_role() accepted_at gate)
--
-- GAP THIS CLOSES: require_role() — the RBAC write check every sensitive RLS
-- policy calls (organizations_update, memberships_insert/update/delete,
-- invitations_insert/update, and downstream callers) — grants the invited role
-- on the mere EXISTENCE of an organization_memberships row with a high enough
-- role_enum, regardless of whether the invite has been ACCEPTED. After SC-1A
-- (0199) a brand-new invitee gets a *pending* membership (accepted_at IS NULL)
-- the moment they are invited; if that pending invite carries e.g. role_enum
-- 'admin', require_role(org, 'admin') would already return TRUE and let them
-- perform admin writes BEFORE accepting. accepted_at is the accept gate (0039
-- added the column and backfilled every existing membership with
-- accepted_at = joined_at, so all already-accepted memberships are non-null;
-- only un-accepted invites are NULL).
--
-- FIX: redefine BOTH require_role() signatures so a membership only satisfies
-- the RBAC check when accepted_at IS NOT NULL — mirroring the gate P0-01 (0203)
-- added to get_accessible_org_ids(). A pending member fails require_role even
-- for their invited role; every accepted role keeps its existing privilege.
--
-- This is a write-side companion to 0203: 0203 stops pending invitees from
-- READING org data; 0210 stops them from WRITING via the role-gated policies.
--
-- The role-ranking comparison, return contract, and overload set are preserved
-- byte-for-byte from 0039 — the ONLY behavioural change is the added
-- `accepted_at IS NOT NULL` predicate. Hardening matches 0039 exactly:
-- LANGUAGE sql, STABLE, SECURITY DEFINER, pinned search_path = public. Both
-- functions are used inside RLS USING/WITH CHECK clauses (evaluated as the
-- calling role), so authenticated + service_role retain EXECUTE — re-asserted
-- defensively below.
--
-- Idempotent: CREATE OR REPLACE + guarded GRANT are all re-runnable.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. require_role(min_role) — any ACCEPTED org membership satisfies.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.require_role(min_role org_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM organization_memberships m
     WHERE m.user_id  = auth.uid()
       AND m.role_enum IS NOT NULL
       -- ACCEPTED ONLY: a pending invite (accepted_at IS NULL) must not
       -- satisfy the RBAC write check, even for its invited role.
       AND m.accepted_at IS NOT NULL
       AND CASE m.role_enum
             WHEN 'owner'      THEN 4
             WHEN 'admin'      THEN 3
             WHEN 'accountant' THEN 2
             WHEN 'employee'   THEN 1
             ELSE 0
           END
           >=
           CASE min_role
             WHEN 'owner'      THEN 4
             WHEN 'admin'      THEN 3
             WHEN 'accountant' THEN 2
             WHEN 'employee'   THEN 1
             ELSE 0
           END
  );
$$;

-- ----------------------------------------------------------------------------
-- 2. require_role(org_id, min_role) — scoped to a specific org, ACCEPTED only.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.require_role(p_org_id uuid, min_role org_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM organization_memberships m
     WHERE m.user_id         = auth.uid()
       AND m.organization_id = p_org_id
       AND m.role_enum       IS NOT NULL
       -- ACCEPTED ONLY: a pending invite (accepted_at IS NULL) must not
       -- satisfy the RBAC write check, even for its invited role.
       AND m.accepted_at     IS NOT NULL
       AND CASE m.role_enum
             WHEN 'owner'      THEN 4
             WHEN 'admin'      THEN 3
             WHEN 'accountant' THEN 2
             WHEN 'employee'   THEN 1
             ELSE 0
           END
           >=
           CASE min_role
             WHEN 'owner'      THEN 4
             WHEN 'admin'      THEN 3
             WHEN 'accountant' THEN 2
             WHEN 'employee'   THEN 1
             ELSE 0
           END
  );
$$;

-- ----------------------------------------------------------------------------
-- 3. Re-assert the pinned search_path and the intended grants. Both functions
--    are DEFINER and used in RLS USING/WITH CHECK clauses → caller role needs
--    EXECUTE. Guarded with to_regprocedure() so a missing signature never
--    aborts the migration on a partial database.
-- ----------------------------------------------------------------------------
DO $harden$
DECLARE
  sigs text[] := ARRAY[
    'public.require_role(org_role)',
    'public.require_role(uuid, org_role)'
  ];
  sig  text;
BEGIN
  FOREACH sig IN ARRAY sigs LOOP
    IF to_regprocedure(sig) IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION %s SET search_path = public;', sig);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role;', sig);
    ELSE
      RAISE NOTICE 'Skipping % (not found in this database)', sig;
    END IF;
  END LOOP;
END
$harden$;

COMMENT ON FUNCTION public.require_role(org_role) IS
  'TRUE when the current caller has at least min_role via an ACCEPTED membership '
  '(accepted_at IS NOT NULL) in ANY organization. Pending invites grant no role. '
  'SECURITY DEFINER, pinned search_path. P1-14 companion to get_accessible_org_ids().';

COMMENT ON FUNCTION public.require_role(uuid, org_role) IS
  'TRUE when the current caller has at least min_role via an ACCEPTED membership '
  '(accepted_at IS NOT NULL) in the given organization. Pending invites grant no '
  'role. SECURITY DEFINER, pinned search_path. P1-14 companion to '
  'get_accessible_org_ids().';

COMMIT;
