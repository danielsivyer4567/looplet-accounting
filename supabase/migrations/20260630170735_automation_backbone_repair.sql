-- ============================================================================
-- 20260630170735_automation_backbone_repair.sql
--
-- FORWARD-ONLY REPAIR for the Automation Backbone epic (SC-01..SC-08).
--
-- WHY: local migrations 0211-0219 were authored for this epic, but on prod
-- those migration NUMBERS were consumed out-of-band by a different GL-posting
-- chain (0211=cron_heartbeat ... 0219=payment_run_payroll_gl_posting). As a
-- result `supabase db push` will never apply the epic's DDL, and verification
-- confirmed NONE of the epic's objects exist live (automation_jobs,
-- confidence_policies, document_extraction_versions, bank_events_raw,
-- reconciliation_evidence, browser_sessions/browser_job_runs — all absent).
--
-- This migration sits ABOVE the remote head (timestamp 20260630124815) and
-- re-applies the epic schema idempotently. It is a verbatim consolidation of:
--   0211_automation_jobs.sql            (SC-01)
--   0214_confidence_policies.sql        (SC-04)
--   0215_document_extraction_versions.sql (SC-05)
--   0217_raw_bank_events.sql            (SC-06)
--   0218_reconciliation_evidence.sql    (SC-07)
--   0219_browser_jobs.sql               (SC-08)
-- in dependency order (automation_jobs first; everything else is independent).
--
-- IDEMPOTENCY: tables/indexes use IF NOT EXISTS; functions use CREATE OR
-- REPLACE; every CREATE POLICY is preceded by DROP POLICY IF EXISTS so the
-- whole file is safely re-runnable. The migration runner wraps this in a
-- single transaction — no inner BEGIN/COMMIT.
--
-- Prereqs verified present on prod: automation_confidence enum, organizations,
-- bills, bank_transactions, auth.users, get_accessible_org_ids(),
-- automation_feedback.
-- ============================================================================

-- ████████████████████████████████████████████████████████████████████████████
-- SC-01 — automation jobs framework (from 0211_automation_jobs.sql)
-- ████████████████████████████████████████████████████████████████████████████

