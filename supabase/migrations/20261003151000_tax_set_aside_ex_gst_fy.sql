-- ============================================================================
-- 20261003151000_tax_set_aside_ex_gst_fy.sql  (TAX-01)
--
-- The dashboard tax set-aside (v_organization_realtime_pnl.tax_set_aside_cents)
-- was calculated on the wrong base:
--   * GST-inclusive: revenue inc GST minus bills inc GST, so the net GST owed
--     to the ATO was taxed as if it were profit;
--   * not one financial year: wages and overhead came from v_job_pnl, which
--     sums every year, while revenue and bills were current-FY only;
--   * the FY was taken from the database's UTC date.
--
-- The set-aside is now pct x net profit for the organisation's current
-- Australian financial year (1 July - 30 June, today's date in the org's state
-- time zone), all GST-exclusive:
--     revenue ex GST            (invoices issued in the FY,
--                                less posted customer credit notes dated in it)
--   - bill costs ex GST         (bills dated in the FY, total less GST, split by
--                                v_bill_effective_allocations, less posted
--                                supplier credit notes dated in it)
--   - wages                     (job timesheet and wage entries worked in the FY)
--   - overhead                  (job overhead allocations dated in the FY)
-- Wages and overhead keep their old scope (job-linked, as v_job_costs) but are
-- now limited to the FY. Bills keep their scope plus is_probable_bill, which
-- the BAS already applies (logos, photos and screenshots are not costs).
--
-- Columns are kept (CREATE OR REPLACE) with the same meaning; revenue, GST
-- and bill columns now net off credit notes. New columns are appended:
-- fy_start_date, fy_end_date, cost_bills_ex_gst_cents, net_profit_ex_gst_cents,
-- tax_set_aside_pct. The percentage stays organizations.settings
-- .tax_set_aside_pct, else system_defaults.default_tax_set_aside_pct (ADR 0003);
-- this migration does not change the rate, only the base it applies to.
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW public.v_organization_realtime_pnl
WITH (security_invoker = on) AS
WITH fy AS (
  SELECT
    o.id AS organization_id,
    make_date(
      CASE WHEN extract(month FROM t.today) >= 7
           THEN extract(year FROM t.today)::int
           ELSE extract(year FROM t.today)::int - 1 END, 7, 1) AS start_date
  FROM public.organizations o
  LEFT JOIN public.business_profile bp
    ON bp.organization_id = o.id
  CROSS JOIN LATERAL (SELECT public.bas_local_date(now(), bp.state_code) AS today) t
  WHERE o.deleted_at IS NULL
),
org_revenue AS (
  SELECT i.organization_id,
    SUM(i.total_inc_gst_cents)::bigint AS revenue_inc_gst_cents,
    SUM(i.subtotal_ex_gst_cents)::bigint AS revenue_ex_gst_cents,
    SUM(i.gst_cents)::bigint AS gst_collected_cents
  FROM public.invoices i
  JOIN fy ON fy.organization_id = i.organization_id
  WHERE i.deleted_at IS NULL
    AND i.status <> 'void'::public.invoice_status
    AND i.issue_date >= fy.start_date
    AND i.issue_date < (fy.start_date + interval '1 year')
  GROUP BY i.organization_id
),
org_customer_credits AS (
  SELECT cn.organization_id,
    SUM(cn.total_inc_gst_cents)::bigint AS total_inc_gst_cents,
    SUM(cn.subtotal_ex_gst_cents)::bigint AS subtotal_ex_gst_cents,
    SUM(cn.gst_cents)::bigint AS gst_cents
  FROM public.customer_credit_notes cn
  JOIN fy ON fy.organization_id = cn.organization_id
  WHERE cn.deleted_at IS NULL
    AND cn.status = 'posted'::public.credit_note_status
    AND cn.credit_note_date >= fy.start_date
    AND cn.credit_note_date < (fy.start_date + interval '1 year')
  GROUP BY cn.organization_id
),
org_bills AS (
  SELECT bea.organization_id,
    SUM(bea.effective_total_inc_gst_cents)::bigint AS cost_bills_cents,
    SUM(bea.effective_total_inc_gst_cents - bea.effective_gst_cents)::bigint AS cost_bills_ex_gst_cents,
    SUM(bea.effective_gst_cents)::bigint AS gst_input_credit_cents
  FROM public.v_bill_effective_allocations bea
  JOIN public.bills b ON b.id = bea.bill_id
  JOIN fy ON fy.organization_id = bea.organization_id
  WHERE b.is_personal = false
    AND b.is_probable_bill = true
    AND b.status <> 'void'::public.bill_status
    AND b.deleted_at IS NULL
    AND b.invoice_date >= fy.start_date
    AND b.invoice_date < (fy.start_date + interval '1 year')
  GROUP BY bea.organization_id
),
org_supplier_credits AS (
  SELECT bea.organization_id,
    SUM(ROUND(scn.total_inc_gst_cents * bea.percentage / 100))::bigint AS total_inc_gst_cents,
    SUM(ROUND(scn.total_inc_gst_cents * bea.percentage / 100)
        - ROUND(scn.gst_cents * bea.percentage / 100))::bigint AS subtotal_ex_gst_cents,
    SUM(ROUND(scn.gst_cents * bea.percentage / 100))::bigint AS gst_cents
  FROM public.supplier_credit_notes scn
  JOIN public.bills b ON b.id = scn.bill_id
  JOIN public.v_bill_effective_allocations bea ON bea.bill_id = b.id
  JOIN fy ON fy.organization_id = bea.organization_id
  WHERE scn.deleted_at IS NULL
    AND scn.status = 'posted'::public.credit_note_status
    AND b.is_personal = false
    AND b.is_probable_bill = true
    AND b.status <> 'void'::public.bill_status
    AND b.deleted_at IS NULL
    AND scn.credit_note_date >= fy.start_date
    AND scn.credit_note_date < (fy.start_date + interval '1 year')
  GROUP BY bea.organization_id
),
org_wages AS (
  SELECT w.organization_id, SUM(w.total_cost_cents)::bigint AS cost_wages_cents
  FROM (
    SELECT te.organization_id, te.job_id, te.work_date, te.total_cost_cents
      FROM public.timesheet_entries te
     WHERE te.deleted_at IS NULL AND te.job_id IS NOT NULL
    UNION ALL
    SELECT we.organization_id, we.job_id, we.work_date, we.total_cost_cents
      FROM public.wage_entries we
     WHERE we.deleted_at IS NULL AND we.job_id IS NOT NULL
  ) w
  JOIN public.jobs j ON j.id = w.job_id AND j.deleted_at IS NULL
  JOIN fy ON fy.organization_id = w.organization_id
  WHERE w.work_date >= fy.start_date
    AND w.work_date < (fy.start_date + interval '1 year')
  GROUP BY w.organization_id
),
org_overhead AS (
  SELECT oa.organization_id, SUM(oa.amount_cents)::bigint AS cost_overhead_cents
  FROM public.overhead_allocations oa
  JOIN public.jobs j ON j.id = oa.job_id AND j.deleted_at IS NULL
  JOIN fy ON fy.organization_id = oa.organization_id
  WHERE oa.allocation_date >= fy.start_date
    AND oa.allocation_date < (fy.start_date + interval '1 year')
  GROUP BY oa.organization_id
),
base AS (
  SELECT
    o.id AS organization_id,
    o.name AS organization_name,
    o.settings,
    fy.start_date AS fy_start_date,
    (fy.start_date + interval '1 year' - interval '1 day')::date AS fy_end_date,
    COALESCE(r.revenue_inc_gst_cents, 0) - COALESCE(cc.total_inc_gst_cents, 0) AS revenue_inc_gst_cents,
    COALESCE(r.revenue_ex_gst_cents, 0) - COALESCE(cc.subtotal_ex_gst_cents, 0) AS revenue_ex_gst_cents,
    COALESCE(r.gst_collected_cents, 0) - COALESCE(cc.gst_cents, 0) AS gst_collected_cents,
    COALESCE(b.gst_input_credit_cents, 0) - COALESCE(sc.gst_cents, 0) AS gst_input_credit_cents,
    COALESCE(b.cost_bills_cents, 0) - COALESCE(sc.total_inc_gst_cents, 0) AS cost_bills_cents,
    COALESCE(b.cost_bills_ex_gst_cents, 0) - COALESCE(sc.subtotal_ex_gst_cents, 0) AS cost_bills_ex_gst_cents,
    COALESCE(w.cost_wages_cents, 0) AS cost_wages_cents,
    COALESCE(oh.cost_overhead_cents, 0) AS cost_overhead_cents,
    COALESCE(
      (o.settings ->> 'tax_set_aside_pct')::numeric,
      (SELECT sd.value::numeric FROM public.system_defaults sd WHERE sd.key = 'default_tax_set_aside_pct')
    ) AS tax_set_aside_pct
  FROM public.organizations o
  JOIN fy ON fy.organization_id = o.id
  LEFT JOIN org_revenue r ON r.organization_id = o.id
  LEFT JOIN org_customer_credits cc ON cc.organization_id = o.id
  LEFT JOIN org_bills b ON b.organization_id = o.id
  LEFT JOIN org_supplier_credits sc ON sc.organization_id = o.id
  LEFT JOIN org_wages w ON w.organization_id = o.id
  LEFT JOIN org_overhead oh ON oh.organization_id = o.id
  WHERE o.deleted_at IS NULL
),
calc AS (
  SELECT
    base.*,
    GREATEST(0, gst_collected_cents - gst_input_credit_cents)::bigint AS gst_set_aside_cents,
    (cost_bills_cents + cost_wages_cents + cost_overhead_cents)::bigint AS total_cost_cents,
    (revenue_inc_gst_cents - cost_bills_cents - cost_wages_cents - cost_overhead_cents)::bigint AS gross_profit_cents,
    (revenue_ex_gst_cents - cost_bills_ex_gst_cents - cost_wages_cents - cost_overhead_cents)::bigint
      AS net_profit_ex_gst_cents
  FROM base
),
taxed AS (
  SELECT
    calc.*,
    GREATEST(0, ROUND(net_profit_ex_gst_cents::numeric * COALESCE(tax_set_aside_pct, 0) / 100))::bigint
      AS tax_set_aside_cents
  FROM calc
)
SELECT
  organization_id,
  organization_name,
  settings,
  revenue_inc_gst_cents::bigint,
  revenue_ex_gst_cents::bigint,
  gst_collected_cents::bigint,
  gst_input_credit_cents::bigint,
  gst_set_aside_cents,
  cost_bills_cents::bigint,
  cost_wages_cents::bigint,
  cost_overhead_cents::bigint,
  total_cost_cents,
  gross_profit_cents,
  tax_set_aside_cents,
  GREATEST(0, gross_profit_cents - gst_set_aside_cents - tax_set_aside_cents)::bigint AS really_yours_cents,
  fy_start_date,
  fy_end_date,
  cost_bills_ex_gst_cents::bigint,
  net_profit_ex_gst_cents,
  tax_set_aside_pct
FROM taxed;

COMMENT ON VIEW public.v_organization_realtime_pnl IS
  'Dashboard P&L for the organisation''s current Australian financial year (today in '
  'its state time zone). Revenue, GST and bills net off posted credit notes. '
  'tax_set_aside_cents = tax_set_aside_pct x net_profit_ex_gst_cents (revenue ex GST - '
  'bills ex GST - FY job wages - FY job overhead), never negative. gross_profit_cents '
  'stays GST-inclusive for really_yours = gross_profit - gst_set_aside - tax_set_aside '
  '(floored at 0, as before). '
  'SECURITY INVOKER.';

GRANT SELECT ON public.v_organization_realtime_pnl TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
