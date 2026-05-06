-- ============================================================================
-- Migration: 0046_payg_tax_tables
-- Project:   Looplet Accounting
-- Date:      2026-05-03
-- Purpose:   Seed AU PAYG (pay-as-you-go) withholding coefficients for the
--            current financial year (FY 2025-26) and provide a calc_payg_tax()
--            DB function used by the payroll-create-pay-run edge function.
--
-- Source:    ATO Schedule 1 — Statement of formulas for calculating amounts
--            to be withheld (NAT 1004), effective 1 July 2024 onwards. The
--            formula per tier is:
--                y = a * x - b
--            where x = weekly earnings (in dollars), y = weekly amount to
--            withhold (in dollars), and a/b are the published coefficients.
--
--            We store the *upper bound* of each tier and pick the first tier
--            whose tier_max_cents >= weekly_gross_cents (or NULL = top tier).
--
--            "Tax-free threshold claimed" = Scale 2 (most common — employee
--            ticked the TFN-declaration tax-free threshold box).
--            "No tax-free threshold" = Scale 1 (second job / non-resident).
--
-- Adjustments:
--   - For FORTNIGHTLY: divide gross by 2, compute weekly tax, multiply by 2.
--   - For MONTHLY:     divide gross by (52/12), compute weekly tax,
--                      multiply by (52/12). (ATO standard method.)
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Tax tier table (one row per bracket per scale)
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.payg_tax_tiers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fy_start_year   integer NOT NULL,                      -- e.g. 2025 = FY 2025-26
  scale           integer NOT NULL,                      -- 1 (no tfn threshold) / 2 (tfn threshold)
  tier_min_cents  bigint  NOT NULL,                      -- weekly earnings >= this
  tier_max_cents  bigint,                                -- weekly earnings < this; NULL = top tier
  a_coeff         numeric(10,6) NOT NULL,                -- multiply by weekly gross dollars
  b_coeff         numeric(10,6) NOT NULL,                -- subtract this dollar amount
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payg_tax_tiers_uniq
    UNIQUE (fy_start_year, scale, tier_min_cents)
);

CREATE INDEX IF NOT EXISTS payg_tax_tiers_lookup_idx
  ON public.payg_tax_tiers (fy_start_year, scale, tier_min_cents);

