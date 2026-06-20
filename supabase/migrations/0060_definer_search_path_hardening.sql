-- ============================================================================
-- Migration: 0060_definer_search_path_hardening
-- Project:   Looplet Accounting  (EPIC E — make it trustworthy)
-- Purpose:   Harden SECURITY DEFINER functions in the `public` schema that
--            LACK a pinned search_path.
--
--   A SECURITY DEFINER function runs with the privileges of its OWNER, not the
--   caller. If its search_path is mutable (inherited from the caller), an
--   attacker can create same-named objects in a schema earlier on the path and
--   have the definer execute attacker-controlled code with elevated rights
--   (a classic "search_path" privilege-escalation, flagged by Supabase's
--   `function_search_path_mutable` security advisor).
--
--   Mitigation (Supabase / Postgres best practice):
--     1. Pin `SET search_path = ''` so every object reference must be fully
--        schema-qualified — no schema is consulted implicitly.
--     2. REVOKE EXECUTE ... FROM PUBLIC so only intended roles can invoke them.
--
--   SCOPE: A repo-wide grep of supabase/migrations confirms every other
--   SECURITY DEFINER function (require_role, notify, reconcile_*,
--   audit_log_trigger_v2, bills_autolink_supplier, payroll_finalise_pay_run,
--   run_data_completeness_scan, close_idle_accountant_sessions) was already
--   created WITH `SET search_path = public`, i.e. an explicit pinned path that
--   is NOT inherited from the caller — so they are already protected against
--   the escalation vector. The only two definer functions that LACK any
--   search_path clause are:
--
--       public.get_accessible_org_ids()   (migration 0001 ~L132)
--       public.is_agency_user()           (migration 0001 ~L161)
--
--   Both reference public objects UNQUALIFIED in their bodies, so we cannot
--   simply `ALTER FUNCTION ... SET search_path = ''` (that would make
--   `organization_memberships` / `organizations` unresolvable at runtime and
--   break every RLS policy that calls them). We therefore CREATE OR REPLACE
--   them with identical logic but fully schema-qualified references, plus the
--   pinned empty search_path. These two functions are heavily used inside RLS
--   `USING` clauses — preserving their exact result set is essential.
--
--   Idempotent: CREATE OR REPLACE, ALTER ... SET, and REVOKE are all re-runnable.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. get_accessible_org_ids() — schema-qualified body + pinned search_path.
--    Logic is byte-for-byte equivalent to 0001; only object refs are qualified
--    (public.* for tables, auth.uid() for the caller). The enum literals stay
--    bare strings (compared against text columns).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_accessible_org_ids()
RETURNS SETOF uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RETURN;
  END IF;

  -- Direct memberships
  RETURN QUERY
    SELECT m.organization_id
      FROM public.organization_memberships m
     WHERE m.user_id = v_user_id;

  -- Sub-accounts of agencies the user admins
  RETURN QUERY
    SELECT sa.id
      FROM public.organizations sa
      JOIN public.organizations agency
        ON sa.parent_organization_id = agency.id
      JOIN public.organization_memberships m
        ON m.organization_id = agency.id
     WHERE agency.organization_type = 'agency'
       AND sa.organization_type    = 'sub_account'
       AND m.user_id                = v_user_id
       AND m.role IN ('owner', 'admin');
END;
$$;

-- ----------------------------------------------------------------------------
-- 2. is_agency_user() — schema-qualified body + pinned search_path.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_agency_user()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1
      FROM public.organization_memberships m
      JOIN public.organizations o ON o.id = m.organization_id
     WHERE m.user_id = auth.uid()
       AND o.organization_type = 'agency'
       AND m.role IN ('owner', 'admin')
  );
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. Belt-and-braces: re-assert the pinned empty search_path on both, and
--    revoke EXECUTE from PUBLIC. Wrapped in to_regprocedure() guards so the
--    migration never aborts if a signature is unexpectedly absent.
-- ----------------------------------------------------------------------------
DO $harden$
DECLARE
  sig text;
  sigs text[] := ARRAY[
    'public.get_accessible_org_ids()',
    'public.is_agency_user()'
  ];
BEGIN
  FOREACH sig IN ARRAY sigs LOOP
    IF to_regprocedure(sig) IS NOT NULL THEN
      EXECUTE format('ALTER FUNCTION %s SET search_path = '''';', sig);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC;', sig);
      -- Re-assert the intended grants. Both functions are referenced inside RLS
      -- USING clauses, which Postgres evaluates as the *calling* role, so the
      -- authenticated/service_role roles MUST retain EXECUTE (originally granted
      -- en masse by migration 0001 L789). Revoking only the implicit PUBLIC
      -- grant leaves these explicit grants intact; we re-state them defensively.
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role;', sig);
    ELSE
      RAISE NOTICE 'Skipping % (not found in this database)', sig;
    END IF;
  END LOOP;
END
$harden$;

COMMIT;
