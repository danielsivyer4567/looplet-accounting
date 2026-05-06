-- 0042: View consolidation, perf rewrites, and legacy customer_invoices removal.
-- Five fixes from the SQL review (docs/SQL_REVIEW_2026-05-06.md):
-- 1. Migrate v_job_revenue from customer_invoices → invoices
-- 2. Drop v_gst_summary_by_quarter (duplicate of v_bas_quarterly in 0032)
-- 3. Drop legacy customer_invoices table (0 rows; replaced by invoices)
-- 4. Floor tax_set_aside_cents at 0 in v_organization_realtime_pnl
-- 5. Rewrite v_job_pnl with single LATERAL aggregate (5 correlated subqueries → 1 GROUP BY FILTER)

-- DROP CASCADE because column types are changing (numeric → bigint).
DROP VIEW IF EXISTS public.v_organization_realtime_pnl CASCADE;
DROP VIEW IF EXISTS public.v_job_pnl CASCADE;
DROP VIEW IF EXISTS public.v_job_revenue CASCADE;
DROP VIEW IF EXISTS public.v_gst_summary_by_quarter CASCADE;
DROP TABLE IF EXISTS public.customer_invoices CASCADE;

CREATE VIEW public.v_job_revenue AS
SELECT
  organization_id,
  job_id,
  SUM(total_inc_gst_cents)::bigint    AS revenue_inc_gst_cents,
  SUM(subtotal_ex_gst_cents)::bigint  AS revenue_ex_gst_cents,
  SUM(gst_cents)::bigint              AS gst_collected_cents,
  SUM(amount_paid_cents)::bigint      AS amount_paid_cents,
  COUNT(*)::integer                   AS invoice_count
FROM public.invoices
WHERE deleted_at IS NULL
  AND job_id IS NOT NULL
  AND status IN ('sent', 'partially_paid', 'paid', 'overdue')
GROUP BY organization_id, job_id;

CREATE VIEW public.v_job_pnl AS
WITH job_costs_agg AS (
  SELECT
    job_id,
    SUM(total_cents) FILTER (WHERE category = 'bills')    AS cost_bills_cents,
    SUM(total_cents) FILTER (WHERE category = 'wages')    AS cost_wages_cents,
    SUM(total_cents) FILTER (WHERE category = 'overhead') AS cost_overhead_cents,
    SUM(gst_cents)                                         AS gst_input_credit_cents,
    SUM(total_cents)                                       AS total_cost_cents
  FROM public.v_job_costs
  WHERE job_id IS NOT NULL
  GROUP BY job_id
)
SELECT
  j.id AS job_id,
  j.organization_id,
  j.job_number,
  j.name AS job_name,
  j.status AS job_status,
  j.start_date,
  j.end_date,
  COALESCE(r.revenue_inc_gst_cents, 0)::bigint   AS revenue_inc_gst_cents,
  COALESCE(r.revenue_ex_gst_cents, 0)::bigint    AS revenue_ex_gst_cents,
  COALESCE(r.gst_collected_cents, 0)::bigint     AS gst_collected_cents,
  COALESCE(c.cost_bills_cents, 0)::bigint        AS cost_bills_cents,
  COALESCE(c.cost_wages_cents, 0)::bigint        AS cost_wages_cents,
  COALESCE(c.cost_overhead_cents, 0)::bigint     AS cost_overhead_cents,
  COALESCE(c.gst_input_credit_cents, 0)::bigint  AS gst_input_credit_cents,
  COALESCE(c.total_cost_cents, 0)::bigint        AS total_cost_cents,
  (COALESCE(r.revenue_inc_gst_cents, 0) - COALESCE(c.total_cost_cents, 0))::bigint AS gross_profit_cents,
  j.budget_cents,
  j.currency_code
FROM public.jobs j
LEFT JOIN public.v_job_revenue r ON r.job_id = j.id
LEFT JOIN job_costs_agg c        ON c.job_id = j.id
WHERE j.deleted_at IS NULL;

CREATE VIEW public.v_organization_realtime_pnl AS
SELECT
  o.id AS organization_id,
  o.name AS organization_name,
  o.settings,
  COALESCE(SUM(p.revenue_inc_gst_cents), 0)::bigint   AS revenue_inc_gst_cents,
  COALESCE(SUM(p.revenue_ex_gst_cents), 0)::bigint    AS revenue_ex_gst_cents,
  COALESCE(SUM(p.gst_collected_cents), 0)::bigint     AS gst_collected_cents,
  COALESCE(SUM(p.gst_input_credit_cents), 0)::bigint  AS gst_input_credit_cents,
  GREATEST(0, COALESCE(SUM(p.gst_collected_cents), 0) - COALESCE(SUM(p.gst_input_credit_cents), 0))::bigint
    AS gst_set_aside_cents,
  COALESCE(SUM(p.cost_bills_cents), 0)::bigint    AS cost_bills_cents,
  COALESCE(SUM(p.cost_wages_cents), 0)::bigint    AS cost_wages_cents,
  COALESCE(SUM(p.cost_overhead_cents), 0)::bigint AS cost_overhead_cents,
  COALESCE(SUM(p.total_cost_cents), 0)::bigint    AS total_cost_cents,
  COALESCE(SUM(p.gross_profit_cents), 0)::bigint  AS gross_profit_cents,
  GREATEST(
    0,
    ROUND(
      COALESCE(SUM(p.gross_profit_cents), 0)
      * COALESCE(
          (o.settings->>'tax_set_aside_pct')::numeric,
          (SELECT value::numeric FROM public.system_defaults WHERE key = 'default_tax_set_aside_pct')
        )
      / 100
    )
  )::bigint AS tax_set_aside_cents,
  GREATEST(
    0,
    COALESCE(SUM(p.gross_profit_cents), 0)
    - GREATEST(0, COALESCE(SUM(p.gst_collected_cents), 0) - COALESCE(SUM(p.gst_input_credit_cents), 0))
    - GREATEST(
        0,
        ROUND(
          COALESCE(SUM(p.gross_profit_cents), 0)
          * COALESCE(
              (o.settings->>'tax_set_aside_pct')::numeric,
              (SELECT value::numeric FROM public.system_defaults WHERE key = 'default_tax_set_aside_pct')
            )
          / 100
        )
      )
  )::bigint AS really_yours_cents
FROM public.organizations o
LEFT JOIN public.v_job_pnl p ON p.organization_id = o.id
WHERE o.deleted_at IS NULL
GROUP BY o.id, o.name, o.settings;
