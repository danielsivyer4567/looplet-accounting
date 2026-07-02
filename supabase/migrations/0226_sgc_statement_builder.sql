-- ============================================================================
-- 0226_sgc_statement_builder.sql  (P2-SGC)
--
-- Super guarantee correction + SGC draft statement:
--   * statutory SG helper rates, including 12% from 1 July 2025
--   * calc_super_ote(...) wrapper to make the OTE basis explicit
--   * payroll defaults moved from 11.5% to 12%
--   * build_sgc_statement(org, FY start year, quarter) RPC
--
-- This produces a draft Super Guarantee Charge review/statement artifact only.
-- It does not lodge an ATO SGC statement or calculate nominal interest because
-- those require actual payment/lodgment timing and ATO lodgment context.
-- ============================================================================

BEGIN;

INSERT INTO public.system_defaults (key, value, description)
VALUES ('au_super_pct', '12'::jsonb, 'AU statutory super contribution % FY 2026 and later')
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      description = EXCLUDED.description,
      updated_at = now();

ALTER TABLE public.pay_slips
  ALTER COLUMN super_rate_pct SET DEFAULT 12.00;

CREATE INDEX IF NOT EXISTS pay_runs_org_pay_date_status_idx
  ON public.pay_runs (organization_id, pay_date, status, id);

CREATE INDEX IF NOT EXISTS pay_slips_org_run_employee_idx
  ON public.pay_slips (organization_id, pay_run_id, employee_id);

CREATE OR REPLACE FUNCTION public.au_sg_rate_pct(p_pay_date date)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_pay_date >= DATE '2025-07-01' THEN 12.00
    WHEN p_pay_date >= DATE '2024-07-01' THEN 11.50
    WHEN p_pay_date >= DATE '2023-07-01' THEN 11.00
    WHEN p_pay_date >= DATE '2022-07-01' THEN 10.50
    WHEN p_pay_date >= DATE '2021-07-01' THEN 10.00
    ELSE 9.50
  END;
$$;

COMMENT ON FUNCTION public.au_sg_rate_pct(date) IS
  'Australian statutory Super Guarantee rate by pay date. Returns 12.00 from 1 July 2025.';

