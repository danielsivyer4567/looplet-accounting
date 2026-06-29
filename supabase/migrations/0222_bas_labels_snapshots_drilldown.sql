-- ============================================================================
-- 0222_bas_labels_snapshots_drilldown.sql  (P2-02a)
--
-- BAS label completion plus immutable worksheet evidence:
--   * complete GST label helper: G1, G2, G3, G10, G11, 1A, 1B
--   * PAYG-W helper includes W3 even though no source exists yet (0, explicit)
--   * PAYG-I values come from an auditable source table instead of silent
--     generate_bas_worksheet placeholders
--   * generate_bas_worksheet returns period metadata for nil-activity quarters,
--     full labels, source drilldown, and evidence status
--   * snapshot_bas_worksheet writes immutable source/payload evidence
--
-- This migration adds explicit RPCs/tables, not posting triggers. Lodgement
-- transport remains owned by the P2-LODGE slices.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Quarter period helper.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bas_quarter_period(
  p_fy_start_year integer,
  p_quarter integer
)
RETURNS TABLE (
  quarter_start date,
  quarter_end date,
  due_date date
)
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT q.quarter_start, q.quarter_end, q.due_date
    FROM public.au_bas_quarter(
      CASE p_quarter
        WHEN 1 THEN make_date(p_fy_start_year, 7, 1)
        WHEN 2 THEN make_date(p_fy_start_year, 10, 1)
        WHEN 3 THEN make_date(p_fy_start_year + 1, 1, 1)
        WHEN 4 THEN make_date(p_fy_start_year + 1, 4, 1)
        ELSE NULL
      END
    ) q
   WHERE p_fy_start_year IS NOT NULL
     AND p_quarter BETWEEN 1 AND 4;
$$;

COMMENT ON FUNCTION public.bas_quarter_period(integer, integer) IS
  'Returns AU BAS quarter start/end/due dates for an FY start year and quarter. '
  'Unlike v_bas_quarterly period metadata, this works for nil-activity quarters.';

REVOKE ALL ON FUNCTION public.bas_quarter_period(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bas_quarter_period(integer, integer)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. PAYG-I source table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bas_payg_instalment_amounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  fy_start_year integer NOT NULL CHECK (fy_start_year BETWEEN 2000 AND 2100),
  quarter_num integer NOT NULL CHECK (quarter_num BETWEEN 1 AND 4),
  t7_payg_instalment_income_cents bigint NOT NULL DEFAULT 0
    CHECK (t7_payg_instalment_income_cents >= 0),
  label_5a_payg_instalment_cents bigint NOT NULL DEFAULT 0
    CHECK (label_5a_payg_instalment_cents >= 0),
  label_5b_payg_instalment_credit_cents bigint NOT NULL DEFAULT 0
    CHECK (label_5b_payg_instalment_credit_cents >= 0),
  source_reference text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS bas_payg_instalment_amounts_period_uniq
  ON public.bas_payg_instalment_amounts (organization_id, fy_start_year, quarter_num)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS bas_payg_instalment_amounts_org_period_idx
  ON public.bas_payg_instalment_amounts (organization_id, fy_start_year, quarter_num)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE public.bas_payg_instalment_amounts IS
  'Auditable source values for BAS PAYG instalment labels T7, 5A and 5B. '
  'generate_bas_worksheet reads this table when business_profile.is_paygi_registered '
  'instead of inventing PAYG-I amounts.';

DROP TRIGGER IF EXISTS bas_payg_instalment_amounts_updated_at
  ON public.bas_payg_instalment_amounts;
CREATE TRIGGER bas_payg_instalment_amounts_updated_at
  BEFORE UPDATE ON public.bas_payg_instalment_amounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS bas_payg_instalment_amounts_audit
  ON public.bas_payg_instalment_amounts;
CREATE TRIGGER bas_payg_instalment_amounts_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.bas_payg_instalment_amounts
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger_v2();

ALTER TABLE public.bas_payg_instalment_amounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bas_payg_instalment_amounts_select
  ON public.bas_payg_instalment_amounts;
CREATE POLICY bas_payg_instalment_amounts_select
  ON public.bas_payg_instalment_amounts FOR SELECT
  TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS bas_payg_instalment_amounts_insert
  ON public.bas_payg_instalment_amounts;
CREATE POLICY bas_payg_instalment_amounts_insert
  ON public.bas_payg_instalment_amounts FOR INSERT
  TO authenticated
  WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS bas_payg_instalment_amounts_update
  ON public.bas_payg_instalment_amounts;
CREATE POLICY bas_payg_instalment_amounts_update
  ON public.bas_payg_instalment_amounts FOR UPDATE
  TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()))
  WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));

