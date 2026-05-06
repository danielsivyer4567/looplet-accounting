-- 0040: Notifications system.
--
-- Per-org / per-user notifications surfaced in the header bell + /notifications
-- inbox. Producer side: SECURITY DEFINER `notify(...)` function used by the
-- nightly notifications-cron edge function. Consumer side: SELECT/UPDATE under
-- RLS so members can read + mark their own org's notifications read.
--
-- Categories (free-form text but expected to be one of):
--   bill_overdue
--   invoice_overdue
--   bas_due
--   connection_expiring
--   low_confidence_review
--   subscription_alert
--   cron_failed
--
-- Severities: info | warning | error
--
-- Idempotency for the cron is enforced by the cron itself (pre-checking for an
-- existing matching row created today) rather than via a DB unique constraint,
-- because notifications can legitimately repeat across days.

BEGIN;

CREATE TABLE IF NOT EXISTS public.notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  category        text NOT NULL,
  severity        text NOT NULL DEFAULT 'info'
                    CHECK (severity IN ('info', 'warning', 'error')),
  title           text NOT NULL,
  body            text,
  link            text,
  resource_type   text,
  resource_id     uuid,
  read_at         timestamptz,
  dismissed_at    timestamptz,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.notifications IS
  'Per-org / per-user notifications surfaced in the header bell + /notifications inbox.';
COMMENT ON COLUMN public.notifications.user_id IS
  'NULL = org-wide notification (visible to every member). Otherwise targeted at one user.';
COMMENT ON COLUMN public.notifications.category IS
  'Free-form category. Frontend filters / icons key off this.';
COMMENT ON COLUMN public.notifications.link IS
  'Optional in-app route, e.g. "/bills/abc123". Click handler navigates here and marks read.';

-- Inbox view: unread first, then most recent.
CREATE INDEX IF NOT EXISTS notifications_org_inbox_idx
  ON public.notifications (organization_id, read_at NULLS FIRST, created_at DESC);

-- Per-user shortcut for the header badge query.
CREATE INDEX IF NOT EXISTS notifications_user_read_idx
  ON public.notifications (user_id, read_at)
  WHERE user_id IS NOT NULL;

-- Idempotency lookup: cron uses (org, category, resource_id, day) to dedupe.
CREATE INDEX IF NOT EXISTS notifications_idempotency_idx
  ON public.notifications (organization_id, category, resource_id, created_at);

-- ============================================================================
-- RLS
-- ============================================================================

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- SELECT: any member of the org. Per-user-targeted notifications stay visible
-- to that user's row and to other admins of the same org (mirrors how audit_log
-- works for transparency).
DROP POLICY IF EXISTS notifications_select ON public.notifications;
CREATE POLICY notifications_select
  ON public.notifications
  FOR SELECT
  USING (
    organization_id IN (SELECT public.get_accessible_org_ids())
    AND (user_id IS NULL OR user_id = auth.uid()
         OR EXISTS (
           SELECT 1 FROM public.organization_memberships m
           WHERE m.organization_id = public.notifications.organization_id
             AND m.user_id = auth.uid()
             AND m.role IN ('owner', 'admin')
         ))
  );

-- UPDATE: only the owning user (or any member if user_id IS NULL) can flip
-- read_at / dismissed_at on their own org's notifications.
DROP POLICY IF EXISTS notifications_update ON public.notifications;
CREATE POLICY notifications_update
  ON public.notifications
  FOR UPDATE
  USING (
    organization_id IN (SELECT public.get_accessible_org_ids())
    AND (user_id IS NULL OR user_id = auth.uid())
  )
  WITH CHECK (
    organization_id IN (SELECT public.get_accessible_org_ids())
    AND (user_id IS NULL OR user_id = auth.uid())
  );

-- INSERT/DELETE: not allowed via RLS — only via SECURITY DEFINER notify()
-- (or service-role from the cron).

-- ============================================================================
-- Generator function
-- ============================================================================

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
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_severity NOT IN ('info', 'warning', 'error') THEN
    RAISE EXCEPTION 'invalid severity: %', p_severity;
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

COMMENT ON FUNCTION public.notify IS
  'INSERT a notification row. SECURITY DEFINER so callers do not need direct write access to public.notifications.';

REVOKE ALL ON FUNCTION public.notify(uuid, text, text, text, text, text, uuid, text, uuid, jsonb)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify(uuid, text, text, text, text, text, uuid, text, uuid, jsonb)
  TO service_role, authenticated;

COMMIT;
