-- ============================================================================
-- Migration: 20261003190000_payg_tables_2025_26
-- Purpose:   Replace the FY2025-26 PAYG withholding rows seeded by 0046 with
--            the coefficients of the 2025 legislative instrument.
--
-- Source:    Taxation Administration (Withholding Schedules) Instrument 2025,
--            Schedule 1 "Statement of formulas for calculating amounts to be
--            withheld" (NAT 1004), registered 4 June 2025, for payments made
--            from 1 July 2025 (its amounts were last updated 1 July 2024):
--            https://www.legislation.gov.au/F2025L00647/asmade/text
--            Coefficients copied from Scale 1 (tax-free threshold not claimed)
--            and Scale 2 (tax-free threshold claimed). Other scales (3 foreign
--            resident, 4 no TFN, 5 and 6 Medicare exemptions), the Medicare levy
--            adjustment and tax offsets are not modelled by calc_payg_tax.
--
-- What 0046 got wrong (fy_start_year 2025):
--   - Scale 1 had nine rows with boundaries and coefficients that are not in
--     the instrument (for example "x < 144: 0.16 / 0.16" and "x < 500: 0.26 /
--     14.5096"; the instrument has x < 150: 0.1600 / 0.1600 and x < 371:
--     0.2117 / 7.7550, seven rows in all).
--   - Scale 2 rows below $1,282 were right, but the top three rows used the
--     boundaries $2,307 and $3,461 with b = 338.0769 and 615.9808; the
--     instrument has $2,596 and $3,653 with b = 358.3077 and 650.6154.
--   calc_payg_tax itself already follows the Schedule 1 procedure (x = whole
--   weekly dollars + 99 cents, whole-dollar rounding) since 20261003130300.
--
-- The 2025 Scale 1 and 2 rows are a lookup seeded by this repository, so the
-- stale rows are removed and the official set loaded. Pay runs keep their own
-- payg_tax_cents; nothing posted is recalculated.
-- ============================================================================

BEGIN;

-- Rows of 0046 whose lower bound is not a Schedule 1 boundary.
DELETE FROM public.payg_tax_tiers
 WHERE fy_start_year = 2025
   AND (
        (scale = 1 AND tier_min_cents NOT IN (0, 15000, 37100, 51500, 93200, 224600, 330300))
     OR (scale = 2 AND tier_min_cents NOT IN (0, 36100, 50000, 62500, 72100, 86500, 128200, 259600, 365300))
   );

-- Scale 1: tax-free threshold not claimed. "Weekly earnings (x) less than" -> tier_max_cents.
-- The negative b on the third row is in the instrument ("This is intentional").
INSERT INTO public.payg_tax_tiers (fy_start_year, scale, tier_min_cents, tier_max_cents, a_coeff, b_coeff, notes) VALUES
  (2025, 1,      0,  15000, 0.1600,   0.1600, 'FY2025-26 Sch 1 scale 1: x < 150'),
  (2025, 1,  15000,  37100, 0.2117,   7.7550, 'FY2025-26 Sch 1 scale 1: x < 371'),
  (2025, 1,  37100,  51500, 0.1890,  -0.6702, 'FY2025-26 Sch 1 scale 1: x < 515'),
  (2025, 1,  51500,  93200, 0.3227,  68.2367, 'FY2025-26 Sch 1 scale 1: x < 932'),
  (2025, 1,  93200, 224600, 0.3200,  65.7202, 'FY2025-26 Sch 1 scale 1: x < 2,246'),
  (2025, 1, 224600, 330300, 0.3900, 222.9510, 'FY2025-26 Sch 1 scale 1: x < 3,303'),
  (2025, 1, 330300,   NULL, 0.4700, 487.2587, 'FY2025-26 Sch 1 scale 1: x 3,303 and over')
ON CONFLICT (fy_start_year, scale, tier_min_cents) DO UPDATE SET
  tier_max_cents = EXCLUDED.tier_max_cents,
  a_coeff        = EXCLUDED.a_coeff,
  b_coeff        = EXCLUDED.b_coeff,
  notes          = EXCLUDED.notes;

-- Scale 2: tax-free threshold claimed.
INSERT INTO public.payg_tax_tiers (fy_start_year, scale, tier_min_cents, tier_max_cents, a_coeff, b_coeff, notes) VALUES
  (2025, 2,      0,  36100, 0,      0,        'FY2025-26 Sch 1 scale 2: x < 361, nil'),
  (2025, 2,  36100,  50000, 0.1600,  57.8462, 'FY2025-26 Sch 1 scale 2: x < 500'),
  (2025, 2,  50000,  62500, 0.2600, 107.8462, 'FY2025-26 Sch 1 scale 2: x < 625'),
  (2025, 2,  62500,  72100, 0.1800,  57.8462, 'FY2025-26 Sch 1 scale 2: x < 721'),
  (2025, 2,  72100,  86500, 0.1890,  64.3365, 'FY2025-26 Sch 1 scale 2: x < 865'),
  (2025, 2,  86500, 128200, 0.3227, 180.0385, 'FY2025-26 Sch 1 scale 2: x < 1,282'),
  (2025, 2, 128200, 259600, 0.3200, 176.5769, 'FY2025-26 Sch 1 scale 2: x < 2,596'),
  (2025, 2, 259600, 365300, 0.3900, 358.3077, 'FY2025-26 Sch 1 scale 2: x < 3,653'),
  (2025, 2, 365300,   NULL, 0.4700, 650.6154, 'FY2025-26 Sch 1 scale 2: x 3,653 and over')
ON CONFLICT (fy_start_year, scale, tier_min_cents) DO UPDATE SET
  tier_max_cents = EXCLUDED.tier_max_cents,
  a_coeff        = EXCLUDED.a_coeff,
  b_coeff        = EXCLUDED.b_coeff,
  notes          = EXCLUDED.notes;

COMMIT;
