-- 0104: request_approval() — open (or auto-resolve) an approvals row.
--
-- Phase 2.B (SC-2.B.01). The single entry point that creates an approvals row
-- (0102) for a gated action. Hashes the payload to bind the approval to exact
-- content, maps the risk tier to an initial status, and is idempotent on
-- (org, resource_type, resource_id, payload_hash).
--
-- SECURITY DEFINER + pinned search_path = public (0060 hardening). AuthZ mirrors
-- create_api_key (0068): a real authenticated user who is a member of p_org — this
-- closes the cross-tenant IDOR (a caller can't open approvals in someone else's org).
--
-- HASH CONTRACT: payload_hash = encode(digest(p_payload::text,'sha256'),'hex').
-- p_payload is jsonb, whose ::text is canonical (sorted keys, normalized), so equal
-- payloads hash equally. digest lives in the `extensions` schema, so it is qualified
-- (the pinned search_path = public would not find it unqualified). NOTE for SC-2.B.03 /
-- SC-2.C: any caller computing this hash must reproduce Postgres jsonb::text exactly
-- (Deno JSON.stringify drops the spaces jsonb::text keeps) — prefer hashing in PG.

CREATE OR REPLACE FUNCTION public.request_approval(
  p_org           uuid,
  p_resource_type text,
  p_resource_id   uuid,
  p_risk_tier     public.approval_risk_tier,
  p_payload       jsonb
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hash   text;
  v_status public.approval_status;
  v_id     uuid;
BEGIN
  -- AuthZ: real user, member of the org (cf. 0068 create_api_key).
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_org NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RAISE EXCEPTION 'organization not accessible';
  END IF;

  -- Bind the approval to the exact payload content.
  v_hash := encode(extensions.digest(p_payload::text, 'sha256'), 'hex');

  -- Idempotency: a live row for this exact (org, resource, payload) already exists.
  SELECT a.id INTO v_id
    FROM public.approvals a
   WHERE a.organization_id = p_org
     AND a.resource_type   = p_resource_type
     AND a.resource_id     = p_resource_id
     AND a.payload_hash    = v_hash
     AND a.deleted_at IS NULL;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  -- Tier mapping (§3.2): only tier2_approve gates (pending). tier0_silent and
  -- tier1_notify both proceed -> auto-resolved 'approved'. Auto-resolved rows set
  -- resolved_at but leave resolved_by NULL, so they stay distinguishable from a
  -- human approval (which stamps resolved_by in approve(), SC-2.B.02).
  v_status := CASE WHEN p_risk_tier = 'tier2_approve'
                   THEN 'pending'::public.approval_status
                   ELSE 'approved'::public.approval_status END;

  BEGIN
    INSERT INTO public.approvals (
      organization_id, risk_tier, status, resource_type, resource_id, payload_hash,
      requested_by, requested_at, created_by, resolved_at
    ) VALUES (
      p_org, p_risk_tier, v_status, p_resource_type, p_resource_id, v_hash,
      auth.uid(), now(), auth.uid(),
      CASE WHEN v_status = 'approved' THEN now() ELSE NULL END
    )
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    -- Lost an idempotency race: return the row the concurrent winner inserted.
    SELECT a.id INTO v_id
      FROM public.approvals a
     WHERE a.organization_id = p_org
       AND a.resource_type   = p_resource_type
       AND a.resource_id     = p_resource_id
       AND a.payload_hash    = v_hash
       AND a.deleted_at IS NULL;
  END;

  RETURN v_id;
END;
$$;

-- 0060 hardening: no implicit PUBLIC execute on a DEFINER function.
REVOKE ALL ON FUNCTION public.request_approval(uuid, text, uuid, public.approval_risk_tier, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_approval(uuid, text, uuid, public.approval_risk_tier, jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
