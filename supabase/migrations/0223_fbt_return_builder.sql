-- ============================================================================
-- 0223_fbt_return_builder.sql  (P2-FBT)
--
-- FBT return builder:
--   * source table for curated FBT benefit inputs
--   * year-keyed FBT rate table
--   * build_fbt_return(org, FBT year-end year) RPC
--   * fbt_return_approval_payload(org, FBT year-end year) RPC
--
-- This is a draft-return builder only. It does not lodge, sign, transmit, or
-- write STP reportable-fringe-benefit amounts.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.fbt_rates (
  fbt_year_end_year integer PRIMARY KEY CHECK (fbt_year_end_year BETWEEN 2000 AND 2100),
  fbt_rate_bps integer NOT NULL CHECK (fbt_rate_bps BETWEEN 0 AND 10000),
  type_1_gross_up_rate_bps integer NOT NULL CHECK (type_1_gross_up_rate_bps > 0),
  type_2_gross_up_rate_bps integer NOT NULL CHECK (type_2_gross_up_rate_bps > 0),
  source_label text NOT NULL,
  source_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.fbt_rates IS
  'FBT return rates by FBT year-end year. Rates are explicit inputs to the return '
  'builder, not hidden application constants.';

INSERT INTO public.fbt_rates (
  fbt_year_end_year,
  fbt_rate_bps,
  type_1_gross_up_rate_bps,
  type_2_gross_up_rate_bps,
  source_label,
  source_url
)
VALUES
  (2025, 4700, 20802, 18868, 'ATO FBT rates and thresholds 2025', 'https://www.ato.gov.au/tax-rates-and-codes/fringe-benefits-tax-rates-and-thresholds'),
  (2026, 4700, 20802, 18868, 'ATO FBT rates and thresholds 2026', 'https://www.ato.gov.au/tax-rates-and-codes/fringe-benefits-tax-rates-and-thresholds')
ON CONFLICT (fbt_year_end_year) DO UPDATE SET
  fbt_rate_bps = EXCLUDED.fbt_rate_bps,
  type_1_gross_up_rate_bps = EXCLUDED.type_1_gross_up_rate_bps,
  type_2_gross_up_rate_bps = EXCLUDED.type_2_gross_up_rate_bps,
  source_label = EXCLUDED.source_label,
  source_url = EXCLUDED.source_url;

ALTER TABLE public.fbt_rates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fbt_rates_select ON public.fbt_rates;
CREATE POLICY fbt_rates_select
  ON public.fbt_rates FOR SELECT
  TO authenticated
  USING (true);

REVOKE ALL ON public.fbt_rates FROM PUBLIC, anon;
GRANT SELECT ON public.fbt_rates TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.fbt_benefit_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  fbt_year_end_year integer NOT NULL CHECK (fbt_year_end_year BETWEEN 2000 AND 2100),
  benefit_kind text NOT NULL CHECK (
    benefit_kind IN (
      'car',
      'car_parking',
      'loan',
      'expense_payment',
      'housing',
      'living_away_from_home',
      'entertainment',
      'residual',
      'other'
    )
  ),
  description text NOT NULL CHECK (length(btrim(description)) > 0),
  employee_reference text,
  taxable_value_cents bigint NOT NULL CHECK (taxable_value_cents >= 0),
  employee_contribution_cents bigint NOT NULL DEFAULT 0 CHECK (employee_contribution_cents >= 0),
  gross_up_type text NOT NULL DEFAULT 'type_1' CHECK (gross_up_type IN ('type_1', 'type_2')),
  is_exempt boolean NOT NULL DEFAULT false,
  exempt_reason text,
  source_reference text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id),
  deleted_at timestamptz,
  CONSTRAINT fbt_exempt_reason_required
    CHECK (is_exempt = false OR length(btrim(COALESCE(exempt_reason, ''))) > 0)
);

