-- 0106: is_action_approved() — the single Tier-2 approval guard.
--
-- Phase 2.B (SC-2.B.03). THE read guard every money-mover/lodgement calls before
-- it acts: Phase 3 super-batch send (SC-3.G.01) and the whole Phase 7 DSP lodge
-- track (SC-7.B/7.D/7.E) all reuse it. Returns TRUE only when a live, human-approved
-- tier2 row binds to the EXACT payload — so approve-then-mutate-payload can't pass.
--
-- Pure predicate, STABLE SECURITY DEFINER + pinned search_path = public (0060): the
-- DEFINER bypass means an authenticated user and a service_role edge fn get the SAME
-- answer regardless of RLS. AuthZ of the *caller* to the resource is the money-mover's
-- job (it does its own membership check); this fn only answers "is this exact action
-- approved?". The (org,resource_type,resource_id,payload_hash) lookup is served by the
-- 0102 partial unique index; tier+status are then checked on that single row.
--
-- TWO forms (the hash form's signature is the stable forward contract — do not change):
--   * (..., p_payload_hash text)  — canonical; caller already holds the hash.
--   * (..., p_payload jsonb)      — convenience overload that hashes IN Postgres with
--     the SAME canonical expression as request_approval (0104), so edge-fn callers pass
--     the jsonb payload and never serialize JSON in Deno (whose JSON.stringify spacing
--     differs from jsonb::text and would silently mismatch the hash).

CREATE OR REPLACE FUNCTION public.is_action_approved(
  p_org           uuid,
  p_resource_type text,
  p_resource_id   uuid,
  p_payload_hash  text
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.approvals a
     WHERE a.organization_id = p_org
       AND a.resource_type   = p_resource_type
       AND a.resource_id     = p_resource_id
       AND a.payload_hash    = p_payload_hash
       AND a.risk_tier       = 'tier2_approve'
       AND a.status          = 'approved'
       AND a.deleted_at IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION public.is_action_approved(
  p_org           uuid,
  p_resource_type text,
  p_resource_id   uuid,
  p_payload       jsonb
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_action_approved(
    p_org, p_resource_type, p_resource_id,
    encode(extensions.digest(p_payload::text, 'sha256'), 'hex')
  );
$$;

-- 0060 hardening: no implicit PUBLIC execute. Granted to authenticated (UI) and
-- service_role (edge fns call the guard via the admin client).
REVOKE ALL ON FUNCTION public.is_action_approved(uuid, text, uuid, text)  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_action_approved(uuid, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_action_approved(uuid, text, uuid, text)  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_action_approved(uuid, text, uuid, jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
