-- ============================================================================
-- 0200_tag_drop.sql  (SC-2B: schema + RLS + storage)
--
-- Tag-drop page-annotation system, ported from the looplet CRM
-- (src migration 20260208000001_create_tags.sql) onto looplet-accounting
-- primitives. Lets a member drop a pin on any page, attach a comment / drawing /
-- media, tag staff, thread replies, and rate-limit creation.
--
-- PORT CHANGES vs the source schema:
--   * The source RLS scoped rows via a `profiles(id, organization_id)` table.
--     looplet-accounting has no `profiles`; every org-scoped policy here uses the
--     canonical `organization_id IN (SELECT public.get_accessible_org_ids())`
--     (0001). That helper already returns an accountant's CLIENT orgs (direct
--     memberships + agency sub-accounts), so an accountant who is a member of a
--     client org can read / reply to that client's tags — the cross-tenant
--     surface Epic 1 relies on.
--   * `tag_drafts.job_id` references `jobs(id)` (source used `projects`).
--   * `check_tag_rate_limit` is hardened: SECURITY DEFINER + `SET search_path`
--     (0060 convention) and EXECUTE revoked from anon/public
--     ([[definer-fn-grant-gotcha]]). Body is otherwise a verbatim port.
--   * Private `tag-attachments` storage bucket + org-scoped storage RLS are
--     created in SQL here (the source left the bucket as a dashboard comment),
--     following the `bills` bucket pattern (0087). Object-key convention:
--     `org-<organization_id>/...` — the ported uploader (SC-2D/2E) must write
--     keys with that prefix so a member can only read/write their own org's
--     objects.
--
-- The DB functions `get_taggable_staff`, `create_tag_with_rate_limit` and the
-- `dispatch_tag_notification` trigger are SC-2C (separate migration).
--
-- Idempotent + prod-safe: enums guarded by DO blocks, tables IF NOT EXISTS,
-- policies DROP IF EXISTS + CREATE, bucket ON CONFLICT DO NOTHING. Safe to
-- re-assert over a drifted live history ([[migration-history-drift]]).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.tag_approval_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.tag_attachment_type AS ENUM ('image', 'audio', 'drawing', 'video');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ----------------------------------------------------------------------------
-- tags — core annotation/pin storage
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tags (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  creator_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Position
  page_url          text NOT NULL,
  coords            jsonb NOT NULL DEFAULT '{"x": 0, "y": 0}',

  -- Content
  comment           text,
  drawing_data      text,   -- legacy base64; prefer drawing_url
  drawing_url       text,   -- storage URL for drawing

  -- Workflow
  requires_approval boolean DEFAULT FALSE,
  approval_status   public.tag_approval_status DEFAULT 'pending',
  approved_by       uuid REFERENCES auth.users(id),
  approved_at       timestamptz,

  -- Metadata
  timestamp         bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint,
  created_at        timestamptz DEFAULT NOW(),
  updated_at        timestamptz DEFAULT NOW(),
  deleted_at        timestamptz,

  CONSTRAINT valid_coords CHECK (
    coords ? 'x' AND coords ? 'y' AND
    (coords->>'x')::numeric >= 0 AND
    (coords->>'y')::numeric >= 0
  ),
  CONSTRAINT comment_length CHECK (char_length(comment) <= 5000)
);
CREATE INDEX IF NOT EXISTS idx_tags_organization    ON public.tags(organization_id);
CREATE INDEX IF NOT EXISTS idx_tags_creator         ON public.tags(creator_id);
CREATE INDEX IF NOT EXISTS idx_tags_page_url        ON public.tags(page_url);
CREATE INDEX IF NOT EXISTS idx_tags_created_at      ON public.tags(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tags_approval_status ON public.tags(approval_status) WHERE requires_approval = TRUE;
CREATE INDEX IF NOT EXISTS idx_tags_not_deleted     ON public.tags(id) WHERE deleted_at IS NULL;

-- ----------------------------------------------------------------------------
-- tag_staff — staff tagged/notified on a tag
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tag_staff (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tag_id      uuid NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE,
  staff_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  notified_at timestamptz DEFAULT NOW(),
  read_at     timestamptz,
  UNIQUE (tag_id, staff_id)
);
CREATE INDEX IF NOT EXISTS idx_tag_staff_tag    ON public.tag_staff(tag_id);
CREATE INDEX IF NOT EXISTS idx_tag_staff_staff  ON public.tag_staff(staff_id);
CREATE INDEX IF NOT EXISTS idx_tag_staff_unread ON public.tag_staff(staff_id) WHERE read_at IS NULL;

-- ----------------------------------------------------------------------------
-- tag_attachments — files attached to a tag
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tag_attachments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tag_id          uuid NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE,
  attachment_type public.tag_attachment_type NOT NULL,
  storage_url     text NOT NULL,
  file_name       text,
  file_size       integer,
  mime_type       text,
  created_at      timestamptz DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tag_attachments_tag ON public.tag_attachments(tag_id);

-- ----------------------------------------------------------------------------
-- tag_replies — threaded conversation on a tag
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tag_replies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tag_id          uuid NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE,
  parent_reply_id uuid REFERENCES public.tag_replies(id) ON DELETE CASCADE,
  creator_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content         text NOT NULL,
  created_at      timestamptz DEFAULT NOW(),
  updated_at      timestamptz DEFAULT NOW(),
  deleted_at      timestamptz,
  CONSTRAINT reply_content_length CHECK (char_length(content) <= 2000)
);
CREATE INDEX IF NOT EXISTS idx_tag_replies_tag     ON public.tag_replies(tag_id);
CREATE INDEX IF NOT EXISTS idx_tag_replies_creator ON public.tag_replies(creator_id);
CREATE INDEX IF NOT EXISTS idx_tag_replies_parent  ON public.tag_replies(parent_reply_id);

