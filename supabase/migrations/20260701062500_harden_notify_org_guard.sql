-- 20260701062500_harden_notify_org_guard.sql
--
-- Harden public.notify(). It is SECURITY DEFINER and intentionally callable by
-- authenticated users, so the function itself must re-check org access before
-- inserting a notification row. service_role remains allowed for cron/system
-- producers.

BEGIN;

CREATE OR REPLACE FUNCTION public.notify(
  p_org           uuid,
  p_category      text,
  p_title         text,
  p_body          text DEFAULT NULL,
  p_link          text DEFAULT NULL,
  p_severity      text DEFAULT 'info',
  p_user_id       uuid DEFAULT NULL,
  p_resource_type text DEFAULT NULL,
  p_resource_id   uuid DEFAULT NULL,
  p_metadata      jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id uuid;
  v_caller uuid := auth.uid();
  v_role text := COALESCE(auth.role(), '');
BEGIN
  IF p_org IS NULL THEN
    RAISE EXCEPTION 'organization is required'
      USING ERRCODE = '22004';
  END IF;

  IF p_category IS NULL OR btrim(p_category) = '' THEN
    RAISE EXCEPTION 'category is required'
      USING ERRCODE = '22004';
  END IF;

  IF p_title IS NULL OR btrim(p_title) = '' THEN
    RAISE EXCEPTION 'title is required'
      USING ERRCODE = '22004';
  END IF;

  IF p_severity NOT IN ('info', 'warning', 'error') THEN
    RAISE EXCEPTION 'invalid severity: %', p_severity
      USING ERRCODE = '22023';
  END IF;

  IF v_role <> 'service_role' THEN
    IF v_caller IS NULL THEN
      RAISE EXCEPTION 'not authenticated'
        USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.organization_memberships m
      WHERE m.organization_id = p_org
        AND m.user_id = v_caller
        AND m.accepted_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'not authorized for organization'
        USING ERRCODE = '42501';
    END IF;

    IF p_user_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM public.organization_memberships target_member
      WHERE target_member.organization_id = p_org
        AND target_member.user_id = p_user_id
        AND target_member.accepted_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'notification target user is not a member of the organization'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO public.notifications
    (organization_id, user_id, category, severity, title, body, link,
     resource_type, resource_id, metadata)
  VALUES
    (p_org, p_user_id, p_category, p_severity, p_title, p_body, p_link,
     p_resource_type, p_resource_id, COALESCE(p_metadata, '{}'::jsonb))
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.notify(uuid, text, text, text, text, text, uuid, text, uuid, jsonb) IS
  'INSERT a notification row. SECURITY DEFINER; service_role can emit system notifications, authenticated callers must be accepted members of p_org and may only target members of that org.';

REVOKE ALL ON FUNCTION public.notify(uuid, text, text, text, text, text, uuid, text, uuid, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.notify(uuid, text, text, text, text, text, uuid, text, uuid, jsonb)
  TO service_role, authenticated;

COMMIT;
