-- ============================================================================
-- 0211_automation_jobs.sql
--
-- Unified automation worker/job framework.
--
-- Four tables:
--   automation_jobs         — the job queue
--   automation_job_steps    — per-step audit log for each job run
--   automation_artifacts    — evidence attached to jobs (screenshots, payloads)
--   automation_dead_letters — terminal failures that need human attention
--
-- Five SECURITY DEFINER RPCs (all writes go through these):
--   enqueue_automation_job      — add a job to the queue
--   claim_automation_jobs       — worker claims N due jobs atomically
--   complete_automation_job     — mark job succeeded
--   fail_automation_job         — increment attempt count, set last_error
--   dead_letter_automation_job  — move terminal job to dead_letters
--
-- SECURITY: authenticated clients SELECT only; writes go through DEFINER RPCs
-- or direct service_role access. No client INSERT/UPDATE/DELETE.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Enum: automation_job_status
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE public.automation_job_status AS ENUM (
    'pending',
    'claimed',
    'completed',
    'failed',
    'dead_lettered'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON TYPE public.automation_job_status IS
  'Lifecycle states for automation_jobs rows.';

-- ---------------------------------------------------------------------------
-- Table: automation_jobs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.automation_jobs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- What kind of work to do
  job_kind         text        NOT NULL,  -- e.g. 'bill_extract', 'receipt_sync', 'xero_push'
  source_kind      text,                  -- optional: 'bill', 'bank_transaction', 'receipt'
  source_id        uuid,                  -- optional: FK to the source row

  -- Scheduling
  status           public.automation_job_status NOT NULL DEFAULT 'pending',
  priority         int         NOT NULL DEFAULT 5,   -- lower = higher priority
  run_after        timestamptz NOT NULL DEFAULT now(),

  -- Retry tracking
  attempts         int         NOT NULL DEFAULT 0,
  max_attempts     int         NOT NULL DEFAULT 3,

  -- Locking (optimistic claim)
  locked_at        timestamptz,
  locked_by        text,                  -- worker instance id / function invocation id

  -- Error info
  last_error       text,

  -- Audit
  enqueued_at      timestamptz NOT NULL DEFAULT now(),
  enqueued_by      uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  completed_at     timestamptz,

  -- Input payload for the job (optional, for parameterised jobs)
  payload          jsonb
);

COMMENT ON TABLE public.automation_jobs IS
  'Central job queue for all automation workers. One row per unit of work. '
  'Workers claim rows atomically via claim_automation_jobs RPC.';

CREATE INDEX IF NOT EXISTS idx_auto_jobs_org_status
  ON public.automation_jobs (organization_id, status, run_after)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS idx_auto_jobs_source
  ON public.automation_jobs (organization_id, source_kind, source_id)
  WHERE source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_auto_jobs_pending_due
  ON public.automation_jobs (priority, run_after)
  WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Table: automation_job_steps
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.automation_job_steps (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid        NOT NULL REFERENCES public.automation_jobs(id) ON DELETE CASCADE,
  step_name   text        NOT NULL,
  status      text        NOT NULL DEFAULT 'started',  -- 'started', 'ok', 'error', 'skipped'
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  result      jsonb,    -- structured success result
  error       text      -- error message on failure
);

COMMENT ON TABLE public.automation_job_steps IS
  'Append-only per-step audit log. Each automation job records steps as it '
  'progresses so failures can be diagnosed without re-running the whole job.';

CREATE INDEX IF NOT EXISTS idx_auto_job_steps_job
  ON public.automation_job_steps (job_id, started_at);