-- ----------------------------------------------------------------------------
-- tag_rate_limits — anti-spam ledger (see check_tag_rate_limit below)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tag_rate_limits (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  page_url   text,
  created_at timestamptz DEFAULT NOW(),
  expires_at timestamptz DEFAULT (NOW() + INTERVAL '1 hour')
);
CREATE INDEX IF NOT EXISTS idx_tag_rate_limits_user    ON public.tag_rate_limits(user_id);
CREATE INDEX IF NOT EXISTS idx_tag_rate_limits_expires ON public.tag_rate_limits(expires_at);

-- ----------------------------------------------------------------------------
-- tag_drafts — saved drafts (job_id -> jobs, not projects)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tag_drafts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  page_url          text,
  comment           text,
  drawing_data      text,
  tagged_staff_ids  uuid[] DEFAULT '{}',
  requires_approval boolean DEFAULT FALSE,
  job_id            uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  created_at        timestamptz DEFAULT NOW(),
  updated_at        timestamptz DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tag_drafts_user ON public.tag_drafts(user_id);

-- ============================================================================
-- Row Level Security  (org scope via get_accessible_org_ids)
-- ============================================================================
ALTER TABLE public.tags            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tag_staff       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tag_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tag_replies     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tag_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tag_drafts      ENABLE ROW LEVEL SECURITY;

-- ----- tags -----
DROP POLICY IF EXISTS tags_select ON public.tags;
CREATE POLICY tags_select ON public.tags
  FOR SELECT USING (
    organization_id IN (SELECT public.get_accessible_org_ids())
    AND deleted_at IS NULL
  );

DROP POLICY IF EXISTS tags_insert ON public.tags;
CREATE POLICY tags_insert ON public.tags
  FOR INSERT WITH CHECK (
    organization_id IN (SELECT public.get_accessible_org_ids())
    AND creator_id = auth.uid()
  );

DROP POLICY IF EXISTS tags_update_own ON public.tags;
CREATE POLICY tags_update_own ON public.tags
  FOR UPDATE USING (creator_id = auth.uid())
  WITH CHECK (creator_id = auth.uid());

DROP POLICY IF EXISTS tags_delete_own ON public.tags;
CREATE POLICY tags_delete_own ON public.tags
  FOR DELETE USING (creator_id = auth.uid());

-- ----- tag_staff -----
-- A tagged user sees their own notifications; a tag's creator manages its staff.
DROP POLICY IF EXISTS tag_staff_select_own ON public.tag_staff;
CREATE POLICY tag_staff_select_own ON public.tag_staff
  FOR SELECT USING (staff_id = auth.uid());

