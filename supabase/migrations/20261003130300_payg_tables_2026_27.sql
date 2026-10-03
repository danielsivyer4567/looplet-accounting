-- ============================================================================
-- Migration: 20261003130300_payg_tables_2026_27
-- Purpose:   PAYG withholding for payments made from 1 July 2026 (FY2026-27),
--            and the Schedule 1 procedure for working out x and rounding.
--
-- Source:    Taxation Administration (Withholding Schedules) Instrument 2026,
--            Schedule 1 "Statement of formulas for calculating amounts to be
--            withheld" (NAT 1004), registered 12 June 2026, amounts and formulas
--            updated 1 July 2026:
--            https://www.legislation.gov.au/F2026L00716/asmade/text
--            Coefficients copied from Scale 1 (tax-free threshold not claimed)
--            and Scale 2 (tax-free threshold claimed). Other scales (3 foreign
--            resident, 4 no TFN, 5 and 6 Medicare exemptions), the Medicare levy
--            adjustment and tax offsets are not modelled by calc_payg_tax.
--
-- Procedure (Schedule 1, same in the 2025 instrument F2025L00647):
--   - x = weekly earnings ignoring cents, plus 99 cents; y = a * x - b, rounded
--     to the nearest dollar (50 cents rounds up).
--   - fortnightly: earnings / 2, ignore cents, + 99 cents; weekly y * 2.
--   - monthly: earnings (+ 1 cent if they end in 33 cents) * 3 / 13, ignore
--     cents, + 99 cents; weekly y * 13 / 3, rounded to the nearest dollar.
--   calc_payg_tax previously used the exact weekly earnings and did not round
--   monthly amounts to whole dollars (e.g. $940.33 instead of the ATO's $940
--   on $5,400.33 a month).
-- ============================================================================

BEGIN;

-- Scale 2: tax-free threshold claimed. "Weekly earnings (x) less than" -> tier_max_cents.
INSERT INTO public.payg_tax_tiers (fy_start_year, scale, tier_min_cents, tier_max_cents, a_coeff, b_coeff, notes) VALUES
  (2026, 2,      0,  36200, 0,      0,        'FY2026-27 Sch 1 scale 2: x < 362, nil'),
  (2026, 2,  36200,  53800, 0.1500,  54.3462, 'FY2026-27 Sch 1 scale 2: x < 538'),
  (2026, 2,  53800,  67300, 0.2500, 108.2135, 'FY2026-27 Sch 1 scale 2: x < 673'),
  (2026, 2,  67300,  72100, 0.1700,  54.3473, 'FY2026-27 Sch 1 scale 2: x < 721'),
  (2026, 2,  72100,  86500, 0.1790,  60.8377, 'FY2026-27 Sch 1 scale 2: x < 865'),
  (2026, 2,  86500, 128200, 0.3227, 185.1935, 'FY2026-27 Sch 1 scale 2: x < 1,282'),
  (2026, 2, 128200, 259600, 0.3200, 181.7319, 'FY2026-27 Sch 1 scale 2: x < 2,596'),
  (2026, 2, 259600, 365300, 0.3900, 363.4627, 'FY2026-27 Sch 1 scale 2: x < 3,653'),
  (2026, 2, 365300,   NULL, 0.4700, 655.7704, 'FY2026-27 Sch 1 scale 2: x 3,653 and over')
ON CONFLICT (fy_start_year, scale, tier_min_cents) DO UPDATE SET
  tier_max_cents = EXCLUDED.tier_max_cents,
  a_coeff        = EXCLUDED.a_coeff,
  b_coeff        = EXCLUDED.b_coeff,
  notes          = EXCLUDED.notes;

-- Scale 1: tax-free threshold not claimed.
INSERT INTO public.payg_tax_tiers (fy_start_year, scale, tier_min_cents, tier_max_cents, a_coeff, b_coeff, notes) VALUES
  (2026, 1,      0,  18800, 0.1500,   0.1500, 'FY2026-27 Sch 1 scale 1: x < 188'),
  (2026, 1,  18800,  37100, 0.2084,  11.0185, 'FY2026-27 Sch 1 scale 1: x < 371'),
  (2026, 1,  37100,  51500, 0.1790,   0.1066, 'FY2026-27 Sch 1 scale 1: x < 515'),
  (2026, 1,  51500,  93200, 0.3227,  74.1674, 'FY2026-27 Sch 1 scale 1: x < 932'),
  (2026, 1,  93200, 224600, 0.3200,  71.6508, 'FY2026-27 Sch 1 scale 1: x < 2,246'),
  (2026, 1, 224600, 330300, 0.3900, 228.8816, 'FY2026-27 Sch 1 scale 1: x < 3,303'),
  (2026, 1, 330300,   NULL, 0.4700, 493.1893, 'FY2026-27 Sch 1 scale 1: x 3,303 and over')