REVOKE ALL ON public.bas_payg_instalment_amounts FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON public.bas_payg_instalment_amounts TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Complete BAS label helpers.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_bas_worksheet_gst_labels(
  p_org uuid,
  p_fy_start_year integer,
  p_quarter integer
)
RETURNS TABLE (
  g1_total_sales_cents bigint,
  g2_export_sales_cents bigint,
  g3_gst_free_sales_cents bigint,
  g10_capital_purchases_cents bigint,
  g11_noncapital_purchases_cents bigint,
  label_1a_gst_on_sales_cents bigint,
  label_1b_gst_on_purchases_cents bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH period AS (
    SELECT *
      FROM public.bas_quarter_period(p_fy_start_year, p_quarter)
  ),
  sales_lines AS (
    SELECT
      ili.line_total_inc_gst_cents::bigint AS total_inc_gst_cents,
      ili.line_gst_cents::bigint AS gst_cents,
      (
        COALESCE(coa.expected_gst_treatment, '') = 'EXPORT'
      ) AS is_export,
      (
        ili.gst_treatment = 'free'::public.invoice_gst_treatment
        AND COALESCE(coa.expected_gst_treatment, '') <> 'EXPORT'
      ) AS is_gst_free
    FROM period p
    JOIN public.invoices i
      ON i.organization_id = p_org
     AND i.deleted_at IS NULL
     AND i.status <> 'void'::public.invoice_status
     AND i.issue_date BETWEEN p.quarter_start AND p.quarter_end
    JOIN public.invoice_line_items ili
      ON ili.invoice_id = i.id
     AND ili.organization_id = i.organization_id
    LEFT JOIN public.chart_of_accounts coa
      ON coa.organization_id = i.organization_id
     AND coa.code = NULLIF(btrim(ili.account_code), '')
  ),
  sales AS (
    SELECT
      COALESCE(SUM(total_inc_gst_cents), 0)::bigint AS g1_total_sales_cents,
      COALESCE(SUM(total_inc_gst_cents) FILTER (WHERE is_export), 0)::bigint AS g2_export_sales_cents,
      COALESCE(SUM(total_inc_gst_cents) FILTER (WHERE is_gst_free), 0)::bigint AS g3_gst_free_sales_cents,
      COALESCE(SUM(gst_cents), 0)::bigint AS label_1a_gst_on_sales_cents
    FROM sales_lines
  ),
  purchase_rows AS (
    SELECT
      (COALESCE(bea.effective_subtotal_ex_gst_cents, 0)
        + COALESCE(bea.effective_gst_cents, 0))::bigint AS purchase_inc_gst_cents,
      COALESCE(bea.effective_gst_cents, 0)::bigint AS gst_cents,
      (
        EXISTS (
          SELECT 1
            FROM public.fixed_assets fa
           WHERE fa.source_bill_id = b.id
             AND fa.deleted_at IS NULL
        )
        OR b.auto_category_code IN ('plant_equipment', 'motor_vehicle')
        OR EXISTS (
          SELECT 1
            FROM public.bill_line_items bli
            JOIN public.chart_of_accounts coa
              ON coa.organization_id = bli.organization_id
             AND coa.code = NULLIF(btrim(bli.account_code), '')
             AND coa.expected_gst_treatment = 'GST_ON_CAPITAL'
           WHERE bli.bill_id = b.id
        )
      ) AS is_capital_purchase
    FROM period p
    JOIN public.v_bill_effective_allocations bea
      ON bea.organization_id = p_org
    JOIN public.bills b
      ON b.id = bea.bill_id
    CROSS JOIN LATERAL public.au_bas_quarter(b.invoice_date) q
    WHERE b.deleted_at IS NULL
      AND b.is_personal = false
      AND b.is_probable_bill = true
      AND b.invoice_date IS NOT NULL
      AND q.fy_start_year = p_fy_start_year
      AND q.quarter_num = p_quarter
  ),
  purchases AS (
    SELECT
      COALESCE(SUM(purchase_inc_gst_cents), 0)::bigint AS total_purchases_inc_gst_cents,
      COALESCE(SUM(purchase_inc_gst_cents) FILTER (WHERE is_capital_purchase), 0)::bigint AS g10_capital_purchases_cents,
      COALESCE(SUM(gst_cents), 0)::bigint AS label_1b_gst_on_purchases_cents
    FROM purchase_rows
  )
  SELECT
    COALESCE(s.g1_total_sales_cents, 0)::bigint,
    COALESCE(s.g2_export_sales_cents, 0)::bigint,
    COALESCE(s.g3_gst_free_sales_cents, 0)::bigint,
    COALESCE(p.g10_capital_purchases_cents, 0)::bigint,
    GREATEST(
      COALESCE(p.total_purchases_inc_gst_cents, 0)
      - COALESCE(p.g10_capital_purchases_cents, 0),
      0
    )::bigint,
    COALESCE(s.label_1a_gst_on_sales_cents, 0)::bigint,
    COALESCE(p.label_1b_gst_on_purchases_cents, 0)::bigint
  FROM (SELECT 1) base
  LEFT JOIN sales s ON true
  LEFT JOIN purchases p ON true;
$$;

COMMENT ON FUNCTION public.generate_bas_worksheet_gst_labels(uuid, integer, integer) IS
  'Complete BAS GST labels G1/G2/G3/G10/G11/1A/1B for an org + AU FY quarter. '
  'G2 comes from invoice lines posted to accounts marked expected_gst_treatment=EXPORT; '
  'G3 comes from GST-free invoice lines; G10 comes from fixed-asset linked, capital '
  'category, or GST_ON_CAPITAL purchase evidence. SECURITY INVOKER and RLS scoped.';

REVOKE ALL ON FUNCTION public.generate_bas_worksheet_gst_labels(uuid, integer, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_bas_worksheet_gst_labels(uuid, integer, integer)
  TO authenticated, service_role;

-- Preserve the original 0120 helper signature while replacing the hard-coded G10.
CREATE OR REPLACE FUNCTION public.generate_bas_worksheet_gst(
  p_org uuid,
  p_fy_start_year integer,
  p_quarter integer
)
RETURNS TABLE (
  g1_total_sales_cents bigint,
  g10_capital_purchases_cents bigint,
  g11_noncapital_purchases_cents bigint,
  label_1a_gst_on_sales_cents bigint,
  label_1b_gst_on_purchases_cents bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    g.g1_total_sales_cents,
    g.g10_capital_purchases_cents,
    g.g11_noncapital_purchases_cents,
    g.label_1a_gst_on_sales_cents,
    g.label_1b_gst_on_purchases_cents
  FROM public.generate_bas_worksheet_gst_labels(p_org, p_fy_start_year, p_quarter) g;
$$;

COMMENT ON FUNCTION public.generate_bas_worksheet_gst(uuid, integer, integer) IS
  'Compatibility wrapper for the original 0120 GST helper signature. G10 is no '
  'longer hard-coded to 0; it is derived by generate_bas_worksheet_gst_labels().';

REVOKE ALL ON FUNCTION public.generate_bas_worksheet_gst(uuid, integer, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_bas_worksheet_gst(uuid, integer, integer)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.generate_bas_worksheet_payg_labels(
  p_org uuid,
  p_fy_start_year integer,
  p_quarter integer
)
RETURNS TABLE (
  w1_total_salary_wages_cents bigint,
  w2_payg_withheld_cents bigint,
  w3_other_withheld_cents bigint,
  w4_no_abn_withheld_cents bigint,
  w5_total_withheld_cents bigint,
  label_4_payg_withheld_cents bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    COALESCE(SUM(ps.gross_total_cents), 0)::bigint,
    COALESCE(SUM(ps.payg_tax_cents), 0)::bigint,
    0::bigint,
    0::bigint,
    COALESCE(SUM(ps.payg_tax_cents), 0)::bigint,
    COALESCE(SUM(ps.payg_tax_cents), 0)::bigint
  FROM public.pay_slips ps
  JOIN public.pay_runs pr
    ON pr.id = ps.pay_run_id
  CROSS JOIN LATERAL public.au_bas_quarter(pr.pay_date) q
  WHERE ps.organization_id = p_org
    AND pr.status IN ('approved', 'paid')
    AND q.fy_start_year = p_fy_start_year
    AND q.quarter_num = p_quarter;
$$;

COMMENT ON FUNCTION public.generate_bas_worksheet_payg_labels(uuid, integer, integer) IS
  'BAS PAYG withholding labels W1/W2/W3/W4/W5/4. W3 and W4 remain explicit zero '
  'because no no-ABN/other withholding source exists yet; W5 and label 4 equal W2.';

REVOKE ALL ON FUNCTION public.generate_bas_worksheet_payg_labels(uuid, integer, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_bas_worksheet_payg_labels(uuid, integer, integer)
  TO authenticated, service_role;

-- Preserve the original 0121 helper signature.
CREATE OR REPLACE FUNCTION public.generate_bas_worksheet_payg(
  p_org uuid,
  p_fy_start_year integer,
  p_quarter integer
)
RETURNS TABLE (
  w1_total_salary_wages_cents bigint,
  w2_payg_withheld_cents bigint,
  w4_no_abn_withheld_cents bigint,
  w5_total_withheld_cents bigint,
  label_4_payg_withheld_cents bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    p.w1_total_salary_wages_cents,
    p.w2_payg_withheld_cents,
    p.w4_no_abn_withheld_cents,
    p.w5_total_withheld_cents,
    p.label_4_payg_withheld_cents
  FROM public.generate_bas_worksheet_payg_labels(p_org, p_fy_start_year, p_quarter) p;
$$;

REVOKE ALL ON FUNCTION public.generate_bas_worksheet_payg(uuid, integer, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_bas_worksheet_payg(uuid, integer, integer)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.generate_bas_worksheet_payg_instalment(
  p_org uuid,
  p_fy_start_year integer,
  p_quarter integer
)
RETURNS TABLE (
  t7_payg_instalment_income_cents bigint,
  label_5a_payg_instalment_cents bigint,
  label_5b_payg_instalment_credit_cents bigint,
  source_status text,
  source_id uuid,
  source_reference text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    COALESCE(i.t7_payg_instalment_income_cents, 0)::bigint,
    COALESCE(i.label_5a_payg_instalment_cents, 0)::bigint,
    COALESCE(i.label_5b_payg_instalment_credit_cents, 0)::bigint,
    CASE WHEN i.id IS NULL THEN 'missing' ELSE 'provided' END::text,
    i.id,
    i.source_reference
  FROM (SELECT 1) base
  LEFT JOIN public.bas_payg_instalment_amounts i
    ON i.organization_id = p_org
   AND i.fy_start_year = p_fy_start_year
   AND i.quarter_num = p_quarter
   AND i.deleted_at IS NULL;
$$;

COMMENT ON FUNCTION public.generate_bas_worksheet_payg_instalment(uuid, integer, integer) IS
  'PAYG instalment labels T7/5A/5B for a BAS quarter. Returns source_status=missing '
  'when the organization is PAYG-I registered but no ATO-notified amount has been '
  'entered in bas_payg_instalment_amounts.';

REVOKE ALL ON FUNCTION public.generate_bas_worksheet_payg_instalment(uuid, integer, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_bas_worksheet_payg_instalment(uuid, integer, integer)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Parameterized source drilldown.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_bas_worksheet_source_drilldown(
  p_org uuid,
  p_fy_start_year integer,
  p_quarter integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH period AS (
    SELECT *
      FROM public.bas_quarter_period(p_fy_start_year, p_quarter)
  ),
  sales_lines AS (
    SELECT
      i.id AS invoice_id,
      i.invoice_number,
      i.issue_date,
      ili.id AS invoice_line_item_id,
      ili.line_number,
      ili.description,
      ili.account_code,
      ili.gst_treatment::text AS gst_treatment,
      ili.line_total_inc_gst_cents::bigint AS total_inc_gst_cents,
      ili.line_total_ex_gst_cents::bigint AS subtotal_ex_gst_cents,
      ili.line_gst_cents::bigint AS gst_cents,
      COALESCE(coa.expected_gst_treatment, '') = 'EXPORT' AS is_export,
      (
        ili.gst_treatment = 'free'::public.invoice_gst_treatment
        AND COALESCE(coa.expected_gst_treatment, '') <> 'EXPORT'
      ) AS is_gst_free
    FROM period p
    JOIN public.invoices i
      ON i.organization_id = p_org
     AND i.deleted_at IS NULL
     AND i.status <> 'void'::public.invoice_status
     AND i.issue_date BETWEEN p.quarter_start AND p.quarter_end
    JOIN public.invoice_line_items ili
      ON ili.invoice_id = i.id
     AND ili.organization_id = i.organization_id
    LEFT JOIN public.chart_of_accounts coa
      ON coa.organization_id = i.organization_id
     AND coa.code = NULLIF(btrim(ili.account_code), '')
  ),
  purchase_rows AS (
    SELECT
      b.id AS bill_id,
      b.invoice_number,
      b.invoice_date,
      b.supplier_id,
      COALESCE(s.name, b.supplier_name_raw) AS supplier_name,
      bea.organization_id,
      bea.is_host,
      bea.percentage,
      bea.effective_subtotal_ex_gst_cents::bigint AS subtotal_ex_gst_cents,
      bea.effective_gst_cents::bigint AS gst_cents,
      (COALESCE(bea.effective_subtotal_ex_gst_cents, 0)
        + COALESCE(bea.effective_gst_cents, 0))::bigint AS total_inc_gst_cents,
      (
        EXISTS (
          SELECT 1
            FROM public.fixed_assets fa
           WHERE fa.source_bill_id = b.id
             AND fa.deleted_at IS NULL
        )
        OR b.auto_category_code IN ('plant_equipment', 'motor_vehicle')
        OR EXISTS (
          SELECT 1
            FROM public.bill_line_items bli
            JOIN public.chart_of_accounts coa
              ON coa.organization_id = bli.organization_id
             AND coa.code = NULLIF(btrim(bli.account_code), '')
             AND coa.expected_gst_treatment = 'GST_ON_CAPITAL'
           WHERE bli.bill_id = b.id
        )
      ) AS is_capital_purchase
    FROM public.v_bill_effective_allocations bea
    JOIN public.bills b
      ON b.id = bea.bill_id
    LEFT JOIN public.suppliers s
      ON s.id = b.supplier_id
    CROSS JOIN LATERAL public.au_bas_quarter(b.invoice_date) q
    WHERE bea.organization_id = p_org
      AND b.deleted_at IS NULL
      AND b.is_personal = false
      AND b.is_probable_bill = true
      AND b.invoice_date IS NOT NULL
      AND q.fy_start_year = p_fy_start_year
      AND q.quarter_num = p_quarter
  ),
  payg_rows AS (
    SELECT
      pr.id AS pay_run_id,
      pr.pay_date,
      pr.status::text AS pay_run_status,
      ps.id AS pay_slip_id,
      ps.employee_id,
      ps.gross_total_cents::bigint AS gross_total_cents,
      ps.payg_tax_cents::bigint AS payg_tax_cents
    FROM public.pay_slips ps
    JOIN public.pay_runs pr
      ON pr.id = ps.pay_run_id
    CROSS JOIN LATERAL public.au_bas_quarter(pr.pay_date) q
    WHERE ps.organization_id = p_org
      AND pr.status IN ('approved', 'paid')
      AND q.fy_start_year = p_fy_start_year
      AND q.quarter_num = p_quarter
  ),
  paygi AS (
    SELECT *
      FROM public.generate_bas_worksheet_payg_instalment(p_org, p_fy_start_year, p_quarter)
  )
  SELECT jsonb_build_object(
    'sales', jsonb_build_object(
      'source_tables', jsonb_build_array('invoices', 'invoice_line_items', 'chart_of_accounts'),
      'totals', jsonb_build_object(
        'G1', COALESCE((SELECT SUM(total_inc_gst_cents) FROM sales_lines), 0),
        'G2', COALESCE((SELECT SUM(total_inc_gst_cents) FROM sales_lines WHERE is_export), 0),
        'G3', COALESCE((SELECT SUM(total_inc_gst_cents) FROM sales_lines WHERE is_gst_free), 0),
        '1A', COALESCE((SELECT SUM(gst_cents) FROM sales_lines), 0)
      ),
      'rows', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'invoice_id', invoice_id,
            'invoice_number', invoice_number,
            'issue_date', issue_date,
            'invoice_line_item_id', invoice_line_item_id,
            'line_number', line_number,
            'description', description,
            'account_code', account_code,
            'gst_treatment', gst_treatment,
            'labels', jsonb_build_array('G1')
              || CASE WHEN is_export THEN jsonb_build_array('G2') ELSE '[]'::jsonb END
              || CASE WHEN is_gst_free THEN jsonb_build_array('G3') ELSE '[]'::jsonb END
              || CASE WHEN gst_cents > 0 THEN jsonb_build_array('1A') ELSE '[]'::jsonb END,
            'subtotal_ex_gst_cents', subtotal_ex_gst_cents,
            'gst_cents', gst_cents,
            'total_inc_gst_cents', total_inc_gst_cents
          )
          ORDER BY issue_date, invoice_number, line_number
        )
        FROM sales_lines
      ), '[]'::jsonb)
    ),
    'purchases', jsonb_build_object(
      'source_tables', jsonb_build_array(
        'v_bill_effective_allocations',
        'bills',
        'bill_line_items',
        'fixed_assets',
        'chart_of_accounts'
      ),
      'totals', jsonb_build_object(
        'G10', COALESCE((SELECT SUM(total_inc_gst_cents) FROM purchase_rows WHERE is_capital_purchase), 0),
        'G11', COALESCE((SELECT SUM(total_inc_gst_cents) FROM purchase_rows WHERE NOT is_capital_purchase), 0),
        '1B', COALESCE((SELECT SUM(gst_cents) FROM purchase_rows), 0)
      ),
      'rows', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'bill_id', bill_id,
            'invoice_number', invoice_number,
            'invoice_date', invoice_date,
            'supplier_id', supplier_id,
            'supplier_name', supplier_name,
            'effective_organization_id', organization_id,
            'is_host', is_host,
            'percentage', percentage,
            'labels', CASE
              WHEN is_capital_purchase THEN jsonb_build_array('G10', '1B')
              ELSE jsonb_build_array('G11', '1B')
            END,
            'is_capital_purchase', is_capital_purchase,
            'subtotal_ex_gst_cents', subtotal_ex_gst_cents,
            'gst_cents', gst_cents,
            'total_inc_gst_cents', total_inc_gst_cents
          )
          ORDER BY invoice_date, invoice_number, bill_id
        )
        FROM purchase_rows
      ), '[]'::jsonb)
    ),
    'payg_withholding', jsonb_build_object(
      'source_tables', jsonb_build_array('pay_runs', 'pay_slips'),
      'totals', jsonb_build_object(
        'W1', COALESCE((SELECT SUM(gross_total_cents) FROM payg_rows), 0),
        'W2', COALESCE((SELECT SUM(payg_tax_cents) FROM payg_rows), 0),
        'W3', 0,
        'W4', 0,
        'W5', COALESCE((SELECT SUM(payg_tax_cents) FROM payg_rows), 0),
        '4', COALESCE((SELECT SUM(payg_tax_cents) FROM payg_rows), 0)
      ),
      'rows', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'pay_run_id', pay_run_id,
            'pay_date', pay_date,
            'pay_run_status', pay_run_status,
            'pay_slip_id', pay_slip_id,
            'employee_id', employee_id,
            'labels', jsonb_build_array('W1', 'W2', 'W5', '4'),
            'gross_total_cents', gross_total_cents,
            'payg_tax_cents', payg_tax_cents
          )
          ORDER BY pay_date, pay_run_id, pay_slip_id
        )
        FROM payg_rows
      ), '[]'::jsonb)
    ),
    'payg_instalment', jsonb_build_object(
      'source_tables', jsonb_build_array('business_profile', 'bas_payg_instalment_amounts'),
      'source_status', COALESCE((SELECT source_status FROM paygi), 'missing'),
      'source_id', (SELECT source_id FROM paygi),
      'source_reference', (SELECT source_reference FROM paygi),
      'totals', jsonb_build_object(
        'T7', COALESCE((SELECT t7_payg_instalment_income_cents FROM paygi), 0),
        '5A', COALESCE((SELECT label_5a_payg_instalment_cents FROM paygi), 0),
        '5B', COALESCE((SELECT label_5b_payg_instalment_credit_cents FROM paygi), 0)
      )
    )
  );