-- Read-only for everyone (it's a public lookup table).
ALTER TABLE public.payg_tax_tiers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payg_tax_tiers_select ON public.payg_tax_tiers;
CREATE POLICY payg_tax_tiers_select ON public.payg_tax_tiers
  FOR SELECT TO authenticated USING (true);

-- ----------------------------------------------------------------------------
-- 2. Seed FY 2025-26 (effective 1 July 2025 — same coefficients as 2024-25
--    after the Stage 3 tax cuts of 1 July 2024; no further rate changes
--    scheduled for FY 2025-26 as of this migration date).
--
--    Source: ATO NAT 1004 — Statement of formulas, July 2024.
--            (https://www.ato.gov.au/rates/schedule-1)
-- ----------------------------------------------------------------------------

-- Scale 2: with tax-free threshold (most employees)
INSERT INTO public.payg_tax_tiers (fy_start_year, scale, tier_min_cents, tier_max_cents, a_coeff, b_coeff, notes) VALUES
  (2025, 2,        0,    36100,  0.0,       0.0,        'TFN: <=$361/week — no withholding'),
  (2025, 2,    36100,    50000,  0.16,     57.8462,     'TFN tier 1'),
  (2025, 2,    50000,    62500,  0.26,    107.8462,     'TFN tier 2'),
  (2025, 2,    62500,    72100,  0.18,     57.8462,     'TFN tier 3'),
  (2025, 2,    72100,    86500,  0.189,    64.3365,     'TFN tier 4'),
  (2025, 2,    86500,   128200,  0.3227,  180.0385,     'TFN tier 5'),
  (2025, 2,   128200,   230700,  0.32,    176.5769,     'TFN tier 6 — 32%'),
  (2025, 2,   230700,   346100,  0.39,    338.0769,     'TFN tier 7 — 37% effective'),
  (2025, 2,   346100,    NULL,   0.47,    615.9808,     'TFN tier 8 — 45% top + 2% Medicare')
ON CONFLICT (fy_start_year, scale, tier_min_cents) DO UPDATE SET
  tier_max_cents = EXCLUDED.tier_max_cents,
  a_coeff        = EXCLUDED.a_coeff,
  b_coeff        = EXCLUDED.b_coeff,
  notes          = EXCLUDED.notes;

-- Scale 1: NO tax-free threshold (second job / foreign resident default)
-- Coefficients per ATO Schedule 1 (NAT 1004), Scale 1.
INSERT INTO public.payg_tax_tiers (fy_start_year, scale, tier_min_cents, tier_max_cents, a_coeff, b_coeff, notes) VALUES
  (2025, 1,        0,    14400,  0.16,      0.16,       'No-TFN tier 1'),
  (2025, 1,    14400,    50000,  0.26,     14.5096,     'No-TFN tier 2'),
  (2025, 1,    50000,    62500,  0.18,    -25.4904,     'No-TFN tier 3'),
  (2025, 1,    62500,    72100,  0.189,   -19.8654,     'No-TFN tier 4'),
  (2025, 1,    72100,    86500,  0.3227,  76.4673,      'No-TFN tier 5'),
  (2025, 1,    86500,   128200,  0.32,    74.8077,      'No-TFN tier 6'),
  (2025, 1,   128200,   230700,  0.39,    164.5961,     'No-TFN tier 7'),
  (2025, 1,   230700,   346100,  0.47,    427.5961,     'No-TFN tier 8 (top + Medicare)'),
  (2025, 1,   346100,    NULL,   0.47,    427.5961,     'No-TFN tier 9 (continuation)')
ON CONFLICT (fy_start_year, scale, tier_min_cents) DO UPDATE SET
  tier_max_cents = EXCLUDED.tier_max_cents,
  a_coeff        = EXCLUDED.a_coeff,
  b_coeff        = EXCLUDED.b_coeff,
  notes          = EXCLUDED.notes;

-- ----------------------------------------------------------------------------
-- 3. Helper: pick the right tier for a given weekly gross
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._payg_pick_tier(
  p_weekly_gross_cents bigint,
  p_scale              integer,
  p_fy_start_year      integer DEFAULT 2025
)
RETURNS public.payg_tax_tiers
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_row public.payg_tax_tiers;
BEGIN
  SELECT * INTO v_row
    FROM public.payg_tax_tiers
   WHERE fy_start_year = p_fy_start_year
     AND scale         = p_scale
     AND p_weekly_gross_cents >= tier_min_cents
     AND (tier_max_cents IS NULL OR p_weekly_gross_cents < tier_max_cents)
   ORDER BY tier_min_cents DESC
   LIMIT 1;

  IF NOT FOUND THEN
    -- Top-tier fallback
    SELECT * INTO v_row
      FROM public.payg_tax_tiers
     WHERE fy_start_year = p_fy_start_year
       AND scale         = p_scale
     ORDER BY tier_min_cents DESC
     LIMIT 1;
  END IF;

  RETURN v_row;
END $$;

-- ----------------------------------------------------------------------------
-- 4. Public: calc_payg_tax — multi-frequency PAYG withholding calculator
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.calc_payg_tax(
  p_gross_cents       bigint,
  p_frequency         text,
  p_claims_threshold  boolean DEFAULT true
)
RETURNS bigint
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_weeks_in_period   numeric;
  v_weekly_gross      bigint;
  v_tier              public.payg_tax_tiers;
  v_weekly_tax_dollars numeric;
  v_weekly_tax_cents  bigint;
  v_period_tax_cents  bigint;
  v_scale             integer;
  v_fy                integer;
BEGIN
  IF p_gross_cents <= 0 THEN
    RETURN 0;
  END IF;

  -- Resolve the FY based on TODAY (FY runs 1 July → 30 June).
  IF EXTRACT(MONTH FROM CURRENT_DATE) >= 7 THEN
    v_fy := EXTRACT(YEAR FROM CURRENT_DATE)::integer;
  ELSE
    v_fy := EXTRACT(YEAR FROM CURRENT_DATE)::integer - 1;
  END IF;
  -- We currently only seed FY 2025-26.
  IF v_fy < 2025 THEN
    v_fy := 2025;
  END IF;

  v_scale := CASE WHEN p_claims_threshold THEN 2 ELSE 1 END;

  v_weeks_in_period := CASE p_frequency
    WHEN 'weekly'      THEN 1
    WHEN 'fortnightly' THEN 2
    WHEN 'monthly'     THEN 52.0 / 12.0
    ELSE                    1
  END;

  -- Convert period gross → weekly gross (cents).
  v_weekly_gross := ROUND(p_gross_cents / v_weeks_in_period)::bigint;

  v_tier := public._payg_pick_tier(v_weekly_gross, v_scale, v_fy);

  IF v_tier.id IS NULL OR v_tier.a_coeff IS NULL THEN
    RETURN 0;
  END IF;

  -- Tier 0 (sub-threshold, scale 2) returns 0.
  IF v_tier.a_coeff = 0 AND v_tier.b_coeff = 0 THEN
    RETURN 0;
  END IF;

  -- Apply formula in dollars: weekly_tax_dollars = a * weekly_gross_dollars - b
  v_weekly_tax_dollars := v_tier.a_coeff * (v_weekly_gross::numeric / 100.0)
                          - v_tier.b_coeff;
  IF v_weekly_tax_dollars < 0 THEN
    v_weekly_tax_dollars := 0;
  END IF;

  -- ATO rounds the weekly amount to whole dollars.
  v_weekly_tax_cents := ROUND(v_weekly_tax_dollars)::bigint * 100;

  v_period_tax_cents := ROUND(v_weekly_tax_cents * v_weeks_in_period)::bigint;

  RETURN GREATEST(0, v_period_tax_cents);
END $$;

GRANT EXECUTE ON FUNCTION public.calc_payg_tax(bigint, text, boolean)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public._payg_pick_tier(bigint, integer, integer)
  TO authenticated, service_role;
GRANT SELECT ON public.payg_tax_tiers TO authenticated, service_role;

COMMIT;