ON CONFLICT (fy_start_year, scale, tier_min_cents) DO UPDATE SET
  tier_max_cents = EXCLUDED.tier_max_cents,
  a_coeff        = EXCLUDED.a_coeff,
  b_coeff        = EXCLUDED.b_coeff,
  notes          = EXCLUDED.notes;

-- Same signature and errors as 20261003130000; only x and the rounding change, to the Schedule 1 procedure.
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
  v_weekly_dollars bigint;   -- weekly equivalent earnings, cents ignored
  v_x_cents        bigint;   -- x in cents: whole dollars plus 99 cents
  v_tier           public.payg_tax_tiers;
  v_weekly_tax     bigint;   -- whole dollars
  v_scale          integer;
  v_fy             integer;
  v_gross          bigint;
BEGIN
  IF p_pay_date IS NULL THEN
    RAISE EXCEPTION 'calc_payg_tax: a pay date is required to choose the PAYG withholding table'
      USING ERRCODE = '22004';
  END IF;
  IF p_frequency IS NULL OR p_frequency NOT IN ('weekly', 'fortnightly', 'monthly') THEN
    RAISE EXCEPTION 'calc_payg_tax: unknown pay frequency %; expected weekly, fortnightly or monthly',
      coalesce(p_frequency, 'NULL') USING ERRCODE = '22023';
  END IF;

  -- The financial year runs 1 July to 30 June; fy_start_year 2026 is FY2026-27.
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

  -- Weekly equivalent, ignoring cents.
  v_gross := p_gross_cents;
  IF p_frequency = 'monthly' AND v_gross % 100 = 33 THEN
    v_gross := v_gross + 1;              -- "$x.33" months: add 1 cent before converting
  END IF;
  v_weekly_dollars := CASE p_frequency
    WHEN 'weekly'      THEN v_gross / 100
    WHEN 'fortnightly' THEN v_gross / 200
    WHEN 'monthly'     THEN (v_gross * 3) / 1300
  END;                                   -- bigint division truncates: cents ignored
  v_x_cents := v_weekly_dollars * 100 + 99;

  v_tier := public._payg_pick_tier(v_x_cents, v_scale, v_fy);
  IF v_tier.id IS NULL OR v_tier.a_coeff IS NULL THEN
    RAISE EXCEPTION 'calc_payg_tax: no FY%-% scale % tier covers weekly earnings of % cents',
      v_fy, lpad(((v_fy + 1) % 100)::text, 2, '0'), v_scale, v_x_cents
      USING ERRCODE = 'P0002';
  END IF;

  -- y = a * x - b, rounded to the nearest dollar (half up), never negative.
  v_weekly_tax := GREATEST(0, ROUND(v_tier.a_coeff * (v_x_cents::numeric / 100) - v_tier.b_coeff))::bigint;

  RETURN CASE p_frequency
    WHEN 'weekly'      THEN v_weekly_tax * 100
    WHEN 'fortnightly' THEN v_weekly_tax * 2 * 100
    WHEN 'monthly'     THEN ROUND(v_weekly_tax * 13 / 3.0)::bigint * 100
  END;
END $$;

COMMENT ON FUNCTION public.calc_payg_tax(bigint, text, boolean, date) IS
  'PAYG withholding in cents for one pay period (Schedule 1 procedure: x = whole weekly dollars + 99 cents, results '
  'rounded to whole dollars), from the payg_tax_tiers table of the financial year containing p_pay_date. Raises when '
  'no table covers that year. Scales 1 and 2 only; Medicare levy adjustment and tax offsets are not applied.';

REVOKE ALL ON FUNCTION public.calc_payg_tax(bigint, text, boolean, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calc_payg_tax(bigint, text, boolean, date) TO authenticated, service_role;

COMMIT;
