-- ============================================================================
-- 0201_tag_functions.sql  (SC-2C: tag DB functions + notify trigger)
--
-- The data-plane functions for the tag-drop system (schema/RLS landed in 0200):
--   * get_taggable_staff(p_org)        — org members the caller may tag.
--   * create_tag_with_rate_limit(...)  — rate-limited tag creation + staff fan-out.
--   * dispatch_tag_notification()      — AFTER INSERT trigger on tag_staff that
--                                        raises an in-app notify() to each tagged
--                                        user (in-app only; looplet notify() has
--                                        no email/push channel).
--
-- PORT CHANGES vs the CRM source (20260208000001_create_tags.sql):
--   * No `profiles` table. get_taggable_staff joins organization_memberships +
--     auth.users; display name / avatar come from auth.users.raw_user_meta_data,
--     role from the membership (role_enum from 0199, falling back to role).
--   * CALLER AUTHZ. The source functions were SECURITY DEFINER with no caller
--     gate, so any authenticated user could enumerate / write to an arbitrary
--     org by passing its id ([[edge-fn-caller-org-authz]]). Both functions now
--     require the target org to be in the caller's get_accessible_org_ids()
--     (which already includes an accountant's client orgs), restoring the RLS
--     boundary that DEFINER bypasses.
--   * NEW notify trigger. The CRM dispatched mention notifications from the
--     frontend; here it is DB-side via notify() (0040) so it can't be skipped.
--     On notify failure we DO NOT swallow — we write an audit_log row
--     (action='TAG_NOTIFY_FAILED') so a dropped mention is observable.
--   * DEFINER-hardened: SET search_path = public, EXECUTE revoked from anon/public
--     ([[definer-fn-grant-gotcha]]).
--
-- Idempotent: CREATE OR REPLACE for functions, DROP TRIGGER IF EXISTS + CREATE.
-- ============================================================================

BEGIN;

-- ============================================================================
-- get_taggable_staff — org members the caller may tag (id, email, name, avatar, role)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_taggable_staff(
  p_organization_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id         uuid,
  email      text,
  full_name  text,
  avatar_url text,
  role       text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.user_id AS id,
    au.email::text AS email,
    COALESCE(
      au.raw_user_meta_data->>'full_name',
      au.raw_user_meta_data->>'name',
      NULLIF(trim(
        COALESCE(au.raw_user_meta_data->>'first_name', '') || ' ' ||
        COALESCE(au.raw_user_meta_data->>'last_name', '')
      ), ''),
      au.email::text
    ) AS full_name,
    au.raw_user_meta_data->>'avatar_url' AS avatar_url,
    COALESCE(m.role_enum::text, m.role::text) AS role
  FROM public.organization_memberships m
  JOIN auth.users au ON au.id = m.user_id
  -- Caller authz: only orgs the caller can access (their own + accountant clients).
  WHERE m.organization_id IN (SELECT public.get_accessible_org_ids())
    AND (p_organization_id IS NULL OR m.organization_id = p_organization_id)
    AND m.accepted_at IS NOT NULL
  ORDER BY full_name;
END;
$$;

REVOKE ALL ON FUNCTION public.get_taggable_staff(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_taggable_staff(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_taggable_staff(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_taggable_staff(uuid) IS
  'Members the caller may tag, scoped to get_accessible_org_ids() (includes an '
  'accountant''s client orgs). Name/avatar from auth.users metadata, role from '
  'the membership. SECURITY DEFINER to read auth.users; caller-org gated.';

-- ============================================================================
-- create_tag_with_rate_limit — rate-limited tag creation + staff fan-out
-- Returns {success:true, data:{id, timestamp}} | {success:false, error:{...}}.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_tag_with_rate_limit(
  p_organization_id   uuid,
  p_page_url          text,
  p_coords            jsonb,
  p_comment           text DEFAULT NULL,
  p_drawing_data      text DEFAULT NULL,
  p_tagged_staff_ids  uuid[] DEFAULT '{}',
  p_requires_approval boolean DEFAULT FALSE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id    uuid := auth.uid();
  v_rate_check jsonb;
  v_tag_id     uuid;
  v_staff_id   uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', FALSE,
      'error', jsonb_build_object('message', 'Not authenticated'));
  END IF;

  -- Caller authz: DEFINER bypasses RLS, so re-assert the tags_insert boundary.
  IF p_organization_id NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RETURN jsonb_build_object('success', FALSE,
      'error', jsonb_build_object('message', 'No access to that organization'));
  END IF;

  -- Rate limit (5s cooldown + 50/hour)
  v_rate_check := public.check_tag_rate_limit(v_user_id, p_page_url);
  IF NOT (v_rate_check->>'allowed')::boolean THEN
    RETURN jsonb_build_object('success', FALSE, 'error', v_rate_check);
  END IF;

  -- Create the tag
  INSERT INTO public.tags (
    organization_id, creator_id, page_url, coords, comment,
    drawing_data, requires_approval, approval_status
  ) VALUES (
    p_organization_id, v_user_id, p_page_url, p_coords, p_comment,
    p_drawing_data, p_requires_approval,
    CASE WHEN p_requires_approval THEN 'pending'::public.tag_approval_status ELSE NULL END
  )
  RETURNING id INTO v_tag_id;

  -- Fan out to tagged staff (notification raised by dispatch_tag_notification trigger)
  FOREACH v_staff_id IN ARRAY COALESCE(p_tagged_staff_ids, '{}')
  LOOP
    INSERT INTO public.tag_staff (tag_id, staff_id)
    VALUES (v_tag_id, v_staff_id)
    ON CONFLICT (tag_id, staff_id) DO NOTHING;
  END LOOP;

  -- Record for rate limiting
  INSERT INTO public.tag_rate_limits (user_id, page_url)
  VALUES (v_user_id, p_page_url);

  RETURN jsonb_build_object(
    'success', TRUE,
    'data', jsonb_build_object(
      'id', v_tag_id,
      'timestamp', (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_tag_with_rate_limit(uuid, text, jsonb, text, text, uuid[], boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_tag_with_rate_limit(uuid, text, jsonb, text, text, uuid[], boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_tag_with_rate_limit(uuid, text, jsonb, text, text, uuid[], boolean) TO authenticated, service_role;

COMMENT ON FUNCTION public.create_tag_with_rate_limit(uuid, text, jsonb, text, text, uuid[], boolean) IS
  'Rate-limited tag creation: gates the caller org, runs check_tag_rate_limit, '
  'inserts the tag, fans out to tag_staff (which fires dispatch_tag_notification), '
  'and records the rate-limit row. SECURITY DEFINER + caller-org gated.';

-- ============================================================================
-- dispatch_tag_notification — AFTER INSERT on tag_staff -> in-app notify()
-- No silent swallow: on notify failure write an audit_log row instead.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.dispatch_tag_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tag          public.tags%ROWTYPE;
  v_creator_name text;
BEGIN
  SELECT * INTO v_tag FROM public.tags WHERE id = NEW.tag_id;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- Don't notify the creator about tagging themselves.
  IF NEW.staff_id = v_tag.creator_id THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(
    au.raw_user_meta_data->>'full_name',
    au.raw_user_meta_data->>'name',
    au.email::text,
    'Someone'
  )
  INTO v_creator_name
  FROM auth.users au
  WHERE au.id = v_tag.creator_id;

  BEGIN
    PERFORM public.notify(
      p_org           => v_tag.organization_id,
      p_category      => 'mention',
      p_title         => COALESCE(v_creator_name, 'Someone') || ' tagged you',
      p_body          => left(COALESCE(v_tag.comment, ''), 280),
      p_link          => v_tag.page_url || '?tag=' || v_tag.id::text,
      p_severity      => 'info',
      p_user_id       => NEW.staff_id,
      p_resource_type => 'tag',
      p_resource_id   => v_tag.id,
      p_metadata      => jsonb_build_object(
        'tag_id', v_tag.id,
        'creator_id', v_tag.creator_id,
        'page_url', v_tag.page_url
      )
    );
  EXCEPTION WHEN OTHERS THEN
    -- Surface the dropped mention rather than swallowing it.
    INSERT INTO public.audit_log (
      organization_id, table_name, record_id, operation, actor_user_id,
      action, resource_type, resource_id, metadata
    ) VALUES (
      v_tag.organization_id, 'tag_staff', NEW.id, 'INSERT', v_tag.creator_id,
      'TAG_NOTIFY_FAILED', 'tag', v_tag.id,
      jsonb_build_object(
        'staff_id', NEW.staff_id,
        'sqlstate', SQLSTATE,
        'error', SQLERRM
      )
    );
  END;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.dispatch_tag_notification() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.dispatch_tag_notification() TO authenticated, service_role;

COMMENT ON FUNCTION public.dispatch_tag_notification() IS
  'AFTER INSERT trigger on tag_staff: raises an in-app notify() (category=mention, '
  'resource_type=tag, link=page_url?tag=<id>) to the tagged user, skipping the '
  'creator. On notify failure writes audit_log action=TAG_NOTIFY_FAILED (no swallow).';

DROP TRIGGER IF EXISTS trigger_dispatch_tag_notification ON public.tag_staff;
CREATE TRIGGER trigger_dispatch_tag_notification
  AFTER INSERT ON public.tag_staff
  FOR EACH ROW EXECUTE FUNCTION public.dispatch_tag_notification();

COMMIT;
