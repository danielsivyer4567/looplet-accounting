-- ============================================================================
-- 20260630171500_automation_backbone_definer_hardening.sql
--
-- HARDENING follow-up to 20260630170735_automation_backbone_repair.sql.
--
-- Supabase security advisors (run right after the repair landed) flagged that
-- several SECURITY DEFINER functions from the epic carry an implicit EXECUTE
-- grant to PUBLIC — the `REVOKE ... FROM PUBLIC, anon` lines in the original
-- migrations do not remove a grant that PostgreSQL hands to PUBLIC *by default*
-- on every new function, and `REVOKE FROM anon` is a no-op when the privilege
-- is held via PUBLIC. (See the documented definer-fn-grant gotcha.)
--
-- CONFIRMED EXPLOIT (rolled-back live probe, impersonating the `anon` role):
--   SET ROLE anon; SELECT public.replay_bank_event('<id>');
--   -> returned ok:true WITH the raw_payload. An UNAUTHENTICATED caller hitting
--      /rest/v1/rpc/replay_bank_event with a known/guessed event UUID could read
--      raw bank payloads. Root causes: (1) PUBLIC EXECUTE grant; (2) the function
--      treats auth.uid() IS NULL as "service_role, allow", but anon is also NULL.
--
-- This migration:
--   1. Revokes EXECUTE from PUBLIC + anon + authenticated on the worker-internal
--      and replay functions (they are service_role-only by design).
--   2. Re-grants EXECUTE to service_role explicitly (idempotent safety).
--   3. Hardens replay_bank_event so it FAILS CLOSED for any non-service caller:
--      it now requires the caller to be service_role (auth.role() = 'service_role'),
--      so even an accidental future grant can't leak payloads to anon/authenticated.
--
-- Functions intentionally left executable by `authenticated` (org-authz enforced
-- internally) — NOT touched here: enqueue_automation_job, get_confidence_policy,
-- upsert_confidence_policy, delete_confidence_policy.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Worker-internal job RPCs: service_role only.
--    These were granted to service_role in 0211 but PUBLIC's default EXECUTE
--    (and an authenticated grant the advisor flagged) left them callable by
--    signed-in users. Lock them to service_role.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.claim_automation_jobs(text,text[],int,int)        FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_automation_job(uuid,text)                FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fail_automation_job(uuid,text,text,timestamptz)   FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.dead_letter_automation_job(uuid,text,text)        FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_automation_jobs(text,text[],int,int)        TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_automation_job(uuid,text)                TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_automation_job(uuid,text,text,timestamptz)   TO service_role;
GRANT EXECUTE ON FUNCTION public.dead_letter_automation_job(uuid,text,text)        TO service_role;

-- ---------------------------------------------------------------------------
-- 2. replay_bank_event: revoke from PUBLIC/anon/authenticated; service_role only.
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.replay_bank_event(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.replay_bank_event(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Defense-in-depth: replay_bank_event fails closed for any non-service caller.
--    Previously `auth.uid() IS NULL` was the allow-path, which also matched anon.
--    Now we require the service_role JWT claim explicitly. service_role clients
--    (the bank-sync / replay edge fns) set role=service_role; everyone else is denied.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.replay_bank_event(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.bank_events_raw%ROWTYPE;
BEGIN
  -- Fail closed: only the service_role may replay raw events. auth.role() reads
  -- the JWT 'role' claim; for anon/authenticated callers it is not 'service_role'.
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not authorized');
  END IF;

  SELECT * INTO v_row FROM public.bank_events_raw WHERE id = p_event_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'event not found');
  END IF;

  RETURN jsonb_build_object(
    'ok',                true,
    'event_id',          v_row.id,
    'provider',          v_row.provider,
    'provider_event_id', v_row.provider_event_id,
    'raw_payload',       v_row.raw_payload,
    'received_at',       v_row.received_at
  );
END;
$$;

-- Re-assert grants after CREATE OR REPLACE so the final ACL is explicit.
REVOKE EXECUTE ON FUNCTION public.replay_bank_event(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.replay_bank_event(uuid) TO service_role;

COMMENT ON FUNCTION public.replay_bank_event IS
  'Returns the stored raw payload for a bank event so an edge fn can re-run '
  'normalisation. service_role ONLY (fails closed for anon/authenticated). '
  'Hardened in 20260630171500 after an advisor flagged PUBLIC/anon EXECUTE.';
