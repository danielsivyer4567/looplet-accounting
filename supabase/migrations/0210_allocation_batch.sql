-- ============================================================================
-- Migration: 0210_allocation_batch
-- Adds batch allocation tooling for unallocated bills:
--   v_allocation_queue          — bills awaiting job allocation with suggestions
--   bulk_accept_job_suggestions — one-shot RPC to confirm all high-score suggestions
--   rematch_unallocated_bills   — re-run match_job_for_bill on unmatched bills
-- Both RPCs are SECURITY DEFINER; callers must be org members (enforced via
-- get_accessible_org_ids()). EXECUTE revoked from PUBLIC, anon, authenticated.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- View: v_allocation_queue
-- Bills that still need a job allocated (job_id IS NULL), surfacing any fuzzy
-- suggestion already stored on the row plus the candidate job details.
-- SECURITY INVOKER so the caller's RLS applies — only rows the caller can see
-- via the bills/jobs RLS policies will be returned.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_allocation_queue
WITH (security_invoker = on)
AS
SELECT
  b.id                        AS bill_id,
  b.organization_id,
  b.status,
  b.supplier_name_raw,
  b.invoice_number,
  b.invoice_date,
  b.total_inc_gst_cents,
  b.job_reference_raw,
  b.suggested_job_id,
  b.suggested_match_score     AS score,
  j.job_number                AS suggested_job_number,
  j.name                      AS suggested_job_name,
  j.status                    AS suggested_job_status,
  b.created_at
FROM public.bills b
LEFT JOIN public.jobs j
       ON j.id = b.suggested_job_id
      AND j.deleted_at IS NULL
WHERE b.job_id     IS NULL
  AND b.deleted_at IS NULL
  AND b.status IN ('received', 'verified');

COMMENT ON VIEW public.v_allocation_queue IS
  'Bills that have not yet been allocated to a job. Includes any fuzzy-match '
  'suggestion (suggested_job_id / score) stored by match_job_for_bill(). '
  'SECURITY INVOKER — caller sees only what their RLS policies permit.';

-- ----------------------------------------------------------------------------
-- RPC: bulk_accept_job_suggestions
-- Accepts every pending fuzzy suggestion for an org that meets the minimum
-- score threshold. Moves the bill to status=''attached'' in a single UPDATE.
--
-- AuthZ: caller must be a member of p_org_id (get_accessible_org_ids()).
-- Returns: { ok: bool, attached: int }
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bulk_accept_job_suggestions(
  p_org_id    uuid,
  p_min_score numeric DEFAULT 0.85
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_attached integer := 0;
BEGIN
  -- Verify the caller is a member of the target org.
  IF p_org_id NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RAISE EXCEPTION 'not a member of organization %', p_org_id
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.bills
  SET
    job_id               = suggested_job_id,
    suggested_job_id     = NULL,
    suggested_match_score = NULL,
    status               = 'attached',
    attached_at          = now(),
    attached_by          = auth.uid()
  WHERE organization_id      = p_org_id
    AND job_id              IS NULL
    AND suggested_job_id    IS NOT NULL
    AND suggested_match_score >= p_min_score
    AND deleted_at          IS NULL
    AND status IN ('received', 'verified');

  GET DIAGNOSTICS v_attached = ROW_COUNT;

  RETURN jsonb_build_object(
    'ok',       true,
    'attached', v_attached
  );
END;
$$;

COMMENT ON FUNCTION public.bulk_accept_job_suggestions(uuid, numeric) IS
  'Accepts all pending job suggestions for an org whose score meets p_min_score '
  '(default 0.85). Sets job_id = suggested_job_id, clears suggestion columns, '
  'and flips status to ''attached''. Returns { ok, attached }. '
  'SECURITY DEFINER with explicit org-membership check; EXECUTE revoked from '
  'PUBLIC, anon, and authenticated.';

REVOKE EXECUTE ON FUNCTION public.bulk_accept_job_suggestions(uuid, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.bulk_accept_job_suggestions(uuid, numeric) FROM anon;
REVOKE EXECUTE ON FUNCTION public.bulk_accept_job_suggestions(uuid, numeric) FROM authenticated;

-- ----------------------------------------------------------------------------
-- RPC: rematch_unallocated_bills
-- Re-runs match_job_for_bill() for bills that have a job_reference_raw string
-- but no suggestion yet (suggested_job_id IS NULL) and no confirmed match.
-- Applies the same threshold semantics as the bills-extract edge function:
--   score >= 1.0  -> auto-attach  (job_id set, status = 'attached')
--   score >= 0.5  -> suggestion   (suggested_job_id + suggested_match_score set)
--   score <  0.5  -> skipped      (bill left unchanged)
--
-- AuthZ: caller must be a member of p_org_id (get_accessible_org_ids()).
-- Returns: { ok: bool, auto_attached: int, suggested: int, skipped: int }
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rematch_unallocated_bills(
  p_org_id  uuid,
  p_limit   integer DEFAULT 500
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bill            record;
  v_matched_id      uuid;
  v_score           real;
  v_auto_attached   integer := 0;
  v_suggested       integer := 0;
  v_skipped         integer := 0;
BEGIN
  -- Verify the caller is a member of the target org.
  IF p_org_id NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RAISE EXCEPTION 'not a member of organization %', p_org_id
      USING ERRCODE = 'P0001';
  END IF;

  FOR v_bill IN
    SELECT id, job_reference_raw
    FROM public.bills
    WHERE organization_id  = p_org_id
      AND job_id          IS NULL
      AND suggested_job_id IS NULL
      AND job_reference_raw IS NOT NULL
      AND deleted_at      IS NULL
      AND status IN ('received', 'verified')
    ORDER BY created_at DESC
    LIMIT p_limit
  LOOP
    -- Call the existing scorer; take only the top candidate (LIMIT 1 in the CTE).
    SELECT matched_job_id, score
      INTO v_matched_id, v_score
      FROM public.match_job_for_bill(p_org_id, v_bill.job_reference_raw)
     LIMIT 1;

    IF v_matched_id IS NULL OR v_score IS NULL THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    IF v_score >= 1.0 THEN
      UPDATE public.bills
         SET job_id      = v_matched_id,
             status      = 'attached',
             attached_at = now(),
             attached_by = auth.uid()
       WHERE id = v_bill.id;
      v_auto_attached := v_auto_attached + 1;

    ELSIF v_score >= 0.5 THEN
      UPDATE public.bills
         SET suggested_job_id     = v_matched_id,
             suggested_match_score = v_score
       WHERE id = v_bill.id;
      v_suggested := v_suggested + 1;

    ELSE
      v_skipped := v_skipped + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok',            true,
    'auto_attached', v_auto_attached,
    'suggested',     v_suggested,
    'skipped',       v_skipped
  );
END;
$$;

COMMENT ON FUNCTION public.rematch_unallocated_bills(uuid, integer) IS
  'Re-runs match_job_for_bill() on bills that have a job_reference_raw but no '
  'existing suggestion or confirmed match. Score >= 1.0 -> auto-attached; '
  'score >= 0.5 -> stored as suggestion; otherwise skipped. Returns '
  '{ ok, auto_attached, suggested, skipped }. '
  'SECURITY DEFINER with explicit org-membership check; EXECUTE revoked from '
  'PUBLIC, anon, and authenticated.';

REVOKE EXECUTE ON FUNCTION public.rematch_unallocated_bills(uuid, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rematch_unallocated_bills(uuid, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.rematch_unallocated_bills(uuid, integer) FROM authenticated;
