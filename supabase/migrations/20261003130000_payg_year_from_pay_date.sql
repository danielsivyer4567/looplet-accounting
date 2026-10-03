-- ============================================================================
-- Migration: 20261003130000_payg_year_from_pay_date
-- Purpose:   PAYG withholding uses the financial year of the PAY DATE, and fails
--            loudly when no withholding table covers it.
--
-- Before:    calc_payg_tax(gross, frequency, claims_threshold) chose the tax year
--            from CURRENT_DATE, not the pay date, so a June pay run processed in
--            July (or any back-dated run) used the wrong year's table. When no
--            table existed for that year it returned 0, so from 1 July 2026 (no
--            FY2026-27 table) every payslip silently withheld $0. An unknown
--            frequency was treated as weekly.
--
-- After:     calc_payg_tax(gross, frequency, claims_threshold, pay_date)
--              - financial year = the 1 July to 30 June year containing pay_date;
--              - raises an exception when pay_date is null, the frequency is
--                unknown, or no payg_tax_tiers row covers that year and scale;
--              - the formula, rounding and coefficients are unchanged.
--            The old 3-argument signature is dropped rather than kept: any caller
--            still using it fails with "function does not exist" instead of
--            withholding from the wrong year. Its only caller,
--            payroll-create-pay-run, now passes p_pay_date.
-- ============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.calc_payg_tax(bigint, text, boolean);

CREATE OR REPLACE FUNCTION public.calc_payg_tax(
  p_gross_cents       bigint,
  p_frequency         text,
  p_claims_threshold  boolean,
  p_pay_date          date
)
RETURNS bigint
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_weeks_in_period    numeric;
  v_weekly_gross       bigint;
  v_tier               public.payg_tax_tiers;
  v_weekly_tax_dollars numeric;
  v_weekly_tax_cents   bigint;
  v_scale              integer;
  v_fy                 integer;
BEGIN
  IF p_pay_date IS NULL THEN
    RAISE EXCEPTION 'calc_payg_tax: a pay date is required to choose the PAYG withholding table'
      USING ERRCODE = '22004';
  END IF;

  v_weeks_in_period := CASE p_frequency
    WHEN 'weekly'      THEN 1
    WHEN 'fortnightly' THEN 2
    WHEN 'monthly'     THEN 52.0 / 12.0
  END;
  IF v_weeks_in_period IS NULL THEN
    RAISE EXCEPTION 'calc_payg_tax: unknown pay frequency %; expected weekly, fortnightly or monthly',
      coalesce(p_frequency, 'NULL') USING ERRCODE = '22023';
  END IF;

  -- The financial year runs 1 July to 30 June; fy_start_year 2025 is FY2025-26.
  v_fy := EXTRACT(YEAR FROM p_pay_date)::integer
          - CASE WHEN EXTRACT(MONTH FROM p_pay_date) < 7 THEN 1 ELSE 0 END;
  v_scale := CASE WHEN p_claims_threshold THEN 2 ELSE 1 END;

  IF NOT EXISTS (
    SELECT 1 FROM public.payg_tax_tiers WHERE fy_start_year = v_fy AND scale = v_scale
  ) THEN
    RAISE EXCEPTION 'calc_payg_tax: no PAYG withholding table for FY%-% (pay date %, scale %); load the ATO Schedule 1 coefficients for that year before running payroll',
      v_fy, lpad(((v_fy + 1) % 100)::text, 2, '0'), p_pay_date, v_scale
      USING ERRCODE = 'P0002';
  END IF;

  IF p_gross_cents IS NULL OR p_gross_cents <= 0 THEN
    RETURN 0;
  END IF;

  -- Convert period gross to weekly gross (cents).
  v_weekly_gross := ROUND(p_gross_cents / v_weeks_in_period)::bigint;

  v_tier := public._payg_pick_tier(v_weekly_gross, v_scale, v_fy);
  IF v_tier.id IS NULL OR v_tier.a_coeff IS NULL THEN
    RAISE EXCEPTION 'calc_payg_tax: no FY%-% scale % tier covers weekly earnings of % cents',
      v_fy, lpad(((v_fy + 1) % 100)::text, 2, '0'), v_scale, v_weekly_gross
      USING ERRCODE = 'P0002';
  END IF;

  -- Formula in dollars: weekly_tax_dollars = a * weekly_gross_dollars - b; never negative.
  v_weekly_tax_dollars := GREATEST(0, v_tier.a_coeff * (v_weekly_gross::numeric / 100.0) - v_tier.b_coeff);

  -- The weekly amount is rounded to whole dollars, then scaled back to the pay period.
  v_weekly_tax_cents := ROUND(v_weekly_tax_dollars)::bigint * 100;
  RETURN GREATEST(0, ROUND(v_weekly_tax_cents * v_weeks_in_period)::bigint);
END $$;

COMMENT ON FUNCTION public.calc_payg_tax(bigint, text, boolean, date) IS
  'PAYG withholding in cents for one pay period, from the payg_tax_tiers table of the financial year containing p_pay_date. Raises when no table covers that year.';

REVOKE ALL ON FUNCTION public.calc_payg_tax(bigint, text, boolean, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calc_payg_tax(bigint, text, boolean, date) TO authenticated, service_role;

COMMIT;
