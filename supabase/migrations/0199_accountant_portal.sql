-- ============================================================================
-- 0199_accountant_portal.sql
--
-- Accept-invite RPC for the accountant portal (and team invites generally).
--
-- GAP THIS CLOSES: team-invite (edge fn) only upserts a pending
-- organization_memberships row when the invitee ALREADY exists in auth.users.
-- A brand-new accountant (no account at invite time) gets a team_invitations
-- row but NO membership, so after they sign up they belong to nothing and the
-- invite shows "pending" forever. There is also no path to flip an existing
-- pending membership's accepted_at.
--
-- accept_pending_invites() runs as SECURITY DEFINER (bypassing the admin-gated
-- memberships_insert/update RLS from 0039) but only ever acts on invitations
-- addressed to the CALLER'S OWN authenticated email — so a user can only accept
-- invites that were sent to them. For each matching pending, unexpired invite it
-- create-or-updates the membership with accepted_at = now() and marks the
-- invitation accepted. Returns the accepted org ids so the client can refresh.
--
-- team_invitations.role is the legacy membership_role enum; we map it back to
-- org_role the same way 0039 did (manager -> accountant, member -> employee).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.accept_pending_invites()
RETURNS SETOF uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_email   TEXT := lower(btrim(auth.jwt() ->> 'email'));
  v_inv     RECORD;
  v_role_enum org_role;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  -- No verifiable email on the token → nothing we can safely accept.
  IF v_email IS NULL OR v_email = '' THEN
    RETURN;
  END IF;

  FOR v_inv IN
    SELECT id, organization_id, role, invited_by, created_at
    FROM public.team_invitations
    WHERE lower(email) = v_email
      AND status = 'pending'
      AND expires_at > now()
  LOOP
    -- Reverse the team-invite role mapping (membership_role -> org_role).
    v_role_enum := CASE v_inv.role::text
      WHEN 'owner'   THEN 'owner'::org_role
      WHEN 'admin'   THEN 'admin'::org_role
      WHEN 'manager' THEN 'accountant'::org_role
      ELSE                'employee'::org_role   -- 'member' → employee
    END;

    -- Create the membership if missing (new-user gap), or accept the pending
    -- one. Never downgrade or re-accept an already-accepted membership.
    INSERT INTO public.organization_memberships
      (user_id, organization_id, role, role_enum, is_default,
       invited_by, invited_at, accepted_at)
    VALUES
      (v_user_id, v_inv.organization_id, v_inv.role, v_role_enum, FALSE,
       v_inv.invited_by, v_inv.created_at, now())
    ON CONFLICT (user_id, organization_id) DO UPDATE
      SET accepted_at = now(),
          role        = EXCLUDED.role,
          role_enum   = EXCLUDED.role_enum
      WHERE public.organization_memberships.accepted_at IS NULL;

    UPDATE public.team_invitations
      SET status = 'accepted', accepted_at = now(), updated_at = now()
      WHERE id = v_inv.id;

    RETURN NEXT v_inv.organization_id;
  END LOOP;

  RETURN;
END;
$$;

-- Only signed-in users may accept their own invites; never anon/public.
REVOKE ALL ON FUNCTION public.accept_pending_invites() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.accept_pending_invites() FROM anon;
GRANT EXECUTE ON FUNCTION public.accept_pending_invites() TO authenticated;

COMMENT ON FUNCTION public.accept_pending_invites() IS
  'Accepts all pending, unexpired team_invitations addressed to the calling '
  'user''s authenticated email: create-or-updates organization_memberships with '
  'accepted_at=now() (creating the row for first-time invitees) and marks the '
  'invitations accepted. SECURITY DEFINER but scoped to the caller''s own email. '
  'Returns the accepted organization ids.';