DROP POLICY IF EXISTS tag_staff_creator_manage ON public.tag_staff;
CREATE POLICY tag_staff_creator_manage ON public.tag_staff
  FOR ALL USING (
    tag_id IN (SELECT id FROM public.tags WHERE creator_id = auth.uid())
  );

-- ----- tag_attachments -----
DROP POLICY IF EXISTS tag_attachments_select ON public.tag_attachments;
CREATE POLICY tag_attachments_select ON public.tag_attachments
  FOR SELECT USING (
    tag_id IN (
      SELECT id FROM public.tags
      WHERE organization_id IN (SELECT public.get_accessible_org_ids())
    )
  );

DROP POLICY IF EXISTS tag_attachments_creator_manage ON public.tag_attachments;
CREATE POLICY tag_attachments_creator_manage ON public.tag_attachments
  FOR ALL USING (
    tag_id IN (SELECT id FROM public.tags WHERE creator_id = auth.uid())
  );

-- ----- tag_replies -----
DROP POLICY IF EXISTS tag_replies_select ON public.tag_replies;
CREATE POLICY tag_replies_select ON public.tag_replies
  FOR SELECT USING (
    tag_id IN (
      SELECT id FROM public.tags
      WHERE organization_id IN (SELECT public.get_accessible_org_ids())
    )
    AND deleted_at IS NULL
  );

DROP POLICY IF EXISTS tag_replies_insert ON public.tag_replies;
CREATE POLICY tag_replies_insert ON public.tag_replies
  FOR INSERT WITH CHECK (
    creator_id = auth.uid()
    AND tag_id IN (
      SELECT id FROM public.tags
      WHERE organization_id IN (SELECT public.get_accessible_org_ids())
    )
  );

DROP POLICY IF EXISTS tag_replies_update_own ON public.tag_replies;
CREATE POLICY tag_replies_update_own ON public.tag_replies
  FOR UPDATE USING (creator_id = auth.uid());

DROP POLICY IF EXISTS tag_replies_delete_own ON public.tag_replies;
CREATE POLICY tag_replies_delete_own ON public.tag_replies
  FOR DELETE USING (creator_id = auth.uid());

-- ----- tag_rate_limits -----
DROP POLICY IF EXISTS tag_rate_limits_select_own ON public.tag_rate_limits;
CREATE POLICY tag_rate_limits_select_own ON public.tag_rate_limits
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS tag_rate_limits_insert_own ON public.tag_rate_limits;
CREATE POLICY tag_rate_limits_insert_own ON public.tag_rate_limits
  FOR INSERT WITH CHECK (user_id = auth.uid());

-- ----- tag_drafts -----
DROP POLICY IF EXISTS tag_drafts_manage_own ON public.tag_drafts;
CREATE POLICY tag_drafts_manage_own ON public.tag_drafts
  FOR ALL USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ============================================================================
-- updated_at touch triggers — reuse the canonical set_updated_at() (0001)
-- ============================================================================
DROP TRIGGER IF EXISTS trigger_tags_updated_at ON public.tags;
CREATE TRIGGER trigger_tags_updated_at
  BEFORE UPDATE ON public.tags
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trigger_tag_replies_updated_at ON public.tag_replies;
CREATE TRIGGER trigger_tag_replies_updated_at
  BEFORE UPDATE ON public.tag_replies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trigger_tag_drafts_updated_at ON public.tag_drafts;
CREATE TRIGGER trigger_tag_drafts_updated_at
  BEFORE UPDATE ON public.tag_drafts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- check_tag_rate_limit — verbatim port, DEFINER-hardened
