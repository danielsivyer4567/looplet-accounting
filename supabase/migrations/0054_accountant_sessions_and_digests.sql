-- 0054: Accountant session tracking + activity log + digest emails.
--
-- Goals:
-- 1. Auto-log accountant pageviews + actions during a session
-- 2. Detect session end (idle 30 min OR explicit logout)
-- 3. Generate digest doc on session end → email to accountant
-- 4. On-demand "Send me my activity log" button

CREATE TABLE IF NOT EXISTS public.accountant_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,                    -- the accountant
  started_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,                     -- explicit logout or idle timeout
  end_reason text CHECK (end_reason IN ('logout', 'idle_timeout', 'manual')),
  ip_address text,
  user_agent text,
  digest_sent_at timestamptz,               -- when we emailed the digest
  digest_recipient_email text,              -- where it went
  total_seconds int,                        -- computed on session close
  pageview_count int DEFAULT 0,
  action_count int DEFAULT 0,               -- write operations
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS accountant_sessions_open_idx
  ON public.accountant_sessions (organization_id, user_id, last_activity_at DESC)
  WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS accountant_sessions_for_digest_idx
  ON public.accountant_sessions (digest_sent_at)
  WHERE ended_at IS NOT NULL AND digest_sent_at IS NULL;

CREATE TABLE IF NOT EXISTS public.accountant_activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES public.accountant_sessions(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  event_type text NOT NULL CHECK (event_type IN ('pageview', 'action', 'question', 'export', 'comment')),
  path text,                                -- /bills, /invoices/123, etc.
  description text,                         -- "Opened Bill from Bunnings $1,250"
  resource_type text,
  resource_id uuid,
  duration_ms int,                          -- time on this page
  metadata jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS accountant_activity_log_session_idx
  ON public.accountant_activity_log (session_id, occurred_at);

CREATE INDEX IF NOT EXISTS accountant_activity_log_user_idx
  ON public.accountant_activity_log (organization_id, user_id, occurred_at DESC);

-- RLS
ALTER TABLE public.accountant_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accountant_activity_log ENABLE ROW LEVEL SECURITY;

-- Accountants see their own sessions; owners/admins of the org see all.
CREATE POLICY accountant_sessions_select ON public.accountant_sessions
  FOR SELECT USING (
    organization_id IN (SELECT public.get_accessible_org_ids())
    AND (user_id = auth.uid() OR public.require_role(organization_id, 'admin'::public.org_role))
  );

CREATE POLICY accountant_sessions_insert ON public.accountant_sessions
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND organization_id IN (SELECT public.get_accessible_org_ids())
  );

CREATE POLICY accountant_sessions_update ON public.accountant_sessions
  FOR UPDATE USING (
    user_id = auth.uid()
    AND organization_id IN (SELECT public.get_accessible_org_ids())
  )
  WITH CHECK (
    user_id = auth.uid()
    AND organization_id IN (SELECT public.get_accessible_org_ids())
  );

CREATE POLICY accountant_activity_log_select ON public.accountant_activity_log
  FOR SELECT USING (
    organization_id IN (SELECT public.get_accessible_org_ids())
    AND (user_id = auth.uid() OR public.require_role(organization_id, 'admin'::public.org_role))
  );

CREATE POLICY accountant_activity_log_insert ON public.accountant_activity_log
  FOR INSERT WITH CHECK (
    user_id = auth.uid()
    AND organization_id IN (SELECT public.get_accessible_org_ids())
  );

GRANT SELECT, INSERT, UPDATE ON public.accountant_sessions TO authenticated;
GRANT SELECT, INSERT ON public.accountant_activity_log TO authenticated;

-- =================================================================
-- Heartbeat RPC: client calls this every minute. Creates the session
-- on first call, updates last_activity_at on subsequent calls.
-- =================================================================
CREATE OR REPLACE FUNCTION public.accountant_session_heartbeat(
  p_org_id uuid,
  p_event_type text DEFAULT 'pageview',
  p_path text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_resource_type text DEFAULT NULL,
  p_resource_id uuid DEFAULT NULL,
  p_duration_ms int DEFAULT NULL,
  p_user_agent text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_session_id uuid;
  v_role text;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;

  -- Only log accountants — other roles are tracked via audit_log
  SELECT role INTO v_role FROM public.organization_memberships
   WHERE organization_id = p_org_id AND user_id = v_user_id;
  IF v_role <> 'accountant' THEN RETURN NULL; END IF;

  -- Find or create open session (idle timeout: 30 min)
  SELECT id INTO v_session_id FROM public.accountant_sessions
   WHERE organization_id = p_org_id
     AND user_id = v_user_id
     AND ended_at IS NULL
     AND last_activity_at > now() - INTERVAL '30 minutes'
   ORDER BY started_at DESC LIMIT 1;

  IF v_session_id IS NULL THEN
    INSERT INTO public.accountant_sessions (organization_id, user_id, user_agent)
    VALUES (p_org_id, v_user_id, p_user_agent)
    RETURNING id INTO v_session_id;
  ELSE
    UPDATE public.accountant_sessions
       SET last_activity_at = now(),
           pageview_count = pageview_count + (CASE WHEN p_event_type = 'pageview' THEN 1 ELSE 0 END),
           action_count   = action_count   + (CASE WHEN p_event_type IN ('action', 'comment') THEN 1 ELSE 0 END)
     WHERE id = v_session_id;
  END IF;

  -- Log the activity
  INSERT INTO public.accountant_activity_log (
    session_id, organization_id, user_id, event_type, path, description,
    resource_type, resource_id, duration_ms
  ) VALUES (
    v_session_id, p_org_id, v_user_id, p_event_type, p_path, p_description,
    p_resource_type, p_resource_id, p_duration_ms
  );

  RETURN v_session_id;
END $$;

GRANT EXECUTE ON FUNCTION public.accountant_session_heartbeat TO authenticated;

-- =================================================================
-- Close-idle-sessions: cron worker that ends sessions older than 30 min
-- and queues them for digest email.
-- =================================================================
CREATE OR REPLACE FUNCTION public.close_idle_accountant_sessions()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_closed int := 0;
BEGIN
  UPDATE public.accountant_sessions
     SET ended_at = last_activity_at,
         end_reason = 'idle_timeout',
         total_seconds = EXTRACT(EPOCH FROM (last_activity_at - started_at))::int
   WHERE ended_at IS NULL
     AND last_activity_at < now() - INTERVAL '30 minutes';
  GET DIAGNOSTICS v_closed = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'sessions_closed', v_closed);
END $$;

GRANT EXECUTE ON FUNCTION public.close_idle_accountant_sessions TO authenticated;

-- Cron: every 5 minutes when pg_cron is available. Local reset/test databases
-- may not expose the cron schema, so keep migration application portable.
DO $$
BEGIN
  IF to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
    EXECUTE $schedule$
      SELECT cron.schedule(
        'close-idle-accountant-sessions',
        '*/5 * * * *',
        $cron$ SELECT public.close_idle_accountant_sessions(); $cron$
      );
    $schedule$;
  END IF;
END $$;
