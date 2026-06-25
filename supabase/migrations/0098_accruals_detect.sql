-- 0098: Recurring-bill detection (ledger SC-1.I.01).
--
-- Read-only RPC that surfaces recurring bill *series* — a supplier billed on a
-- regular cadence for a roughly constant amount (rent, insurance, software,
-- retainers). SC-1.I.02 (straight-line accrual, same migration file) consumes
-- these series to spread a prepaid/accrued bill across the periods it covers and
-- post reversing journals. This slice writes NOTHING — splitting the cheap-to-
-- verify detection away from the journaling logic.
--
-- NUMBERING: the ledger Files line optimistically reserved 0097, but 0097 is
-- already taken by 0097_depreciation_accounts_seed (SC-1.G.02). The repo head is
-- 0097, so this migration is 0098 (next sequential). Forward note for the rest of
-- Phase 1.I/1.J: SC-1.I.03 accruals_cron -> 0099; SC-1.J.01/1.J.02 then need
-- 0100/0101, which overlaps Phase 2's planned 0100-0106 block — Phase 2 must shift
-- +2 when reached (verify the live head first, per the global drift rule).
--
-- HEURISTIC: ported from supabase/functions/subscriptions-detect/index.ts, which
-- clusters recurring *bank transactions*. The core algorithm is identical so the
-- two detectors agree on what "recurring" means; only the source differs (bills,
-- grouped by supplier, instead of bank txns grouped by canonical description):
--   1. Group org bills by a canonical supplier key — prefer the supplier_id FK,
--      else a cleaned supplier_name_raw (lowercased, entity-suffixes + punctuation
--      stripped, first 40 chars). Bills with neither identifier can't be grouped
--      and are dropped.
--   2. Keep groups with >= p_min_occurrences bills (default 3 — same as
--      subscriptions-detect; two points can't establish a cadence).
--   3. Compute the group's median amount and drop outliers > ±5% from it (a
--      one-off large bill from a recurring supplier shouldn't distort the series),
--      then re-require >= p_min_occurrences survivors.
--   4. Compute the median gap-in-days between consecutive bills and classify the
--      cadence with the SAME bands as subscriptions-detect (weekly … yearly).
--      A gap that fits no band => not a recurring series => dropped.
--   5. Return one row per surviving series with its cadence, median amount, span,
--      next-expected date, a confidence score and the member bill ids.
--
-- DELIBERATE PARAMETER DEVIATION (documented): p_lookback_months DEFAULT 24, vs
-- subscriptions-detect's hard-coded 18. Bills reach further back than the bank
-- feed and an *annual* accrual (insurance, ASIC fees) needs >= 3 yearly bills,
-- which span 24+ months. It stays a parameter — AU FY windows and review needs
-- vary — so callers focused on monthly series can pass a shorter window.
--
-- amount basis = COALESCE(total_inc_gst_cents, subtotal_ex_gst_cents): the gross
-- recurring outlay is what clusters consistently and what a reviewer recognises.
-- SC-1.I.02 re-derives the net/GST split per bill when it builds journals.
--
-- Security model: SECURITY INVOKER (matches 0090 compute_books_health / 0094
-- detect_capital_purchases). The function filters source rows with
-- organization_id = p_org; RLS on bills (organization_id IN get_accessible_org_ids())
-- scopes results to the caller under their own identity, while a service_role
-- backend bypasses RLS. No privilege-escalation surface, no new advisor class.
--
-- Once Phase 2 (SC-2.A/2.B) lands, the *accrual* path (SC-1.I.02) becomes a Tier-1
-- "notify" action; this detection RPC stays read-only and ungated.

CREATE OR REPLACE FUNCTION public.detect_recurring_bills(
  p_org             uuid,
  p_min_occurrences integer DEFAULT 3,   -- min bills (after outlier filter) to call it a series
  p_lookback_months integer DEFAULT 24   -- window; 24 so an annual cadence can reach 3 occurrences
)
RETURNS TABLE (
  supplier_key        text,    -- stable grouping key (sid:<uuid> | nm:<canonical>); SC-1.I.02 references the series by this
  supplier_id         uuid,    -- representative supplier FK (NULL for name-grouped series)
  supplier_name       text,    -- most-recent non-null supplier_name_raw in the series
  cadence             text,    -- weekly | fortnightly | monthly | quarterly | semi_annual | yearly
  occurrence_count    integer, -- bills in the series after the ±5% outlier filter
  median_amount_cents bigint,  -- gross (inc-GST) recurring amount
  median_gap_days     integer, -- median days between consecutive bills
  first_seen          date,
  last_seen           date,
  next_expected       date,    -- last_seen + median_gap_days
  confidence          numeric, -- 0..1: more observations + tighter gap variance = higher
  bill_ids            uuid[]   -- member bill ids (chronological)
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH base AS (
    SELECT
      b.id,
      b.supplier_id,
      b.supplier_name_raw,
      COALESCE(b.invoice_date, b.created_at::date)              AS bill_date,
      COALESCE(b.total_inc_gst_cents, b.subtotal_ex_gst_cents)  AS amount_cents,
      -- canonical supplier key: prefer the supplier_id FK; else a cleaned name.
      -- The name base reuses public.normalise_supplier_name (0028) — the same
      -- primitive that backs the suppliers unique index + autolink trigger — so the
      -- detector's "same supplier" notion can't drift from the DB's. On top of that
      -- base we additionally strip entity suffixes + punctuation and take the first
      -- 40 chars: a deliberate, *stronger* adaptation of subscriptions-detect's
      -- canonicaliseDescription() (different suffix list, 40- vs 32-char cap, and no
      -- long-number stripping — supplier names aren't bank-txn descriptions with
      -- card masks / refs to remove). The 'sid:'/'nm:' prefixes keep a uuid from
      -- colliding with a name. NULL when the bill has neither identifier (dropped
      -- by the `keyed` CTE below).
      COALESCE(
        'sid:' || b.supplier_id::text,
        'nm:' || NULLIF(
          LEFT(btrim(regexp_replace(
            regexp_replace(public.normalise_supplier_name(b.supplier_name_raw),
                           '\y(pty|ltd|limited|llc|inc|australia|aus)\y', ' ', 'g'),
            '[^a-z0-9]+', ' ', 'g')), 40),
          '')
      )                                                          AS supplier_key
    FROM public.bills b
    WHERE b.organization_id = p_org
      AND b.deleted_at IS NULL
      AND b.status::text <> 'void'
      AND b.is_personal IS NOT TRUE
      AND COALESCE(b.total_inc_gst_cents, b.subtotal_ex_gst_cents) IS NOT NULL
      AND COALESCE(b.invoice_date, b.created_at::date)
            >= (CURRENT_DATE - make_interval(months => p_lookback_months))::date
  ),
  keyed AS (
    SELECT * FROM base WHERE supplier_key IS NOT NULL
  ),
  group_median AS (
    -- groups large enough to bother with, and their median amount for outlier-pruning
    SELECT supplier_key,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY amount_cents) AS med_amt
    FROM keyed
    GROUP BY supplier_key
    HAVING count(*) >= p_min_occurrences
  ),
  filtered AS (
    -- drop bills whose amount is > ±5% from the group median
    SELECT k.*
    FROM keyed k
    JOIN group_median gm USING (supplier_key)
    WHERE abs(k.amount_cents - gm.med_amt) <= gm.med_amt * 0.05
  ),
  gapped AS (
    SELECT f.*,
           (f.bill_date - lag(f.bill_date) OVER (PARTITION BY f.supplier_key ORDER BY f.bill_date, f.id))
             AS gap_days
    FROM filtered f
  ),
  series AS (
    SELECT
      supplier_key,
      count(*)::integer                                                     AS occurrence_count,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY amount_cents)             AS median_amount_num,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_days)
        FILTER (WHERE gap_days IS NOT NULL)                                 AS median_gap_num,
      min(bill_date)                                                        AS first_seen,
      max(bill_date)                                                        AS last_seen,
      avg(gap_days) FILTER (WHERE gap_days IS NOT NULL)                     AS mean_gap,
      stddev_pop(gap_days) FILTER (WHERE gap_days IS NOT NULL)              AS sd_gap,
      (array_agg(supplier_id) FILTER (WHERE supplier_id IS NOT NULL))[1]    AS supplier_id,
      -- most-recent non-null name (DESC), not subscriptions-detect's first/oldest:
      -- supplier names get tidied over time, so the latest spelling reads best in review.
      (array_agg(supplier_name_raw ORDER BY bill_date DESC)
        FILTER (WHERE supplier_name_raw IS NOT NULL))[1]                    AS supplier_name,
      array_agg(id ORDER BY bill_date, id)                                  AS bill_ids
    FROM gapped
    GROUP BY supplier_key
    HAVING count(*) >= p_min_occurrences   -- survivors after outlier filter
  )
  SELECT
    s.supplier_key,
    s.supplier_id,
    s.supplier_name,
    cad.cadence,
    s.occurrence_count,
    round(s.median_amount_num)::bigint                       AS median_amount_cents,
    round(s.median_gap_num)::integer                         AS median_gap_days,
    s.first_seen,
    s.last_seen,
    (s.last_seen + round(s.median_gap_num)::integer)         AS next_expected,
    round(
      least(s.occurrence_count::numeric / 12, 1) * 0.5
      + greatest(0, 1 - CASE WHEN s.mean_gap > 0
                             THEN COALESCE(s.sd_gap, 0) / s.mean_gap
                             ELSE 1 END) * 0.5
    , 2)                                                     AS confidence,
    s.bill_ids
  FROM series s
  CROSS JOIN LATERAL (
    -- same cadence bands as subscriptions-detect classifyCadence()
    SELECT CASE
      WHEN s.median_gap_num >= 5   AND s.median_gap_num <= 8   THEN 'weekly'
      WHEN s.median_gap_num >= 9   AND s.median_gap_num <= 16  THEN 'fortnightly'
      WHEN s.median_gap_num >= 17  AND s.median_gap_num <= 45  THEN 'monthly'
      WHEN s.median_gap_num >= 46  AND s.median_gap_num <= 100 THEN 'quarterly'
      WHEN s.median_gap_num >= 101 AND s.median_gap_num <= 200 THEN 'semi_annual'
      WHEN s.median_gap_num >= 201 AND s.median_gap_num <= 400 THEN 'yearly'
      ELSE NULL
    END AS cadence
  ) cad
  WHERE cad.cadence IS NOT NULL
  ORDER BY s.occurrence_count DESC, median_amount_cents DESC;
$$;

COMMENT ON FUNCTION public.detect_recurring_bills(uuid, integer, integer) IS
  'SC-1.I.01: read-only detection of recurring bill series (supplier billed on a regular cadence for a ~constant amount). Ports subscriptions-detect''s clustering to bills grouped by supplier. Feeds SC-1.I.02 straight-line accruals. amount = inc-GST gross; p_lookback_months defaults to 24 (annual cadences need >= 3 occurrences). SECURITY INVOKER — RLS on bills scopes the caller.';

GRANT EXECUTE ON FUNCTION public.detect_recurring_bills(uuid, integer, integer) TO authenticated;

-- Expose the new RPC to PostgREST immediately.
NOTIFY pgrst, 'reload schema';