CREATE INDEX IF NOT EXISTS fbt_benefit_inputs_org_year_idx
  ON public.fbt_benefit_inputs (organization_id, fbt_year_end_year, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS fbt_benefit_inputs_org_kind_idx
  ON public.fbt_benefit_inputs (organization_id, benefit_kind)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE public.fbt_benefit_inputs IS
  'Curated FBT benefit inputs for the draft FBT return builder. Amounts are '
  'taxable-value cents before gross-up; exempt rows are retained as evidence but '
  'excluded from FBT payable.';

DROP TRIGGER IF EXISTS fbt_benefit_inputs_updated_at
  ON public.fbt_benefit_inputs;
CREATE TRIGGER fbt_benefit_inputs_updated_at
  BEFORE UPDATE ON public.fbt_benefit_inputs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS fbt_benefit_inputs_audit
  ON public.fbt_benefit_inputs;
CREATE TRIGGER fbt_benefit_inputs_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.fbt_benefit_inputs
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger_v2();

ALTER TABLE public.fbt_benefit_inputs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fbt_benefit_inputs_select
  ON public.fbt_benefit_inputs;
CREATE POLICY fbt_benefit_inputs_select
  ON public.fbt_benefit_inputs FOR SELECT
  TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS fbt_benefit_inputs_insert
  ON public.fbt_benefit_inputs;
CREATE POLICY fbt_benefit_inputs_insert
  ON public.fbt_benefit_inputs FOR INSERT
  TO authenticated
  WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS fbt_benefit_inputs_update
  ON public.fbt_benefit_inputs;
CREATE POLICY fbt_benefit_inputs_update
  ON public.fbt_benefit_inputs FOR UPDATE
  TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()))
  WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS fbt_benefit_inputs_delete
  ON public.fbt_benefit_inputs;
CREATE POLICY fbt_benefit_inputs_delete
  ON public.fbt_benefit_inputs FOR DELETE
  TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

REVOKE ALL ON public.fbt_benefit_inputs FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fbt_benefit_inputs TO authenticated;