-- 5s cooldown between tags; max 50 tags/hour. Cleans expired rows on each call.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.check_tag_rate_limit(
  p_user_id  uuid,
  p_page_url text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count_last_minute  integer;
  v_count_last_hour    integer;
  v_last_tag_time      timestamptz;
  v_cooldown_remaining integer;
BEGIN
  -- Clean up expired rate-limit records
  DELETE FROM public.tag_rate_limits WHERE expires_at < NOW();

  SELECT COUNT(*) INTO v_count_last_minute
  FROM public.tag_rate_limits
  WHERE user_id = p_user_id
    AND created_at > NOW() - INTERVAL '1 minute';

  SELECT COUNT(*) INTO v_count_last_hour
  FROM public.tag_rate_limits
  WHERE user_id = p_user_id
    AND created_at > NOW() - INTERVAL '1 hour';

  SELECT MAX(created_at) INTO v_last_tag_time
  FROM public.tag_rate_limits
  WHERE user_id = p_user_id;

  -- Cooldown: 5 seconds between tags
  IF v_last_tag_time IS NOT NULL AND
     v_last_tag_time > NOW() - INTERVAL '5 seconds' THEN
    v_cooldown_remaining := EXTRACT(EPOCH FROM (v_last_tag_time + INTERVAL '5 seconds' - NOW()))::integer;
    RETURN jsonb_build_object(
      'allowed', FALSE,
      'reason', 'cooldown',
      'wait_seconds', v_cooldown_remaining,
      'message', format('Please wait %s seconds before creating another tag', v_cooldown_remaining)
    );
  END IF;

  -- Hourly limit: 50 per hour
  IF v_count_last_hour >= 50 THEN
    RETURN jsonb_build_object(
      'allowed', FALSE,
      'reason', 'hourly_limit',
      'count', v_count_last_hour,
      'message', 'You have reached the maximum of 50 tags per hour'
    );
  END IF;

  RETURN jsonb_build_object(
    'allowed', TRUE,
    'remaining_hourly', 50 - v_count_last_hour
  );
END;
$$;

REVOKE ALL ON FUNCTION public.check_tag_rate_limit(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_tag_rate_limit(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.check_tag_rate_limit(uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.check_tag_rate_limit(uuid, text) IS
  'Anti-spam guard for tag creation: 5s cooldown + 50/hour. Returns a jsonb '
  'verdict {allowed, reason?, message?}. SECURITY DEFINER so it can prune/read '
  'tag_rate_limits without granting table access; called both directly (UI quota) '
  'and by create_tag_with_rate_limit (SC-2C).';

-- ============================================================================
-- Storage: private tag-attachments bucket + org-scoped RLS (bills pattern, 0087)
-- Object-key convention: org-<organization_id>/...
-- ============================================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('tag-attachments', 'tag-attachments', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS tag_attachments_bucket_select ON storage.objects;
CREATE POLICY tag_attachments_bucket_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'tag-attachments'
    AND substring(name FROM '^org-([0-9a-fA-F-]+)/') IN (
      SELECT g::text FROM public.get_accessible_org_ids() AS g
    )
  );

DROP POLICY IF EXISTS tag_attachments_bucket_insert ON storage.objects;
CREATE POLICY tag_attachments_bucket_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'tag-attachments'
    AND substring(name FROM '^org-([0-9a-fA-F-]+)/') IN (
      SELECT g::text FROM public.get_accessible_org_ids() AS g
    )
  );

DROP POLICY IF EXISTS tag_attachments_bucket_update ON storage.objects;
CREATE POLICY tag_attachments_bucket_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'tag-attachments'
    AND substring(name FROM '^org-([0-9a-fA-F-]+)/') IN (
      SELECT g::text FROM public.get_accessible_org_ids() AS g
    )
  )
  WITH CHECK (
    bucket_id = 'tag-attachments'
    AND substring(name FROM '^org-([0-9a-fA-F-]+)/') IN (
      SELECT g::text FROM public.get_accessible_org_ids() AS g
    )
  );

COMMENT ON TABLE public.tags IS 'Page annotations/pins with optional drawings + staff notifications (tag-drop).';
COMMENT ON TABLE public.tag_staff IS 'Staff tagged/notified on a tag.';
COMMENT ON TABLE public.tag_attachments IS 'File attachments for tags (tag-attachments bucket).';
COMMENT ON TABLE public.tag_replies IS 'Threaded replies on a tag.';
COMMENT ON TABLE public.tag_rate_limits IS 'Per-user rate-limit ledger for tag creation.';
COMMENT ON TABLE public.tag_drafts IS 'Saved tag drafts (job_id -> jobs).';

COMMIT;
