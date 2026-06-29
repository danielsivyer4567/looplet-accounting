-- ============================================================================
-- 0047: Split allocation across organisations.
--
-- A trades operator may run multiple businesses out of a single household.
-- A single domain registration bill, an Adobe subscription, or a personal
-- bank-card payment can legitimately serve more than one business. Until
-- now the only knob was MoveToOrg (which wholesales the row to a different
-- org). This migration adds a *splits* table so a single resource can be
-- attributed across multiple orgs by percentage.
--
-- Design:
--   * The "host" org is whatever resource.organization_id already points at.
--   * allocation_splits rows describe the shares attributed to OTHER orgs.
--   * SUM(percentage) for a resource must be <= 100. The host org's effective
--     share is (100 - SUM(splits.percentage)). A resource with zero split
--     rows behaves exactly like before — host org gets 100%.
--   * Effective per-org allocation views surface the math. Downstream rollups
--     (v_organization_realtime_pnl, v_bas_quarterly) are rewritten to consume
--     those views so per-org P&L / BAS is split-aware.
--
-- Touch radius: additive table + 3 effective-allocation views + 2 view
-- rewrites. Original rows in bills/bank_transactions/subscriptions are left
-- alone — splits are a side-channel, not a destructive remap.
-- ============================================================================

-- -- Enum tagging which physical table a split row points at -----------------
DO $$ BEGIN
  CREATE TYPE public.split_resource_type AS ENUM ('bill', 'bank_transaction', 'subscription');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -- Splits table -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.allocation_splits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type public.split_resource_type NOT NULL,
  resource_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  percentage numeric(5,2) NOT NULL CHECK (percentage > 0 AND percentage <= 100),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT splits_resource_org_uniq UNIQUE (resource_type, resource_id, organization_id)
);

CREATE INDEX IF NOT EXISTS allocation_splits_resource_idx
  ON public.allocation_splits (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS allocation_splits_org_idx
  ON public.allocation_splits (organization_id, resource_type);

COMMENT ON TABLE public.allocation_splits IS
  'Cross-org cost-share rows for bills, bank transactions, and subscriptions. The host (native organization_id of the resource) implicitly owns 100 - SUM(splits.percentage). Sum across (resource_type, resource_id) is capped at 100 by trigger.';

-- -- SUM(percentage) per resource <= 100 ------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_split_total() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_total numeric;
  v_resource_type public.split_resource_type;
  v_resource_id uuid;
BEGIN
  v_resource_type := COALESCE(NEW.resource_type, OLD.resource_type);
  v_resource_id   := COALESCE(NEW.resource_id, OLD.resource_id);
  SELECT COALESCE(SUM(percentage), 0) INTO v_total
    FROM public.allocation_splits
   WHERE resource_type = v_resource_type
     AND resource_id   = v_resource_id;
  IF v_total > 100 THEN
    RAISE EXCEPTION
      'Split percentages for %/% sum to %, exceeds 100',
      v_resource_type, v_resource_id, v_total;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS trg_splits_total_check ON public.allocation_splits;
CREATE TRIGGER trg_splits_total_check
  AFTER INSERT OR UPDATE ON public.allocation_splits
  FOR EACH ROW EXECUTE FUNCTION public.enforce_split_total();

-- -- RLS --------------------------------------------------------------------
ALTER TABLE public.allocation_splits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS allocation_splits_select ON public.allocation_splits;
CREATE POLICY allocation_splits_select ON public.allocation_splits
  FOR SELECT USING (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS allocation_splits_insert ON public.allocation_splits;
CREATE POLICY allocation_splits_insert ON public.allocation_splits
  FOR INSERT WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS allocation_splits_update ON public.allocation_splits;
CREATE POLICY allocation_splits_update ON public.allocation_splits
  FOR UPDATE USING (organization_id IN (SELECT public.get_accessible_org_ids()))
  WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));

DROP POLICY IF EXISTS allocation_splits_delete ON public.allocation_splits;
CREATE POLICY allocation_splits_delete ON public.allocation_splits
  FOR DELETE USING (organization_id IN (SELECT public.get_accessible_org_ids()));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.allocation_splits TO authenticated;

-- ============================================================================
-- Effective-allocation views.
--
-- Each view emits one row per (resource, org) combination with the org's
-- effective percentage and dollar share. When no split rows exist, the host
-- org is the only row and receives 100% — i.e. existing behaviour.
-- ============================================================================

