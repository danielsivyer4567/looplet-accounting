-- 0059: GST-coverage gate for BAS.
--
-- Part of EPIC B. Before the OCR fix, bills carried no amount/GST, so
-- v_bas_quarterly was structurally empty/wrong — but nothing told the user
-- the figures were incomplete. This adds a per-quarter coverage view + a
-- readiness gate so BAS isn't surfaced/lodged off thin data.
--
-- IMPORTANT: "in scope" must match exactly the rows that feed
-- v_bas_quarterly.bills_per_q, which (since migration 0047) is built from
-- v_bill_effective_allocations (so split / cross-org bills attribute GST to
-- the correct org). Counting raw bills grouped by the host org would diverge
-- from the figures this gate certifies. Completeness is derived from the
-- underlying bill's amount/GST. A quarter is "ready" when >= 95% of its
-- in-scope allocations carry both a total and GST.

CREATE OR REPLACE VIEW public.v_bas_gst_coverage
WITH (security_invoker = on) AS
SELECT
  bea.organization_id,
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
  count(*) FILTER (
    WHERE b.total_inc_gst_cents IS NOT NULL AND b.gst_cents IS NOT NULL
  ) >= ceil(0.95 * count(*))                                           AS gst_ready
FROM public.v_bill_effective_allocations bea
  JOIN public.bills b ON b.id = bea.bill_id
  CROSS JOIN LATERAL au_bas_quarter(b.invoice_date)
    q(fy_start_year, quarter_num, quarter_start, quarter_end, due_date)
WHERE b.deleted_at IS NULL
  AND b.is_personal = false
  AND b.invoice_date IS NOT NULL
GROUP BY bea.organization_id, q.fy_start_year, q.quarter_num;

COMMENT ON VIEW public.v_bas_gst_coverage IS
  'Per-quarter GST data completeness for BAS, over the same effective-allocation scope as v_bas_quarterly. gst_ready = >=95% of in-scope allocations carry amount+GST. bills_gst_estimated counts derived (1/11) GST to review before lodgement.';

REVOKE ALL ON public.v_bas_gst_coverage FROM anon;
GRANT SELECT ON public.v_bas_gst_coverage TO authenticated;

-- Server-side gate: a future SBR lodge fn calls this before lodging.
-- SECURITY INVOKER (default) so RLS on bills still applies to the caller.
CREATE OR REPLACE FUNCTION public.bas_quarter_gst_ready(
  p_org uuid,
  p_fy_start_year int,
  p_quarter_num int
) RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT gst_ready
       FROM public.v_bas_gst_coverage
      WHERE organization_id = p_org
        AND fy_start_year = p_fy_start_year
        AND quarter_num = p_quarter_num),
    false  -- no in-scope bills → not ready to lodge
  );
$$;

REVOKE ALL ON FUNCTION public.bas_quarter_gst_ready(uuid, int, int) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.bas_quarter_gst_ready(uuid, int, int) TO authenticated;
