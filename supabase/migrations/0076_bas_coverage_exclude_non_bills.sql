-- 0076: Exclude classified non-invoices from BAS GST coverage scope.
--
-- Part of EPIC D (intake classifier). 0075 added bills.is_probable_bill; the
-- mis-filed noise (logos, photos of finished fences, "Pay Now" screenshots)
-- now carries is_probable_bill=false. Those rows must not count toward — or
-- drag down — a quarter's GST coverage, so they're dropped from scope here.
--
-- This is a CREATE OR REPLACE of v_bas_gst_coverage (0059), identical in every
-- respect (security_invoker, columns, the >=95% gst_ready gate) except the
-- WHERE clause gains `AND b.is_probable_bill = true`. The bas_quarter_gst_ready
-- function reads this view and needs no change.

CREATE OR REPLACE VIEW public.v_bas_gst_coverage
WITH (security_invoker = on) AS
SELECT
  b.organization_id,
  q.fy_start_year,
  q.quarter_num,
  count(*)                                                              AS bills_in_scope,
  count(*) FILTER (WHERE b.total_inc_gst_cents IS NOT NULL)             AS bills_with_amount,
  count(*) FILTER (WHERE b.gst_cents IS NOT NULL)                       AS bills_with_gst,
  count(*) FILTER (WHERE b.gst_estimated)                              AS bills_gst_estimated,
  count(*) FILTER (
    WHERE b.total_inc_gst_cents IS NOT NULL AND b.gst_cents IS NOT NULL
  )                                                                    AS bills_complete,
  round(
    100.0 * count(*) FILTER (
      WHERE b.total_inc_gst_cents IS NOT NULL AND b.gst_cents IS NOT NULL
    ) / NULLIF(count(*), 0),
    1
  )                                                                    AS coverage_pct,
  -- ready when >= 95% of in-scope bills are complete (amount + GST)
  count(*) FILTER (
    WHERE b.total_inc_gst_cents IS NOT NULL AND b.gst_cents IS NOT NULL
  ) >= ceil(0.95 * count(*))                                           AS gst_ready
FROM public.bills b
CROSS JOIN LATERAL au_bas_quarter(b.invoice_date)
  q(fy_start_year, quarter_num, quarter_start, quarter_end, due_date)
WHERE b.deleted_at IS NULL
  AND b.is_personal = false
  AND b.invoice_date IS NOT NULL
  AND b.is_probable_bill = true
GROUP BY b.organization_id, q.fy_start_year, q.quarter_num;

COMMENT ON VIEW public.v_bas_gst_coverage IS
  'Per-quarter GST data completeness for BAS. In scope = not deleted, not personal, invoice_date present, AND is_probable_bill (classified non-invoices excluded). gst_ready = >=95% of in-scope bills carry amount+GST. Gate BAS surfacing/lodgement on this.';

REVOKE ALL ON public.v_bas_gst_coverage FROM anon;
GRANT SELECT ON public.v_bas_gst_coverage TO authenticated;
