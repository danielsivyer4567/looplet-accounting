-- 20260702181500_bank_transaction_job_attribution.sql
--
-- bank_transactions had no confirmed job_id — only suggested_job_id, an
-- unconfirmed classifier guess (bank-transaction-classifier), with no
-- human confirm step analogous to bills.job_id + bills-attach. That made
-- any job-related bank spend NOT already captured as a formal bill
-- invisible to v_job_pnl. Add a real, human-confirmed job_id column
-- (bank-transaction-attach-job is the confirm path, mirroring bills-attach)
-- and fold confirmed-job transactions into v_job_costs as a new category —
-- excluding any transaction already matched to a bill/invoice, since that
-- cost/revenue is already counted via bill_costs / invoice revenue and
-- summing both would double-count.

ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS job_id uuid REFERENCES public.jobs(id);

CREATE INDEX IF NOT EXISTS idx_bank_transactions_job_id
  ON public.bank_transactions (job_id)
  WHERE job_id IS NOT NULL;

CREATE OR REPLACE VIEW public.v_job_costs AS
WITH bill_costs AS (
  SELECT
    b.organization_id,
    b.job_id,
    'bills'::text AS category,
    SUM(COALESCE(b.total_inc_gst_cents, 0))::numeric AS total_cents,
    SUM(COALESCE(b.gst_cents, 0))::numeric AS gst_cents,
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
    SUM(we.total_cost_cents)::numeric AS total_cents,
    0::numeric AS gst_cents,
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
    SUM(te.total_cost_cents)::numeric AS total_cents,
    0::numeric AS gst_cents,
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
    SUM(oa.amount_cents)::numeric AS total_cents,
    0::numeric AS gst_cents,
    COUNT(*)::int AS row_count
  FROM public.overhead_allocations oa
  WHERE oa.job_id IS NOT NULL
  GROUP BY oa.organization_id, oa.job_id
),
-- Confirmed-job bank spend not already captured via a bill/invoice match —
-- e.g. EFTPOS purchases, bank fees, or direct debits allocated to a job
-- with no formal bill raised. Debits only (amount_cents < 0); the sign is
-- flipped so this sums as a positive cost like every other category.
bank_direct_costs AS (
  SELECT
    bt.organization_id,
    bt.job_id,
    'bank_direct'::text AS category,
    SUM(-bt.amount_cents)::numeric AS total_cents,
    0::numeric AS gst_cents,
    COUNT(*)::int AS row_count
  FROM public.bank_transactions bt
  WHERE bt.job_id IS NOT NULL
    AND bt.amount_cents < 0
    AND bt.matched_bill_id IS NULL
    AND bt.matched_invoice_id IS NULL
    AND COALESCE(bt.is_personal, false) = false
  GROUP BY bt.organization_id, bt.job_id
)
SELECT * FROM bill_costs
UNION ALL SELECT * FROM legacy_wage_costs
UNION ALL SELECT * FROM timesheet_wage_costs
UNION ALL SELECT * FROM overhead_costs
UNION ALL SELECT * FROM bank_direct_costs;

ALTER VIEW public.v_job_costs SET (security_invoker = on);

COMMENT ON VIEW public.v_job_costs IS
  'Running per-job cost rollup by category. Wages include legacy wage_entries and current timesheet_entries; bank_direct covers confirmed-job bank spend not already captured via a matched bill/invoice, to avoid double-counting.';
