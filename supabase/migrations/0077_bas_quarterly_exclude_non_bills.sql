-- 0077: Exclude classified non-invoices from the BAS quarterly figures.
--
-- Part of EPIC D (intake classifier). Companion to 0076: where 0076 dropped
-- non-bills from the GST *coverage* view, this drops them from v_bas_quarterly
-- itself — the view that produces the actual G11/1B purchase + GST-paid numbers
-- and the per-quarter bill_count. The mis-filed noise (logos, photos of
-- finished fences, "Pay Now" screenshots) carries is_probable_bill=false and
-- would otherwise inflate bill_count on the BAS surface.
--
-- This is a CREATE OR REPLACE of v_bas_quarterly, taken verbatim from the
-- CURRENT live definition (the 0047 redefinition, which computes the bills side
-- from v_bill_effective_allocations so split/cross-org bills attribute their
-- effective GST/subtotal to the right org). The ONLY change is that the
-- bills_per_q CTE's WHERE clause gains `AND b_1.is_probable_bill = true`. The
-- GST/subtotal math (effective_gst_cents / effective_subtotal_ex_gst_cents) and
-- the invoices side are unchanged.

CREATE OR REPLACE VIEW public.v_bas_quarterly AS
WITH inv_per_q AS (
  SELECT i_1.organization_id,
         q.fy_start_year,
         q.quarter_num,
         q.quarter_start,
         q.quarter_end,
         q.due_date,
         sum(i_1.gst_cents) AS gst_collected_cents,
         sum(i_1.subtotal_ex_gst_cents) AS sales_ex_gst_cents,
         count(*) AS invoice_count
  FROM invoices i_1
    CROSS JOIN LATERAL au_bas_quarter(i_1.issue_date) q(fy_start_year, quarter_num, quarter_start, quarter_end, due_date)
  WHERE i_1.deleted_at IS NULL AND i_1.status <> 'void'::invoice_status
  GROUP BY i_1.organization_id, q.fy_start_year, q.quarter_num, q.quarter_start, q.quarter_end, q.due_date
), bills_per_q AS (
  SELECT bea.organization_id,
         q.fy_start_year,
         q.quarter_num,
         sum(bea.effective_gst_cents) AS gst_paid_cents,
         sum(bea.effective_subtotal_ex_gst_cents) AS purchases_ex_gst_cents,
         count(*) AS bill_count
  FROM v_bill_effective_allocations bea
    JOIN bills b_1 ON b_1.id = bea.bill_id
    CROSS JOIN LATERAL au_bas_quarter(b_1.invoice_date) q(fy_start_year, quarter_num, quarter_start, quarter_end, due_date)
  WHERE b_1.deleted_at IS NULL AND b_1.is_personal = false AND b_1.invoice_date IS NOT NULL
    AND b_1.is_probable_bill = true
  GROUP BY bea.organization_id, q.fy_start_year, q.quarter_num
)
SELECT COALESCE(i.organization_id, b.organization_id) AS organization_id,
    COALESCE(i.fy_start_year, b.fy_start_year) AS fy_start_year,
    COALESCE(i.quarter_num, b.quarter_num) AS quarter_num,
    i.quarter_start,
    i.quarter_end,
    i.due_date,
    COALESCE(i.gst_collected_cents, 0::numeric) AS gst_collected_cents,
    COALESCE(b.gst_paid_cents, 0::numeric) AS gst_paid_cents,
    COALESCE(i.gst_collected_cents, 0::numeric) - COALESCE(b.gst_paid_cents, 0::numeric) AS net_gst_cents,
    COALESCE(i.sales_ex_gst_cents, 0::numeric) AS sales_ex_gst_cents,
    COALESCE(b.purchases_ex_gst_cents, 0::numeric) AS purchases_ex_gst_cents,
    COALESCE(i.invoice_count, 0::bigint) AS invoice_count,
    COALESCE(b.bill_count, 0::bigint) AS bill_count
   FROM inv_per_q i
     FULL JOIN bills_per_q b ON b.organization_id = i.organization_id AND b.fy_start_year = i.fy_start_year AND b.quarter_num = i.quarter_num;
