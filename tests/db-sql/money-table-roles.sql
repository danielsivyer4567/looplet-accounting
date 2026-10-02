-- SEC-05: writes to money tables need a role; viewers, pending invitees and outsiders are read-only or locked out.
-- Run with: node scripts/db/run-pg-sql-tests.mjs tests/db-sql/money-table-roles.sql
--
-- Setup runs as postgres (table owner, so RLS does not apply). Each probe switches to the `authenticated` role with
-- the user's JWT claims, runs one statement, records ok (rows changed), none (no rows visible to change) or denied
-- (RLS or same-org check), and always rolls the statement back so probes do not affect each other.

BEGIN;

CREATE FUNCTION pg_temp.probe(p_user uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  n bigint := 0;
  result text;
BEGIN
  -- Both forms: older auth.uid() reads request.jwt.claim.sub, newer reads request.jwt.claims.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE EXCEPTION 'probe-rollback';
  EXCEPTION
    WHEN insufficient_privilege THEN result := 'denied';
    WHEN raise_exception THEN
      result := CASE WHEN SQLERRM = 'probe-rollback' THEN CASE WHEN n > 0 THEN 'ok' ELSE 'none' END
                     ELSE 'error: ' || SQLERRM END;
    WHEN others THEN result := 'error: ' || SQLSTATE || ' ' || SQLERRM;
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  RETURN result;
END $$;

-- Fixed ids: org A is under test, org B belongs to an outsider.
CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
INSERT INTO ids VALUES
  ('org_a', '0a000000-0000-4000-8000-000000000001'), ('org_b', '0b000000-0000-4000-8000-000000000001'),
  ('owner', '10000000-0000-4000-8000-000000000001'), ('admin', '10000000-0000-4000-8000-000000000002'),
  ('accountant', '10000000-0000-4000-8000-000000000003'), ('employee', '10000000-0000-4000-8000-000000000004'),
  ('viewer', '10000000-0000-4000-8000-000000000005'), ('pending_admin', '10000000-0000-4000-8000-000000000006'),
  ('outsider', '10000000-0000-4000-8000-000000000007'),
  ('supplier', '20000000-0000-4000-8000-000000000001'), ('supplier_del', '20000000-0000-4000-8000-000000000002'),
  ('bill', '30000000-0000-4000-8000-000000000001'), ('bill_del', '30000000-0000-4000-8000-000000000002'),
  ('bill_b', '30000000-0000-4000-8000-0000000000b1'),
  ('customer', '40000000-0000-4000-8000-000000000001'), ('customer_del', '40000000-0000-4000-8000-000000000002'),
  ('invoice', '50000000-0000-4000-8000-000000000001'),
  ('journal', '60000000-0000-4000-8000-000000000001'),
  ('lock', '70000000-0000-4000-8000-000000000001'),
  ('employee_row', '80000000-0000-4000-8000-000000000001'), ('employee_b', '80000000-0000-4000-8000-0000000000b1'),
  ('run', '90000000-0000-4000-8000-000000000001'), ('run_del', '90000000-0000-4000-8000-000000000002'),
  ('item', '91000000-0000-4000-8000-000000000001'),
  ('super', '92000000-0000-4000-8000-000000000001'),
  ('pay_run_b', '93000000-0000-4000-8000-0000000000b1');
CREATE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT v FROM ids WHERE k = p $$;

INSERT INTO auth.users (id, email, aud, role)
SELECT v, k || '@example.test', 'authenticated', 'authenticated' FROM ids
 WHERE k IN ('owner', 'admin', 'accountant', 'employee', 'viewer', 'pending_admin', 'outsider');

INSERT INTO public.organizations (id, name) VALUES (pg_temp.id('org_a'), 'Org A'), (pg_temp.id('org_b'), 'Org B');

INSERT INTO public.organization_memberships (user_id, organization_id, role, role_enum, accepted_at) VALUES
  (pg_temp.id('owner'),         pg_temp.id('org_a'), 'owner',  'owner',      now()),
  (pg_temp.id('admin'),         pg_temp.id('org_a'), 'admin',  'admin',      now()),
  (pg_temp.id('accountant'),    pg_temp.id('org_a'), 'member', 'accountant', now()),
  (pg_temp.id('employee'),      pg_temp.id('org_a'), 'member', 'employee',   now()),
  (pg_temp.id('viewer'),        pg_temp.id('org_a'), 'member', 'viewer',     now()),
  (pg_temp.id('pending_admin'), pg_temp.id('org_a'), 'admin',  'admin',      NULL),
  (pg_temp.id('outsider'),      pg_temp.id('org_b'), 'owner',  'owner',      now());

-- One enum label for bills.source, whatever the enum is called.
CREATE TEMP TABLE bill_source AS
SELECT e.enumlabel AS label
  FROM pg_attribute a JOIN pg_enum e ON e.enumtypid = a.atttypid
 WHERE a.attrelid = 'public.bills'::regclass AND a.attname = 'source'
 ORDER BY e.enumsortorder LIMIT 1;

INSERT INTO public.suppliers (id, organization_id, name) VALUES
  (pg_temp.id('supplier'), pg_temp.id('org_a'), 'Payee Pty Ltd'), (pg_temp.id('supplier_del'), pg_temp.id('org_a'), 'Spare supplier');
DO $$
DECLARE src text := (SELECT label FROM bill_source);
BEGIN
  EXECUTE format(
    'INSERT INTO public.bills (id, organization_id, source, storage_key, original_filename, mime_type) VALUES '
    '(%L, %L, %L, %L, %L, %L), (%L, %L, %L, %L, %L, %L), (%L, %L, %L, %L, %L, %L)',
    pg_temp.id('bill'), pg_temp.id('org_a'), src, 'a/1', 'bill.pdf', 'application/pdf',
    pg_temp.id('bill_del'), pg_temp.id('org_a'), src, 'a/2', 'spare.pdf', 'application/pdf',
    pg_temp.id('bill_b'), pg_temp.id('org_b'), src, 'b/1', 'other-org.pdf', 'application/pdf');
END $$;
INSERT INTO public.customers (id, organization_id, name) VALUES
  (pg_temp.id('customer'), pg_temp.id('org_a'), 'Customer'), (pg_temp.id('customer_del'), pg_temp.id('org_a'), 'Spare customer');
INSERT INTO public.invoices (id, organization_id, invoice_number, customer_id, due_date)
  VALUES (pg_temp.id('invoice'), pg_temp.id('org_a'), 'INV-T-1', pg_temp.id('customer'), DATE '2030-01-31');
INSERT INTO public.journal_entries (id, organization_id) VALUES (pg_temp.id('journal'), pg_temp.id('org_a'));
INSERT INTO public.period_locks (id, organization_id, period_start, period_end, reason)
  VALUES (pg_temp.id('lock'), pg_temp.id('org_a'), DATE '2001-01-01', DATE '2001-01-31', 'test lock');
INSERT INTO public.employees (id, organization_id, full_name) VALUES
  (pg_temp.id('employee_row'), pg_temp.id('org_a'), 'Staff Member'), (pg_temp.id('employee_b'), pg_temp.id('org_b'), 'Other Org Staff');
INSERT INTO public.payment_runs (id, organization_id, pay_date) VALUES
  (pg_temp.id('run'), pg_temp.id('org_a'), DATE '2030-01-15'), (pg_temp.id('run_del'), pg_temp.id('org_a'), DATE '2030-01-16');
INSERT INTO public.payment_run_items (id, payment_run_id, organization_id, bill_id, amount_cents, payee_bsb, payee_account_number, payee_account_name)
  VALUES (pg_temp.id('item'), pg_temp.id('run'), pg_temp.id('org_a'), pg_temp.id('bill'), 1000, '062-000', '12345678', 'Payee Pty Ltd');
INSERT INTO public.super_batches (id, organization_id, fy_start_year, quarter) VALUES (pg_temp.id('super'), pg_temp.id('org_a'), 2030, 1);
INSERT INTO public.pay_runs (id, organization_id, period_start, period_end, pay_date)
  VALUES (pg_temp.id('pay_run_b'), pg_temp.id('org_b'), DATE '2030-01-01', DATE '2030-01-07', DATE '2030-01-08');

-- Probe statements. %s placeholders are filled from ids at run time.
CREATE TEMP TABLE cases (tbl text, op text, min_role text, sql text);
INSERT INTO cases VALUES
  ('suppliers', 'insert', 'accountant', format('INSERT INTO public.suppliers (organization_id, name) VALUES (%L, %L)', pg_temp.id('org_a'), 'New supplier')),
  ('suppliers', 'update', 'accountant', format('UPDATE public.suppliers SET payee_bsb = %L WHERE id = %L', '999-999', pg_temp.id('supplier'))),
  ('suppliers', 'delete', NULL, format('DELETE FROM public.suppliers WHERE id = %L', pg_temp.id('supplier_del'))),
  ('bills', 'insert', 'employee', format('INSERT INTO public.bills (organization_id, source, storage_key, original_filename, mime_type) VALUES (%L, %L, %L, %L, %L)',
     pg_temp.id('org_a'), (SELECT label FROM bill_source), 'a/new', 'new.pdf', 'application/pdf')),
  ('bills', 'update', 'accountant', format('UPDATE public.bills SET original_filename = %L WHERE id = %L', 'renamed.pdf', pg_temp.id('bill'))),
  ('bills', 'delete', NULL, format('DELETE FROM public.bills WHERE id = %L', pg_temp.id('bill_del'))),
  ('customers', 'insert', 'accountant', format('INSERT INTO public.customers (organization_id, name) VALUES (%L, %L)', pg_temp.id('org_a'), 'New customer')),
  ('customers', 'update', 'accountant', format('UPDATE public.customers SET name = %L WHERE id = %L', 'Renamed', pg_temp.id('customer'))),
  ('customers', 'delete', NULL, format('DELETE FROM public.customers WHERE id = %L', pg_temp.id('customer_del'))),
  ('invoices', 'insert', 'accountant', format('INSERT INTO public.invoices (organization_id, invoice_number, customer_id, due_date) VALUES (%L, %L, %L, %L)',
     pg_temp.id('org_a'), 'INV-T-2', pg_temp.id('customer'), DATE '2030-02-28')),
  ('invoices', 'update', 'accountant', format('UPDATE public.invoices SET due_date = %L WHERE id = %L', DATE '2030-03-31', pg_temp.id('invoice'))),
  ('invoices', 'delete', 'accountant', format('DELETE FROM public.invoices WHERE id = %L', pg_temp.id('invoice'))),
  ('journal_entries', 'insert', 'accountant', format('INSERT INTO public.journal_entries (organization_id) VALUES (%L)', pg_temp.id('org_a'))),
  ('journal_entries', 'update', 'accountant', format('UPDATE public.journal_entries SET organization_id = organization_id WHERE id = %L', pg_temp.id('journal'))),
  ('journal_entries', 'delete', 'accountant', format('DELETE FROM public.journal_entries WHERE id = %L', pg_temp.id('journal'))),
  ('period_locks', 'insert', 'accountant', format('INSERT INTO public.period_locks (organization_id, period_start, period_end, reason) VALUES (%L, %L, %L, %L)',
     pg_temp.id('org_a'), DATE '2001-02-01', DATE '2001-02-28', 'another lock')),
  ('period_locks', 'update', 'accountant', format('UPDATE public.period_locks SET reason = %L WHERE id = %L', 'changed', pg_temp.id('lock'))),
  ('period_locks', 'delete', NULL, format('DELETE FROM public.period_locks WHERE id = %L', pg_temp.id('lock'))),
  ('employees', 'insert', 'admin', format('INSERT INTO public.employees (organization_id, full_name) VALUES (%L, %L)', pg_temp.id('org_a'), 'New Staff')),
  ('employees', 'update', 'admin', format('UPDATE public.employees SET full_name = %L WHERE id = %L', 'Renamed Staff', pg_temp.id('employee_row'))),
  ('employees', 'delete', NULL, format('DELETE FROM public.employees WHERE id = %L', pg_temp.id('employee_row'))),
  ('payment_runs', 'insert', 'admin', format('INSERT INTO public.payment_runs (organization_id, pay_date) VALUES (%L, %L)', pg_temp.id('org_a'), DATE '2030-01-20')),
  ('payment_runs', 'update', 'admin', format('UPDATE public.payment_runs SET pay_date = %L WHERE id = %L', DATE '2030-01-21', pg_temp.id('run'))),
  ('payment_runs', 'delete', 'admin', format('DELETE FROM public.payment_runs WHERE id = %L', pg_temp.id('run_del'))),
  ('payment_run_items', 'insert', 'admin', format('INSERT INTO public.payment_run_items (payment_run_id, organization_id, bill_id, amount_cents, payee_bsb, payee_account_number, payee_account_name) VALUES (%L, %L, %L, 500, %L, %L, %L)',
     pg_temp.id('run'), pg_temp.id('org_a'), pg_temp.id('bill_del'), '062-000', '12345678', 'Spare')),
  ('payment_run_items', 'update', 'admin', format('UPDATE public.payment_run_items SET amount_cents = 2000 WHERE id = %L', pg_temp.id('item'))),
  ('payment_run_items', 'delete', 'admin', format('DELETE FROM public.payment_run_items WHERE id = %L', pg_temp.id('item'))),
  ('super_batches', 'insert', 'admin', format('INSERT INTO public.super_batches (organization_id, fy_start_year, quarter) VALUES (%L, 2030, 2)', pg_temp.id('org_a'))),
  ('super_batches', 'update', 'admin', format('UPDATE public.super_batches SET quarter = 3 WHERE id = %L', pg_temp.id('super'))),
  ('super_batches', 'delete', 'admin', format('DELETE FROM public.super_batches WHERE id = %L', pg_temp.id('super')));

CREATE TEMP TABLE ranks (role text PRIMARY KEY, rank int);
INSERT INTO ranks VALUES ('viewer', 0), ('employee', 1), ('accountant', 2), ('admin', 3), ('owner', 4);

-- Expected: an accepted member at or above the minimum role succeeds; everyone else is refused. A refused insert
-- raises an RLS error ('denied'); a refused update or delete sees no rows ('none'). A NULL minimum role means no one
-- may do it: bills, suppliers, customers, period locks and employees have no DELETE policy (they are soft-deleted).
CREATE TEMP TABLE results AS
SELECT c.tbl, c.op, u.who,
       CASE WHEN c.min_role IS NOT NULL AND u.rank IS NOT NULL AND u.rank >= (SELECT rank FROM ranks WHERE role = c.min_role) THEN 'ok'
            WHEN c.op = 'insert' THEN 'denied' ELSE 'none' END AS expected,
       pg_temp.probe(pg_temp.id(u.who), c.sql) AS actual
  FROM cases c
 CROSS JOIN (VALUES ('owner', 4), ('admin', 3), ('accountant', 2), ('employee', 1), ('viewer', 0),
                    ('pending_admin', NULL), ('outsider', NULL)) AS u(who, rank);

-- Reads are unchanged: every accepted member, including viewers, still sees the books; outsiders see nothing.
CREATE TEMP TABLE reads AS
SELECT u.who,
       (SELECT pg_temp.probe(pg_temp.id(u.who), format('SELECT 1 FROM public.suppliers WHERE id = %L', pg_temp.id('supplier')))) AS supplier,
       (SELECT pg_temp.probe(pg_temp.id(u.who), format('SELECT 1 FROM public.bills WHERE id = %L', pg_temp.id('bill')))) AS bill
  FROM (VALUES ('viewer'), ('employee'), ('owner'), ('pending_admin'), ('outsider')) AS u(who);

-- Same-organisation links hold even for the table owner and the service role (triggers run for every role).
CREATE TEMP TABLE links (name text, actual text);
DO $$
BEGIN
  BEGIN
    INSERT INTO public.payment_run_items (payment_run_id, organization_id, bill_id, amount_cents, payee_bsb, payee_account_number, payee_account_name)
      VALUES (pg_temp.id('run'), pg_temp.id('org_a'), pg_temp.id('bill_b'), 1, '062-000', '1', 'x');
    INSERT INTO links VALUES ('payment run item -> other org bill', 'allowed');
  EXCEPTION WHEN insufficient_privilege THEN INSERT INTO links VALUES ('payment run item -> other org bill', 'denied');
  END;
  BEGIN
    INSERT INTO public.pay_slips (organization_id, pay_run_id, employee_id, net_pay_cents)
      VALUES (pg_temp.id('org_b'), pg_temp.id('pay_run_b'), pg_temp.id('employee_row'), 1);
    INSERT INTO links VALUES ('pay slip -> other org employee', 'allowed');
  EXCEPTION WHEN insufficient_privilege THEN INSERT INTO links VALUES ('pay slip -> other org employee', 'denied');
  END;
  BEGIN
    INSERT INTO public.pay_slips (organization_id, pay_run_id, employee_id, net_pay_cents)
      VALUES (pg_temp.id('org_b'), pg_temp.id('pay_run_b'), pg_temp.id('employee_b'), 1);
    INSERT INTO links VALUES ('pay slip -> own org employee', 'allowed');
  EXCEPTION WHEN insufficient_privilege THEN INSERT INTO links VALUES ('pay slip -> own org employee', 'denied');
  END;
END $$;

DO $$
DECLARE
  r record;
  bad text := '';
  total int;
BEGIN
  SELECT count(*) INTO total FROM results;
  FOR r IN SELECT * FROM results WHERE actual IS DISTINCT FROM expected ORDER BY tbl, op, who LOOP
    bad := bad || format(E'\n  %s %s as %s: expected %s, got %s', r.tbl, r.op, r.who, r.expected, r.actual);
  END LOOP;
  FOR r IN SELECT * FROM reads LOOP
    IF (r.who IN ('pending_admin', 'outsider')) <> (r.supplier = 'none' AND r.bill = 'none')
       OR (r.who NOT IN ('pending_admin', 'outsider') AND (r.supplier <> 'ok' OR r.bill <> 'ok')) THEN
      bad := bad || format(E'\n  read as %s: supplier %s, bill %s', r.who, r.supplier, r.bill);
    END IF;
  END LOOP;
  FOR r IN SELECT * FROM links LOOP
    IF (r.name LIKE '%other org%' AND r.actual <> 'denied') OR (r.name LIKE '%own org%' AND r.actual <> 'allowed') THEN
      bad := bad || format(E'\n  link %s: %s', r.name, r.actual);
    END IF;
  END LOOP;
  IF bad <> '' THEN
    RAISE EXCEPTION 'money-table role checks failed:%', bad;
  END IF;
  RAISE NOTICE 'money-table roles: % write probes, % read probes and % link checks as expected', total, (SELECT count(*) FROM reads), (SELECT count(*) FROM links);
END $$;

ROLLBACK;
