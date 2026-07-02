-- Wire the current payroll UI table into job P&L wage costs.
--
-- Historical wage entries remain supported, but Employee/Timesheet screens now
-- write public.timesheet_entries. Migration 0033 says timesheet_entries drives
-- v_job_pnl, so v_job_costs must include those rows as the wages category.

CREATE OR REPLACE VIEW public.v_job_costs AS
WITH bill_costs AS (
  SELECT
    b.organization_id,
    b.job_id,
    'bills'::text AS category,
    SUM(COALESCE(b.total_inc_gst_cents, 0))::bigint AS total_cents,
    SUM(COALESCE(b.gst_cents, 0))::bigint AS gst_cents,
    COUNT(*)::int AS row_count
  FROM public.bills b
  WHERE b.deleted_at IS NULL
    AND b.job_id IS NOT NULL
    AND b.status IN ('attached', 'paid')
  GROUP BY b.organization_id, b.job_id
),
legacy_wage_costs AS (
  SELECT
    we.organization_id,
    we.job_id,
    'wages'::text AS category,
    SUM(we.total_cost_cents)::bigint AS total_cents,
    0::bigint AS gst_cents,
    COUNT(*)::int AS row_count
  FROM public.wage_entries we
  WHERE we.deleted_at IS NULL
    AND we.job_id IS NOT NULL
  GROUP BY we.organization_id, we.job_id
),
timesheet_wage_costs AS (
  SELECT
    te.organization_id,
    te.job_id,
    'wages'::text AS category,
    SUM(te.total_cost_cents)::bigint AS total_cents,
    0::bigint AS gst_cents,
    COUNT(*)::int AS row_count
  FROM public.timesheet_entries te
  WHERE te.deleted_at IS NULL
    AND te.job_id IS NOT NULL
  GROUP BY te.organization_id, te.job_id
),
overhead_costs AS (
  SELECT
    oa.organization_id,
    oa.job_id,
    'overhead'::text AS category,
    SUM(oa.amount_cents)::bigint AS total_cents,
    0::bigint AS gst_cents,
    COUNT(*)::int AS row_count
  FROM public.overhead_allocations oa
  WHERE oa.job_id IS NOT NULL
  GROUP BY oa.organization_id, oa.job_id
)
SELECT * FROM bill_costs
UNION ALL SELECT * FROM legacy_wage_costs
UNION ALL SELECT * FROM timesheet_wage_costs
UNION ALL SELECT * FROM overhead_costs;

COMMENT ON VIEW public.v_job_costs IS
  'Running per-job cost rollup by category. Wages include legacy wage_entries and current timesheet_entries so Employee log-time rows flow into v_job_pnl.';
