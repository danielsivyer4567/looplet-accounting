-- 0105: approve() / reject() — admin-gated resolution of a pending approval.
--
-- Phase 2.B (SC-2.B.02). Two RPCs that resolve a pending approvals row (0102):
-- approve() flips it to 'approved', reject() to 'rejected'. Both are owner/admin
-- only and stamp resolved_by/resolved_at; the UPDATE fires the 0103 audit trigger,
-- so every resolution lands in audit_log immutably.
--
-- The resolution invariant (authenticated + admin gate + pending-only + stamp) lives
-- in ONE place — the internal _resolve_approval() helper — so approve and reject can
-- never drift. approve/reject are thin wrappers. _resolve is NOT granted to clients;
-- it's reachable only through the two wrappers (which run as the DEFINER owner).
--
-- require_role(org,'admin') RETURNS boolean (it does NOT raise) and is true for rank
-- >= admin, i.e. admin OR owner — so we test it and raise ourselves. SECURITY DEFINER
-- + pinned search_path = public (0060). Depends on SC-2.B.01 + SC-2.A.03.

CREATE OR REPLACE FUNCTION public._resolve_approval(
  p_approval_id uuid,
  p_new_status  public.approval_status,
  p_reason      text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org    uuid;
  v_status public.approval_status;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  SELECT organization_id, status INTO v_org, v_status
    FROM public.approvals
   WHERE id = p_approval_id AND deleted_at IS NULL;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'approval not found';
  END IF;

  -- owner/admin only (require_role is true for rank >= admin, i.e. admin or owner).
  IF NOT public.require_role(v_org, 'admin'::public.org_role) THEN
    RAISE EXCEPTION 'insufficient privilege: admin role required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- a precise message for the common case (already resolved).
  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'approval already resolved (status=%)', v_status
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- atomic guard: WHERE status='pending' so two concurrent resolves can't both apply.
  UPDATE public.approvals
     SET status        = p_new_status,
         resolved_by   = auth.uid(),
         resolved_at   = now(),
         reject_reason = CASE WHEN p_new_status = 'rejected' THEN p_reason ELSE reject_reason END
   WHERE id = p_approval_id AND status = 'pending' AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'approval already resolved (concurrent)'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.approve(p_approval_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$ BEGIN PERFORM public._resolve_approval(p_approval_id, 'approved'::public.approval_status, NULL); END; $$;

-- Rejecting a money-mover guardrail action requires a stated reason — it lands in
-- reject_reason and the immutable audit trail, so a veto is always accountable.
CREATE OR REPLACE FUNCTION public.reject(p_approval_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'rejection reason required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM public._resolve_approval(p_approval_id, 'rejected'::public.approval_status, p_reason);
END;
$$;

-- 0060 hardening: no implicit PUBLIC execute; clients reach resolution only via
-- approve/reject, never the internal _resolve_approval helper.
REVOKE ALL ON FUNCTION public._resolve_approval(uuid, public.approval_status, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approve(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reject(uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