$$;

COMMENT ON FUNCTION public.generate_bas_worksheet_source_drilldown(uuid, integer, integer) IS
  'Parameterized BAS source drilldown for an org/FY quarter. Returns source rows '
  'and label mappings for invoice lines, effective bill allocations, pay slips, '
  'and PAYG-I source amounts. SECURITY INVOKER and RLS scoped.';

REVOKE ALL ON FUNCTION public.generate_bas_worksheet_source_drilldown(uuid, integer, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_bas_worksheet_source_drilldown(uuid, integer, integer)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Full worksheet payload with completed labels and source evidence.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_bas_worksheet(
  p_org uuid,
  p_fy_start_year integer,
  p_quarter integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH period AS (
    SELECT *
      FROM public.bas_quarter_period(p_fy_start_year, p_quarter)
  ),
  gst AS (
    SELECT *
      FROM public.generate_bas_worksheet_gst_labels(p_org, p_fy_start_year, p_quarter)
  ),
  payg AS (
    SELECT *
      FROM public.generate_bas_worksheet_payg_labels(p_org, p_fy_start_year, p_quarter)
  ),
  paygi AS (
    SELECT *
      FROM public.generate_bas_worksheet_payg_instalment(p_org, p_fy_start_year, p_quarter)
  ),
  profile AS (
    SELECT COALESCE(bool_or(is_paygi_registered), false) AS is_paygi_registered
      FROM public.business_profile
     WHERE organization_id = p_org
  ),
  drilldown AS (
    SELECT public.generate_bas_worksheet_source_drilldown(
      p_org,
      p_fy_start_year,
      p_quarter
    ) AS source_drilldown
  )
  SELECT jsonb_build_object(
    'organization_id', p_org,
    'fy_start_year', p_fy_start_year,
    'quarter', p_quarter,
    'quarter_start', period.quarter_start,
    'quarter_end', period.quarter_end,
    'due_date', period.due_date,
    'gst', jsonb_build_object(
      'G1', gst.g1_total_sales_cents,
      'G2', gst.g2_export_sales_cents,
      'G3', gst.g3_gst_free_sales_cents,
      'G10', gst.g10_capital_purchases_cents,
      'G11', gst.g11_noncapital_purchases_cents,
      '1A', gst.label_1a_gst_on_sales_cents,
      '1B', gst.label_1b_gst_on_purchases_cents
    ),
    'payg_withholding', jsonb_build_object(
      'W1', payg.w1_total_salary_wages_cents,
      'W2', payg.w2_payg_withheld_cents,
      'W3', payg.w3_other_withheld_cents,
      'W4', payg.w4_no_abn_withheld_cents,
      'W5', payg.w5_total_withheld_cents,
      '4', payg.label_4_payg_withheld_cents
    ),
    'payg_instalment',
      CASE WHEN (SELECT is_paygi_registered FROM profile)
           THEN jsonb_build_object(
             'T7', paygi.t7_payg_instalment_income_cents,
             '5A', paygi.label_5a_payg_instalment_cents,
             '5B', paygi.label_5b_payg_instalment_credit_cents,
             'source_status', paygi.source_status,
             'source_id', paygi.source_id,
             'source_reference', paygi.source_reference
           )
           ELSE null END,
    'summary', jsonb_build_object(
      '9_net_amount_cents',
        gst.label_1a_gst_on_sales_cents
        - gst.label_1b_gst_on_purchases_cents
        + payg.label_4_payg_withheld_cents
        + CASE WHEN (SELECT is_paygi_registered FROM profile)
               THEN paygi.label_5a_payg_instalment_cents - paygi.label_5b_payg_instalment_credit_cents
               ELSE 0 END
    ),
    'source_drilldown', drilldown.source_drilldown,
    'evidence', jsonb_build_object(
      'label_source', 'generate_bas_worksheet:v2',
      'payg_instalment_source_status',
        CASE WHEN (SELECT is_paygi_registered FROM profile)
             THEN paygi.source_status
             ELSE 'not_registered' END,
      'snapshot_rpc', 'snapshot_bas_worksheet'
    )
  )
  FROM period, gst, payg, paygi, drilldown;
$$;

COMMENT ON FUNCTION public.generate_bas_worksheet(uuid, integer, integer) IS
  'Full BAS worksheet JSONB for an org + AU FY quarter. Includes completed GST '
  'labels G1/G2/G3/G10/G11/1A/1B, PAYG-W labels W1/W2/W3/W4/W5/4, PAYG-I labels '
  'only when registered and sourced from bas_payg_instalment_amounts, label 9, '
  'nil-activity period metadata, and source drilldown evidence. SECURITY INVOKER.';

REVOKE ALL ON FUNCTION public.generate_bas_worksheet(uuid, integer, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_bas_worksheet(uuid, integer, integer)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Immutable snapshots.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bas_worksheet_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  fy_start_year integer NOT NULL CHECK (fy_start_year BETWEEN 2000 AND 2100),
  quarter_num integer NOT NULL CHECK (quarter_num BETWEEN 1 AND 4),
  quarter_start date NOT NULL,
  quarter_end date NOT NULL,
  due_date date NOT NULL,
  worksheet jsonb NOT NULL CHECK (jsonb_typeof(worksheet) = 'object'),
  source_drilldown jsonb NOT NULL CHECK (jsonb_typeof(source_drilldown) = 'object'),
  snapshot_hash text NOT NULL CHECK (length(snapshot_hash) = 64),
  source_version text NOT NULL DEFAULT 'generate_bas_worksheet:v2',
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS bas_worksheet_snapshots_hash_uniq
  ON public.bas_worksheet_snapshots (
    organization_id,
    fy_start_year,
    quarter_num,
    snapshot_hash
  );

CREATE INDEX IF NOT EXISTS bas_worksheet_snapshots_org_period_idx
  ON public.bas_worksheet_snapshots (
    organization_id,
    fy_start_year,
    quarter_num,
    created_at DESC
  );

COMMENT ON TABLE public.bas_worksheet_snapshots IS
  'Immutable BAS worksheet evidence. Each row stores the generated worksheet, '
  'source drilldown, period metadata, and SHA-256 snapshot_hash used by approval '
  'and lodgement flows.';

CREATE OR REPLACE FUNCTION public.guard_bas_worksheet_snapshots_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'bas_worksheet_snapshots rows are immutable'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DELETE on immutable table bas_worksheet_snapshots is forbidden'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.guard_bas_worksheet_snapshots_immutable() IS
  'Trigger guard for immutable BAS worksheet snapshots: no UPDATE or DELETE is '
  'allowed. Corrections require a new snapshot row with a new hash.';

DROP TRIGGER IF EXISTS bas_worksheet_snapshots_immutable
  ON public.bas_worksheet_snapshots;
CREATE TRIGGER bas_worksheet_snapshots_immutable
  BEFORE UPDATE OR DELETE ON public.bas_worksheet_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.guard_bas_worksheet_snapshots_immutable();

DROP TRIGGER IF EXISTS bas_worksheet_snapshots_audit
  ON public.bas_worksheet_snapshots;
CREATE TRIGGER bas_worksheet_snapshots_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.bas_worksheet_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger_v2();

ALTER TABLE public.bas_worksheet_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bas_worksheet_snapshots_select
  ON public.bas_worksheet_snapshots;
CREATE POLICY bas_worksheet_snapshots_select
  ON public.bas_worksheet_snapshots FOR SELECT
  TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS bas_worksheet_snapshots_insert
  ON public.bas_worksheet_snapshots;
CREATE POLICY bas_worksheet_snapshots_insert
  ON public.bas_worksheet_snapshots FOR INSERT
  TO authenticated
  WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));

REVOKE ALL ON public.bas_worksheet_snapshots FROM PUBLIC, anon;
GRANT SELECT, INSERT ON public.bas_worksheet_snapshots TO authenticated;

CREATE OR REPLACE FUNCTION public.snapshot_bas_worksheet(
  p_org uuid,
  p_fy_start_year integer,
  p_quarter integer
)
RETURNS public.bas_worksheet_snapshots
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_quarter_start date;
  v_quarter_end date;
  v_due_date date;
  v_worksheet jsonb;
  v_drilldown jsonb;
  v_hash text;
  v_snapshot public.bas_worksheet_snapshots;
BEGIN
  IF p_org IS NULL THEN
    RAISE EXCEPTION 'organization_id is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_fy_start_year IS NULL OR p_quarter NOT BETWEEN 1 AND 4 THEN
    RAISE EXCEPTION 'valid BAS FY start year and quarter are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_org NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RAISE EXCEPTION 'not authorized to snapshot BAS worksheet for org %', p_org
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT q.quarter_start, q.quarter_end, q.due_date
    INTO v_quarter_start, v_quarter_end, v_due_date
    FROM public.bas_quarter_period(p_fy_start_year, p_quarter) q;

  IF v_quarter_start IS NULL THEN
    RAISE EXCEPTION 'valid BAS FY start year and quarter are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_worksheet := public.generate_bas_worksheet(p_org, p_fy_start_year, p_quarter);

  IF v_worksheet IS NULL OR jsonb_typeof(v_worksheet) <> 'object' THEN
    RAISE EXCEPTION 'BAS worksheet did not return an object for org %, FY %, quarter %',
      p_org,
      p_fy_start_year,
      p_quarter
      USING ERRCODE = 'check_violation';
  END IF;

  v_drilldown := COALESCE(v_worksheet -> 'source_drilldown', '{}'::jsonb);

  v_hash := encode(
    digest(
      jsonb_build_object(
        'organization_id', p_org,
        'fy_start_year', p_fy_start_year,
        'quarter', p_quarter,
        'worksheet', v_worksheet,
        'source_drilldown', v_drilldown,
        'source_version', 'generate_bas_worksheet:v2'
      )::text,
      'sha256'
    ),
    'hex'
  );

  INSERT INTO public.bas_worksheet_snapshots (
    organization_id,
    fy_start_year,
    quarter_num,
    quarter_start,
    quarter_end,
    due_date,
    worksheet,
    source_drilldown,
    snapshot_hash,
    created_by
  )
  VALUES (
    p_org,
    p_fy_start_year,
    p_quarter,
    v_quarter_start,
    v_quarter_end,
    v_due_date,
    v_worksheet,
    v_drilldown,
    v_hash,
    auth.uid()
  )
  ON CONFLICT (
    organization_id,
    fy_start_year,
    quarter_num,
    snapshot_hash
  )
  DO NOTHING
  RETURNING * INTO v_snapshot;

  IF v_snapshot.id IS NULL THEN
    SELECT *
      INTO v_snapshot
      FROM public.bas_worksheet_snapshots
     WHERE organization_id = p_org
       AND fy_start_year = p_fy_start_year
       AND quarter_num = p_quarter
       AND snapshot_hash = v_hash
     ORDER BY created_at DESC
     LIMIT 1;
  END IF;

  IF v_snapshot.id IS NULL THEN
    RAISE EXCEPTION 'BAS worksheet snapshot insert/replay failed for org %, FY %, quarter %',
      p_org,
      p_fy_start_year,
      p_quarter
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN v_snapshot;
END;
$$;

COMMENT ON FUNCTION public.snapshot_bas_worksheet(uuid, integer, integer) IS
  'Creates or replays an immutable BAS worksheet snapshot for an org + AU FY quarter. '
  'The snapshot stores generate_bas_worksheet:v2 output, source drilldown evidence, '
  'period metadata, and SHA-256 snapshot_hash for approval/lodgement payload binding.';

REVOKE ALL ON FUNCTION public.snapshot_bas_worksheet(uuid, integer, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.snapshot_bas_worksheet(uuid, integer, integer)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
