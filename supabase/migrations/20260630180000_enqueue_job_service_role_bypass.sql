-- ============================================================================
-- 20260630180000_enqueue_job_service_role_bypass.sql
--
-- Fixes a blocker in the SC-09 `ingest` edge function (found by the deploy-
-- readiness analysis): `enqueue_automation_job` gates on
-- `get_accessible_org_ids()`, which returns an EMPTY set for a bare service-role
-- client (auth.uid() IS NULL, no organization_id JWT claim). So the ingest
-- function — which calls this RPC via the service-role client to enqueue
-- document/payment jobs — gets `organization not accessible` (P0001) on every
-- call. Confirmed against live prod via pg_get_functiondef + a rolled-back
-- service-role probe.
--
-- Fix: add a service_role bypass to the org-gate, mirroring the
-- replay_bank_event hardening (20260630171500). The service_role is the trusted
-- backend identity (it already bypasses RLS everywhere); letting it enqueue for
-- any org is correct. For `authenticated` callers (the RPC is also granted to
-- authenticated, e.g. UI-driven enqueue) auth.role() is NOT 'service_role', so
-- the org-membership check is UNCHANGED and still enforced — no privilege
-- widening for end users.
--
-- CREATE OR REPLACE preserves the existing signature, ACL (grants), and the
-- pinned search_path. No other caller's behavior changes.
-- ============================================================================

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
  -- service_role (trusted backend: ingest, workers) may enqueue for any org.
  -- authenticated callers still must belong to the target org. auth.role()
  -- reads the request JWT 'role' claim, which reflects the CALLER even inside
  -- this SECURITY DEFINER function.
  IF coalesce(auth.role(), '') <> 'service_role'
     AND p_org_id NOT IN (SELECT public.get_accessible_org_ids()) THEN
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
  'Adds a job to the automation queue. SECURITY DEFINER. service_role bypasses '
  'the org-accessibility gate (trusted backend: ingest/workers); authenticated '
  'callers must belong to the target org. Bypass added 20260630180000.';