DO $$ BEGIN
  CREATE TYPE public.automation_job_status AS ENUM (
    'pending', 'claimed', 'completed', 'failed', 'dead_lettered'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON TYPE public.automation_job_status IS
  'Lifecycle states for automation_jobs rows.';

CREATE TABLE IF NOT EXISTS public.automation_jobs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  job_kind         text        NOT NULL,
  source_kind      text,
  source_id        uuid,
  status           public.automation_job_status NOT NULL DEFAULT 'pending',
  priority         int         NOT NULL DEFAULT 5,
  run_after        timestamptz NOT NULL DEFAULT now(),
  attempts         int         NOT NULL DEFAULT 0,
  max_attempts     int         NOT NULL DEFAULT 3,
  locked_at        timestamptz,
  locked_by        text,
  last_error       text,
  enqueued_at      timestamptz NOT NULL DEFAULT now(),
  enqueued_by      uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  completed_at     timestamptz,
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

CREATE TABLE IF NOT EXISTS public.automation_job_steps (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid        NOT NULL REFERENCES public.automation_jobs(id) ON DELETE CASCADE,
  step_name   text        NOT NULL,
  status      text        NOT NULL DEFAULT 'started',
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  result      jsonb,
  error       text
);

COMMENT ON TABLE public.automation_job_steps IS
  'Append-only per-step audit log. Each automation job records steps as it '
  'progresses so failures can be diagnosed without re-running the whole job.';

CREATE INDEX IF NOT EXISTS idx_auto_job_steps_job
  ON public.automation_job_steps (job_id, started_at);

CREATE TABLE IF NOT EXISTS public.automation_artifacts (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        uuid        NOT NULL REFERENCES public.automation_jobs(id) ON DELETE CASCADE,
  kind          text        NOT NULL,
  storage_path  text,
  payload_hash  text,
  metadata      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.automation_artifacts IS
  'Evidence attached to automation jobs: screenshots, hashed payloads, '
  'response bodies, DB proof references. Immutable once written.';

CREATE INDEX IF NOT EXISTS idx_auto_artifacts_job
  ON public.automation_artifacts (job_id, kind);

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
  resolved_at      timestamptz,
  resolved_by      uuid        REFERENCES auth.users(id),
  CONSTRAINT uq_dead_letters_original_job UNIQUE (original_job_id)
);

COMMENT ON TABLE public.automation_dead_letters IS
  'Terminal failures that exceeded max_attempts and need human attention. '
  'Each row corresponds to one dead-lettered automation_job.';

CREATE INDEX IF NOT EXISTS idx_auto_dead_letters_org
  ON public.automation_dead_letters (organization_id, dead_lettered_at)
  WHERE resolved_at IS NULL;

ALTER TABLE public.automation_jobs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_job_steps    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_artifacts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_dead_letters ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS auto_jobs_select ON public.automation_jobs;
CREATE POLICY auto_jobs_select ON public.automation_jobs
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS auto_jobs_no_insert ON public.automation_jobs;
CREATE POLICY auto_jobs_no_insert ON public.automation_jobs
  FOR INSERT TO authenticated WITH CHECK (false);

DROP POLICY IF EXISTS auto_jobs_no_update ON public.automation_jobs;
CREATE POLICY auto_jobs_no_update ON public.automation_jobs
  FOR UPDATE TO authenticated USING (false);

DROP POLICY IF EXISTS auto_jobs_no_delete ON public.automation_jobs;
CREATE POLICY auto_jobs_no_delete ON public.automation_jobs
  FOR DELETE TO authenticated USING (false);

DROP POLICY IF EXISTS auto_steps_select ON public.automation_job_steps;
CREATE POLICY auto_steps_select ON public.automation_job_steps
  FOR SELECT TO authenticated
  USING (
    job_id IN (
      SELECT id FROM public.automation_jobs
      WHERE organization_id IN (SELECT public.get_accessible_org_ids())
    )
  );

DROP POLICY IF EXISTS auto_steps_no_insert ON public.automation_job_steps;
CREATE POLICY auto_steps_no_insert ON public.automation_job_steps
  FOR INSERT TO authenticated WITH CHECK (false);

DROP POLICY IF EXISTS auto_steps_no_update ON public.automation_job_steps;
CREATE POLICY auto_steps_no_update ON public.automation_job_steps
  FOR UPDATE TO authenticated USING (false);

DROP POLICY IF EXISTS auto_artifacts_select ON public.automation_artifacts;
CREATE POLICY auto_artifacts_select ON public.automation_artifacts
  FOR SELECT TO authenticated
  USING (
    job_id IN (
      SELECT id FROM public.automation_jobs
      WHERE organization_id IN (SELECT public.get_accessible_org_ids())
    )
  );

DROP POLICY IF EXISTS auto_artifacts_no_insert ON public.automation_artifacts;
CREATE POLICY auto_artifacts_no_insert ON public.automation_artifacts
  FOR INSERT TO authenticated WITH CHECK (false);

DROP POLICY IF EXISTS auto_artifacts_no_update ON public.automation_artifacts;
CREATE POLICY auto_artifacts_no_update ON public.automation_artifacts
  FOR UPDATE TO authenticated USING (false);

DROP POLICY IF EXISTS auto_dead_letters_select ON public.automation_dead_letters;
CREATE POLICY auto_dead_letters_select ON public.automation_dead_letters
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS auto_dead_letters_no_insert ON public.automation_dead_letters;
CREATE POLICY auto_dead_letters_no_insert ON public.automation_dead_letters
  FOR INSERT TO authenticated WITH CHECK (false);

DROP POLICY IF EXISTS auto_dead_letters_no_update ON public.automation_dead_letters;
CREATE POLICY auto_dead_letters_no_update ON public.automation_dead_letters
  FOR UPDATE TO authenticated USING (false);

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

CREATE OR REPLACE FUNCTION public.claim_automation_jobs(
  p_worker_id  text,
  p_job_kinds  text[]  DEFAULT NULL,
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
  'IMPORTANT: claim_automation_jobs is the ONLY place that increments attempts.';

CREATE OR REPLACE FUNCTION public.complete_automation_job(
  p_job_id    uuid,
  p_worker_id text
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

CREATE OR REPLACE FUNCTION public.fail_automation_job(
  p_job_id    uuid,
  p_worker_id text,
  p_error     text,
  p_run_after timestamptz DEFAULT NULL
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

CREATE OR REPLACE FUNCTION public.dead_letter_automation_job(
  p_job_id    uuid,
  p_worker_id text,
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

  IF v_job.status NOT IN ('claimed', 'failed') THEN
    RAISE EXCEPTION 'cannot dead-letter a job in status %: job=%', v_job.status, p_job_id
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.automation_jobs
  SET status = 'dead_lettered', locked_at = NULL, locked_by = NULL
  WHERE id = p_job_id;

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

GRANT EXECUTE ON FUNCTION public.enqueue_automation_job(uuid,text,text,uuid,int,timestamptz,int,jsonb)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_automation_jobs(text,text[],int,int)                               TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_automation_job(uuid,text)                                       TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_automation_job(uuid,text,text,timestamptz)                          TO service_role;
GRANT EXECUTE ON FUNCTION public.dead_letter_automation_job(uuid,text,text)                               TO service_role;

REVOKE ALL ON FUNCTION public.enqueue_automation_job(uuid,text,text,uuid,int,timestamptz,int,jsonb)   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.claim_automation_jobs(text,text[],int,int)                               FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.complete_automation_job(uuid,text)                                       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fail_automation_job(uuid,text,text,timestamptz)                          FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dead_letter_automation_job(uuid,text,text)                               FROM PUBLIC, anon;

-- ████████████████████████████████████████████████████████████████████████████
-- SC-04 — confidence policies (from 0214_confidence_policies.sql)
-- ████████████████████████████████████████████████████████████████████████████

CREATE TABLE IF NOT EXISTS public.confidence_policies (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  supplier_id   uuid,
  source_kind   text        NOT NULL,
  task_type     text        NOT NULL,
  policy        public.automation_confidence NOT NULL,
  valid_from    timestamptz NOT NULL DEFAULT now(),
  valid_until   timestamptz,
  created_by    uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_policy_valid_window CHECK (
    valid_until IS NULL OR valid_until > valid_from
  )
);

COMMENT ON TABLE public.confidence_policies IS
  'Per-org (optionally per-supplier) policy overrides for confidence bands. '
  'The most specific active policy wins over the computed confidence.';

CREATE INDEX IF NOT EXISTS idx_confidence_policies_org
  ON public.confidence_policies (org_id, source_kind, task_type, valid_from);

CREATE INDEX IF NOT EXISTS idx_confidence_policies_supplier
  ON public.confidence_policies (org_id, supplier_id, source_kind, task_type)
  WHERE supplier_id IS NOT NULL;

ALTER TABLE public.confidence_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conf_policies_select ON public.confidence_policies;
CREATE POLICY conf_policies_select ON public.confidence_policies
  FOR SELECT TO authenticated
  USING (org_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS conf_policies_no_direct_insert ON public.confidence_policies;
CREATE POLICY conf_policies_no_direct_insert ON public.confidence_policies
  FOR INSERT TO authenticated WITH CHECK (false);

DROP POLICY IF EXISTS conf_policies_no_direct_update ON public.confidence_policies;
CREATE POLICY conf_policies_no_direct_update ON public.confidence_policies
  FOR UPDATE TO authenticated USING (false);

DROP POLICY IF EXISTS conf_policies_no_direct_delete ON public.confidence_policies;
CREATE POLICY conf_policies_no_direct_delete ON public.confidence_policies
  FOR DELETE TO authenticated USING (false);

GRANT SELECT ON public.confidence_policies TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.confidence_policies TO service_role;
REVOKE ALL ON public.confidence_policies FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.get_confidence_policy(
  p_org_id      uuid,
  p_source_kind text,
  p_task_type   text,
  p_supplier_id uuid DEFAULT NULL
)
RETURNS public.automation_confidence
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_policy public.automation_confidence;
BEGIN
  IF p_org_id NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RAISE EXCEPTION 'organization not accessible' USING ERRCODE = 'P0001';
  END IF;

  IF p_supplier_id IS NOT NULL THEN
    SELECT policy INTO v_policy
    FROM public.confidence_policies
    WHERE org_id      = p_org_id
      AND supplier_id = p_supplier_id
      AND source_kind = p_source_kind
      AND task_type   = p_task_type
      AND valid_from  <= now()
      AND (valid_until IS NULL OR valid_until > now())
    ORDER BY valid_from DESC
    LIMIT 1;

    IF FOUND THEN
      RETURN v_policy;
    END IF;
  END IF;

  SELECT policy INTO v_policy
  FROM public.confidence_policies
  WHERE org_id      = p_org_id
    AND supplier_id IS NULL
    AND source_kind = p_source_kind
    AND task_type   = p_task_type
    AND valid_from  <= now()
    AND (valid_until IS NULL OR valid_until > now())
  ORDER BY valid_from DESC
  LIMIT 1;

  RETURN v_policy;
END;
$$;

COMMENT ON FUNCTION public.get_confidence_policy IS
  'Returns the most specific active confidence policy for the given org/source/task '
  '(supplier-scoped beats org-wide). Returns NULL when no policy matches. '
  'SECURITY DEFINER — enforces org accessibility; callers provide their own org.';

CREATE OR REPLACE FUNCTION public.upsert_confidence_policy(
  p_org_id      uuid,
  p_source_kind text,
  p_task_type   text,
  p_policy      public.automation_confidence,
  p_supplier_id uuid         DEFAULT NULL,
  p_valid_from  timestamptz  DEFAULT now(),
  p_valid_until timestamptz  DEFAULT NULL
)
RETURNS public.confidence_policies
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_result public.confidence_policies;
BEGIN
  IF p_org_id NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RAISE EXCEPTION 'organization not accessible' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.confidence_policies
    (org_id, supplier_id, source_kind, task_type, policy,
     valid_from, valid_until, created_by)
  VALUES
    (p_org_id, p_supplier_id, p_source_kind, p_task_type, p_policy,
     p_valid_from, p_valid_until, auth.uid())
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.upsert_confidence_policy IS
  'Creates a new confidence policy row for the caller''s org. SECURITY DEFINER.';

CREATE OR REPLACE FUNCTION public.delete_confidence_policy(
  p_policy_id uuid,
  p_org_id    uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_org_id NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RAISE EXCEPTION 'organization not accessible' USING ERRCODE = 'P0001';
  END IF;

  DELETE FROM public.confidence_policies
  WHERE id = p_policy_id AND org_id = p_org_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'policy not found: %', p_policy_id USING ERRCODE = 'P0002';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.delete_confidence_policy IS
  'Deletes a confidence policy row owned by the caller''s org. SECURITY DEFINER.';

GRANT EXECUTE ON FUNCTION public.get_confidence_policy(uuid,text,text,uuid)          TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_confidence_policy(uuid,text,text,public.automation_confidence,uuid,timestamptz,timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_confidence_policy(uuid,uuid)                 TO authenticated;

REVOKE ALL ON FUNCTION public.get_confidence_policy(uuid,text,text,uuid)          FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.upsert_confidence_policy(uuid,text,text,public.automation_confidence,uuid,timestamptz,timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_confidence_policy(uuid,uuid)                 FROM PUBLIC, anon;

-- ████████████████████████████████████████████████████████████████████████████
-- SC-05 — document extraction versions (from 0215_document_extraction_versions.sql)
-- ████████████████████████████████████████████████████████████████████████████

CREATE TABLE IF NOT EXISTS public.document_extraction_versions (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id          uuid        NOT NULL REFERENCES public.bills(id) ON DELETE CASCADE,
  organization_id  uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider         text        NOT NULL,
  model            text,
  method           text        NOT NULL CHECK (method IN ('cache', 'text', 'vision')),
  confidence       numeric(4,3),
  extracted_json   jsonb       NOT NULL DEFAULT '{}',
  field_confidence jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.document_extraction_versions IS
  'Append-only extraction history for bills. Each row preserves raw extracted '
  'JSON and provider/confidence so confidence improvements can be audited.';

ALTER TABLE public.document_extraction_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org members read own extraction versions" ON public.document_extraction_versions;
CREATE POLICY "org members read own extraction versions"
  ON public.document_extraction_versions
  FOR SELECT
  TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

CREATE INDEX IF NOT EXISTS idx_dev_bill_id_created
  ON public.document_extraction_versions (bill_id, created_at DESC);

-- ████████████████████████████████████████████████████████████████████████████
-- SC-06 — raw bank events (from 0217_raw_bank_events.sql; inner BEGIN/COMMIT removed)
-- ████████████████████████████████████████████████████████████████████████████

CREATE TABLE IF NOT EXISTS public.bank_events_raw (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid        REFERENCES public.organizations(id),
  provider          text        NOT NULL,
  provider_event_id text        NOT NULL,
  payload_hash      text        NOT NULL,
  raw_payload       jsonb       NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_events_raw_dedup UNIQUE (provider, organization_id, provider_event_id, payload_hash)
);

ALTER TABLE public.bank_events_raw
  ALTER COLUMN organization_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS bank_events_raw_dedup_unmatched
  ON public.bank_events_raw (provider, provider_event_id, payload_hash)
  WHERE organization_id IS NULL;

ALTER TABLE public.bank_events_raw ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org members read bank_events_raw" ON public.bank_events_raw;
CREATE POLICY "org members read bank_events_raw"
  ON public.bank_events_raw FOR SELECT
  USING (
    organization_id IN (SELECT public.get_accessible_org_ids())
  );

GRANT SELECT ON public.bank_events_raw TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bank_events_raw TO service_role;

REVOKE INSERT, UPDATE, DELETE ON public.bank_events_raw FROM authenticated, anon;

CREATE INDEX IF NOT EXISTS idx_bank_events_raw_org_provider
  ON public.bank_events_raw (organization_id, provider, provider_event_id);

ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS raw_event_id uuid REFERENCES public.bank_events_raw(id);

CREATE INDEX IF NOT EXISTS idx_bank_transactions_raw_event
  ON public.bank_transactions (raw_event_id)
  WHERE raw_event_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.replay_bank_event(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.bank_events_raw%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.bank_events_raw WHERE id = p_event_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'event not found');
  END IF;

  IF auth.uid() IS NOT NULL THEN
    IF v_row.organization_id IS NULL OR
       v_row.organization_id NOT IN (SELECT public.get_accessible_org_ids()) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'not authorized');
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok',               true,
    'event_id',         v_row.id,
    'provider',         v_row.provider,
    'provider_event_id', v_row.provider_event_id,
    'raw_payload',      v_row.raw_payload,
    'received_at',      v_row.received_at
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.replay_bank_event(uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.replay_bank_event(uuid) TO authenticated, service_role;

-- ████████████████████████████████████████████████████████████████████████████
-- SC-07 — reconciliation evidence (from 0218_reconciliation_evidence.sql)
-- ████████████████████████████████████████████████████████████████████████████

CREATE TABLE IF NOT EXISTS public.reconciliation_evidence (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_transaction_id uuid        NOT NULL REFERENCES public.bank_transactions(id) ON DELETE CASCADE,
  organization_id     uuid        NOT NULL REFERENCES public.organizations(id),
  reason_codes        text[]      NOT NULL DEFAULT '{}',
  score_components    jsonb       NOT NULL DEFAULT '{}',
  auto_applied        boolean     NOT NULL DEFAULT false,
  skipped_reason      text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reconciliation_evidence_txn_idx
  ON public.reconciliation_evidence (bank_transaction_id);
CREATE INDEX IF NOT EXISTS reconciliation_evidence_org_created_idx
  ON public.reconciliation_evidence (organization_id, created_at DESC);

ALTER TABLE public.reconciliation_evidence ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.reconciliation_evidence TO authenticated;

DROP POLICY IF EXISTS "org_members_read_reconciliation_evidence" ON public.reconciliation_evidence;
CREATE POLICY "org_members_read_reconciliation_evidence"
  ON public.reconciliation_evidence
  FOR SELECT
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

REVOKE INSERT, UPDATE, DELETE
  ON public.reconciliation_evidence FROM authenticated, anon;

-- ████████████████████████████████████████████████████████████████████████████
-- SC-08 — browser job schema (from 0219_browser_jobs.sql)
-- ████████████████████████████████████████████████████████████████████████████

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

DROP POLICY IF EXISTS "org_members_read_browser_sessions" ON public.browser_sessions;
CREATE POLICY "org_members_read_browser_sessions"
  ON public.browser_sessions
  FOR SELECT
  USING (org_id IN (SELECT public.get_accessible_org_ids()));

REVOKE INSERT, UPDATE, DELETE
  ON public.browser_sessions FROM authenticated, anon;

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

DROP POLICY IF EXISTS "org_members_read_browser_job_runs" ON public.browser_job_runs;
CREATE POLICY "org_members_read_browser_job_runs"
  ON public.browser_job_runs
  FOR SELECT
  USING (
    session_id IN (
      SELECT id FROM public.browser_sessions
      WHERE org_id IN (SELECT public.get_accessible_org_ids())
    )
  );

REVOKE INSERT, UPDATE, DELETE
  ON public.browser_job_runs FROM authenticated, anon;
