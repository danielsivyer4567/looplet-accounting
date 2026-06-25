-- 0094: Capital-purchase detection + capitalisation (ledger SC-1.F.01 + SC-1.F.02).
--
-- Two RPCs that share one threshold/eligibility/account-hint definition:
--   * detect_capital_purchases   (SC-1.F.01) — read-only; surfaces bills that look
--     like capital purchases (assets to capitalise + depreciate) rather than period
--     expenses. Writes nothing.
--   * propose_capitalisation     (SC-1.F.02) — drafts a `proposed` fixed_assets row
--     + a default depreciation_schedule for one such bill, so a human can confirm
--     (SC-1.H). Idempotent on source_bill_id. Defined at the foot of this file; it
--     REUSES detect_capital_purchases so the capital-eligibility / cost-base /
--     asset-account-hint logic lives in exactly one place and cannot drift.
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
  p_threshold_cents bigint DEFAULT 100000,  -- AUD $1,000 (low-value-pool review trigger); pass the FY IAWO amount to override
  p_bill_id         uuid   DEFAULT NULL     -- optional: restrict to a single bill (NULL = whole org). Lets propose_capitalisation reuse this eligibility/derivation by PK instead of scanning + sorting the whole org.
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
      AND (p_bill_id IS NULL OR b.id = p_bill_id)   -- single-bill fast path (indexed PK); whole org when NULL
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

COMMENT ON FUNCTION public.detect_capital_purchases(uuid, bigint, uuid) IS
  'SC-1.F.01: read-only detection of capital-purchase candidate bills (cost base >= threshold, not already expense-coded, not already capitalised). Feeds SC-1.F.02 propose_capitalisation. cost_base_cents is ex-GST where known; p_threshold_cents defaults to $1,000 (pass the FY IAWO amount to override). p_bill_id restricts to one bill (NULL = whole org) so propose_capitalisation can reuse this logic by PK. suggested_asset_account_code is an advisory chart_of_accounts.code hint (no FK).';

GRANT EXECUTE ON FUNCTION public.detect_capital_purchases(uuid, bigint, uuid) TO authenticated;

-- ===========================================================================
-- SC-1.F.02 — propose_capitalisation(p_bill_id)
-- ===========================================================================
-- Drafts a `proposed` fixed_assets row + a default depreciation_schedule for a
-- capital-purchase bill, then returns the new asset id. A human confirms the
-- proposal (proposed -> active) and refines method / effective life in the
-- register UI (SC-1.H). Once Phase 2 (SC-2.A/2.B) lands this is a Tier-1 "notify"
-- action; until then it simply writes the `proposed` row.
--
-- Security model: SECURITY INVOKER (matches detect_capital_purchases above and is
-- a deliberate divergence from the "DEFINER" forward-note in 0093). INVOKER lets
-- the existing RLS do the scoping with no privilege-escalation surface: an
-- authenticated member can only resolve / write rows for bills in their accessible
-- orgs (bills SELECT + fixed_assets/depreciation_schedules INSERT policies, 0093),
-- while a service_role backend bypasses RLS (rolbypassrls) so automation still
-- works. A DEFINER variant would have to re-derive org access itself (it bypasses
-- RLS) to avoid letting a member capitalise another org's bill — INVOKER gets that
-- for free. No new SECURITY DEFINER advisor is introduced.
--
-- Eligibility + the derived fields (cost_base, asset-account hint, acquisition
-- date, supplier) come from detect_capital_purchases(org, 0): the dollar threshold
-- is dropped to 0 because a human asking to capitalise THIS bill must not be gated
-- by the review-trigger amount — only the coding/status eligibility applies. If the
-- bill is not a candidate (already expense-coded, personal, void, zero/neg cost
-- base) the function raises rather than writing a meaningless asset.
--
-- Idempotency: "no duplicate, keyed on source_bill_id". A live fixed_assets row for
-- the bill short-circuits to returning that asset unchanged (detect also excludes
-- already-capitalised bills, so the existing-asset check is what makes a re-run a
-- no-op). The partial unique index fixed_assets_source_bill_uniq (0093) is the hard
-- backstop under concurrency.
--
-- effective_life_years / method are STARTING ESTIMATES the human confirms: motor
-- vehicles use the ATO ~8-year car effective life, other plant/equipment defaults
-- to 5 years; prime cost (straight-line) is the conservative default method (also
-- the fixed_assets table default). The schedule carries its own copy of the calc
-- inputs (0093) so SC-1.G.01 compute_depreciation is self-contained.