CREATE OR REPLACE FUNCTION public.calc_super(
  p_gross_cents bigint,
  p_rate_pct    numeric DEFAULT NULL,
  p_org_id      uuid    DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_rate numeric;
BEGIN
  IF p_rate_pct IS NOT NULL THEN
    v_rate := p_rate_pct;
  ELSIF p_org_id IS NOT NULL THEN
    SELECT COALESCE(
        NULLIF(settings->>'super_rate_pct', '')::numeric,
        (SELECT (value)::numeric FROM public.system_defaults WHERE key = 'au_super_pct'),
        12.00
      )
      INTO v_rate
      FROM public.organizations
     WHERE id = p_org_id;
    v_rate := COALESCE(
      v_rate,
      (SELECT (value)::numeric FROM public.system_defaults WHERE key = 'au_super_pct'),
      12.00
    );
  ELSE
    SELECT COALESCE((value)::numeric, 12.00)
      INTO v_rate
      FROM public.system_defaults
     WHERE key = 'au_super_pct';
    v_rate := COALESCE(v_rate, 12.00);
  END IF;

  IF v_rate < 0 OR v_rate > 100 THEN
    RAISE EXCEPTION 'invalid super rate percentage: %', v_rate
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Historical RPC name is p_gross_cents for compatibility; callers that need
  -- SG compliance must pass ordinary time earnings (OTE), not overtime-inclusive gross.
  RETURN ROUND(GREATEST(p_gross_cents, 0) * v_rate / 100.0)::bigint;
END $$;

CREATE OR REPLACE FUNCTION public.calc_super_ote(
  p_ote_cents bigint,
  p_rate_pct  numeric DEFAULT NULL,
  p_org_id    uuid    DEFAULT NULL
) RETURNS bigint
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT public.calc_super(p_ote_cents, p_rate_pct, p_org_id);
$$;

COMMENT ON FUNCTION public.calc_super_ote(bigint, numeric, uuid) IS
  'Calculates Super Guarantee from ordinary time earnings (OTE). Overtime must be excluded by the caller.';

GRANT EXECUTE ON FUNCTION public.au_sg_rate_pct(date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.calc_super(bigint, numeric, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.calc_super_ote(bigint, numeric, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.build_sgc_statement(
  p_org uuid,
  p_fy_start_year integer,
  p_quarter integer
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_quarter_start date;
  v_quarter_end date;
  v_due_date date;
  v_employees jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_employee_count integer := 0;
  v_slip_count integer := 0;
  v_gross_total_cents bigint := 0;
  v_ote_cents bigint := 0;
  v_overtime_excluded_cents bigint := 0;
  v_required_super_cents bigint := 0;
  v_payroll_super_cents bigint := 0;
  v_shortfall_cents bigint := 0;
  v_shortfall_employee_count integer := 0;
  v_recorded_rate_min numeric := null;
  v_recorded_rate_max numeric := null;
  v_statutory_rate_min numeric := null;
  v_statutory_rate_max numeric := null;
  v_admin_fee_cents bigint := 0;
  v_input_hash text;
BEGIN
  IF p_org IS NULL THEN
    RAISE EXCEPTION 'organization_id is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_fy_start_year IS NULL OR p_fy_start_year NOT BETWEEN 2000 AND 2100 THEN
    RAISE EXCEPTION 'valid FY start year is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_quarter IS NULL OR p_quarter NOT BETWEEN 1 AND 4 THEN
    RAISE EXCEPTION 'quarter must be between 1 and 4'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_org NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RAISE EXCEPTION 'not authorized to build SGC statement for org %', p_org
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT quarter_start, quarter_end, due_date
    INTO v_quarter_start, v_quarter_end, v_due_date
    FROM public.au_bas_quarter(
      CASE p_quarter
        WHEN 1 THEN make_date(p_fy_start_year, 7, 1)
        WHEN 2 THEN make_date(p_fy_start_year, 10, 1)
        WHEN 3 THEN make_date(p_fy_start_year + 1, 1, 1)
        ELSE make_date(p_fy_start_year + 1, 4, 1)
      END
    );

  WITH scoped_slips AS (
    SELECT
      ps.id AS pay_slip_id,
      ps.employee_id,
      e.full_name AS employee_name,
      pr.id AS pay_run_id,
      pr.pay_date,
      ps.gross_total_cents,
      ps.gross_ordinary_cents,
      ps.gross_leave_cents,
      ps.gross_overtime_cents,
      (COALESCE(ps.gross_ordinary_cents, 0) + COALESCE(ps.gross_leave_cents, 0))::bigint
        AS ordinary_time_earnings_cents,
      public.au_sg_rate_pct(pr.pay_date) AS statutory_rate_pct,
      COALESCE(ps.super_rate_pct, public.au_sg_rate_pct(pr.pay_date)) AS recorded_rate_pct,
      ps.super_guarantee_cents AS payroll_super_cents,
      public.calc_super_ote(
        (COALESCE(ps.gross_ordinary_cents, 0) + COALESCE(ps.gross_leave_cents, 0))::bigint,
        public.au_sg_rate_pct(pr.pay_date),
        p_org
      ) AS required_super_cents
    FROM public.pay_slips ps
    JOIN public.pay_runs pr
      ON pr.id = ps.pay_run_id
     AND pr.organization_id = ps.organization_id
    JOIN public.employees e
      ON e.id = ps.employee_id
     AND e.organization_id = ps.organization_id
    WHERE ps.organization_id = p_org
      AND pr.pay_date BETWEEN v_quarter_start AND v_quarter_end
      AND pr.status IN ('approved', 'paid')
  ),
  employee_rows AS (
    SELECT
      employee_id,
      employee_name,
      COUNT(*)::int AS slip_count,
      COALESCE(SUM(gross_total_cents), 0)::bigint AS gross_total_cents,
      COALESCE(SUM(ordinary_time_earnings_cents), 0)::bigint AS ordinary_time_earnings_cents,
      COALESCE(SUM(gross_overtime_cents), 0)::bigint AS overtime_excluded_cents,
      COALESCE(SUM(required_super_cents), 0)::bigint AS required_super_cents,
      COALESCE(SUM(payroll_super_cents), 0)::bigint AS payroll_super_cents,
      GREATEST(
        COALESCE(SUM(required_super_cents), 0)::bigint
          - COALESCE(SUM(payroll_super_cents), 0)::bigint,
        0
      )::bigint AS calculation_shortfall_cents,
      MIN(recorded_rate_pct) AS recorded_rate_min_pct,
      MAX(recorded_rate_pct) AS recorded_rate_max_pct,
      MIN(statutory_rate_pct) AS statutory_rate_min_pct,
      MAX(statutory_rate_pct) AS statutory_rate_max_pct,
      jsonb_agg(
        jsonb_build_object(
          'pay_slip_id', pay_slip_id,
          'pay_run_id', pay_run_id,
          'pay_date', pay_date,
          'gross_total_cents', gross_total_cents,
          'ordinary_time_earnings_cents', ordinary_time_earnings_cents,
          'overtime_excluded_cents', gross_overtime_cents,
          'statutory_rate_pct', statutory_rate_pct,
          'recorded_rate_pct', recorded_rate_pct,
          'required_super_cents', required_super_cents,
          'payroll_super_cents', payroll_super_cents
        )
        ORDER BY pay_date, pay_slip_id
      ) AS pay_slips
    FROM scoped_slips
    GROUP BY employee_id, employee_name
  ),
  employee_json AS (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'employee_id', employee_id,
          'employee_name', employee_name,
          'slip_count', slip_count,
          'gross_total_cents', gross_total_cents,
          'ordinary_time_earnings_cents', ordinary_time_earnings_cents,
          'overtime_excluded_cents', overtime_excluded_cents,
          'required_super_cents', required_super_cents,
          'payroll_super_cents', payroll_super_cents,
          'calculation_shortfall_cents', calculation_shortfall_cents,
          'recorded_rate_min_pct', recorded_rate_min_pct,
          'recorded_rate_max_pct', recorded_rate_max_pct,
          'statutory_rate_min_pct', statutory_rate_min_pct,
          'statutory_rate_max_pct', statutory_rate_max_pct,
          'pay_slips', pay_slips
        )
        ORDER BY calculation_shortfall_cents DESC, employee_name
      ),
      '[]'::jsonb
    ) AS rows
    FROM employee_rows
  ),
  rollup AS (
    SELECT
      COUNT(*)::int AS employee_count,
      COALESCE(SUM(slip_count), 0)::int AS slip_count,
      COALESCE(SUM(gross_total_cents), 0)::bigint AS gross_total_cents,
      COALESCE(SUM(ordinary_time_earnings_cents), 0)::bigint AS ordinary_time_earnings_cents,
      COALESCE(SUM(overtime_excluded_cents), 0)::bigint AS overtime_excluded_cents,
      COALESCE(SUM(required_super_cents), 0)::bigint AS required_super_cents,
      COALESCE(SUM(payroll_super_cents), 0)::bigint AS payroll_super_cents,
      COALESCE(SUM(calculation_shortfall_cents), 0)::bigint AS calculation_shortfall_cents,
      COUNT(*) FILTER (WHERE calculation_shortfall_cents > 0)::int AS shortfall_employee_count,
      MIN(recorded_rate_min_pct) AS recorded_rate_min_pct,
      MAX(recorded_rate_max_pct) AS recorded_rate_max_pct,
      MIN(statutory_rate_min_pct) AS statutory_rate_min_pct,
      MAX(statutory_rate_max_pct) AS statutory_rate_max_pct
    FROM employee_rows
  )
  SELECT
    employee_json.rows,
    rollup.employee_count,
    rollup.slip_count,
    rollup.gross_total_cents,
    rollup.ordinary_time_earnings_cents,
    rollup.overtime_excluded_cents,
    rollup.required_super_cents,
    rollup.payroll_super_cents,
    rollup.calculation_shortfall_cents,
    rollup.shortfall_employee_count,
    rollup.recorded_rate_min_pct,
    rollup.recorded_rate_max_pct,
    rollup.statutory_rate_min_pct,
    rollup.statutory_rate_max_pct
    INTO
      v_employees,
      v_employee_count,
      v_slip_count,
      v_gross_total_cents,
      v_ote_cents,
      v_overtime_excluded_cents,
      v_required_super_cents,
      v_payroll_super_cents,
      v_shortfall_cents,
      v_shortfall_employee_count,
      v_recorded_rate_min,
      v_recorded_rate_max,
      v_statutory_rate_min,
      v_statutory_rate_max
  FROM rollup, employee_json;

  v_admin_fee_cents := v_shortfall_employee_count * 2000;

  v_input_hash := encode(
    digest(
      jsonb_build_object(
        'organization_id', p_org,
        'fy_start_year', p_fy_start_year,
        'quarter', p_quarter,
        'quarter_start', v_quarter_start,
        'quarter_end', v_quarter_end,
        'employees', v_employees
      )::text,
      'sha256'
    ),
    'hex'
  );

  IF v_slip_count = 0 THEN
    v_warnings := v_warnings || jsonb_build_array(
      'no approved or paid pay slips found for this super guarantee quarter'
    );
  END IF;

  IF COALESCE(v_overtime_excluded_cents, 0) > 0 THEN
    v_warnings := v_warnings || jsonb_build_array(
      'overtime wages are excluded from the OTE super guarantee base'
    );
  END IF;

  IF COALESCE(v_recorded_rate_min, 0) < COALESCE(v_statutory_rate_min, 0) THEN
    v_warnings := v_warnings || jsonb_build_array(
      'one or more pay slips record a super rate below the statutory rate for the pay date'
    );
  END IF;

  IF v_shortfall_cents > 0 THEN
    v_warnings := v_warnings || jsonb_build_array(
      v_shortfall_employee_count::text || ' employee(s) have a calculated SG shortfall'
    );
  END IF;

  v_warnings := v_warnings || jsonb_build_array(
    'nominal interest and actual late-payment liability require payment/lodgment dates and are not calculated here'
  );

  RETURN jsonb_build_object(
    'schema_version', 'build_sgc_statement:v1',
    'organization_id', p_org,
    'fy_start_year', p_fy_start_year,
    'quarter', p_quarter,
    'quarter_start', v_quarter_start,
    'quarter_end', v_quarter_end,
    'due_date', v_due_date,
    'summary', jsonb_build_object(
      'employee_count', v_employee_count,
      'slip_count', v_slip_count,
      'gross_total_cents', v_gross_total_cents,
      'ordinary_time_earnings_cents', v_ote_cents,
      'overtime_excluded_cents', v_overtime_excluded_cents,
      'required_super_cents', v_required_super_cents,
      'payroll_super_cents', v_payroll_super_cents,
      'calculation_shortfall_cents', v_shortfall_cents,
      'shortfall_employee_count', v_shortfall_employee_count,
      'recorded_rate_min_pct', v_recorded_rate_min,
      'recorded_rate_max_pct', v_recorded_rate_max,
      'statutory_rate_min_pct', v_statutory_rate_min,
      'statutory_rate_max_pct', v_statutory_rate_max
    ),
    'sgc_components', jsonb_build_object(
      'super_shortfall_cents', v_shortfall_cents,
      'nominal_interest_cents', null,
      'nominal_interest_reason', 'Requires actual payment/lodgment dates; calculate in the ATO SGC statement before lodgment',
      'admin_fee_cents_per_employee', 2000,
      'admin_fee_cents', v_admin_fee_cents,
      'draft_total_ex_interest_cents', v_shortfall_cents + v_admin_fee_cents
    ),
    'employees', v_employees,
    'evidence', jsonb_build_object(
      'source_tables', jsonb_build_array('pay_runs', 'pay_slips', 'employees', 'system_defaults'),
      'calculation_basis', 'SG required = ordinary time earnings (gross ordinary + leave) × statutory SG rate; overtime excluded',
      'input_hash', v_input_hash,
      'source_version', 'build_sgc_statement:v1',
      'source_label', 'ATO Super guarantee and Super guarantee charge',
      'source_urls', jsonb_build_array(
        'https://www.ato.gov.au/tax-rates-and-codes/key-superannuation-rates-and-thresholds/super-guarantee',
        'https://www.ato.gov.au/businesses-and-organisations/super-for-employers/paying-super-contributions/how-much-super-to-pay',
        'https://www.ato.gov.au/businesses-and-organisations/super-for-employers/quarterly-super-to-30-june-2026/missed-and-late-super-guarantee-payments/the-super-guarantee-charge'
      )
    ),
    'warnings', v_warnings,
    'lodgement', jsonb_build_object(
      'enabled', false,
      'reason', 'SGC statement builder is a draft review artifact only; live ATO lodgement remains on the external-gated ATO TODO list'
    )
  );
END;
$$;

COMMENT ON FUNCTION public.build_sgc_statement(uuid, integer, integer) IS
  'Builds a draft quarterly Super Guarantee Charge statement/review payload from approved/paid pay_slips. '
  'Required SG is calculated on OTE (ordinary + leave), excludes overtime, and applies statutory SG rates. '
  'Does not lodge to ATO or calculate nominal interest.';

REVOKE ALL ON FUNCTION public.build_sgc_statement(uuid, integer, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.build_sgc_statement(uuid, integer, integer)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
