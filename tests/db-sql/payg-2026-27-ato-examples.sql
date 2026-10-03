-- PAY-04: FY2026-27 PAYG withholding reproduces the ATO's own worked examples to the dollar.
-- Run with: node scripts/db/run-pg-sql-tests.mjs tests/db-sql/payg-2026-27-ato-examples.sql
--
-- Source: Taxation Administration (Withholding Schedules) Instrument 2026, Schedule 1 (NAT 1004), for payments made
-- from 1 July 2026: https://www.legislation.gov.au/F2026L00716/asmade/text
--
-- Schedule 1 has three worked examples. Examples 1 and 3 use Scale 2 and are reproduced below up to the step
-- calc_payg_tax covers; the Medicare levy adjustment (example 1) and tax offsets (example 3) that follow are not
-- modelled by the app. Example 2 uses Scale 5 (full Medicare levy exemption), which the app does not model.

BEGIN;

CREATE FUNCTION pg_temp.expect(p_label text, p_got bigint, p_want bigint) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN RAISE EXCEPTION '%: expected % cents, got %', p_label, p_want, p_got; END IF;
END $$;

DO $$
DECLARE
  r record;
  prev record;
  gap numeric;
  sc integer;
BEGIN
  -- ATO example 1: weekly earnings $1,333.45, tax-free threshold claimed (Scale 2). x = 1,333.99;
  -- (0.3200 x 1,333.99) - 181.7319 = 245.1449, or $245.
  PERFORM pg_temp.expect('ATO example 1 (weekly $1,333.45)',
    public.calc_payg_tax(133345, 'weekly', true, DATE '2026-07-01'), 24500);

  -- ATO example 3: monthly earnings $5,400.33, Scale 2. ($5,400.33 + 0.01) x 3 / 13 = 1,246.2323, so x = 1,246.99;
  -- (0.3227 x 1,246.99) - 185.1935 = 217.2102, or $217 a week; $217 x 13 / 3 = $940 a month.
  PERFORM pg_temp.expect('ATO example 3 (monthly $5,400.33)',
    public.calc_payg_tax(540033, 'monthly', true, DATE '2026-09-30'), 94000);
  -- Its weekly step on its own.
  PERFORM pg_temp.expect('ATO example 3 weekly step ($1,246)',
    public.calc_payg_tax(124600, 'weekly', true, DATE '2026-09-30'), 21700);

  -- ATO example 2's fortnightly conversion ($1,299.30 / 2 = 649.65, ignore cents, x = 649.99), on Scale 2 instead of
  -- its Scale 5: (0.2500 x 649.99) - 108.2135 = 54.2840, or $54 a week, $108 a fortnight.
  PERFORM pg_temp.expect('example 2 conversion on Scale 2 (fortnightly $1,299.30)',
    public.calc_payg_tax(129930, 'fortnightly', true, DATE '2027-06-30'), 10800);

  -- Table edges, by the same formula: nil below $362 with the threshold; Scale 1 and top-rate rows.
  PERFORM pg_temp.expect('weekly $361.99, Scale 2', public.calc_payg_tax(36199, 'weekly', true, DATE '2026-07-01'), 0);
  PERFORM pg_temp.expect('weekly $1,000, Scale 1 (0.32 x 1,000.99 - 71.6508 = 248.67)',
    public.calc_payg_tax(100000, 'weekly', false, DATE '2026-07-01'), 24900);
  PERFORM pg_temp.expect('weekly $4,000, Scale 2 (0.47 x 4,000.99 - 655.7704 = 1,224.69)',
    public.calc_payg_tax(400000, 'weekly', true, DATE '2026-07-01'), 122500);
  PERFORM pg_temp.expect('weekly $4,000, Scale 1 (0.47 x 4,000.99 - 493.1893 = 1,387.28)',
    public.calc_payg_tax(400000, 'weekly', false, DATE '2026-07-01'), 138700);

  -- The FY2026-27 table is not used for an FY2025-26 pay date, and vice versa.
  IF public.calc_payg_tax(133345, 'weekly', true, DATE '2026-06-30') IN (0, 24500) THEN
    RAISE EXCEPTION 'pay date 30 June 2026 must use the FY2025-26 table';
  END IF;

  -- Every Schedule 1 row is loaded: 9 for Scale 2, 7 for Scale 1, contiguous from $0 with an open top row.
  IF (SELECT count(*) FROM public.payg_tax_tiers WHERE fy_start_year = 2026 AND scale = 2) <> 9
     OR (SELECT count(*) FROM public.payg_tax_tiers WHERE fy_start_year = 2026 AND scale = 1) <> 7 THEN
    RAISE EXCEPTION 'FY2026-27 table rows missing';
  END IF;
  FOR sc IN 1..2 LOOP
    prev := NULL;
    FOR r IN SELECT * FROM public.payg_tax_tiers WHERE fy_start_year = 2026 AND scale = sc ORDER BY tier_min_cents LOOP
      IF prev IS NULL THEN
        IF r.tier_min_cents <> 0 THEN RAISE EXCEPTION 'scale % does not start at $0', r.scale; END IF;
      ELSE
        IF r.tier_min_cents <> prev.tier_max_cents THEN
          RAISE EXCEPTION 'scale % has a gap at % cents', r.scale, prev.tier_max_cents;
        END IF;
        -- The formulas either side of each Schedule 1 boundary give almost the same amount there (the published
        -- rows differ by at most 11 cents, at $188 on Scale 1); a mistyped coefficient shows up as a jump of dollars.
        IF prev.a_coeff <> 0 THEN
          gap := abs((prev.a_coeff * (r.tier_min_cents / 100.0) - prev.b_coeff)
                   - (r.a_coeff * (r.tier_min_cents / 100.0) - r.b_coeff));
          IF gap > 0.50 THEN
            RAISE EXCEPTION 'scale % jumps by $% at $%', r.scale, round(gap, 4), r.tier_min_cents / 100;
          END IF;
        END IF;
      END IF;
      prev := r;
    END LOOP;
    IF prev.tier_max_cents IS NOT NULL THEN RAISE EXCEPTION 'scale % has no open top row', prev.scale; END IF;
  END LOOP;

  RAISE NOTICE 'payg-2026-27-ato-examples: ATO Schedule 1 examples 1 and 3 reproduced ($245 weekly; $217 weekly, $940 monthly); FY2026-27 rows complete and continuous';
END $$;

ROLLBACK;
