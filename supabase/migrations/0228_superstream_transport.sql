-- ============================================================================
-- 0228_superstream_transport.sql  (P2-SUPER)
--
-- SuperStream / clearing-house transport path:
--   * employee_super_fund_accounts captures fund USI/member-number details
--   * super_batch_lines are enriched with fund details + validation errors
--   * build_superstream_payload(batch) returns a documented clearing-house file
--     payload for external upload; live clearing-house API dispatch remains
--     fail-closed until provider credentials/specs are configured.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.employee_super_fund_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  fund_name text NOT NULL CHECK (length(btrim(fund_name)) > 0),
  fund_abn text CHECK (fund_abn IS NULL OR fund_abn ~ '^[0-9]{11}$'),
  fund_usi text NOT NULL CHECK (length(btrim(fund_usi)) > 0),
  member_number text NOT NULL CHECK (length(btrim(member_number)) > 0),
  payment_reference text,
  is_default boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id)
);

ALTER TABLE public.employee_super_fund_accounts
  DROP CONSTRAINT IF EXISTS employee_super_fund_one_default;

CREATE UNIQUE INDEX IF NOT EXISTS employee_super_fund_one_default_idx
  ON public.employee_super_fund_accounts (employee_id)
  WHERE is_default IS TRUE;

CREATE INDEX IF NOT EXISTS employee_super_fund_accounts_org_employee_idx
  ON public.employee_super_fund_accounts (organization_id, employee_id);

COMMENT ON TABLE public.employee_super_fund_accounts IS
  'Employee default super fund account for SuperStream/clearing-house files. '
  'fund_usi and member_number are required before a super batch can be exported.';

ALTER TABLE public.super_batch_lines
  ADD COLUMN IF NOT EXISTS fund_name text,
  ADD COLUMN IF NOT EXISTS fund_abn text,
  ADD COLUMN IF NOT EXISTS payment_reference text,
  ADD COLUMN IF NOT EXISTS validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.super_batches
  ADD COLUMN IF NOT EXISTS transport_mode text NOT NULL DEFAULT 'clearing_house_file'
    CHECK (transport_mode IN ('clearing_house_file', 'api')),
  ADD COLUMN IF NOT EXISTS transport_payload_hash text,
  ADD COLUMN IF NOT EXISTS transport_reference text,
  ADD COLUMN IF NOT EXISTS transported_at timestamptz,
  ADD COLUMN IF NOT EXISTS transport_response jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION public.employee_super_fund_accounts_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.employees e
     WHERE e.id = NEW.employee_id
       AND e.organization_id = NEW.organization_id
       AND e.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'employee % does not belong to organization %', NEW.employee_id, NEW.organization_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS employee_super_fund_accounts_guard
  ON public.employee_super_fund_accounts;
CREATE TRIGGER employee_super_fund_accounts_guard
  BEFORE INSERT OR UPDATE ON public.employee_super_fund_accounts
  FOR EACH ROW EXECUTE FUNCTION public.employee_super_fund_accounts_guard();

DROP TRIGGER IF EXISTS employee_super_fund_accounts_audit
  ON public.employee_super_fund_accounts;
CREATE TRIGGER employee_super_fund_accounts_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.employee_super_fund_accounts
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger_v2();

ALTER TABLE public.employee_super_fund_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS employee_super_fund_accounts_select
  ON public.employee_super_fund_accounts;
CREATE POLICY employee_super_fund_accounts_select
  ON public.employee_super_fund_accounts FOR SELECT
  TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS employee_super_fund_accounts_insert
  ON public.employee_super_fund_accounts;
CREATE POLICY employee_super_fund_accounts_insert
  ON public.employee_super_fund_accounts FOR INSERT
  TO authenticated
  WITH CHECK (
    organization_id IN (SELECT public.get_accessible_org_ids())
    AND public.require_role(organization_id, 'admin'::public.org_role)
  );

DROP POLICY IF EXISTS employee_super_fund_accounts_update
  ON public.employee_super_fund_accounts;
CREATE POLICY employee_super_fund_accounts_update
  ON public.employee_super_fund_accounts FOR UPDATE
  TO authenticated
  USING (
    organization_id IN (SELECT public.get_accessible_org_ids())
    AND public.require_role(organization_id, 'admin'::public.org_role)
  )
  WITH CHECK (
    organization_id IN (SELECT public.get_accessible_org_ids())
    AND public.require_role(organization_id, 'admin'::public.org_role)
  );

DROP POLICY IF EXISTS employee_super_fund_accounts_delete
  ON public.employee_super_fund_accounts;
CREATE POLICY employee_super_fund_accounts_delete
  ON public.employee_super_fund_accounts FOR DELETE
  TO authenticated
  USING (
    organization_id IN (SELECT public.get_accessible_org_ids())
    AND public.require_role(organization_id, 'admin'::public.org_role)
  );

REVOKE ALL ON public.employee_super_fund_accounts FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_super_fund_accounts TO authenticated;

