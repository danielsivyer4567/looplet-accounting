-- ============================================================================
-- 0232_automation_decisions.sql
--
-- Records AI/automation suggestions alongside human acceptance or override.
-- Every row is an indivisible decision record: the AI proposes, the human
-- either accepts or overrides. Never updated once resolved.
--
-- SECURITY: SELECT-only for authenticated clients (RLS). Writes go through
-- SECURITY DEFINER RPCs or backend functions.
-- ============================================================================

-- -- Enum: automation_confidence ------------------------------------------------

CREATE TYPE public.automation_confidence AS ENUM (
  'auto_post',
  'quick_confirm',
  'review_needed',
  'advisor_required',
  'blocked_external'
);

COMMENT ON TYPE public.automation_confidence IS
  'Confidence bands for AI/automation decisions. Maps to owner-facing task '
  'urgency and determines whether the suggestion can auto-post or needs review.';

-- -- Table: automation_decisions ------------------------------------------------

CREATE TABLE public.automation_decisions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Source (what was being processed)
  source_kind        text NOT NULL,       -- 'bill_upload', 'bank_match', 'coding_suggestion', 'receipt_ocr'
  source_id          uuid NOT NULL,       -- FK to the source row (bills, bank_transactions, etc.)

  -- The decision
  decision_kind      text NOT NULL,       -- 'supplier_match', 'category', 'gst_treatment', 'job_tag', 'asset_treatment'
  suggested_treatment jsonb NOT NULL,     -- the AI-suggested value(s)
  confidence         public.automation_confidence NOT NULL,
  reason_codes       text[] NOT NULL DEFAULT '{}',
  evidence_refs      jsonb,               -- supporting evidence (matched ids, OCR snapshots)
  policy_refs        jsonb,               -- deterministic rules that contributed

  -- Resolution (one of accepted or overridden is set when resolved)
  accepted_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  accepted_at        timestamptz,
  overridden_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  override_reason    text,

  -- Audit
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Exactly one resolution path, never both
  CONSTRAINT chk_single_resolution CHECK (
    (accepted_by IS NULL AND accepted_at IS NULL)
    OR (overridden_by IS NULL AND override_reason IS NULL)
  )
);

COMMENT ON TABLE public.automation_decisions IS
  'One row per AI/automation decision. Suggested treatments are recorded at '
  'creation time; a human later accepts (accepted_at) or overrides '
  '(overridden_by + reason). Once resolved, the row is immutable.';

-- -- Indexes --------------------------------------------------------------------

CREATE INDEX idx_auto_decisions_org_source
  ON public.automation_decisions (organization_id, source_kind, source_id);
CREATE INDEX idx_auto_decisions_unresolved
  ON public.automation_decisions (organization_id)
  WHERE accepted_at IS NULL AND overridden_by IS NULL;

-- -- Trigger: prevent mutation after resolution --------------------------------

CREATE OR REPLACE FUNCTION public.block_resolved_decision_change()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.accepted_at IS NOT NULL OR OLD.overridden_by IS NOT NULL THEN
    RAISE EXCEPTION 'cannot mutate a resolved automation_decision (%)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_decisions_block_resolved ON public.automation_decisions;
CREATE TRIGGER trg_auto_decisions_block_resolved
  BEFORE UPDATE ON public.automation_decisions
  FOR EACH ROW EXECUTE FUNCTION public.block_resolved_decision_change();

-- -- RLS ------------------------------------------------------------------------

ALTER TABLE public.automation_decisions ENABLE ROW LEVEL SECURITY;

-- Clients can SELECT resolved decisions (for UI display) and unresolved ones
-- (for review queues). Writes flow through DEFINER RPCs or backend functions.
CREATE POLICY auto_decisions_select ON public.automation_decisions
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

-- Block client INSERT/UPDATE/DELETE — all writes go through backend
CREATE POLICY auto_decisions_no_client_insert ON public.automation_decisions
  FOR INSERT TO authenticated
  WITH CHECK (false);

CREATE POLICY auto_decisions_no_client_update ON public.automation_decisions
  FOR UPDATE TO authenticated
  USING (false);

CREATE POLICY auto_decisions_no_client_delete ON public.automation_decisions
  FOR DELETE TO authenticated
  USING (false);