-- -- bills -----------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_bill_effective_allocations AS
WITH split_totals AS (
  SELECT resource_id AS bill_id, COALESCE(SUM(percentage), 0)::numeric AS split_total_pct
    FROM public.allocation_splits
   WHERE resource_type = 'bill'
   GROUP BY resource_id
)
-- Host org row: 100 - sum(splits) when splits exist, else 100.
SELECT
  b.id                                          AS bill_id,
  b.organization_id                             AS organization_id,
  true                                          AS is_host,
  GREATEST(0, 100 - COALESCE(s.split_total_pct, 0))::numeric(5,2) AS percentage,
  ROUND(COALESCE(b.total_inc_gst_cents, 0)
        * GREATEST(0, 100 - COALESCE(s.split_total_pct, 0)) / 100)::bigint AS effective_total_inc_gst_cents,
  ROUND(COALESCE(b.subtotal_ex_gst_cents, 0)
        * GREATEST(0, 100 - COALESCE(s.split_total_pct, 0)) / 100)::bigint AS effective_subtotal_ex_gst_cents,
  ROUND(COALESCE(b.gst_cents, 0)
        * GREATEST(0, 100 - COALESCE(s.split_total_pct, 0)) / 100)::bigint AS effective_gst_cents
FROM public.bills b
LEFT JOIN split_totals s ON s.bill_id = b.id
WHERE b.deleted_at IS NULL
UNION ALL
-- Non-host rows from allocation_splits.
SELECT
  b.id                                          AS bill_id,
  asp.organization_id                           AS organization_id,
  false                                         AS is_host,
  asp.percentage::numeric(5,2)                  AS percentage,
  ROUND(COALESCE(b.total_inc_gst_cents, 0) * asp.percentage / 100)::bigint AS effective_total_inc_gst_cents,
  ROUND(COALESCE(b.subtotal_ex_gst_cents, 0) * asp.percentage / 100)::bigint AS effective_subtotal_ex_gst_cents,
  ROUND(COALESCE(b.gst_cents, 0) * asp.percentage / 100)::bigint AS effective_gst_cents
FROM public.allocation_splits asp
JOIN public.bills b ON b.id = asp.resource_id
WHERE asp.resource_type = 'bill'
  AND b.deleted_at IS NULL;

COMMENT ON VIEW public.v_bill_effective_allocations IS
  'One row per (bill, org) with the org-effective percentage and dollar share. Host org row exists for every bill (percentage = 100 if no splits, else 100 - sum). Use this in P&L / BAS rollups instead of summing bills.organization_id directly.';

-- -- bank_transactions -----------------------------------------------------
CREATE OR REPLACE VIEW public.v_bank_transaction_effective_allocations AS
WITH split_totals AS (
  SELECT resource_id AS txn_id, COALESCE(SUM(percentage), 0)::numeric AS split_total_pct
    FROM public.allocation_splits
   WHERE resource_type = 'bank_transaction'
   GROUP BY resource_id
)
SELECT
  t.id                                          AS bank_transaction_id,
  t.organization_id                             AS organization_id,
  true                                          AS is_host,
  GREATEST(0, 100 - COALESCE(s.split_total_pct, 0))::numeric(5,2) AS percentage,
  ROUND(COALESCE(t.amount_cents, 0)
        * GREATEST(0, 100 - COALESCE(s.split_total_pct, 0)) / 100)::bigint AS effective_amount_cents
FROM public.bank_transactions t
LEFT JOIN split_totals s ON s.txn_id = t.id
UNION ALL
SELECT
  t.id                                          AS bank_transaction_id,
  asp.organization_id                           AS organization_id,
  false                                         AS is_host,
  asp.percentage::numeric(5,2)                  AS percentage,
  ROUND(COALESCE(t.amount_cents, 0) * asp.percentage / 100)::bigint AS effective_amount_cents
FROM public.allocation_splits asp
JOIN public.bank_transactions t ON t.id = asp.resource_id
WHERE asp.resource_type = 'bank_transaction';

COMMENT ON VIEW public.v_bank_transaction_effective_allocations IS
  'One row per (bank_transaction, org) with the org-effective percentage and dollar share. Mirrors v_bill_effective_allocations.';

-- -- subscriptions ---------------------------------------------------------
CREATE OR REPLACE VIEW public.v_subscription_effective_allocations AS
WITH split_totals AS (
  SELECT resource_id AS sub_id, COALESCE(SUM(percentage), 0)::numeric AS split_total_pct
    FROM public.allocation_splits
   WHERE resource_type = 'subscription'
   GROUP BY resource_id
)
SELECT
  s.id                                          AS subscription_id,
  s.organization_id                             AS organization_id,
  true                                          AS is_host,
  GREATEST(0, 100 - COALESCE(st.split_total_pct, 0))::numeric(5,2) AS percentage,
  ROUND(COALESCE(s.amount_cents, 0)
        * GREATEST(0, 100 - COALESCE(st.split_total_pct, 0)) / 100)::bigint AS effective_amount_cents
