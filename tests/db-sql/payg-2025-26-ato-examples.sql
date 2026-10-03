-- PAY-06: FY2025-26 PAYG withholding reproduces the ATO's own worked examples and sample data to the dollar.
-- Run with: node scripts/db/run-pg-sql-tests.mjs tests/db-sql/payg-2025-26-ato-examples.sql
--
-- Source: Taxation Administration (Withholding Schedules) Instrument 2025, Schedule 1 (NAT 1004), for payments made
-- from 1 July 2025: https://www.legislation.gov.au/F2025L00647/asmade/text
--
-- Schedule 1 has three general examples. Examples 1 and 3 use Scale 2 and are reproduced below up to the step
-- calc_payg_tax covers; the Medicare levy adjustment (example 1) and tax offsets (example 3) that follow are not
-- modelled by the app. Example 2 uses Scale 5 (full Medicare levy exemption), which the app does not model.
-- The schedule also publishes "Sample data" tables that software "should be tested for accuracy against"; every
-- Scale 1 and Scale 2 row of its weekly, fortnightly and monthly tables is checked here.

BEGIN;

CREATE FUNCTION pg_temp.expect(p_label text, p_got bigint, p_want bigint) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN RAISE EXCEPTION '%: expected % cents, got %', p_label, p_want, p_got; END IF;
END $$;

