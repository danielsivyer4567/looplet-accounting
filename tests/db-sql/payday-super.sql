-- PAY-05: super guarantee due dates. Payday Super (7 business days after the pay date; 20 for a new employee's first
-- contribution to a fund) for pay dates from 1 July 2026; 28 days after the quarter end before then.
-- Run with: node scripts/db/run-pg-sql-tests.mjs tests/db-sql/payday-super.sql
--
-- Calendar used below: 1 July 2026 is a Wednesday. Setup runs as postgres; everything is rolled back.

BEGIN;

CREATE FUNCTION pg_temp.due(p_pay_date date, p_first boolean DEFAULT false) RETURNS text
LANGUAGE sql AS $$ SELECT rule || ' ' || due_date FROM public.super_guarantee_due(p_pay_date, p_first) $$;

CREATE FUNCTION pg_temp.expect(p_label text, p_got text, p_want text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN RAISE EXCEPTION '%: expected %, got %', p_label, p_want, p_got; END IF;
END $$;

DO $$
DECLARE
  e text;
BEGIN
  IF EXTRACT(ISODOW FROM DATE '2026-07-01') <> 3 THEN RAISE EXCEPTION 'calendar assumption: 1 July 2026 is a Wednesday'; END IF;

  -- Quarterly rule for pay dates before 1 July 2026: 28 days after the end of the pay date's quarter.
  PERFORM pg_temp.expect('Jul-Sep quarter', pg_temp.due('2025-08-15'), 'quarterly 2025-10-28');
  PERFORM pg_temp.expect('Oct-Dec quarter', pg_temp.due('2025-12-31'), 'quarterly 2026-01-28');
  PERFORM pg_temp.expect('Jan-Mar quarter', pg_temp.due('2026-02-10'), 'quarterly 2026-04-28');
  PERFORM pg_temp.expect('Apr-Jun quarter, first day', pg_temp.due('2026-04-01'), 'quarterly 2026-07-28');
  -- The last pay date before Payday Super stays quarterly even though its due date falls after 1 July 2026.
  PERFORM pg_temp.expect('30 June 2026', pg_temp.due('2026-06-30'), 'quarterly 2026-07-28');
  -- The new-employee flag has no effect under the quarterly rule.
  PERFORM pg_temp.expect('quarterly, first contribution', pg_temp.due('2026-06-30', true), 'quarterly 2026-07-28');

  -- Payday Super from 1 July 2026: received by the fund by the 7th business day after the pay date.
  -- Wed 1 Jul: Thu 2, Fri 3, Mon 6, Tue 7, Wed 8, Thu 9, Fri 10.
  PERFORM pg_temp.expect('Wed 1 Jul 2026', pg_temp.due('2026-07-01'), 'payday_super 2026-07-10');
  -- Fri 3 Jul: Mon 6 .. Fri 10, Mon 13, Tue 14 (the weekend is skipped).
  PERFORM pg_temp.expect('Fri 3 Jul 2026', pg_temp.due('2026-07-03'), 'payday_super 2026-07-14');
  -- A Saturday payday counts from the next business day too.
  PERFORM pg_temp.expect('Sat 4 Jul 2026', pg_temp.due('2026-07-04'), 'payday_super 2026-07-14');
  -- First contribution to a fund for a new employee: the 20th business day (Wed 29 Jul).
  PERFORM pg_temp.expect('first contribution', pg_temp.due('2026-07-01', true), 'payday_super 2026-07-29');

  -- A whole-of-State public holiday recorded in super_non_business_days is not a business day.
  INSERT INTO public.super_non_business_days (day, description) VALUES ('2026-07-08', 'payday-super test day');
  PERFORM pg_temp.expect('with a holiday in the window', pg_temp.due('2026-07-01'), 'payday_super 2026-07-13');
  DELETE FROM public.super_non_business_days WHERE day = '2026-07-08';

  BEGIN
    PERFORM public.super_guarantee_due(NULL);
    RAISE EXCEPTION 'a null pay date returned a due date';
  EXCEPTION WHEN null_value_not_allowed THEN NULL;
  END;
END $$;

-- Per pay run, through the view, under each user's own access.
INSERT INTO auth.users (id, email, aud, role) VALUES
  ('10000000-0000-4000-8000-0000000000d1', 'owner-d@example.test', 'authenticated', 'authenticated'),
  ('10000000-0000-4000-8000-0000000000d2', 'outsider-d@example.test', 'authenticated', 'authenticated');
INSERT INTO public.organizations (id, name) VALUES
  ('0a000000-0000-4000-8000-0000000000d1', 'Org D'), ('0b000000-0000-4000-8000-0000000000d1', 'Org E');
INSERT INTO public.organization_memberships (user_id, organization_id, role, role_enum, accepted_at) VALUES
  ('10000000-0000-4000-8000-0000000000d1', '0a000000-0000-4000-8000-0000000000d1', 'owner', 'owner', now()),
  ('10000000-0000-4000-8000-0000000000d2', '0b000000-0000-4000-8000-0000000000d1', 'owner', 'owner', now());
INSERT INTO public.pay_runs (id, organization_id, period_start, period_end, pay_date) VALUES
  ('93000000-0000-4000-8000-0000000000d1', '0a000000-0000-4000-8000-0000000000d1', '2026-06-22', '2026-06-28', '2026-06-30'),
  ('93000000-0000-4000-8000-0000000000d2', '0a000000-0000-4000-8000-0000000000d1', '2026-06-29', '2026-07-05', '2026-07-03');

SELECT set_config('request.jwt.claims', json_build_object('sub', '10000000-0000-4000-8000-0000000000d1', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000d1', true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  got text;
BEGIN
  SELECT string_agg(pay_run_id || ' ' || super_due_rule || ' ' || super_due_date, ', ' ORDER BY pay_date) INTO got
    FROM public.v_pay_run_super_due WHERE organization_id = '0a000000-0000-4000-8000-0000000000d1';
  PERFORM pg_temp.expect('owner sees both runs',
    got,
    '93000000-0000-4000-8000-0000000000d1 quarterly 2026-07-28, 93000000-0000-4000-8000-0000000000d2 payday_super 2026-07-14');
  -- Holidays are readable but only the service role maintains them.
  BEGIN
    INSERT INTO public.super_non_business_days (day, description) VALUES ('2026-07-09', 'not allowed');
    RAISE EXCEPTION 'a signed-in user added a non-business day';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM count(*) FROM public.super_non_business_days;
END $$;
RESET ROLE;

SELECT set_config('request.jwt.claims', json_build_object('sub', '10000000-0000-4000-8000-0000000000d2', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-0000000000d2', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.v_pay_run_super_due WHERE organization_id = '0a000000-0000-4000-8000-0000000000d1') THEN
    RAISE EXCEPTION 'an outsider can see another organisation''s pay run due dates';
  END IF;
END $$;
RESET ROLE;

DO $$
BEGIN
  IF has_table_privilege('anon', 'public.v_pay_run_super_due', 'SELECT') THEN
    RAISE EXCEPTION 'anon must not read pay run due dates';
  END IF;
  RAISE NOTICE 'payday-super: quarterly due dates before 1 July 2026, 7th (or 20th) business day after payday from then, holidays respected, view scoped by RLS';
END $$;

ROLLBACK;