CREATE OR REPLACE FUNCTION public.build_fbt_return(
  p_org uuid,
  p_fbt_year_end_year integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_period_start date;
  v_period_end date;
  v_due_date date;
  v_profile business_profile%ROWTYPE;
  v_rates fbt_rates%ROWTYPE;
  v_type_1_taxable bigint := 0;
  v_type_2_taxable bigint := 0;
  v_employee_contributions bigint := 0;
  v_exempt_taxable bigint := 0;
  v_grossed_up bigint := 0;
  v_fbt_payable bigint := 0;
  v_input_hash text;
  v_rows jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
BEGIN
  IF p_org IS NULL THEN
    RAISE EXCEPTION 'organization_id is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_fbt_year_end_year IS NULL OR p_fbt_year_end_year NOT BETWEEN 2000 AND 2100 THEN
    RAISE EXCEPTION 'valid FBT year-end year is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_org NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RAISE EXCEPTION 'not authorized to build FBT return for org %', p_org
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_period_start := make_date(p_fbt_year_end_year - 1, 4, 1);
  v_period_end := make_date(p_fbt_year_end_year, 3, 31);
  v_due_date := make_date(p_fbt_year_end_year, 5, 21);

  SELECT *
    INTO v_profile
    FROM public.business_profile
   WHERE organization_id = p_org;

  IF v_profile.organization_id IS NULL THEN
    RAISE EXCEPTION 'build_fbt_return: no business_profile for org %', p_org
      USING ERRCODE = 'no_data_found';
  END IF;

  SELECT *
    INTO v_rates
    FROM public.fbt_rates
   WHERE fbt_year_end_year <= p_fbt_year_end_year
   ORDER BY fbt_year_end_year DESC
   LIMIT 1;

  IF v_rates.fbt_year_end_year IS NULL THEN
    RAISE EXCEPTION 'build_fbt_return: no FBT rates for year %', p_fbt_year_end_year
      USING ERRCODE = 'no_data_found';
  END IF;

  WITH active_inputs AS (
    SELECT
      i.*,
      GREATEST(i.taxable_value_cents - i.employee_contribution_cents, 0)::bigint
        AS net_taxable_value_cents
    FROM public.fbt_benefit_inputs i
    WHERE i.organization_id = p_org
      AND i.fbt_year_end_year = p_fbt_year_end_year
      AND i.deleted_at IS NULL
  ),
  totals AS (
    SELECT
      COALESCE(SUM(net_taxable_value_cents)
        FILTER (WHERE gross_up_type = 'type_1' AND is_exempt = false), 0)::bigint
        AS type_1_taxable,
      COALESCE(SUM(net_taxable_value_cents)
        FILTER (WHERE gross_up_type = 'type_2' AND is_exempt = false), 0)::bigint
        AS type_2_taxable,
      COALESCE(SUM(employee_contribution_cents)
        FILTER (WHERE is_exempt = false), 0)::bigint
        AS employee_contributions,
      COALESCE(SUM(taxable_value_cents)
        FILTER (WHERE is_exempt = true), 0)::bigint
        AS exempt_taxable
    FROM active_inputs
  ),
  rows AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id', id,
        'benefit_kind', benefit_kind,
        'description', description,
        'employee_reference', employee_reference,
        'taxable_value_cents', taxable_value_cents,
        'employee_contribution_cents', employee_contribution_cents,
        'net_taxable_value_cents', net_taxable_value_cents,
        'gross_up_type', gross_up_type,
        'is_exempt', is_exempt,
        'exempt_reason', exempt_reason,
        'source_reference', source_reference
      )
      ORDER BY benefit_kind, description, id
    ), '[]'::jsonb) AS body
    FROM active_inputs
  )
  SELECT
    totals.type_1_taxable,
    totals.type_2_taxable,
    totals.employee_contributions,
    totals.exempt_taxable,
    rows.body
    INTO
      v_type_1_taxable,
      v_type_2_taxable,
      v_employee_contributions,
      v_exempt_taxable,
      v_rows
  FROM totals, rows;

  v_grossed_up := (
    ROUND((v_type_1_taxable * v_rates.type_1_gross_up_rate_bps)::numeric / 10000)
    + ROUND((v_type_2_taxable * v_rates.type_2_gross_up_rate_bps)::numeric / 10000)
  )::bigint;
  v_fbt_payable := ROUND((v_grossed_up * v_rates.fbt_rate_bps)::numeric / 10000)::bigint;

  v_input_hash := encode(
    digest(
      jsonb_build_object(
        'organization_id', p_org,
        'fbt_year_end_year', p_fbt_year_end_year,
        'rates_year', v_rates.fbt_year_end_year,
        'rows', v_rows
      )::text,
      'sha256'
    ),
    'hex'
  );

  IF COALESCE(v_profile.is_fbt_registered, false) = false THEN
    v_warnings := v_warnings || jsonb_build_array(
      'business_profile.is_fbt_registered is false; return is draft/pre-registration only'
    );
  END IF;

  IF COALESCE(v_profile.vehicle_count, 0) > 0 AND v_profile.has_logbook IS DISTINCT FROM true THEN
    v_warnings := v_warnings || jsonb_build_array(
      'vehicle_count is present but business_profile.has_logbook is not true; car-benefit method choice needs evidence review'
    );
  END IF;

  IF jsonb_array_length(v_rows) = 0 THEN
    v_warnings := v_warnings || jsonb_build_array(
      'no fbt_benefit_inputs rows for this FBT year'
    );
  END IF;

  RETURN jsonb_build_object(
    'schema_version', 'build_fbt_return:v1',
    'organization_id', p_org,
    'fbt_year_end_year', p_fbt_year_end_year,
    'period_start', v_period_start,
    'period_end', v_period_end,
    'due_date', v_due_date,
    'registration', jsonb_build_object(
      'is_fbt_registered', COALESCE(v_profile.is_fbt_registered, false),
      'employees_count', COALESCE(v_profile.employees_count, 0),
      'vehicle_count', COALESCE(v_profile.vehicle_count, 0),
      'has_logbook', v_profile.has_logbook
    ),
    'rates', jsonb_build_object(
      'fbt_year_end_year', v_rates.fbt_year_end_year,
      'fbt_rate_bps', v_rates.fbt_rate_bps,
      'type_1_gross_up_rate_bps', v_rates.type_1_gross_up_rate_bps,
      'type_2_gross_up_rate_bps', v_rates.type_2_gross_up_rate_bps,
      'source_label', v_rates.source_label,
      'source_url', v_rates.source_url
    ),
    'summary', jsonb_build_object(
      'type_1_taxable_value_cents', v_type_1_taxable,
      'type_2_taxable_value_cents', v_type_2_taxable,
      'aggregate_taxable_value_cents', v_type_1_taxable + v_type_2_taxable,
      'employee_contributions_cents', v_employee_contributions,
      'exempt_taxable_value_cents', v_exempt_taxable,
      'grossed_up_taxable_amount_cents', v_grossed_up,
      'fbt_payable_cents', v_fbt_payable
    ),
    'benefits', v_rows,
    'evidence', jsonb_build_object(
      'source_tables', jsonb_build_array('fbt_benefit_inputs', 'business_profile', 'fbt_rates'),
      'input_hash', v_input_hash,
      'source_version', 'build_fbt_return:v1'
    ),
    'approval', jsonb_build_object(
      'resource_type', 'fbt_return',
      'resource_id', p_org::text || ':' || p_fbt_year_end_year::text,
      'payload_rpc', 'fbt_return_approval_payload'
    ),
    'warnings', v_warnings,
    'lodgement', jsonb_build_object(
      'enabled', false,
      'reason', 'FBT return builder is draft-only; ATO lodgement remains on the external-gated lodgement TODO list'
    )
  );
