-- 0077: Exclude classified non-invoices from the BAS quarterly figures.
--
-- Part of EPIC D (intake classifier). Companion to 0076: where 0076 dropped
-- non-bills from the GST *coverage* view, this drops them from v_bas_quarterly
-- itself — the view that produces the actual G11/1B purchase + GST-paid numbers
-- and the per-quarter bill_count. The mis-filed noise (logos, photos of
-- finished fences, "Pay Now" screenshots) carries is_probable_bill=false and
-- would otherwise inflate bill_count on the BAS surface.
--
-- This is a CREATE OR REPLACE of v_bas_quarterly (latest def in 0032),
-- identical except the bills_per_q CTE's WHERE clause gains
-- `AND b.is_probable_bill = true`. The invoices side is unchanged.

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
    AND b.is_probable_bill = true
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
