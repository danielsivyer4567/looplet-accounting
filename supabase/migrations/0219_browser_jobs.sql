-- 0219: Browser job schema — opt-in browser automation tables.
--
-- browser_sessions: tracks a browser automation session (purpose, status lifecycle).
-- browser_job_runs: records each individual URL visit within a session
--   (screenshot, console errors, network failures, redirect chain, duration).
--
-- Writes go through service_role only (a headless browser runner attached to
-- the automation-worker dispatches results). Org members get SELECT only.
--
-- The browser_collect job_kind is registered in the automation-worker dispatcher
-- but returns not_supported unless a real runner is attached. See BROWSER_AUTOMATION_RUNBOOK.md.
--
-- RLS pattern matches 0218 (reconciliation_evidence): SELECT for authenticated;
-- REVOKE INSERT/UPDATE/DELETE from authenticated+anon.

CREATE TABLE IF NOT EXISTS public.browser_sessions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  created_by  uuid        REFERENCES auth.users(id),
  purpose     text        NOT NULL,
  status      text        NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  started_at  timestamptz,
  ended_at    timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS browser_sessions_org_idx
  ON public.browser_sessions (org_id, created_at DESC);

ALTER TABLE public.browser_sessions ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.browser_sessions TO authenticated;

CREATE POLICY "org_members_read_browser_sessions"
  ON public.browser_sessions
  FOR SELECT
  USING (org_id IN (SELECT get_accessible_org_ids()));

REVOKE INSERT, UPDATE, DELETE
  ON public.browser_sessions FROM authenticated, anon;

-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.browser_job_runs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       uuid        NOT NULL REFERENCES public.browser_sessions(id) ON DELETE CASCADE,
  target_url       text        NOT NULL,
  screenshot_path  text,
  console_errors   jsonb       NOT NULL DEFAULT '[]',
  failed_responses jsonb       NOT NULL DEFAULT '[]',
  final_url        text,
  duration_ms      integer,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS browser_job_runs_session_idx
  ON public.browser_job_runs (session_id, created_at DESC);

ALTER TABLE public.browser_job_runs ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.browser_job_runs TO authenticated;

CREATE POLICY "org_members_read_browser_job_runs"
  ON public.browser_job_runs
  FOR SELECT
  USING (
    session_id IN (
      SELECT id FROM public.browser_sessions
      WHERE org_id IN (SELECT get_accessible_org_ids())
    )
  );

REVOKE INSERT, UPDATE, DELETE
  ON public.browser_job_runs FROM authenticated, anon;