END;
$$;

COMMENT ON FUNCTION public.build_fbt_return(uuid, integer) IS
  'Builds a draft FBT return JSON payload for an org and FBT year-end year. '
  'Reads curated fbt_benefit_inputs, explicit fbt_rates, and business_profile '
  'under SECURITY INVOKER/RLS. Does not lodge or write STP/RFBA amounts.';

REVOKE ALL ON FUNCTION public.build_fbt_return(uuid, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.build_fbt_return(uuid, integer)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fbt_return_approval_payload(
  p_org uuid,
  p_fbt_year_end_year integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH ret AS (
    SELECT public.build_fbt_return(p_org, p_fbt_year_end_year) AS body
  )
  SELECT jsonb_build_object(
    'kind', 'fbt_return_approve',
    'organization_id', p_org,
    'fbt_year_end_year', p_fbt_year_end_year,
    'resource_id', p_org::text || ':' || p_fbt_year_end_year::text,
    'period_start', body ->> 'period_start',
    'period_end', body ->> 'period_end',
    'input_hash', body #>> '{evidence,input_hash}',
    'aggregate_taxable_value_cents',
      COALESCE((body #>> '{summary,aggregate_taxable_value_cents}')::bigint, 0),
    'grossed_up_taxable_amount_cents',
      COALESCE((body #>> '{summary,grossed_up_taxable_amount_cents}')::bigint, 0),
    'fbt_payable_cents',
      COALESCE((body #>> '{summary,fbt_payable_cents}')::bigint, 0),
    'benefit_count',
      jsonb_array_length(COALESCE(body -> 'benefits', '[]'::jsonb))
  )
  FROM ret;
$$;

COMMENT ON FUNCTION public.fbt_return_approval_payload(uuid, integer) IS
  'Stable Tier-2 approval payload for FBT return approval. The payload includes '
  'the FBT year identity, key totals, and input_hash so changing benefit rows '
  'invalidates stale approvals.';

REVOKE ALL ON FUNCTION public.fbt_return_approval_payload(uuid, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fbt_return_approval_payload(uuid, integer)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
