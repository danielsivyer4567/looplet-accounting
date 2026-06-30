-- ============================================================================
-- 0214_confidence_policies.sql
--
-- Table-driven confidence policy overrides.
-- Lets orgs (and optionally per-supplier) override the default confidence band
-- for a given source_kind + task_type combination.
--
-- Specificity precedence (most to least):
--   1. org + supplier + source_kind + task_type
--   2. org + source_kind + task_type
--   3. (no match → caller uses its computed band)
--
-- RPC: get_confidence_policy — returns the most specific active policy or NULL.
--
-- SECURITY: authenticated clients SELECT only; writes via DEFINER RPC or
-- service_role. anon/public blocked.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Table: confidence_policies
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.confidence_policies (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Scope filters (NULL = wildcard for that dimension)
  supplier_id   uuid,       -- NULL = applies to all suppliers
  source_kind   text        NOT NULL,  -- 'bill_upload' | 'bank_match' | 'coding_suggestion' | 'receipt_ocr'
  task_type     text        NOT NULL,  -- 'supplier_match' | 'category' | 'gst_treatment' | 'job_tag' | 'asset_treatment'

  -- The override
  policy        public.automation_confidence NOT NULL,

  -- Validity window (NULL = no bound on that side)
  valid_from    timestamptz NOT NULL DEFAULT now(),
  valid_until   timestamptz,

  -- Audit
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

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE public.confidence_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY conf_policies_select ON public.confidence_policies
  FOR SELECT TO authenticated
  USING (org_id IN (SELECT public.get_accessible_org_ids()));

CREATE POLICY conf_policies_no_direct_insert ON public.confidence_policies
  FOR INSERT TO authenticated WITH CHECK (false);

CREATE POLICY conf_policies_no_direct_update ON public.confidence_policies
  FOR UPDATE TO authenticated USING (false);

CREATE POLICY conf_policies_no_direct_delete ON public.confidence_policies
  FOR DELETE TO authenticated USING (false);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT SELECT ON public.confidence_policies TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.confidence_policies TO service_role;
REVOKE ALL ON public.confidence_policies FROM PUBLIC, anon;

-- ---------------------------------------------------------------------------
-- RPC: get_confidence_policy
-- ---------------------------------------------------------------------------
-- Returns the most specific active policy for the given org/source/task,
-- optionally refined by supplier. Returns NULL when no policy matches.
-- Specificity: supplier-scoped beats org-wide; ties broken by valid_from DESC.

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

  -- Supplier-specific match first (only when supplier provided)
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

  -- Org-wide match (no supplier filter)
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

  RETURN v_policy;  -- NULL when no policy found
END;
$$;

COMMENT ON FUNCTION public.get_confidence_policy IS
  'Returns the most specific active confidence policy for the given org/source/task '
  '(supplier-scoped beats org-wide). Returns NULL when no policy matches. '
  'SECURITY DEFINER — enforces org accessibility; callers provide their own org.';

-- ---------------------------------------------------------------------------
-- RPC: upsert_confidence_policy
-- ---------------------------------------------------------------------------
-- Authenticated callers create or replace a policy. Enforces org membership.

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

-- ---------------------------------------------------------------------------
-- RPC: delete_confidence_policy
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- Grants for RPCs
-- ---------------------------------------------------------------------------

GRANT EXECUTE ON FUNCTION public.get_confidence_policy(uuid,text,text,uuid)          TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_confidence_policy(uuid,text,text,public.automation_confidence,uuid,timestamptz,timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_confidence_policy(uuid,uuid)                  TO authenticated;

REVOKE ALL ON FUNCTION public.get_confidence_policy(uuid,text,text,uuid)          FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.upsert_confidence_policy(uuid,text,text,public.automation_confidence,uuid,timestamptz,timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_confidence_policy(uuid,uuid)                  FROM PUBLIC, anon;