CREATE OR REPLACE FUNCTION public.propose_capitalisation(p_bill_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_org         uuid;
  v_created_at  timestamptz;
  v_existing    uuid;
  v_cost_base   bigint;
  v_acct_code   text;
  v_acq_date    date;
  v_supplier    text;
  v_category    text;
  v_eff_life    numeric;
  v_asset_id    uuid;
BEGIN
  -- Resolve the bill (org + a created_at fallback for a missing invoice date). RLS
  -- on bills scopes this to the caller's accessible orgs; service_role bypasses it.
  SELECT b.organization_id, b.created_at
    INTO v_org, v_created_at
  FROM public.bills b
  WHERE b.id = p_bill_id
    AND b.deleted_at IS NULL;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'propose_capitalisation: bill % not found or not accessible', p_bill_id;
  END IF;

  -- Idempotency: one live asset per source bill. If already capitalised, return it.
  SELECT fa.id INTO v_existing
  FROM public.fixed_assets fa
  WHERE fa.source_bill_id = p_bill_id
    AND fa.deleted_at IS NULL;

  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  -- Eligibility + derived fields from the SC-1.F.01 detector (single source of truth
  -- for the category allowlist, cost base and asset-account hint). Threshold 0: only
  -- the coding/status eligibility gates an explicit capitalisation request. Passing
  -- p_bill_id restricts the detector to this one bill (PK lookup) — no whole-org scan.
  SELECT d.cost_base_cents, d.suggested_asset_account_code, d.acquisition_date,
         d.supplier_name, d.auto_category_code
    INTO v_cost_base, v_acct_code, v_acq_date, v_supplier, v_category
  FROM public.detect_capital_purchases(v_org, 0, p_bill_id) d;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'propose_capitalisation: bill % is not a capital-purchase candidate (already expense-coded, personal, void, or zero cost base)', p_bill_id;
  END IF;

  -- Starting estimates the human confirms (SC-1.H).
  v_eff_life := CASE WHEN v_category = 'motor_vehicle' THEN 8 ELSE 5 END;
  v_acq_date := COALESCE(v_acq_date, v_created_at::date);   -- fixed_assets.acquisition_date is NOT NULL

  INSERT INTO public.fixed_assets (
    organization_id, source_bill_id, name, asset_account_code,
    acquisition_date, cost_base_cents, depreciation_method,
    effective_life_years, status, created_by
  ) VALUES (
    v_org, p_bill_id,
    COALESCE(NULLIF(btrim(v_supplier), ''), 'Capital asset'),
    v_acct_code, v_acq_date, v_cost_base, 'prime_cost',
    v_eff_life, 'proposed', auth.uid()
  )
  RETURNING id INTO v_asset_id;

  INSERT INTO public.depreciation_schedules (
    organization_id, fixed_asset_id, method, start_date,
    opening_cost_base_cents, effective_life_years, created_by
  ) VALUES (
    v_org, v_asset_id, 'prime_cost', v_acq_date,
    v_cost_base, v_eff_life, auth.uid()
  );

  RETURN v_asset_id;
END;
$$;

COMMENT ON FUNCTION public.propose_capitalisation(uuid) IS
  'SC-1.F.02: drafts a proposed fixed_assets row + default depreciation_schedule for a capital-purchase bill and returns the asset id. Idempotent on source_bill_id (re-run returns the existing asset). Reuses detect_capital_purchases for eligibility/cost-base/account-hint. effective_life_years + method are starting estimates a human confirms (SC-1.H). SECURITY INVOKER — RLS scopes the caller.';

GRANT EXECUTE ON FUNCTION public.propose_capitalisation(uuid) TO authenticated;

-- Expose the new RPCs to PostgREST immediately.
NOTIFY pgrst, 'reload schema';
