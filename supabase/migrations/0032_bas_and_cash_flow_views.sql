-- 0032: BAS quarterly rollup + cash-flow forecast view + AU fiscal-year helper.
-- AU fiscal year: Jul 1 - Jun 30. Quarters: Q1 Jul-Sep, Q2 Oct-Dec, Q3 Jan-Mar, Q4 Apr-Jun.
-- Personal-flagged bills are excluded from BAS / cash-flow.

CREATE OR REPLACE FUNCTION public.au_bas_quarter(d date)
RETURNS TABLE (fy_start_year int, quarter_num int, quarter_start date, quarter_end date, due_date date)
LANGUAGE sql IMMUTABLE AS $$
  SELECT
    CASE WHEN extract(month FROM d) >= 7 THEN extract(year FROM d)::int ELSE (extract(year FROM d) - 1)::int END,
    CASE
      WHEN extract(month FROM d) IN (7,8,9)   THEN 1
      WHEN extract(month FROM d) IN (10,11,12) THEN 2
      WHEN extract(month FROM d) IN (1,2,3)    THEN 3
      ELSE 4 END,
    CASE
      WHEN extract(month FROM d) IN (7,8,9)   THEN make_date(extract(year FROM d)::int, 7, 1)
      WHEN extract(month FROM d) IN (10,11,12) THEN make_date(extract(year FROM d)::int, 10, 1)
      WHEN extract(month FROM d) IN (1,2,3)    THEN make_date(extract(year FROM d)::int, 1, 1)
      ELSE make_date(extract(year FROM d)::int, 4, 1) END,
    CASE
      WHEN extract(month FROM d) IN (7,8,9)   THEN make_date(extract(year FROM d)::int, 9, 30)
      WHEN extract(month FROM d) IN (10,11,12) THEN make_date(extract(year FROM d)::int, 12, 31)
      WHEN extract(month FROM d) IN (1,2,3)    THEN make_date(extract(year FROM d)::int, 3, 31)
      ELSE make_date(extract(year FROM d)::int, 6, 30) END,
    CASE
      WHEN extract(month FROM d) IN (7,8,9)   THEN make_date(extract(year FROM d)::int, 10, 28)
      WHEN extract(month FROM d) IN (10,11,12) THEN make_date(extract(year FROM d)::int + 1, 2, 28)
      WHEN extract(month FROM d) IN (1,2,3)    THEN make_date(extract(year FROM d)::int, 4, 28)
      ELSE make_date(extract(year FROM d)::int, 7, 28) END;
$$;

CREATE OR REPLACE VIEW public.v_bas_quarterly AS
WITH inv_per_q AS (
  SELECT i.organization_id, q.fy_start_year, q.quarter_num, q.quarter_start, q.quarter_end, q.due_date,
         SUM(i.gst_cents) AS gst_collected_cents,
         SUM(i.subtotal_ex_gst_cents) AS sales_ex_gst_cents,
         COUNT(*) AS invoice_count
  FROM public.invoices i CROSS JOIN LATERAL public.au_bas_quarter(i.issue_date) q
  WHERE i.deleted_at IS NULL AND i.status NOT IN ('void')
  GROUP BY i.organization_id, q.fy_start_year, q.quarter_num, q.quarter_start, q.quarter_end, q.due_date
),
bills_per_q AS (
  SELECT b.organization_id, q.fy_start_year, q.quarter_num,
         SUM(b.gst_cents) AS gst_paid_cents,
         SUM(b.subtotal_ex_gst_cents) AS purchases_ex_gst_cents,
         COUNT(*) AS bill_count
  FROM public.bills b CROSS JOIN LATERAL public.au_bas_quarter(b.invoice_date) q
  WHERE b.deleted_at IS NULL AND b.is_personal = false AND b.invoice_date IS NOT NULL
  GROUP BY b.organization_id, q.fy_start_year, q.quarter_num
)
SELECT
  COALESCE(i.organization_id, b.organization_id) AS organization_id,
  COALESCE(i.fy_start_year, b.fy_start_year)     AS fy_start_year,
  COALESCE(i.quarter_num, b.quarter_num)         AS quarter_num,
  i.quarter_start, i.quarter_end, i.due_date,
  COALESCE(i.gst_collected_cents, 0)             AS gst_collected_cents,
  COALESCE(b.gst_paid_cents, 0)                  AS gst_paid_cents,
  COALESCE(i.gst_collected_cents, 0) - COALESCE(b.gst_paid_cents, 0) AS net_gst_cents,
  COALESCE(i.sales_ex_gst_cents, 0)              AS sales_ex_gst_cents,
  COALESCE(b.purchases_ex_gst_cents, 0)          AS purchases_ex_gst_cents,
  COALESCE(i.invoice_count, 0)                   AS invoice_count,
  COALESCE(b.bill_count, 0)                      AS bill_count
FROM inv_per_q i
FULL OUTER JOIN bills_per_q b ON b.organization_id = i.organization_id
  AND b.fy_start_year = i.fy_start_year AND b.quarter_num = i.quarter_num;

CREATE OR REPLACE VIEW public.v_cash_flow_weekly AS
WITH invoice_inflows AS (
  SELECT organization_id, date_trunc('week', due_date)::date AS week_start,
         'invoice'::text AS source_type, SUM(balance_due_cents) AS amount_cents
  FROM public.invoices
  WHERE deleted_at IS NULL AND status NOT IN ('paid', 'void') AND balance_due_cents > 0
  GROUP BY organization_id, date_trunc('week', due_date)::date
),
bill_outflows AS (
  SELECT organization_id, date_trunc('week', COALESCE(due_date, invoice_date))::date AS week_start,
         'bill'::text AS source_type, -SUM(total_inc_gst_cents) AS amount_cents
  FROM public.bills
  WHERE deleted_at IS NULL AND status NOT IN ('paid', 'void')
    AND total_inc_gst_cents IS NOT NULL
    AND COALESCE(due_date, invoice_date) IS NOT NULL
    AND is_personal = false
  GROUP BY organization_id, date_trunc('week', COALESCE(due_date, invoice_date))::date
)
SELECT * FROM invoice_inflows UNION ALL SELECT * FROM bill_outflows;