-- ---------------------------------------------------------------------------
-- Table: automation_artifacts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.automation_artifacts (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        uuid        NOT NULL REFERENCES public.automation_jobs(id) ON DELETE CASCADE,
  kind          text        NOT NULL,  -- 'screenshot', 'log', 'payload_hash', 'response_body', 'db_proof'
  storage_path  text,                 -- Supabase Storage path if applicable
  payload_hash  text,                 -- SHA-256 of the artifact content
  metadata      jsonb,                -- arbitrary key-value evidence
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.automation_artifacts IS
  'Evidence attached to automation jobs: screenshots, hashed payloads, '
  'response bodies, DB proof references. Immutable once written.';

CREATE INDEX IF NOT EXISTS idx_auto_artifacts_job
  ON public.automation_artifacts (job_id, kind);

-- ---------------------------------------------------------------------------
-- Table: automation_dead_letters
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.automation_dead_letters (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  original_job_id  uuid        NOT NULL REFERENCES public.automation_jobs(id) ON DELETE CASCADE,
  job_kind         text        NOT NULL,
  source_kind      text,
  source_id        uuid,
  last_error       text        NOT NULL,
  payload          jsonb,
  attempts         int         NOT NULL DEFAULT 0,
  dead_lettered_at timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz,   -- set when a human resolves the dead letter
  resolved_by      uuid        REFERENCES auth.users(id),

  -- One dead-letter row per job; double-call is a hard error at the DB layer
  CONSTRAINT uq_dead_letters_original_job UNIQUE (original_job_id)
);

COMMENT ON TABLE public.automation_dead_letters IS
  'Terminal failures that exceeded max_attempts and need human attention. '
  'Each row corresponds to one dead-lettered automation_job.';

CREATE INDEX IF NOT EXISTS idx_auto_dead_letters_org
  ON public.automation_dead_letters (organization_id, dead_lettered_at)
  WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE public.automation_jobs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_job_steps   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_artifacts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_dead_letters ENABLE ROW LEVEL SECURITY;

-- Clients SELECT only; writes go through DEFINER RPCs or service_role
CREATE POLICY auto_jobs_select ON public.automation_jobs
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

CREATE POLICY auto_jobs_no_insert ON public.automation_jobs
  FOR INSERT TO authenticated WITH CHECK (false);

CREATE POLICY auto_jobs_no_update ON public.automation_jobs
  FOR UPDATE TO authenticated USING (false);

CREATE POLICY auto_jobs_no_delete ON public.automation_jobs
  FOR DELETE TO authenticated USING (false);

CREATE POLICY auto_steps_select ON public.automation_job_steps
  FOR SELECT TO authenticated
  USING (
    job_id IN (
      SELECT id FROM public.automation_jobs
      WHERE organization_id IN (SELECT public.get_accessible_org_ids())
    )
  );

CREATE POLICY auto_steps_no_insert ON public.automation_job_steps
  FOR INSERT TO authenticated WITH CHECK (false);

CREATE POLICY auto_steps_no_update ON public.automation_job_steps
  FOR UPDATE TO authenticated USING (false);

CREATE POLICY auto_artifacts_select ON public.automation_artifacts
  FOR SELECT TO authenticated
  USING (
    job_id IN (
      SELECT id FROM public.automation_jobs
      WHERE organization_id IN (SELECT public.get_accessible_org_ids())
    )
  );

CREATE POLICY auto_artifacts_no_insert ON public.automation_artifacts
  FOR INSERT TO authenticated WITH CHECK (false);

CREATE POLICY auto_artifacts_no_update ON public.automation_artifacts
  FOR UPDATE TO authenticated USING (false);

CREATE POLICY auto_dead_letters_select ON public.automation_dead_letters
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

CREATE POLICY auto_dead_letters_no_insert ON public.automation_dead_letters
  FOR INSERT TO authenticated WITH CHECK (false);

CREATE POLICY auto_dead_letters_no_update ON public.automation_dead_letters
  FOR UPDATE TO authenticated USING (false);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT SELECT ON public.automation_jobs         TO authenticated;
GRANT SELECT ON public.automation_job_steps    TO authenticated;
GRANT SELECT ON public.automation_artifacts    TO authenticated;
GRANT SELECT ON public.automation_dead_letters TO authenticated;

GRANT INSERT, UPDATE ON public.automation_jobs         TO service_role;
GRANT INSERT         ON public.automation_job_steps    TO service_role;
GRANT INSERT         ON public.automation_artifacts    TO service_role;
GRANT INSERT, UPDATE ON public.automation_dead_letters TO service_role;

REVOKE ALL ON public.automation_jobs         FROM PUBLIC, anon;
REVOKE ALL ON public.automation_job_steps    FROM PUBLIC, anon;
REVOKE ALL ON public.automation_artifacts    FROM PUBLIC, anon;
REVOKE ALL ON public.automation_dead_letters FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- RPC: enqueue_automation_job
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enqueue_automation_job(
  p_org_id       uuid,
  p_job_kind     text,
  p_source_kind  text    DEFAULT NULL,
  p_source_id    uuid    DEFAULT NULL,
  p_priority     int     DEFAULT 5,
  p_run_after    timestamptz DEFAULT now(),
  p_max_attempts int     DEFAULT 3,
  p_payload      jsonb   DEFAULT NULL
)
RETURNS public.automation_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_result public.automation_jobs;
BEGIN
  IF p_org_id NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RAISE EXCEPTION 'organization not accessible' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.automation_jobs
    (organization_id, job_kind, source_kind, source_id,
     priority, run_after, max_attempts, payload, enqueued_by)
  VALUES
    (p_org_id, p_job_kind, p_source_kind, p_source_id,
     p_priority, p_run_after, p_max_attempts, p_payload, auth.uid())
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.enqueue_automation_job IS
  'Adds a new job to the automation queue. SECURITY DEFINER — enforces org '
  'accessibility but allows authenticated callers to enqueue.';

-- ---------------------------------------------------------------------------
-- RPC: claim_automation_jobs
-- ---------------------------------------------------------------------------
-- Workers call this to atomically lock N pending jobs that are due.
-- Returns the claimed rows (worker must process then call complete/fail).

CREATE OR REPLACE FUNCTION public.claim_automation_jobs(
  p_worker_id  text,
  p_job_kinds  text[]  DEFAULT NULL,   -- NULL = claim any kind
  p_limit      int     DEFAULT 5,
  p_lock_secs  int     DEFAULT 120
)
RETURNS SETOF public.automation_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.automation_jobs
  SET
    status    = 'claimed',
    locked_at = now(),
    locked_by = p_worker_id,
    attempts  = attempts + 1
  WHERE id IN (
    SELECT id FROM public.automation_jobs
    WHERE status = 'pending'
      AND run_after <= now()
      AND attempts < max_attempts
      AND (p_job_kinds IS NULL OR job_kind = ANY(p_job_kinds))
      AND (locked_at IS NULL OR locked_at < now() - (p_lock_secs || ' seconds')::interval)
    ORDER BY priority ASC, run_after ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$;

COMMENT ON FUNCTION public.claim_automation_jobs IS
  'Atomically locks N due pending jobs for a worker. Uses SKIP LOCKED to '
  'avoid contention between concurrent workers. SECURITY DEFINER. '
  'IMPORTANT: claim_automation_jobs is the ONLY place that increments attempts. '
  'complete_automation_job, fail_automation_job, and dead_letter_automation_job '
  'must NOT touch the attempts column. The p_worker_id is caller-supplied text '
  '(trust model: service_role only); workers pass back the same value they '
  'received from the claim result to prove ownership on complete/fail/dead-letter.';

-- ---------------------------------------------------------------------------
-- RPC: complete_automation_job
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.complete_automation_job(
  p_job_id    uuid,
  p_worker_id text   -- must match locked_by from the claim result
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.automation_jobs
  SET status = 'completed', completed_at = now(), locked_at = NULL, locked_by = NULL
  WHERE id = p_job_id AND locked_by = p_worker_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'job not found or not owned by worker %: job=%', p_worker_id, p_job_id
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.complete_automation_job IS
  'Marks a job as successfully completed. Verifies p_worker_id matches locked_by '
  'to prevent ghost-completes when a stale lock expires. SECURITY DEFINER.';

-- ---------------------------------------------------------------------------
-- RPC: fail_automation_job
-- ---------------------------------------------------------------------------
-- Sets last_error and resets status to pending (for retry) unless attempts
-- has reached max_attempts. NOTE: claim_automation_jobs is the single point
-- that increments attempts; this function only reads the already-incremented value.

CREATE OR REPLACE FUNCTION public.fail_automation_job(
  p_job_id    uuid,
  p_worker_id text,                        -- must match locked_by from the claim result
  p_error     text,
  p_run_after timestamptz DEFAULT NULL     -- optional backoff delay
)
RETURNS public.automation_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_result public.automation_jobs;
BEGIN
  UPDATE public.automation_jobs
  SET
    status     = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
    last_error = p_error,
    locked_at  = NULL,
    locked_by  = NULL,
    run_after  = COALESCE(p_run_after, now() + interval '60 seconds')
  WHERE id = p_job_id AND locked_by = p_worker_id
  RETURNING * INTO v_result;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'job not found or not owned by worker %: job=%', p_worker_id, p_job_id
      USING ERRCODE = 'P0001';
  END IF;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.fail_automation_job IS
  'Records a job failure. Verifies p_worker_id matches locked_by. '
  'If attempts < max_attempts (already incremented by claim), resets to '
  'pending for retry. Otherwise marks failed. SECURITY DEFINER.';

-- ---------------------------------------------------------------------------
-- RPC: dead_letter_automation_job
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.dead_letter_automation_job(
  p_job_id    uuid,
  p_worker_id text,   -- must match locked_by from the claim result
  p_reason    text
)
RETURNS public.automation_dead_letters
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_job    public.automation_jobs;
  v_result public.automation_dead_letters;
BEGIN
  SELECT * INTO v_job
  FROM public.automation_jobs
  WHERE id = p_job_id AND locked_by = p_worker_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'job not found or not owned by worker %: job=%', p_worker_id, p_job_id
      USING ERRCODE = 'P0001';
  END IF;

  -- Guard: only claimed or failed jobs can be dead-lettered
  IF v_job.status NOT IN ('claimed', 'failed') THEN
    RAISE EXCEPTION 'cannot dead-letter a job in status %: job=%', v_job.status, p_job_id
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.automation_jobs
  SET status = 'dead_lettered', locked_at = NULL, locked_by = NULL
  WHERE id = p_job_id;

  -- UNIQUE(original_job_id) on automation_dead_letters makes a double-call a hard error
  INSERT INTO public.automation_dead_letters
    (organization_id, original_job_id, job_kind, source_kind, source_id,
     last_error, payload, attempts)
  VALUES
    (v_job.organization_id, v_job.id, v_job.job_kind, v_job.source_kind,
     v_job.source_id, p_reason, v_job.payload, v_job.attempts)
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.dead_letter_automation_job IS
  'Moves a terminal job to the dead_letters table. Verifies p_worker_id matches '
  'locked_by and that the job is in claimed/failed status. The UNIQUE constraint '
  'on original_job_id makes double-dead-lettering a hard DB error. SECURITY DEFINER.';

-- ---------------------------------------------------------------------------
-- Grants for RPCs
-- ---------------------------------------------------------------------------

GRANT EXECUTE ON FUNCTION public.enqueue_automation_job(uuid,text,text,uuid,int,timestamptz,int,jsonb)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_automation_jobs(text,text[],int,int)                               TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_automation_job(uuid,text)                                       TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_automation_job(uuid,text,text,timestamptz)                         TO service_role;
GRANT EXECUTE ON FUNCTION public.dead_letter_automation_job(uuid,text,text)                               TO service_role;

REVOKE ALL ON FUNCTION public.enqueue_automation_job(uuid,text,text,uuid,int,timestamptz,int,jsonb)   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.claim_automation_jobs(text,text[],int,int)                               FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.complete_automation_job(uuid,text)                                       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fail_automation_job(uuid,text,text,timestamptz)                         FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dead_letter_automation_job(uuid,text,text)                               FROM PUBLIC, anon;
