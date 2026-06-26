-- 0090: Books-health raw component scoring function (ledger SC-1.A.01).
--
-- Pure, side-effect-free read of the four raw signals that say whether an org's
-- books are "right". SC-1.A.02 weights these into a single 0-100 score + a
-- `blocking` flag that every downstream engine (BAS, EOFY, returns) reads before
-- it will run.
--
-- Components (all org-scoped; this is SECURITY INVOKER so RLS on the underlying
-- tables scopes results to the caller's accessible orgs — the SC-1.A.02 view
-- adds the explicit get_accessible_org_ids() filter):
--   uncoded_count       live (non-void) bills with no auto_category_code
--   unreconciled_count  business bank_transactions matched to neither bill nor invoice
--   open_period_count   calendar months with activity not covered by an active period lock
--   coverage_pct        100 * (coded bills + reconciled txns) / (all bills + all business txns)
--
-- "Coded" = has an auto_category_code today. When the SC-1.C classifier starts
-- posting GL journals from bills, coverage can be tightened to "has a posted
-- journal_entry"; kept as the categorisation signal here so the metric is
-- meaningful before that lands. (Note: `bills.category_code` does NOT exist —
-- the live column is `auto_category_code`.)

CREATE OR REPLACE FUNCTION public.compute_books_health(p_org_id uuid)
RETURNS TABLE (
  uncoded_count       integer,
  unreconciled_count  integer,
  open_period_count   integer,
  coverage_pct        numeric
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH bill_stats AS (
    SELECT
      count(*)::int AS total_bills,
      count(*) FILTER (
        WHERE b.auto_category_code IS NULL OR length(trim(b.auto_category_code)) = 0
      )::int AS uncoded_bills
    FROM public.bills b
    WHERE b.organization_id = p_org_id
      AND b.deleted_at IS NULL
      AND b.status::text <> 'void'
  ),
  txn_stats AS (
    SELECT
      count(*)::int AS total_txns,
      count(*) FILTER (
        WHERE t.matched_bill_id IS NULL AND t.matched_invoice_id IS NULL
      )::int AS unreconciled_txns
    FROM public.bank_transactions t
    WHERE t.organization_id = p_org_id
      AND t.is_personal IS NOT TRUE
  ),
  activity_months AS (
    SELECT DISTINCT date_trunc('month', d)::date AS m_start
    FROM (
      SELECT b.invoice_date AS d
        FROM public.bills b
        WHERE b.organization_id = p_org_id AND b.deleted_at IS NULL
          AND b.status::text <> 'void' AND b.invoice_date IS NOT NULL
      UNION ALL
      SELECT i.issue_date
        FROM public.invoices i
        WHERE i.organization_id = p_org_id AND i.deleted_at IS NULL
          AND i.status::text <> 'void' AND i.issue_date IS NOT NULL
      UNION ALL
      SELECT t.posted_at::date
        FROM public.bank_transactions t
        WHERE t.organization_id = p_org_id AND t.is_personal IS NOT TRUE
          AND t.posted_at IS NOT NULL
    ) s
  ),
  open_months AS (
    SELECT am.m_start
    FROM activity_months am
    WHERE NOT EXISTS (
      SELECT 1 FROM public.period_locks pl
      WHERE pl.organization_id = p_org_id
        AND pl.unlocked_at IS NULL
        AND pl.period_start <= am.m_start
        AND pl.period_end   >= (am.m_start + INTERVAL '1 month' - INTERVAL '1 day')::date
    )
  )
  SELECT
    bs.uncoded_bills                              AS uncoded_count,
    ts.unreconciled_txns                          AS unreconciled_count,
    (SELECT count(*)::int FROM open_months)       AS open_period_count,
    CASE
      WHEN (bs.total_bills + ts.total_txns) = 0 THEN 100.00
      ELSE round(
        100.0 * ((bs.total_bills - bs.uncoded_bills) + (ts.total_txns - ts.unreconciled_txns))
        / (bs.total_bills + ts.total_txns), 2)
    END                                           AS coverage_pct
  FROM bill_stats bs, txn_stats ts;
$$;

GRANT EXECUTE ON FUNCTION public.compute_books_health(uuid) TO authenticated;
