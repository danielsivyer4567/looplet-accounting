-- 0084: Scope the dashboard P&L (v_organization_realtime_pnl) to the CURRENT
-- Australian financial year (1 Jul – 30 Jun).
--
-- 0083 made the view org-wide but all-time, which wrongly lumped multiple years
-- of revenue (and their period-specific GST / income-tax set-asides) into one
-- headline. This filters revenue to current-FY invoices and bill costs to
-- current-FY dated bills (undated bills aren't attributable to a period; they
-- surface once OCR captures a date). Prior years remain visible per-quarter in
-- the BAS report. security_invoker stays on.
CREATE OR REPLACE VIEW public.v_organization_realtime_pnl
WITH (security_invoker = on) AS
WITH fy AS (
  SELECT make_date(
    CASE WHEN extract(month FROM current_date) >= 7
         THEN extract(year FROM current_date)::int
         ELSE extract(year FROM current_date)::int - 1 END, 7, 1) AS start
),
org_revenue AS (
  SELECT i.organization_id,
    (sum(i.total_inc_gst_cents))::bigint AS revenue_inc_gst_cents,
    (sum(i.subtotal_ex_gst_cents))::bigint AS revenue_ex_gst_cents,
    (sum(i.gst_cents))::bigint AS gst_collected_cents
  FROM invoices i CROSS JOIN fy
  WHERE i.deleted_at IS NULL AND i.status <> 'void'
    AND i.issue_date >= fy.start AND i.issue_date < (fy.start + interval '1 year')
  GROUP BY i.organization_id
),
org_wages_overhead AS (
  SELECT p.organization_id,
    (sum(p.cost_wages_cents))::bigint AS cost_wages_cents,
    (sum(p.cost_overhead_cents))::bigint AS cost_overhead_cents
  FROM v_job_pnl p GROUP BY p.organization_id
),
org_bills AS (
  SELECT bea.organization_id,
    (sum(bea.effective_total_inc_gst_cents))::bigint AS cost_bills_cents,
    (sum(bea.effective_gst_cents))::bigint AS gst_input_credit_cents
  FROM (v_bill_effective_allocations bea JOIN bills b_1 ON ((b_1.id = bea.bill_id))) CROSS JOIN fy
  WHERE ((b_1.is_personal = false) AND (b_1.status <> 'void'::bill_status) AND (b_1.deleted_at IS NULL)
    AND b_1.invoice_date >= fy.start AND b_1.invoice_date < (fy.start + interval '1 year'))
  GROUP BY bea.organization_id
)
SELECT o.id AS organization_id, o.name AS organization_name, o.settings,
  COALESCE(r.revenue_inc_gst_cents, (0)::bigint) AS revenue_inc_gst_cents,
  COALESCE(r.revenue_ex_gst_cents, (0)::bigint) AS revenue_ex_gst_cents,
  COALESCE(r.gst_collected_cents, (0)::bigint) AS gst_collected_cents,
  COALESCE(b.gst_input_credit_cents, (0)::bigint) AS gst_input_credit_cents,
  GREATEST((0)::bigint, (COALESCE(r.gst_collected_cents, (0)::bigint) - COALESCE(b.gst_input_credit_cents, (0)::bigint))) AS gst_set_aside_cents,
  COALESCE(b.cost_bills_cents, (0)::bigint) AS cost_bills_cents,
  COALESCE(wo.cost_wages_cents, (0)::bigint) AS cost_wages_cents,
  COALESCE(wo.cost_overhead_cents, (0)::bigint) AS cost_overhead_cents,
  ((COALESCE(b.cost_bills_cents, (0)::bigint) + COALESCE(wo.cost_wages_cents, (0)::bigint)) + COALESCE(wo.cost_overhead_cents, (0)::bigint)) AS total_cost_cents,
  (((COALESCE(r.revenue_inc_gst_cents, (0)::bigint) - COALESCE(b.cost_bills_cents, (0)::bigint)) - COALESCE(wo.cost_wages_cents, (0)::bigint)) - COALESCE(wo.cost_overhead_cents, (0)::bigint)) AS gross_profit_cents,
  (GREATEST((0)::numeric, round(((((((COALESCE(r.revenue_inc_gst_cents, (0)::bigint) - COALESCE(b.cost_bills_cents, (0)::bigint)) - COALESCE(wo.cost_wages_cents, (0)::bigint)) - COALESCE(wo.cost_overhead_cents, (0)::bigint)))::numeric * COALESCE(((o.settings ->> 'tax_set_aside_pct'::text))::numeric, ( SELECT (system_defaults.value)::numeric AS value FROM system_defaults WHERE (system_defaults.key = 'default_tax_set_aside_pct'::text)))) / (100)::numeric))))::bigint AS tax_set_aside_cents,
  (GREATEST((0)::numeric, ((((((COALESCE(r.revenue_inc_gst_cents, (0)::bigint) - COALESCE(b.cost_bills_cents, (0)::bigint)) - COALESCE(wo.cost_wages_cents, (0)::bigint)) - COALESCE(wo.cost_overhead_cents, (0)::bigint)) - GREATEST((0)::bigint, (COALESCE(r.gst_collected_cents, (0)::bigint) - COALESCE(b.gst_input_credit_cents, (0)::bigint)))))::numeric - GREATEST((0)::numeric, round(((((((COALESCE(r.revenue_inc_gst_cents, (0)::bigint) - COALESCE(b.cost_bills_cents, (0)::bigint)) - COALESCE(wo.cost_wages_cents, (0)::bigint)) - COALESCE(wo.cost_overhead_cents, (0)::bigint)))::numeric * COALESCE(((o.settings ->> 'tax_set_aside_pct'::text))::numeric, ( SELECT (system_defaults.value)::numeric AS value FROM system_defaults WHERE (system_defaults.key = 'default_tax_set_aside_pct'::text)))) / (100)::numeric))))))::bigint AS really_yours_cents
FROM (((organizations o
  LEFT JOIN org_revenue r ON ((r.organization_id = o.id)))
  LEFT JOIN org_wages_overhead wo ON ((wo.organization_id = o.id)))
  LEFT JOIN org_bills b ON ((b.organization_id = o.id)))
WHERE (o.deleted_at IS NULL);