FROM public.subscriptions s
LEFT JOIN split_totals st ON st.sub_id = s.id
UNION ALL
SELECT
  s.id                                          AS subscription_id,
  asp.organization_id                           AS organization_id,
  false                                         AS is_host,
  asp.percentage::numeric(5,2)                  AS percentage,
  ROUND(COALESCE(s.amount_cents, 0) * asp.percentage / 100)::bigint AS effective_amount_cents
FROM public.allocation_splits asp
JOIN public.subscriptions s ON s.id = asp.resource_id
WHERE asp.resource_type = 'subscription';

COMMENT ON VIEW public.v_subscription_effective_allocations IS
  'One row per (subscription, org) with the org-effective percentage and dollar share. Mirrors v_bill_effective_allocations.';

GRANT SELECT ON public.v_bill_effective_allocations TO authenticated;
GRANT SELECT ON public.v_bank_transaction_effective_allocations TO authenticated;
GRANT SELECT ON public.v_subscription_effective_allocations TO authenticated;

-- ============================================================================
-- Rewrite v_organization_realtime_pnl + v_bas_quarterly to use the effective
-- allocation views.
--
-- v_organization_realtime_pnl previously aggregated v_job_pnl by host org.
-- v_job_pnl itself sums v_job_costs.bills (which group by bills.organization_id).
-- For job-level P&L we keep the host-org behaviour (the bill is attached to a
-- job in one org; splitting across jobs is a different feature). What changes
-- is the org-level rollup: cost_bills_cents needs to reflect the effective
-- per-org share, not the host-org-only share.
--
-- The strategy: we rebuild v_organization_realtime_pnl to:
--   * take revenue, wages, overhead from v_job_pnl (host-org only — unchanged)
--   * take cost_bills_cents from v_bill_effective_allocations
--     filtered to status IN ('attached','paid') and job_id NOT NULL? No —
--     for the org rollup we want all non-personal bills, same as the bills
--     side of v_bas_quarterly. We mirror that here so the org P&L sees every
--     bill cost (including bills not yet linked to a job).
--   * keep gst_input_credit_cents from effective allocations (BAS side).
--
-- Behavioural delta when no splits exist:
--   * cost_bills_cents previously came from v_job_costs (job-attached bills
--     only). It now reflects ALL non-personal bills. This is a deliberate
--     correction — the org rollup should show all real costs, not just
--     job-attached ones. Documented in the COMMENT below.
-- ============================================================================

DROP VIEW IF EXISTS public.v_organization_realtime_pnl CASCADE;

