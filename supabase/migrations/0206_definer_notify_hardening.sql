-- ============================================================================
-- Migration: 0206_definer_notify_hardening
-- Project:   Looplet Accounting  (finish-line: P1-06 security hardening)
-- Purpose:   Close a cross-tenant IDOR in public.notify() and tighten EXECUTE
--            grants on SECURITY DEFINER write functions that should not be
--            world-/anon-/authenticated-callable.
--
--   BACKGROUND
--   ----------
--   public.notify(...) (migration 0040) is SECURITY DEFINER and INSERTs straight
--   into public.notifications, bypassing that table's INSERT RLS (there is none
--   for end users — writes are intended to flow only through this function or
--   service_role). It was GRANTed to `authenticated` with NO org-membership
--   check in its body, so ANY logged-in user could forge a notification into ANY
--   organisation (spoofed "bas_due"/"cron_failed" alerts, injected links, etc.)
--   — a classic cross-tenant IDOR mirroring the reporting-view leak fixed in
--   0055. All three real callers
--     - functions/notifications-cron/index.ts
--     - functions/accountant-orchestrator/index.ts
--     - functions/payroll-finalise-pay-run/index.ts
--   invoke notify() through a service_role ("admin") client, where auth.uid() is
--   NULL. We therefore add a body guard that only constrains *interactive*
--   callers (auth.uid() IS NOT NULL): they must belong to the target org via
--   public.get_accessible_org_ids(). service_role keeps full reach so the cron /
--   orchestrator / payroll paths are unaffected.
--
--   GRANT HARDENING (each function + rationale)
--   -------------------------------------------
--   * public.notify(...)                       — keep authenticated+service_role
--       EXECUTE (the body guard is now the real protection), but REVOKE FROM
--       PUBLIC/anon defensively. Belt-and-braces over 0055 which only revoked
--       anon.
--   * public.close_idle_accountant_sessions()  — service_role ONLY. This is a
--       cron worker (scheduled every 5 min, migration 0054) that sweeps idle
--       sessions across EVERY org with no caller-org scoping; no frontend code
--       invokes it. Letting any authenticated user trigger a global cross-tenant
--       sweep is needless privilege. REVOKE FROM authenticated/anon/PUBLIC and
--       GRANT to service_role only.
--
--   DELIBERATELY LEFT ALONE (authenticated callers legitimately need these — all
--   already enforce their own in-body org/role guard):
--     - public.notify(...)                      (now guarded — see above)
--     - public.request_approval(...)            (guards get_accessible_org_ids)
--     - public.approve(uuid) / public.reject(uuid,text) (guard require_role admin)
--     - public.issue_receipt_identity(...)      (guards get_accessible_org_ids)
--     - public.payroll_finalise_pay_run(uuid)   (guards require_role owner + approval)
--     - public.create_organization_with_owner(text) (creates caller's own org)
--     - public.accept_pending_invites()         (scoped to auth.uid()'s invites)
--     - public.run_data_completeness_scan(uuid) (scoped read/write for caller org)
--     - public.accountant_session_heartbeat(...) (caller's own session)
--     - public.get_accessible_org_ids() / public.is_agency_user()
--           (hardened in 0060; used inside RLS USING clauses — MUST stay
--            EXECUTEable by authenticated)
--
--   No orphaned/duplicate SECURITY DEFINER functions are present in this repo to
--   drop (the deduct_credits / check_rate_limit ports referenced by 0055 have no
--   definition here; 0055 already revoked them defensively via to_regprocedure).
--
--   Idempotent: CREATE OR REPLACE + guarded REVOKE/GRANT are all re-runnable, so
--   `supabase db push` no-ops on an already-patched database.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. notify() — add the org-membership guard.
--    Body is byte-for-byte the 0040 definition plus the leading guard block.
--    Signature, SECURITY DEFINER, SET search_path = public, and return type are
--    preserved exactly so the existing service_role callers keep working.
-- ----------------------------------------------------------------------------
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
  -- Org-membership guard (P1-06): an interactive caller may only create
  -- notifications inside an organisation they belong to. service_role has
  -- auth.uid() IS NULL and is the legitimate producer (cron / orchestrator /
  -- payroll edge functions), so it is exempt and retains full reach.
  IF auth.uid() IS NOT NULL
     AND p_org NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RAISE EXCEPTION 'organization not accessible: %', p_org
      USING ERRCODE = 'insufficient_privilege';
  END IF;

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

COMMENT ON FUNCTION public.notify(uuid, text, text, text, text, text, uuid, text, uuid, jsonb) IS
  'INSERT a notification row. SECURITY DEFINER so callers do not need direct write access to public.notifications. Interactive callers (auth.uid() not null) may only target an org they belong to via get_accessible_org_ids(); service_role is exempt.';

-- ----------------------------------------------------------------------------
-- 2. EXECUTE-grant hardening on definer write functions.
--    Guarded with to_regprocedure() so the migration never aborts when a
--    signature is unexpectedly absent (e.g. a partially-reset local DB).
-- ----------------------------------------------------------------------------
DO $harden$
DECLARE
  v_notify_sig text := 'public.notify(uuid,text,text,text,text,text,uuid,text,uuid,jsonb)';
  v_close_sig  text := 'public.close_idle_accountant_sessions()';
BEGIN
  -- notify(): body guard is the real protection; keep authenticated+service_role
  -- EXECUTE but strip PUBLIC/anon (belt-and-braces over 0055's anon-only revoke).
  IF to_regprocedure(v_notify_sig) IS NOT NULL THEN
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon;', v_notify_sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role;', v_notify_sig);
  ELSE
    RAISE NOTICE 'Skipping % (not found in this database)', v_notify_sig;
  END IF;

  -- close_idle_accountant_sessions(): cron-only, cross-org sweep → service_role only.
  IF to_regprocedure(v_close_sig) IS NOT NULL THEN
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated;', v_close_sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role;', v_close_sig);
  ELSE
    RAISE NOTICE 'Skipping % (not found in this database)', v_close_sig;
  END IF;
END
$harden$;

-- Make PostgREST pick up the changed function signature/grants immediately.
NOTIFY pgrst, 'reload schema';

COMMIT;