-- Schedule 1 "Sample data": earnings and the amounts to be withheld under Scale 1 (no tax-free threshold) and
-- Scale 2 (tax-free threshold claimed), in cents.
CREATE TEMP TABLE sample_data (frequency text, earnings_cents bigint, scale1_cents bigint, scale2_cents bigint);
INSERT INTO sample_data VALUES
    ('weekly', 11600, 1900, 0),
    ('weekly', 11700, 1900, 0),
    ('weekly', 14900, 2400, 0),
    ('weekly', 15000, 2400, 0),
    ('weekly', 24900, 4500, 0),
    ('weekly', 25000, 4500, 0),
    ('weekly', 36000, 6900, 0),
    ('weekly', 36100, 6900, 0),
    ('weekly', 37000, 7100, 200),
    ('weekly', 37100, 7100, 200),
    ('weekly', 49900, 9500, 2200),
    ('weekly', 50000, 9500, 2200),
    ('weekly', 51400, 9800, 2600),
    ('weekly', 51500, 9800, 2600),
    ('weekly', 62400, 13300, 5500),
    ('weekly', 62500, 13400, 5500),
    ('weekly', 72000, 16400, 7200),
    ('weekly', 72100, 16500, 7200),
    ('weekly', 84200, 20400, 9500),
    ('weekly', 84300, 20400, 9500),
    ('weekly', 86400, 21100, 9900),
    ('weekly', 86500, 21100, 9900),
    ('weekly', 93100, 23300, 12100),
    ('weekly', 93200, 23300, 12100),
    ('weekly', 105200, 27100, 16000),
    ('weekly', 105300, 27200, 16000),
    ('weekly', 128100, 34500, 23400),
    ('weekly', 128200, 34500, 23400),
    ('weekly', 184400, 52500, 41400),
    ('weekly', 184500, 52500, 41400),
    ('weekly', 211900, 61300, 50200),
    ('weekly', 212000, 61300, 50200),
    ('weekly', 224500, 65300, 54200),
    ('weekly', 224600, 65300, 54200),
    ('weekly', 249000, 74900, 62100),
    ('weekly', 249100, 74900, 62100),
    ('weekly', 259500, 78900, 65400),
    ('weekly', 259600, 79000, 65500),
    ('weekly', 265200, 81200, 67600),
    ('weekly', 265300, 81200, 67700),
    ('weekly', 273600, 84400, 70900),
    ('weekly', 273700, 84500, 71000),
    ('weekly', 289800, 90800, 77200),
    ('weekly', 289900, 90800, 77300),
    ('weekly', 330200, 106500, 93000),
    ('weekly', 330300, 106600, 93000),
    ('weekly', 365200, 123000, 106600),
    ('weekly', 365300, 123000, 106700),
    ('fortnightly', 23200, 3800, 0),
    ('fortnightly', 23400, 3800, 0),
    ('fortnightly', 29800, 4800, 0),
    ('fortnightly', 30000, 4800, 0),
    ('fortnightly', 49800, 9000, 0),
    ('fortnightly', 50000, 9000, 0),
    ('fortnightly', 72000, 13800, 0),
    ('fortnightly', 72200, 13800, 0),
    ('fortnightly', 74000, 14200, 400),
    ('fortnightly', 74200, 14200, 400),
    ('fortnightly', 99800, 19000, 4400),
    ('fortnightly', 100000, 19000, 4400),
    ('fortnightly', 102800, 19600, 5200),
    ('fortnightly', 103000, 19600, 5200),
    ('fortnightly', 124800, 26600, 11000),
    ('fortnightly', 125000, 26800, 11000),
    ('fortnightly', 144000, 32800, 14400),
    ('fortnightly', 144200, 33000, 14400),
    ('fortnightly', 168400, 40800, 19000),
    ('fortnightly', 168600, 40800, 19000),
    ('fortnightly', 172800, 42200, 19800),
    ('fortnightly', 173000, 42200, 19800),
    ('fortnightly', 186200, 46600, 24200),
    ('fortnightly', 186400, 46600, 24200),
    ('fortnightly', 210400, 54200, 32000),
    ('fortnightly', 210600, 54400, 32000),
    ('fortnightly', 256200, 69000, 46800),
    ('fortnightly', 256400, 69000, 46800),
    ('fortnightly', 368800, 105000, 82800),
    ('fortnightly', 369000, 105000, 82800),
    ('fortnightly', 423800, 122600, 100400),
    ('fortnightly', 424000, 122600, 100400),
    ('fortnightly', 449000, 130600, 108400),
    ('fortnightly', 449200, 130600, 108400),
    ('fortnightly', 498000, 149800, 124200),
    ('fortnightly', 498200, 149800, 124200),
    ('fortnightly', 519000, 157800, 130800),
    ('fortnightly', 519200, 158000, 131000),
    ('fortnightly', 530400, 162400, 135200),
    ('fortnightly', 530600, 162400, 135400),
    ('fortnightly', 547200, 168800, 141800),
    ('fortnightly', 547400, 169000, 142000),
    ('fortnightly', 579600, 181600, 154400),
    ('fortnightly', 579800, 181600, 154600),
    ('fortnightly', 660400, 213000, 186000),
    ('fortnightly', 660600, 213200, 186000),
    ('fortnightly', 730400, 246000, 213200),
    ('fortnightly', 730600, 246000, 213400),
    ('monthly', 50267, 8200, 0),
    ('monthly', 50700, 8200, 0),
    ('monthly', 64567, 10400, 0),
    ('monthly', 65000, 10400, 0),
    ('monthly', 107900, 19500, 0),
    ('monthly', 108333, 19500, 0),
    ('monthly', 156000, 29900, 0),
    ('monthly', 156433, 29900, 0),
    ('monthly', 160333, 30800, 900),
    ('monthly', 160767, 30800, 900),
    ('monthly', 216233, 41200, 9500),
    ('monthly', 216667, 41200, 9500),
    ('monthly', 222733, 42500, 11300),
    ('monthly', 223167, 42500, 11300),
    ('monthly', 270400, 57600, 23800),
    ('monthly', 270833, 58100, 23800),
    ('monthly', 312000, 71100, 31200),
    ('monthly', 312433, 71500, 31200),
    ('monthly', 364867, 88400, 41200),
    ('monthly', 365300, 88400, 41200),
    ('monthly', 374400, 91400, 42900),
    ('monthly', 374833, 91400, 42900),
    ('monthly', 403433, 101000, 52400),
    ('monthly', 403867, 101000, 52400),
    ('monthly', 455867, 117400, 69300),
    ('monthly', 456300, 117900, 69300),
    ('monthly', 555100, 149500, 101400),
    ('monthly', 555533, 149500, 101400),
    ('monthly', 799067, 227500, 179400),
    ('monthly', 799500, 227500, 179400),
    ('monthly', 918233, 265600, 217500),
    ('monthly', 918667, 265600, 217500),
    ('monthly', 972833, 283000, 234900),
    ('monthly', 973267, 283000, 234900),
    ('monthly', 1079000, 324600, 269100),
    ('monthly', 1079433, 324600, 269100),
    ('monthly', 1124500, 341900, 283400),
    ('monthly', 1124933, 342300, 283800),
    ('monthly', 1149200, 351900, 292900),
    ('monthly', 1149633, 351900, 293400),
    ('monthly', 1185600, 365700, 307200),
    ('monthly', 1186033, 366200, 307700),
    ('monthly', 1255800, 393500, 334500),
    ('monthly', 1256233, 393500, 335000),
    ('monthly', 1430867, 461500, 403000),
    ('monthly', 1431300, 461900, 403000),
    ('monthly', 1582533, 533000, 461900),
    ('monthly', 1582967, 533000, 462400);

DO $$
DECLARE
  r record;
  prev record;
  gap numeric;
  sc integer;
  n_rows integer;
  pay_date date;