CREATE VIEW public.v_organization_realtime_pnl AS
WITH org_revenue AS (
  -- Revenue from v_job_pnl (invoices, host-org)
  SELECT
    p.organization_id,
    SUM(p.revenue_inc_gst_cents)::bigint  AS revenue_inc_gst_cents,
    SUM(p.revenue_ex_gst_cents)::bigint   AS revenue_ex_gst_cents,
    SUM(p.gst_collected_cents)::bigint    AS gst_collected_cents
  FROM public.v_job_pnl p
  GROUP BY p.organization_id
),
org_wages_overhead AS (
  -- Wages + overhead (host-org, job-attached only) — unchanged from before
  SELECT
    p.organization_id,
    SUM(p.cost_wages_cents)::bigint       AS cost_wages_cents,
    SUM(p.cost_overhead_cents)::bigint    AS cost_overhead_cents
  FROM public.v_job_pnl p
  GROUP BY p.organization_id
),
org_bills AS (
  -- Bill costs reflecting effective allocations across orgs.
  -- Excludes is_personal bills (matches BAS / cash-flow logic).
  SELECT
    bea.organization_id,
    SUM(bea.effective_total_inc_gst_cents)::bigint  AS cost_bills_cents,
    SUM(bea.effective_gst_cents)::bigint            AS gst_input_credit_cents
  FROM public.v_bill_effective_allocations bea
  JOIN public.bills b ON b.id = bea.bill_id
  WHERE b.is_personal = false
    AND b.status IN ('attached', 'paid')
  GROUP BY bea.organization_id
)
SELECT
  o.id                                                     AS organization_id,
  o.name                                                   AS organization_name,
  o.settings,
  COALESCE(r.revenue_inc_gst_cents, 0)::bigint             AS revenue_inc_gst_cents,
  COALESCE(r.revenue_ex_gst_cents, 0)::bigint              AS revenue_ex_gst_cents,
  COALESCE(r.gst_collected_cents, 0)::bigint               AS gst_collected_cents,
  COALESCE(b.gst_input_credit_cents, 0)::bigint            AS gst_input_credit_cents,
  GREATEST(
    0,
    COALESCE(r.gst_collected_cents, 0) - COALESCE(b.gst_input_credit_cents, 0)
  )::bigint                                                AS gst_set_aside_cents,
  COALESCE(b.cost_bills_cents, 0)::bigint                  AS cost_bills_cents,
  COALESCE(wo.cost_wages_cents, 0)::bigint                 AS cost_wages_cents,
  COALESCE(wo.cost_overhead_cents, 0)::bigint              AS cost_overhead_cents,
  (COALESCE(b.cost_bills_cents, 0)
     + COALESCE(wo.cost_wages_cents, 0)
     + COALESCE(wo.cost_overhead_cents, 0))::bigint        AS total_cost_cents,
  (COALESCE(r.revenue_inc_gst_cents, 0)
     - COALESCE(b.cost_bills_cents, 0)
     - COALESCE(wo.cost_wages_cents, 0)
     - COALESCE(wo.cost_overhead_cents, 0))::bigint        AS gross_profit_cents,
  GREATEST(
    0,
    ROUND(
      (COALESCE(r.revenue_inc_gst_cents, 0)
         - COALESCE(b.cost_bills_cents, 0)
         - COALESCE(wo.cost_wages_cents, 0)
         - COALESCE(wo.cost_overhead_cents, 0))
      * COALESCE(
          (o.settings->>'tax_set_aside_pct')::numeric,
          (SELECT value::numeric FROM public.system_defaults WHERE key = 'default_tax_set_aside_pct')
        )
      / 100
    )
  )::bigint                                                AS tax_set_aside_cents,
  GREATEST(
    0,
    (COALESCE(r.revenue_inc_gst_cents, 0)
       - COALESCE(b.cost_bills_cents, 0)
       - COALESCE(wo.cost_wages_cents, 0)
       - COALESCE(wo.cost_overhead_cents, 0))
    - GREATEST(0, COALESCE(r.gst_collected_cents, 0) - COALESCE(b.gst_input_credit_cents, 0))
    - GREATEST(
        0,
        ROUND(
          (COALESCE(r.revenue_inc_gst_cents, 0)
             - COALESCE(b.cost_bills_cents, 0)
             - COALESCE(wo.cost_wages_cents, 0)
             - COALESCE(wo.cost_overhead_cents, 0))
          * COALESCE(
              (o.settings->>'tax_set_aside_pct')::numeric,
              (SELECT value::numeric FROM public.system_defaults WHERE key = 'default_tax_set_aside_pct')
            )
          / 100
        )
      )
  )::bigint                                                AS really_yours_cents
FROM public.organizations o
LEFT JOIN org_revenue r        ON r.organization_id = o.id
LEFT JOIN org_wages_overhead wo ON wo.organization_id = o.id
LEFT JOIN org_bills b          ON b.organization_id = o.id
WHERE o.deleted_at IS NULL;

COMMENT ON VIEW public.v_organization_realtime_pnl IS
  '0047: cost_bills_cents and gst_input_credit_cents now flow through v_bill_effective_allocations so cross-org splits attribute the right share to each business. Revenue / wages / overhead are still host-org via v_job_pnl. Note: cost_bills_cents now covers ALL non-personal bills (status attached|paid), not only job-attached ones, since splitting is decoupled from job-attach.';

GRANT SELECT ON public.v_organization_realtime_pnl TO authenticated;

-- -- v_bas_quarterly: rewrite bills_per_q to use effective allocations -----
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
  -- Use effective per-org allocation for purchases / GST paid.
  SELECT bea.organization_id, q.fy_start_year, q.quarter_num,
         SUM(bea.effective_gst_cents)            AS gst_paid_cents,
         SUM(bea.effective_subtotal_ex_gst_cents) AS purchases_ex_gst_cents,
         COUNT(*)                                AS bill_count
  FROM public.v_bill_effective_allocations bea
  JOIN public.bills b ON b.id = bea.bill_id
  CROSS JOIN LATERAL public.au_bas_quarter(b.invoice_date) q
  WHERE b.deleted_at IS NULL AND b.is_personal = false AND b.invoice_date IS NOT NULL
  GROUP BY bea.organization_id, q.fy_start_year, q.quarter_num
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

COMMENT ON VIEW public.v_bas_quarterly IS
  '0047: purchases_ex_gst_cents and gst_paid_cents now flow through v_bill_effective_allocations so each org pays GST only on its share of split bills.';

GRANT SELECT ON public.v_bas_quarterly TO authenticated;
