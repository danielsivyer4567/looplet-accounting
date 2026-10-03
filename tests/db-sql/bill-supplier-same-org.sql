-- SEC-11: bills only reference suppliers of their own organisation.
-- Run with: node scripts/db/run-pg-sql-tests.mjs tests/db-sql/bill-supplier-same-org.sql

BEGIN;

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
INSERT INTO ids VALUES
  ('org_a', 'ab000000-0000-4000-8000-000000000001'), ('org_b', 'ab000000-0000-4000-8000-000000000002'),
  ('owner_a', 'ab100000-0000-4000-8000-000000000001'),
  ('sup_a', 'ab200000-0000-4000-8000-000000000001'), ('sup_b', 'ab200000-0000-4000-8000-000000000002'),
  ('bill_a', 'ab300000-0000-4000-8000-000000000001');
CREATE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT v FROM ids WHERE k = p $$;
CREATE TEMP TABLE src AS
SELECT e.enumlabel AS label FROM pg_attribute a JOIN pg_enum e ON e.enumtypid = a.atttypid
 WHERE a.attrelid = 'public.bills'::regclass AND a.attname = 'source' ORDER BY e.enumsortorder LIMIT 1;

INSERT INTO auth.users (id, email, aud, role) VALUES (pg_temp.id('owner_a'), 'owner-a@example.test', 'authenticated', 'authenticated');
INSERT INTO public.organizations (id, name) VALUES (pg_temp.id('org_a'), 'Org A'), (pg_temp.id('org_b'), 'Org B');
INSERT INTO public.organization_memberships (user_id, organization_id, role, role_enum, accepted_at)
  VALUES (pg_temp.id('owner_a'), pg_temp.id('org_a'), 'owner', 'owner', now());
-- The same supplier name and ABN in both organisations, with different bank details.
INSERT INTO public.suppliers (id, organization_id, name, abn, payee_bsb, payee_account_number) VALUES
  (pg_temp.id('sup_a'), pg_temp.id('org_a'), 'Payee Pty Ltd', '51824753556', '062-000', '11111111'),
  (pg_temp.id('sup_b'), pg_temp.id('org_b'), 'Payee Pty Ltd', '51824753556', '999-999', '99999999');

CREATE TEMP TABLE outcomes (name text, actual text, expected text);

CREATE FUNCTION pg_temp.try(p_name text, p_sql text, p_expected text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE outcome text;
BEGIN
  BEGIN
    EXECUTE p_sql;
    outcome := 'allowed';
  EXCEPTION
    WHEN insufficient_privilege THEN outcome := 'denied';
    WHEN OTHERS THEN outcome := 'error: ' || SQLSTATE || ' ' || SQLERRM;
  END;
  INSERT INTO outcomes VALUES (p_name, outcome, p_expected);
END $$;

-- As the table owner (the service role behaves the same: triggers run for every role).
SELECT pg_temp.try('owner inserts bill -> other org supplier',
  format('INSERT INTO public.bills (organization_id, source, storage_key, original_filename, mime_type, supplier_id) VALUES (%L, %L, %L, %L, %L, %L)',
         pg_temp.id('org_a'), (SELECT label FROM src), 'a/x', 'x.pdf', 'application/pdf', pg_temp.id('sup_b')), 'denied');
SELECT pg_temp.try('owner inserts bill -> own org supplier',
  format('INSERT INTO public.bills (id, organization_id, source, storage_key, original_filename, mime_type, supplier_id) VALUES (%L, %L, %L, %L, %L, %L, %L)',
         pg_temp.id('bill_a'), pg_temp.id('org_a'), (SELECT label FROM src), 'a/1', 'bill.pdf', 'application/pdf', pg_temp.id('sup_a')), 'allowed');
SELECT pg_temp.try('owner repoints bill -> other org supplier',
  format('UPDATE public.bills SET supplier_id = %L WHERE id = %L', pg_temp.id('sup_b'), pg_temp.id('bill_a')), 'denied');

-- As a signed-in owner of org A, through RLS. (The temp fixture tables are the test's own scaffolding.)
GRANT SELECT ON ids, src TO authenticated;
GRANT INSERT ON outcomes TO authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', pg_temp.id('owner_a'), 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', pg_temp.id('owner_a')::text, true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.try('org A owner inserts bill -> org B supplier',
  format('INSERT INTO public.bills (organization_id, source, storage_key, original_filename, mime_type, supplier_id) VALUES (%L, %L, %L, %L, %L, %L)',
         pg_temp.id('org_a'), (SELECT label FROM src), 'a/y', 'y.pdf', 'application/pdf', pg_temp.id('sup_b')), 'denied');
SELECT pg_temp.try('org A owner repoints bill -> org B supplier',
  format('UPDATE public.bills SET supplier_id = %L WHERE id = %L', pg_temp.id('sup_b'), pg_temp.id('bill_a')), 'denied');
RESET ROLE;

-- The auto-link trigger still links by name/ABN within the bill's own organisation.
DO $$
DECLARE linked uuid;
BEGIN
  EXECUTE format('INSERT INTO public.bills (organization_id, source, storage_key, original_filename, mime_type, supplier_name_raw, supplier_abn) '
                 'VALUES (%L, %L, %L, %L, %L, %L, %L) RETURNING supplier_id',
                 pg_temp.id('org_a'), (SELECT label FROM src), 'a/auto', 'auto.pdf', 'application/pdf', 'Payee Pty Ltd', '51824753556')
    INTO linked;
  INSERT INTO outcomes VALUES ('auto-link picks the own-org supplier',
    CASE WHEN linked = pg_temp.id('sup_a') THEN 'allowed' ELSE coalesce(linked::text, 'null') END, 'allowed');
END $$;

DO $$
DECLARE r record; bad text := '';
BEGIN
  FOR r IN SELECT * FROM outcomes WHERE actual IS DISTINCT FROM expected LOOP
    bad := bad || format(E'\n  %s: expected %s, got %s', r.name, r.expected, r.actual);
  END LOOP;
  IF bad <> '' THEN RAISE EXCEPTION 'bill supplier same-org checks failed:%', bad; END IF;
  RAISE NOTICE 'bill supplier same-org: % checks as expected', (SELECT count(*) FROM outcomes);
END $$;

ROLLBACK;