-- -- Grants ---------------------------------------------------------------------

GRANT SELECT ON public.automation_decisions TO authenticated;
GRANT INSERT, UPDATE ON public.automation_decisions TO service_role;

-- Revoke public/anon
REVOKE ALL ON public.automation_decisions FROM PUBLIC;
REVOKE ALL ON public.automation_decisions FROM anon;

-- -- RPC: record_automation_decision -------------------------------------------
--
-- SECURITY DEFINER so the backend can INSERT despite client-blocking RLS.
-- Scoped to the caller's accessible orgs via get_accessible_org_ids().

CREATE OR REPLACE FUNCTION public.record_automation_decision(
  p_org_id              uuid,
  p_source_kind         text,
  p_source_id           uuid,
  p_decision_kind       text,
  p_suggested_treatment jsonb,
  p_confidence          public.automation_confidence,
  p_reason_codes        text[] DEFAULT '{}',
  p_evidence_refs       jsonb DEFAULT NULL,
  p_policy_refs         jsonb DEFAULT NULL
)
RETURNS public.automation_decisions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_result public.automation_decisions;
BEGIN
  IF p_org_id NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RAISE EXCEPTION 'organization not accessible' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.automation_decisions
    (organization_id, source_kind, source_id, decision_kind,
     suggested_treatment, confidence, reason_codes, evidence_refs,
     policy_refs, created_by)
  VALUES
    (p_org_id, p_source_kind, p_source_id, p_decision_kind,
     p_suggested_treatment, p_confidence, p_reason_codes, p_evidence_refs,
     p_policy_refs, auth.uid())
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.record_automation_decision IS
  'Inserts a new automation decision row. SECURITY DEFINER bypasses '
  'client-INSERT RLS but enforces org accessibility.';

-- -- RPC: override_automation_decision ------------------------------------------
--
-- Records a human override of a previous decision. Marks the original as
-- overridden and inserts a new row with the override reason.

CREATE OR REPLACE FUNCTION public.override_automation_decision(
  p_original_id         uuid,
  p_org_id              uuid,
  p_source_kind         text,
  p_source_id           uuid,
  p_decision_kind       text,
  p_suggested_treatment jsonb,
  p_confidence          public.automation_confidence,
  p_reason_codes        text[] DEFAULT '{}',
  p_override_reason     text DEFAULT ''
)
RETURNS public.automation_decisions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_original public.automation_decisions;
  v_result   public.automation_decisions;
BEGIN
  IF p_org_id NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RAISE EXCEPTION 'organization not accessible' USING ERRCODE = 'P0001';
  END IF;

  -- Lock the original row to prevent race conditions
  SELECT * INTO v_original
  FROM public.automation_decisions
  WHERE id = p_original_id AND organization_id = p_org_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'original decision not found' USING ERRCODE = 'P0001';
  END IF;

  IF v_original.overridden_by IS NOT NULL THEN
    RAISE EXCEPTION 'decision already overridden' USING ERRCODE = 'P0001';
  END IF;

  -- Mark original as overridden
  UPDATE public.automation_decisions
  SET overridden_by = auth.uid(), override_reason = p_override_reason
  WHERE id = p_original_id;

  -- Insert the new override row
  INSERT INTO public.automation_decisions
    (organization_id, source_kind, source_id, decision_kind,
     suggested_treatment, confidence, reason_codes, evidence_refs,
     policy_refs, created_by)
  VALUES
    (p_org_id, p_source_kind, p_source_id, p_decision_kind,
     p_suggested_treatment, p_confidence, p_reason_codes,
     NULL, NULL, auth.uid())
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.override_automation_decision IS
  'Records a human override of a previous AI decision. Marks the original '
  'row with overridden_by/reason and inserts a new decision row with the '
  'human-supplied values. SECURITY DEFINER.';

-- Grants for the RPCs
GRANT EXECUTE ON FUNCTION public.record_automation_decision TO authenticated;
GRANT EXECUTE ON FUNCTION public.override_automation_decision TO authenticated;
REVOKE ALL ON FUNCTION public.record_automation_decision FROM PUBLIC;
REVOKE ALL ON FUNCTION public.override_automation_decision FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_automation_decision FROM anon;
REVOKE ALL ON FUNCTION public.override_automation_decision FROM anon;