BEGIN
  -- ATO general example 1: weekly earnings $1,333.45, tax-free threshold claimed (Scale 2). x = 1,333.99;
  -- (0.3200 x 1,333.99) - 176.5769 = 250.2999, or $250.
  PERFORM pg_temp.expect('ATO example 1 (weekly $1,333.45)',
    public.calc_payg_tax(133345, 'weekly', true, DATE '2025-07-01'), 25000);

  -- ATO general example 3: monthly earnings $5,400.33, Scale 2. ($5,400.33 + 0.01) x 3 / 13 = 1,246.2323, so
  -- x = 1,246.99; (0.3227 x 1,246.99) - 180.0385 = 222.3652, or $222 a week; $222 x 13 / 3 = $962 a month.
  PERFORM pg_temp.expect('ATO example 3 (monthly $5,400.33)',
    public.calc_payg_tax(540033, 'monthly', true, DATE '2025-09-30'), 96200);
  -- Its weekly step on its own.
  PERFORM pg_temp.expect('ATO example 3 weekly step ($1,246)',
    public.calc_payg_tax(124600, 'weekly', true, DATE '2025-09-30'), 22200);

  -- ATO general example 2's fortnightly conversion ($1,299.30 / 2 = 649.65, ignore cents, x = 649.99), on Scale 2
  -- instead of its Scale 5: (0.1800 x 649.99) - 57.8462 = 59.1520, or $59 a week, $118 a fortnight.
  PERFORM pg_temp.expect('example 2 conversion on Scale 2 (fortnightly $1,299.30)',
    public.calc_payg_tax(129930, 'fortnightly', true, DATE '2026-06-30'), 11800);

  -- Every Scale 1 and Scale 2 row of the Schedule 1 sample data, weekly, fortnightly and monthly.
  n_rows := 0;
  FOR r IN SELECT * FROM sample_data ORDER BY frequency, earnings_cents LOOP
    -- Spread the pay dates over the year so the whole of FY2025-26 is exercised.
    pay_date := DATE '2025-07-01' + ((n_rows * 7) % 365);
    PERFORM pg_temp.expect(format('sample data %s $%s, Scale 1', r.frequency, (r.earnings_cents / 100.0)::numeric(12,2)),
      public.calc_payg_tax(r.earnings_cents, r.frequency, false, pay_date), r.scale1_cents);
    PERFORM pg_temp.expect(format('sample data %s $%s, Scale 2', r.frequency, (r.earnings_cents / 100.0)::numeric(12,2)),
      public.calc_payg_tax(r.earnings_cents, r.frequency, true, pay_date), r.scale2_cents);
    n_rows := n_rows + 1;
  END LOOP;
  IF n_rows <> 144 THEN RAISE EXCEPTION 'expected 144 sample data rows, found %', n_rows; END IF;

  -- The 0046 rows this replaces are gone: $1,000 a week without the threshold was 0.32 x 1,000 - 74.8077 = $245;
  -- the instrument's row (0.3200 x 1,000.99) - 65.7202 = 254.5966 gives $255.
  PERFORM pg_temp.expect('weekly $1,000, Scale 1', public.calc_payg_tax(100000, 'weekly', false, DATE '2025-07-01'), 25500);
  PERFORM pg_temp.expect('weekly $4,000, Scale 2 (0.47 x 4,000.99 - 650.6154 = 1,229.85)',
    public.calc_payg_tax(400000, 'weekly', true, DATE '2026-06-30'), 123000);
  PERFORM pg_temp.expect('weekly $4,000, Scale 1 (0.47 x 4,000.99 - 487.2587 = 1,393.21)',
    public.calc_payg_tax(400000, 'weekly', false, DATE '2026-06-30'), 139300);

  -- The FY2025-26 table is not used for an FY2026-27 pay date.
  IF public.calc_payg_tax(133345, 'weekly', true, DATE '2026-07-01') = 25000 THEN
    RAISE EXCEPTION 'pay date 1 July 2026 must use the FY2026-27 table';
  END IF;

  -- Every Schedule 1 row is loaded and nothing else: 7 for Scale 1, 9 for Scale 2, contiguous from $0 with an open
  -- top row.
  IF (SELECT count(*) FROM public.payg_tax_tiers WHERE fy_start_year = 2025 AND scale = 1) <> 7
     OR (SELECT count(*) FROM public.payg_tax_tiers WHERE fy_start_year = 2025 AND scale = 2) <> 9 THEN
    RAISE EXCEPTION 'FY2025-26 table has the wrong number of rows (0046 rows left behind, or rows missing)';
  END IF;
  FOR sc IN 1..2 LOOP
    prev := NULL;
    FOR r IN SELECT * FROM public.payg_tax_tiers WHERE fy_start_year = 2025 AND scale = sc ORDER BY tier_min_cents LOOP
      IF prev IS NULL THEN
        IF r.tier_min_cents <> 0 THEN RAISE EXCEPTION 'scale % does not start at $0', r.scale; END IF;
      ELSE
        IF r.tier_min_cents <> prev.tier_max_cents THEN
          RAISE EXCEPTION 'scale % has a gap at % cents', r.scale, prev.tier_max_cents;
        END IF;
        -- The formulas either side of each Schedule 1 boundary give almost the same amount there (the published
        -- rows differ by at most 16 cents, at $150 on Scale 1); a mistyped coefficient shows up as a jump of dollars.
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

  RAISE NOTICE 'payg-2025-26-ato-examples: ATO Schedule 1 examples 1 and 3 reproduced ($250 weekly; $222 weekly, $962 monthly); 144 sample data rows match for Scales 1 and 2; FY2025-26 rows complete and continuous';
END $$;

ROLLBACK;