CREATE OR REPLACE FUNCTION public.generate_super_batch(
  p_org uuid,
  p_fy_start_year integer,
  p_quarter integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_batch_id uuid;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.super_batches
    WHERE organization_id = p_org
      AND fy_start_year = p_fy_start_year
      AND quarter = p_quarter
      AND status IN ('sent', 'confirmed')
      AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'super batch for FY% Q% is already sent/confirmed', p_fy_start_year, p_quarter;
  END IF;

  DELETE FROM public.super_batches
  WHERE organization_id = p_org
    AND fy_start_year = p_fy_start_year
    AND quarter = p_quarter
    AND status IN ('draft', 'approved')
    AND deleted_at IS NULL;

  INSERT INTO public.super_batches (organization_id, fy_start_year, quarter, status, created_by)
  VALUES (p_org, p_fy_start_year, p_quarter, 'draft', auth.uid())
  RETURNING id INTO v_batch_id;

  WITH slip_rollup AS (
    SELECT
      ps.employee_id,
      e.full_name,
      SUM(ps.super_guarantee_cents)::bigint AS super_cents
    FROM public.pay_slips ps
    JOIN public.pay_runs pr ON pr.id = ps.pay_run_id
    JOIN public.employees e ON e.id = ps.employee_id
    CROSS JOIN LATERAL public.au_bas_quarter(pr.pay_date)
      q(fy_start_year, quarter_num, quarter_start, quarter_end, due_date)
    WHERE ps.organization_id = p_org
      AND pr.status IN ('approved', 'paid')
      AND q.fy_start_year = p_fy_start_year
      AND q.quarter_num = p_quarter
      AND ps.super_guarantee_cents > 0
    GROUP BY ps.employee_id, e.full_name
  ),
  ins AS (
    INSERT INTO public.super_batch_lines (
      batch_id,
      organization_id,
      employee_id,
      employee_name,
      super_cents,
      fund_name,
      fund_abn,
      fund_usi,
      member_number,
      payment_reference,
      validation_errors
    )
    SELECT
      v_batch_id,
      p_org,
      r.employee_id,
      r.full_name,
      r.super_cents,
      f.fund_name,
      f.fund_abn,
      f.fund_usi,
      f.member_number,
      f.payment_reference,
      (
        SELECT COALESCE(jsonb_agg(msg), '[]'::jsonb)
        FROM (
          SELECT 'missing default super fund account' AS msg WHERE f.id IS NULL
          UNION ALL SELECT 'missing fund USI' WHERE COALESCE(f.fund_usi, '') = ''
          UNION ALL SELECT 'missing member number' WHERE COALESCE(f.member_number, '') = ''
        ) errs
      )
    FROM slip_rollup r
    LEFT JOIN public.employee_super_fund_accounts f
      ON f.employee_id = r.employee_id
     AND f.organization_id = p_org
     AND f.is_default IS TRUE
    RETURNING super_cents
  )
  UPDATE public.super_batches b
     SET total_super_cents = COALESCE((SELECT SUM(super_cents) FROM ins), 0),
         line_count = (SELECT COUNT(*) FROM ins)
   WHERE b.id = v_batch_id;

  RETURN v_batch_id;
END;
$$;

COMMENT ON FUNCTION public.generate_super_batch(uuid, integer, integer) IS
  'Builds a fresh draft super_batch for an org+FY-quarter, enriching lines with employee default '
  'fund USI/member-number details and validation errors required for clearing-house export.';

CREATE OR REPLACE FUNCTION public.build_superstream_payload(p_batch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_batch public.super_batches%ROWTYPE;
  v_lines jsonb := '[]'::jsonb;
  v_error_count integer := 0;
  v_input_hash text;
BEGIN
  SELECT *
    INTO v_batch
    FROM public.super_batches
   WHERE id = p_batch_id
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'super batch not found: %', p_batch_id;
  END IF;

  IF v_batch.organization_id NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RAISE EXCEPTION 'not authorized to build superstream payload for batch %', p_batch_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT
    COALESCE(jsonb_agg(
      jsonb_build_object(
        'line_id', id,
        'employee_id', employee_id,
        'employee_name', employee_name,
        'fund_name', fund_name,
        'fund_abn', fund_abn,
        'fund_usi', fund_usi,
        'member_number', member_number,
        'payment_reference', payment_reference,
        'super_cents', super_cents,
        'validation_errors', validation_errors
      )
      ORDER BY employee_name, id
    ), '[]'::jsonb),
    COALESCE(SUM(jsonb_array_length(validation_errors)), 0)::int
    INTO v_lines, v_error_count
  FROM public.super_batch_lines
  WHERE batch_id = p_batch_id;

  v_input_hash := encode(
    digest(
      jsonb_build_object(
        'super_batch_id', p_batch_id,
        'total_super_cents', v_batch.total_super_cents,
        'line_count', v_batch.line_count,
        'lines', v_lines
      )::text,
      'sha256'
    ),
    'hex'
  );

  RETURN jsonb_build_object(
    'schema_version', 'build_superstream_payload:v1',
    'super_batch_id', p_batch_id,
    'organization_id', v_batch.organization_id,
    'fy_start_year', v_batch.fy_start_year,
    'quarter', v_batch.quarter,
    'status', v_batch.status,
    'transport', jsonb_build_object(
      'mode', 'clearing_house_file',
      'live_dispatch_enabled', false,
      'reason', 'No clearing-house API transport is configured; export this payload for upload to the nominated clearing house'
    ),
    'summary', jsonb_build_object(
      'line_count', v_batch.line_count,
      'total_super_cents', v_batch.total_super_cents,
      'validation_error_count', v_error_count,
      'ready_for_external_upload', v_error_count = 0 AND v_batch.line_count > 0
    ),
    'lines', v_lines,
    'evidence', jsonb_build_object(
      'source_tables', jsonb_build_array('super_batches', 'super_batch_lines', 'employee_super_fund_accounts', 'pay_runs', 'pay_slips'),
      'input_hash', v_input_hash,
      'source_version', 'build_superstream_payload:v1',
      'source_label', 'ATO SuperStream employer contributions',
      'source_url', 'https://www.ato.gov.au/businesses-and-organisations/super-for-employers/paying-super-contributions/superstream'
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.build_superstream_payload(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.build_superstream_payload(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
