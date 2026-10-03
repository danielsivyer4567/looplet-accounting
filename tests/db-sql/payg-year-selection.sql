-- PAY-03: PAYG withholding uses the financial year of the pay date, and fails loudly instead of returning $0 when no
-- withholding table covers that year.
-- Run with: node scripts/db/run-pg-sql-tests.mjs tests/db-sql/payg-year-selection.sql
--
-- Setup runs as postgres. A synthetic FY2030-31 table (flat 50%) is added inside the transaction so year selection
-- can be checked independently of today's date and of which real ATO tables are loaded. Everything is rolled back.

BEGIN;

-- Returns the error message calc_payg_tax raises, or NULL when it returns normally.
CREATE FUNCTION pg_temp.payg_error(p_gross bigint, p_freq text, p_threshold boolean, p_pay_date date) RETURNS text
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM public.calc_payg_tax(p_gross, p_freq, p_threshold, p_pay_date);
  RETURN NULL;
EXCEPTION WHEN others THEN
  RETURN SQLERRM;
END $$;

-- FY2030-31 (fy_start_year 2030): one tier, 50% of weekly earnings, both scales.
INSERT INTO public.payg_tax_tiers (fy_start_year, scale, tier_min_cents, tier_max_cents, a_coeff, b_coeff, notes) VALUES
  (2030, 2, 0, NULL, 0.5, 0, 'payg-year-selection test: flat 50%'),
  (2030, 1, 0, NULL, 0.5, 0, 'payg-year-selection test: flat 50%');

DO $$
DECLARE
  r bigint;
  e text;
BEGIN
  -- The old 3-argument signature (year from CURRENT_DATE) is gone; only the pay-date version exists.
  IF to_regprocedure('public.calc_payg_tax(bigint,text,boolean)') IS NOT NULL THEN
    RAISE EXCEPTION 'the old calc_payg_tax(bigint, text, boolean) still exists';
  END IF;
  IF to_regprocedure('public.calc_payg_tax(bigint,text,boolean,date)') IS NULL THEN
    RAISE EXCEPTION 'calc_payg_tax(bigint, text, boolean, date) is missing';
  END IF;

  -- FY2025-26 table (0046): $1,000 a week with the tax-free threshold is tier 865-1282, 0.3227 x 1000 - 180.0385
  -- = 142.6615, rounded to $143. The same on the first and last day of that financial year.
  r := public.calc_payg_tax(100000, 'weekly', true, DATE '2025-07-01');
  IF r <> 14300 THEN RAISE EXCEPTION 'FY2025-26 first day: expected 14300, got %', r; END IF;
  r := public.calc_payg_tax(100000, 'weekly', true, DATE '2026-06-30');
  IF r <> 14300 THEN RAISE EXCEPTION 'FY2025-26 last day: expected 14300, got %', r; END IF;
  r := public.calc_payg_tax(200000, 'fortnightly', true, DATE '2025-10-02');
  IF r <> 28600 THEN RAISE EXCEPTION 'FY2025-26 fortnightly: expected 28600, got %', r; END IF;

  -- The day before FY2025-26 is FY2024-25, which has no table: an error, not $0 and not the FY2025-26 table.
  e := pg_temp.payg_error(100000, 'weekly', true, DATE '2025-06-30');
  IF e IS NULL OR e NOT LIKE '%no PAYG withholding table for FY2024-25%' THEN
    RAISE EXCEPTION 'pay date 2025-06-30: expected a missing FY2024-25 table error, got %', coalesce(e, 'a result');
  END IF;

  -- Year selection follows the pay date, not today: the synthetic FY2030-31 table applies from 1 July 2030 to
  -- 30 June 2031, whatever today's date is.
  r := public.calc_payg_tax(100000, 'weekly', true, DATE '2030-07-01');
  IF r <> 50000 THEN RAISE EXCEPTION 'FY2030-31 first day: expected 50000, got %', r; END IF;
  r := public.calc_payg_tax(100000, 'weekly', false, DATE '2031-06-30');
  IF r <> 50000 THEN RAISE EXCEPTION 'FY2030-31 last day (scale 1): expected 50000, got %', r; END IF;
  e := pg_temp.payg_error(100000, 'weekly', true, DATE '2030-06-30');
  IF e IS NULL OR e NOT LIKE '%no PAYG withholding table for FY2029-30 (pay date 2030-06-30, scale 2)%' THEN
    RAISE EXCEPTION 'pay date 2030-06-30: expected a missing FY2029-30 table error, got %', coalesce(e, 'a result');
  END IF;
  e := pg_temp.payg_error(100000, 'weekly', true, DATE '2031-07-01');
  IF e IS NULL OR e NOT LIKE '%FY2031-32%' THEN
    RAISE EXCEPTION 'pay date 2031-07-01: expected a missing FY2031-32 table error, got %', coalesce(e, 'a result');
  END IF;

  -- A year with no table fails even for a $0 payslip, so a whole pay run in an unsupported year fails consistently.
  e := pg_temp.payg_error(0, 'weekly', true, DATE '2029-01-15');
  IF e IS NULL OR e NOT LIKE '%no PAYG withholding table for FY2028-29%' THEN
    RAISE EXCEPTION '$0 in an uncovered year: expected an error, got %', coalesce(e, 'a result');
  END IF;
  r := public.calc_payg_tax(0, 'weekly', true, DATE '2025-10-02');
  IF r <> 0 THEN RAISE EXCEPTION '$0 in a covered year: expected 0, got %', r; END IF;

  -- No pay date, or an unknown frequency, is an error rather than a guess.
  e := pg_temp.payg_error(100000, 'weekly', true, NULL);
  IF e IS NULL OR e NOT LIKE '%pay date is required%' THEN
    RAISE EXCEPTION 'null pay date: expected an error, got %', coalesce(e, 'a result');
  END IF;
  e := pg_temp.payg_error(100000, 'quarterly', true, DATE '2025-10-02');
  IF e IS NULL OR e NOT LIKE '%unknown pay frequency quarterly%' THEN
    RAISE EXCEPTION 'unknown frequency: expected an error, got %', coalesce(e, 'a result');
  END IF;

  -- Callable by signed-in users and the service role, not by anon.
  IF NOT has_function_privilege('authenticated', 'public.calc_payg_tax(bigint,text,boolean,date)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.calc_payg_tax(bigint,text,boolean,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated and service_role must be able to execute calc_payg_tax';
  END IF;
  IF has_function_privilege('anon', 'public.calc_payg_tax(bigint,text,boolean,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not be able to execute calc_payg_tax';
  END IF;
END $$;

-- The same selection as a signed-in user (the function is SECURITY INVOKER and reads payg_tax_tiers under RLS).
SELECT set_config('request.jwt.claims', json_build_object('sub', '10000000-0000-4000-8000-0000000000aa', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000aa', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  r bigint;
BEGIN
  r := public.calc_payg_tax(100000, 'weekly', true, DATE '2030-07-01');
  IF r <> 50000 THEN RAISE EXCEPTION 'as authenticated, FY2030-31: expected 50000, got %', r; END IF;
  r := public.calc_payg_tax(100000, 'weekly', true, DATE '2025-07-01');
  IF r <> 14300 THEN RAISE EXCEPTION 'as authenticated, FY2025-26: expected 14300, got %', r; END IF;
END $$;
RESET ROLE;

DO $$ BEGIN
  RAISE NOTICE 'payg-year-selection: PAYG table follows the pay date''s financial year; uncovered years, null dates and unknown frequencies raise; anon cannot execute';
END $$;

ROLLBACK;
