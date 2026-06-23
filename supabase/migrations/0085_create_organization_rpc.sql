-- ============================================================================
-- 0085_create_organization_rpc.sql
--
-- FIX: brand-new users could not create their FIRST organization, so self-serve
-- signup dead-ended at "No organisation selected".
--
-- Root cause: OrgContext.createOrganization() did two client-side inserts under
-- the user's JWT. The organizations insert was allowed (organizations_insert is
-- WITH CHECK (true)) but the organization_memberships insert was rejected by RLS:
-- memberships_insert (replaced in 0039) requires
--   organization_id IN (SELECT get_accessible_org_ids())
--   AND require_role(organization_id, 'admin')
-- A first-time user has no membership in the just-created org, so both conditions
-- are false → INSERT rejected → org row orphaned, user locked out.
--
-- This RPC runs as SECURITY DEFINER (function owner bypasses RLS), so it can
-- atomically create the org AND the owner membership in one transaction. It sets
-- BOTH role ('owner') and role_enum ('owner') so every role-gated action works
-- (require_role keys off role_enum, which the old client insert never set).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_organization_with_owner(p_name TEXT)
RETURNS SETOF public.organizations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org     public.organizations;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  IF p_name IS NULL OR length(btrim(p_name)) < 2 THEN
    RAISE EXCEPTION 'organization name must be at least 2 characters'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.organizations (name, organization_type, created_by)
  VALUES (btrim(p_name), 'standard', v_user_id)
  RETURNING * INTO v_org;

  INSERT INTO public.organization_memberships
    (user_id, organization_id, role, role_enum, is_default, accepted_at)
  VALUES
    (v_user_id, v_org.id, 'owner', 'owner', TRUE, now());

  RETURN NEXT v_org;
END;
$$;

-- Only signed-in users may bootstrap an org; never anon/public.
REVOKE ALL ON FUNCTION public.create_organization_with_owner(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_organization_with_owner(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_organization_with_owner(TEXT) TO authenticated;

COMMENT ON FUNCTION public.create_organization_with_owner(TEXT) IS
  'Atomically creates an organization and an owner membership for the calling '
  'user, bypassing the admin-gated memberships_insert RLS so a brand-new user '
  'can bootstrap their first org. Sets both role and role_enum to owner.';
