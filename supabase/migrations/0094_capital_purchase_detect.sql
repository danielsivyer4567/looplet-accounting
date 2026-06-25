-- 0094: Capital-purchase detection (ledger SC-1.F.01).
--
-- Read-only RPC that surfaces bills which look like capital purchases (assets to
-- be capitalised + depreciated) rather than period expenses, so SC-1.F.02
-- (propose_capitalisation) can draft a `proposed` fixed_assets row + schedule and
-- a human can confirm. This slice is the DETECTION half only — it writes nothing.
--
-- Security model: SECURITY INVOKER (matches 0090 compute_books_health / 0089
-- generate_tax_obligations). The function takes a single `p_org` and filters the
-- source rows with `organization_id = p_org`; RLS on `bills` / `fixed_assets`
-- (organization_id IN (SELECT get_accessible_org_ids())) does the security scoping
-- under the caller's identity. A wrapping security_invoker view would add the
-- explicit get_accessible_org_ids() fan-out if a multi-org rollup is ever needed
-- (0091 pattern); not needed here.
--
-- WHAT COUNTS AS A CANDIDATE (all org-scoped, live, non-void, non-personal bills):
--   1. Outlay is material — the depreciable cost base clears p_threshold_cents.
--      cost_base_cents = COALESCE(subtotal_ex_gst_cents, total_inc_gst_cents):
--      a GST-registered entity capitalises the GST-exclusive cost (the GST is an
--      input credit, not part of the asset), so we prefer the ex-GST subtotal and
--      fall back to the GST-inclusive total only when the split wasn't parsed.
--      (SC-1.F.02 can refine this against business_profile GST-registration.)
--   2. Not already expense-coded. `auto_category_code` is the house coding signal
--      (text FK -> intake_categories.code). A bill is eligible only when it carries
--      NO deliberate expense decision yet — NULL (uncoded) or 'uncategorized'
--      ("Needs review") — OR it is coded to a capital-asset category
--      ('plant_equipment' = Xero 710, 'motor_vehicle' = Xero 449). Every other
--      category is a real expense/personal coding and is excluded as
--      "already-expense-coded". NB: key on the category CODE, never the Xero code —
--      'fuel' shares Xero 449 with 'motor_vehicle' but is a consumable, not capital.
--   3. Not already capitalised — skip bills that already have a live fixed_assets
--      row (NOT EXISTS on source_bill_id), honouring SC-1.F.02's idempotency key
--      (fixed_assets_source_bill_uniq) so a re-run never re-proposes.
--
-- THRESHOLD: p_threshold_cents is a parameter (AU instant-asset-write-off / pooling
-- thresholds change every FY and by entity turnover, so a frozen constant would be
-- wrong). The DEFAULT 100000 (= AUD $1,000) is the low-value-pool line: a
-- conservative "flag for review" trigger that surfaces every potentially
-- capitalisable purchase for the human gate, rather than the ~$20k IAWO amount
-- (defaulting to $20k would let $1k-$20k assets be silently expensed and never
-- reviewed, defeating the register). Callers wanting the strict "must depreciate
-- (cannot instant-write-off)" set pass the current-FY IAWO amount explicitly.
--
-- suggested_asset_account_code is an advisory chart_of_accounts.code hint (plain
-- text, no FK — same reasoning as 0093.asset_account_code): the seeded capital-asset
-- accounts are 1500 (Tools & equipment) and 1600 (Motor vehicles). It is a hint for
-- the proposed asset / review UI; the human confirms the real account.

CREATE OR REPLACE FUNCTION public.detect_capital_purchases(
  p_org             uuid,
  p_threshold_cents bigint DEFAULT 100000   -- AUD $1,000 (low-value-pool review trigger); pass the FY IAWO amount to override
)
RETURNS TABLE (
  bill_id                       uuid,
  supplier_name                 text,
  acquisition_date              date,
  cost_base_cents               bigint,   -- depreciable base: ex-GST where known, else GST-inclusive
  total_inc_gst_cents           bigint,   -- gross outlay (for display / transparency)
  auto_category_code            text,     -- existing coding (NULL/'uncategorized' = not yet expense-coded)
  suggested_asset_account_code  text      -- advisory COA code hint: 1600 motor vehicles, else 1500 tools & equipment
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH candidate AS (
    SELECT
      b.id                                                     AS bill_id,
      b.supplier_name_raw                                      AS supplier_name,
      b.invoice_date                                           AS acquisition_date,
      COALESCE(b.subtotal_ex_gst_cents, b.total_inc_gst_cents) AS cost_base_cents,
      b.total_inc_gst_cents                                    AS total_inc_gst_cents,
      b.auto_category_code                                     AS auto_category_code
    FROM public.bills b
    WHERE b.organization_id = p_org
      AND b.deleted_at IS NULL
      AND b.status::text <> 'void'
      AND b.is_personal IS NOT TRUE
      AND b.total_inc_gst_cents IS NOT NULL
      -- eligible = not yet expense-coded (NULL / 'uncategorized') OR a capital-asset category
      AND (
        b.auto_category_code IS NULL
        OR b.auto_category_code IN ('uncategorized', 'plant_equipment', 'motor_vehicle')
      )
      -- not already capitalised (SC-1.F.02 idempotency key)
      AND NOT EXISTS (
        SELECT 1 FROM public.fixed_assets fa
        WHERE fa.source_bill_id = b.id
          AND fa.deleted_at IS NULL
      )
  )
  SELECT
    c.bill_id,
    c.supplier_name,
    c.acquisition_date,
    c.cost_base_cents,
    c.total_inc_gst_cents,
    c.auto_category_code,
    CASE WHEN c.auto_category_code = 'motor_vehicle' THEN '1600' ELSE '1500' END
      AS suggested_asset_account_code
  FROM candidate c
  WHERE c.cost_base_cents >= p_threshold_cents
  ORDER BY c.cost_base_cents DESC;
$$;

COMMENT ON FUNCTION public.detect_capital_purchases(uuid, bigint) IS
  'SC-1.F.01: read-only detection of capital-purchase candidate bills (cost base >= threshold, not already expense-coded, not already capitalised). Feeds SC-1.F.02 propose_capitalisation. cost_base_cents is ex-GST where known; p_threshold_cents defaults to $1,000 (pass the FY IAWO amount to override). suggested_asset_account_code is an advisory chart_of_accounts.code hint (no FK).';

GRANT EXECUTE ON FUNCTION public.detect_capital_purchases(uuid, bigint) TO authenticated;

-- Expose the new RPC to PostgREST immediately.
NOTIFY pgrst, 'reload schema';
