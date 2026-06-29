-- ============================================================================
-- 0224_tpar_report_builder.sql  (P2-TPAR)
--
-- TPAR report builder:
--   * build_tpar_report(org, FY start year) RPC
--   * paid AP payment aggregation from direct-paid bills and paid payment runs
--   * reportable supplier detection from subcontractor bill coding or intake rules
--
-- This is a TPAR export/prep builder only. It does not lodge, sign, or transmit
-- anything to the ATO.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.build_tpar_report(
  p_org uuid,
  p_fy_start_year integer
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
  v_profile public.business_profile%ROWTYPE;
  v_rows jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_supplier_count integer := 0;
  v_payment_count integer := 0;
  v_bill_count integer := 0;
  v_gross_paid_cents bigint := 0;
  v_gst_component_cents bigint := 0;
  v_net_paid_cents bigint := 0;
  v_missing_abn_count integer := 0;
  v_missing_gst_count integer := 0;
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

  IF p_org NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RAISE EXCEPTION 'not authorized to build TPAR report for org %', p_org
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_period_start := make_date(p_fy_start_year, 7, 1);
  v_period_end := make_date(p_fy_start_year + 1, 6, 30);
  v_due_date := make_date(p_fy_start_year + 1, 8, 28);

  SELECT *
    INTO v_profile
    FROM public.business_profile
   WHERE organization_id = p_org;

  WITH direct_bill_payments AS (
    SELECT
      b.id AS bill_id,
      b.supplier_id,
      COALESCE(s.name, b.supplier_name_raw, 'Unknown supplier') AS supplier_name,
      NULLIF(btrim(COALESCE(s.abn, b.supplier_abn, '')), '') AS supplier_abn,
      b.invoice_number,
      b.invoice_date,
      b.paid_at::date AS payment_date,
      COALESCE(b.total_inc_gst_cents, 0)::bigint AS gross_paid_cents,
      b.gst_cents::bigint AS bill_gst_cents,
      b.total_inc_gst_cents::bigint AS bill_total_cents,
      b.auto_category_code,
      'bills.paid_at'::text AS source_kind
    FROM public.bills b
    LEFT JOIN public.suppliers s
      ON s.id = b.supplier_id
    WHERE b.organization_id = p_org
      AND b.deleted_at IS NULL
      AND b.is_personal IS NOT TRUE
      AND b.status = 'paid'::public.bill_status
      AND b.paid_at::date BETWEEN v_period_start AND v_period_end
      AND COALESCE(b.total_inc_gst_cents, 0) > 0
      AND NOT EXISTS (
        SELECT 1
          FROM public.payment_run_items pri
          JOIN public.payment_runs pr
            ON pr.id = pri.payment_run_id
         WHERE pri.bill_id = b.id
           AND pr.organization_id = p_org
           AND pr.status = 'paid'::public.payment_run_status
      )
  ),
  payment_run_payments AS (
    SELECT
      b.id AS bill_id,
      b.supplier_id,
      COALESCE(s.name, b.supplier_name_raw, pri.payee_account_name, 'Unknown supplier') AS supplier_name,
      NULLIF(btrim(COALESCE(s.abn, b.supplier_abn, '')), '') AS supplier_abn,
      COALESCE(NULLIF(b.invoice_number, ''), pri.reference) AS invoice_number,
      b.invoice_date,
      pr.pay_date AS payment_date,
      pri.amount_cents::bigint AS gross_paid_cents,
      b.gst_cents::bigint AS bill_gst_cents,
      b.total_inc_gst_cents::bigint AS bill_total_cents,
      b.auto_category_code,
      'payment_run_items'::text AS source_kind
    FROM public.payment_run_items pri
    JOIN public.payment_runs pr
      ON pr.id = pri.payment_run_id
    JOIN public.bills b
      ON b.id = pri.bill_id
    LEFT JOIN public.suppliers s
      ON s.id = b.supplier_id
    WHERE pri.organization_id = p_org
      AND pr.organization_id = p_org
      AND b.organization_id = p_org
      AND pr.status = 'paid'::public.payment_run_status
      AND pr.pay_date BETWEEN v_period_start AND v_period_end
      AND b.deleted_at IS NULL
      AND b.is_personal IS NOT TRUE
      AND pri.amount_cents > 0
  ),
  source_payments AS (
    SELECT * FROM direct_bill_payments
    UNION ALL
    SELECT * FROM payment_run_payments
  ),
  reportable_payments AS (
    SELECT
      p.*,
      CASE
        WHEN p.bill_gst_cents IS NULL THEN NULL::bigint
        WHEN COALESCE(p.bill_total_cents, 0) <= 0 THEN p.bill_gst_cents
        ELSE ROUND((p.gross_paid_cents * p.bill_gst_cents)::numeric / p.bill_total_cents)::bigint
      END AS gst_component_cents
    FROM source_payments p
    WHERE p.auto_category_code = 'subcontractor'
       OR EXISTS (
          SELECT 1
            FROM public.intake_rules r
           WHERE r.organization_id = p_org
             AND r.supplier_id = p.supplier_id
             AND r.category_code = 'subcontractor'
             AND r.is_active IS TRUE
        )
  ),
  grouped AS (
    SELECT
      COALESCE(supplier_id::text, 'raw:' || md5(lower(btrim(supplier_name)))) AS supplier_key,
      supplier_id,
      supplier_name,
      supplier_abn,
      COALESCE(SUM(gross_paid_cents), 0)::bigint AS gross_paid_cents,
      COALESCE(SUM(COALESCE(gst_component_cents, 0)), 0)::bigint AS gst_component_cents,
      (COALESCE(SUM(gross_paid_cents), 0) - COALESCE(SUM(COALESCE(gst_component_cents, 0)), 0))::bigint
        AS net_paid_cents,
      COUNT(*)::int AS payment_count,
      COUNT(DISTINCT bill_id)::int AS bill_count,
      MIN(payment_date) AS first_payment_date,
      MAX(payment_date) AS last_payment_date,
      (supplier_abn IS NULL) AS missing_abn,
      COUNT(*) FILTER (WHERE gst_component_cents IS NULL)::int AS missing_gst_count,
      jsonb_agg(
        jsonb_build_object(
          'bill_id', bill_id,
          'invoice_number', invoice_number,
          'invoice_date', invoice_date,
          'payment_date', payment_date,
          'gross_paid_cents', gross_paid_cents,
          'gst_component_cents', gst_component_cents,
          'source_kind', source_kind
        )
        ORDER BY payment_date, invoice_number, bill_id
      ) AS payments
    FROM reportable_payments
    GROUP BY supplier_id, supplier_name, supplier_abn
  ),
  row_json AS (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'supplier_key', supplier_key,
          'supplier_id', supplier_id,
          'supplier_name', supplier_name,
          'supplier_abn', supplier_abn,
          'gross_paid_cents', gross_paid_cents,
          'gst_component_cents', gst_component_cents,
          'net_paid_cents', net_paid_cents,
          'payment_count', payment_count,
          'bill_count', bill_count,
          'first_payment_date', first_payment_date,
          'last_payment_date', last_payment_date,
          'missing_abn', missing_abn,
          'missing_gst_count', missing_gst_count,
          'payments', payments
        )
        ORDER BY supplier_name, supplier_key
      ),
      '[]'::jsonb
    ) AS rows
    FROM grouped
  ),
  totals AS (
    SELECT
      COUNT(*)::int AS supplier_count,
      COALESCE(SUM(payment_count), 0)::int AS payment_count,
      COALESCE(SUM(bill_count), 0)::int AS bill_count,
      COALESCE(SUM(gross_paid_cents), 0)::bigint AS gross_paid_cents,
      COALESCE(SUM(gst_component_cents), 0)::bigint AS gst_component_cents,
      COALESCE(SUM(net_paid_cents), 0)::bigint AS net_paid_cents,
      COUNT(*) FILTER (WHERE missing_abn)::int AS missing_abn_count,
      COALESCE(SUM(missing_gst_count), 0)::int AS missing_gst_count
    FROM grouped
  )
  SELECT
    row_json.rows,
    totals.supplier_count,
    totals.payment_count,
    totals.bill_count,
    totals.gross_paid_cents,
    totals.gst_component_cents,
    totals.net_paid_cents,
    totals.missing_abn_count,
    totals.missing_gst_count
    INTO
      v_rows,
      v_supplier_count,
      v_payment_count,
      v_bill_count,
      v_gross_paid_cents,
      v_gst_component_cents,
      v_net_paid_cents,
      v_missing_abn_count,
      v_missing_gst_count
  FROM row_json, totals;

  v_input_hash := encode(
    digest(
      jsonb_build_object(
        'organization_id', p_org,
        'fy_start_year', p_fy_start_year,
        'period_start', v_period_start,
        'period_end', v_period_end,
        'rows', v_rows
      )::text,
      'sha256'
    ),
    'hex'
  );

  IF v_profile.organization_id IS NULL THEN
    v_warnings := v_warnings || jsonb_build_array(
      'business_profile is missing; confirm TPAR obligation before exporting'
    );
  ELSIF COALESCE(v_profile.is_tpar_required, false) = false THEN
    v_warnings := v_warnings || jsonb_build_array(
      'business_profile.is_tpar_required is false; export is a draft review only'
    );
  END IF;

  IF v_supplier_count = 0 THEN
    v_warnings := v_warnings || jsonb_build_array(
      'no paid subcontractor bills or supplier intake rules found for this financial year'
    );
  END IF;

  IF v_missing_abn_count > 0 THEN
    v_warnings := v_warnings || jsonb_build_array(
      v_missing_abn_count::text || ' TPAR payee(s) are missing ABN details'
    );
  END IF;

  IF v_missing_gst_count > 0 THEN
    v_warnings := v_warnings || jsonb_build_array(
      v_missing_gst_count::text || ' source payment(s) are missing captured GST amounts'
    );
  END IF;

  RETURN jsonb_build_object(
    'schema_version', 'build_tpar_report:v1',
    'organization_id', p_org,
    'fy_start_year', p_fy_start_year,
    'period_start', v_period_start,
    'period_end', v_period_end,
    'due_date', v_due_date,
    'obligation', jsonb_build_object(
      'is_tpar_required', COALESCE(v_profile.is_tpar_required, false),
      'subbies_count', COALESCE(v_profile.subbies_count, 0),
      'source_label', 'ATO Taxable payments annual report',
      'source_url', 'https://www.ato.gov.au/businesses-and-organisations/preparing-lodging-and-paying/reports-and-returns/taxable-payments-annual-report'
    ),
    'summary', jsonb_build_object(
      'supplier_count', v_supplier_count,
      'payment_count', v_payment_count,
      'bill_count', v_bill_count,
      'gross_paid_cents', v_gross_paid_cents,
      'gst_component_cents', v_gst_component_cents,
      'net_paid_cents', v_net_paid_cents,
      'missing_abn_count', v_missing_abn_count,
      'missing_gst_count', v_missing_gst_count
    ),
    'suppliers', v_rows,
    'evidence', jsonb_build_object(
      'source_tables', jsonb_build_array(
        'bills',
        'payment_runs',
        'payment_run_items',
        'suppliers',
        'intake_rules',
        'business_profile'
      ),
      'reportable_basis', 'bills.auto_category_code = subcontractor OR supplier intake_rules.category_code = subcontractor',
      'input_hash', v_input_hash,
      'source_version', 'build_tpar_report:v1'
    ),
    'warnings', v_warnings,
    'export', jsonb_build_object(
      'format', 'csv',
      'enabled', true,
      'filename', 'tpar-FY' || p_fy_start_year::text || '-' || right((p_fy_start_year + 1)::text, 2) || '.csv'
    ),
    'lodgement', jsonb_build_object(
      'enabled', false,
      'reason', 'TPAR builder produces a review/export artifact only; ATO lodgement remains outside this in-repo finish-line slice'
    )
  );
END;
$$;

COMMENT ON FUNCTION public.build_tpar_report(uuid, integer) IS
  'Builds a draft TPAR report/export payload from paid AP bills and payment runs. '
  'Reportable source rows are scoped to subcontractor bill coding or supplier '
  'intake rules under SECURITY INVOKER/RLS. Does not lodge or transmit to ATO.';

REVOKE ALL ON FUNCTION public.build_tpar_report(uuid, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.build_tpar_report(uuid, integer)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
