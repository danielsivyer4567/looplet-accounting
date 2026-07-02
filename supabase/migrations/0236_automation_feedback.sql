-- ============================================================================
-- 0236_automation_feedback.sql
--
-- Records owner/advisor corrections to automation decisions. Each row tracks
-- what was changed, by whom, and why. Repeated accepted decisions can be
-- promoted into deterministic org-level rules.
--
-- Append-only audit: rows are never updated or deleted.
-- SECURITY INVOKER views for reads; SECURITY DEFINER RPC for inserts.
-- ============================================================================

-- -- Table -------------------------------------------------------------------

CREATE TABLE public.automation_feedback (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source_kind       TEXT NOT NULL,  -- 'bill_coding', 'bank_match', 'gst_treatment', 'supplier', 'job_tag', 'asset_class', 'confidence_outcome'
  source_id         TEXT NOT NULL,  -- the decision or resource ID this correction applies to
  previous_value    JSONB,          -- what the automation suggested
  new_value         JSONB NOT NULL, -- what the user chose instead
  correction_reason TEXT,           -- optional user-provided reason
  accepted_by       UUID REFERENCES auth.users(id),
  accepted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  promoted_to_rule  BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_automation_feedback_org
  ON public.automation_feedback (organization_id, source_kind);

CREATE INDEX idx_automation_feedback_source
  ON public.automation_feedback (source_kind, source_id);

COMMENT ON TABLE public.automation_feedback IS
  'Append-only log of user corrections to automation suggestions. '
  'Used by the learning loop to detect patterns and promote to rules.';

-- -- RLS ---------------------------------------------------------------------

ALTER TABLE public.automation_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "automation_feedback_select_org"
  ON public.automation_feedback
  FOR SELECT
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

CREATE POLICY automation_feedback_no_client_insert
  ON public.automation_feedback
  FOR INSERT TO authenticated
  WITH CHECK (false);

CREATE POLICY automation_feedback_no_client_update
  ON public.automation_feedback
  FOR UPDATE TO authenticated
  USING (false);

CREATE POLICY automation_feedback_no_client_delete
  ON public.automation_feedback
  FOR DELETE TO authenticated
  USING (false);

-- -- RPC: record_feedback ---------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_feedback(
  p_organization_id UUID,
  p_source_kind     TEXT,
  p_source_id       TEXT,
  p_previous_value  JSONB DEFAULT NULL,
  p_new_value       JSONB DEFAULT NULL,
  p_correction_reason TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_organization_id NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RAISE EXCEPTION 'organization not accessible' USING ERRCODE = 'P0001';
  END IF;

  IF p_new_value IS NULL THEN
    RAISE EXCEPTION 'new feedback value is required' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.automation_feedback (
    organization_id, source_kind, source_id,
    previous_value, new_value, correction_reason,
    accepted_by
  ) VALUES (
    p_organization_id, p_source_kind, p_source_id,
    p_previous_value, p_new_value, p_correction_reason,
    auth.uid()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_feedback TO authenticated;
REVOKE ALL ON FUNCTION public.record_feedback FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_feedback FROM anon;

-- -- View: aggregated feedback for rule promotion ---------------------------

CREATE VIEW public.v_feedback_patterns
WITH (security_invoker = on) AS
SELECT
  organization_id,
  source_kind,
  new_value,
  count(*) AS occurrence_count,
  min(accepted_at) AS first_seen_at,
  max(accepted_at) AS last_seen_at
FROM public.automation_feedback
WHERE promoted_to_rule = false
GROUP BY organization_id, source_kind, new_value
HAVING count(*) >= 3;

COMMENT ON VIEW public.v_feedback_patterns IS
  'Aggregates feedback by org, source_kind, and chosen value showing patterns '
  'with 3+ occurrences eligible for rule promotion.';

GRANT SELECT ON public.automation_feedback TO authenticated;
GRANT SELECT ON public.v_feedback_patterns TO authenticated;
REVOKE ALL ON public.automation_feedback FROM PUBLIC;
REVOKE ALL ON public.automation_feedback FROM anon;
REVOKE ALL ON public.v_feedback_patterns FROM PUBLIC;
REVOKE ALL ON public.v_feedback_patterns FROM anon;
