-- SEC-05: writes to money tables need a role; viewers, pending invitees and outsiders are read-only or locked out.
-- Run with: node scripts/db/run-pg-sql-tests.mjs tests/db-sql/money-table-roles.sql
--
-- Setup runs as postgres (table owner, so RLS does not apply). Each probe switches to the `authenticated` role with
-- the caller's JWT claims, runs one statement, records ok (rows changed), none (no rows visible to change) or denied
-- (RLS or same-org check), and always rolls the statement back so probes do not affect each other.
--
-- Callers: one user per role in org A; a pending admin; an outsider (owner of org B); an accepted admin of the agency
-- that org A is a sub-account of; an agency member whose role_enum was lowered to viewer (legacy role still admin);
-- and organisation-pinned machine tokens (no user, organization_id claim) for org A and org B, like the one
-- accruals-run mints to post journals.

BEGIN;

CREATE FUNCTION pg_temp.probe(p_claims jsonb, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  n bigint := 0;
  result text;
BEGIN
  -- Both forms: older auth.uid() reads request.jwt.claim.sub, newer reads request.jwt.claims.
  PERFORM set_config('request.jwt.claims', p_claims::text, true);
  PERFORM set_config('request.jwt.claim.sub', coalesce(p_claims->>'sub', ''), true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    EXECUTE p_sql;
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE EXCEPTION 'probe-rollback';
  EXCEPTION
    WHEN insufficient_privilege THEN result := 'denied';
    WHEN raise_exception THEN
      result := CASE WHEN SQLERRM = 'probe-rollback' THEN CASE WHEN n > 0 THEN 'ok' ELSE 'none' END
                     -- journal_lines' same-org trigger (0075) runs before RLS and refuses a line whose entry the
                     -- caller cannot see; that is a refusal too.
                     WHEN SQLERRM LIKE 'journal line references unknown entry%' THEN 'denied'
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
  ('outsider', '10000000-0000-4000-8000-000000000007'), ('agency_admin', '10000000-0000-4000-8000-000000000008'),
  ('agency', '0c000000-0000-4000-8000-000000000001'),
  ('conn', 'a0000000-0000-4000-8000-000000000001'), ('bank_account', 'a1000000-0000-4000-8000-000000000001'),
  ('coa', 'a2000000-0000-4000-8000-000000000001'), ('journal_l', 'a3000000-0000-4000-8000-000000000001'),
  ('line', 'a4000000-0000-4000-8000-000000000001'),
  ('agency_viewer', '10000000-0000-4000-8000-000000000009'),
  ('inv_line', 'a5000000-0000-4000-8000-000000000001'), ('payment', 'a5000000-0000-4000-8000-000000000002'),
  ('txn', 'a6000000-0000-4000-8000-000000000001'), ('bill_line', 'a7000000-0000-4000-8000-000000000001'),
  ('job', 'a8000000-0000-4000-8000-000000000001'), ('timesheet', 'a9000000-0000-4000-8000-000000000001'),
  ('super_line', 'aa000000-0000-4000-8000-000000000001'), ('wage', 'ab000000-0000-4000-8000-000000000001'),
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
CREATE FUNCTION pg_temp.claims(who text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT CASE who
    WHEN 'machine_a' THEN jsonb_build_object('role', 'authenticated', 'aud', 'authenticated', 'organization_id', pg_temp.id('org_a'))
    WHEN 'machine_b' THEN jsonb_build_object('role', 'authenticated', 'aud', 'authenticated', 'organization_id', pg_temp.id('org_b'))
    ELSE jsonb_build_object('sub', pg_temp.id(who), 'role', 'authenticated')
  END $$;

INSERT INTO auth.users (id, email, aud, role)
SELECT v, k || '@example.test', 'authenticated', 'authenticated' FROM ids
 WHERE k IN ('owner', 'admin', 'accountant', 'employee', 'viewer', 'pending_admin', 'outsider', 'agency_admin', 'agency_viewer');

INSERT INTO public.organizations (id, name, organization_type) VALUES (pg_temp.id('agency'), 'Agency', 'agency');
INSERT INTO public.organizations (id, name, organization_type, parent_organization_id)
  VALUES (pg_temp.id('org_a'), 'Org A', 'sub_account', pg_temp.id('agency'));
INSERT INTO public.organizations (id, name) VALUES (pg_temp.id('org_b'), 'Org B');

INSERT INTO public.organization_memberships (user_id, organization_id, role, role_enum, accepted_at) VALUES
  (pg_temp.id('owner'),         pg_temp.id('org_a'), 'owner',  'owner',      now()),
  (pg_temp.id('admin'),         pg_temp.id('org_a'), 'admin',  'admin',      now()),
  (pg_temp.id('accountant'),    pg_temp.id('org_a'), 'member', 'accountant', now()),
  (pg_temp.id('employee'),      pg_temp.id('org_a'), 'member', 'employee',   now()),
  (pg_temp.id('viewer'),        pg_temp.id('org_a'), 'member', 'viewer',     now()),
  (pg_temp.id('pending_admin'), pg_temp.id('org_a'), 'admin',  'admin',      NULL),
  (pg_temp.id('outsider'),      pg_temp.id('org_b'), 'owner',  'owner',      now()),
  (pg_temp.id('agency_admin'),  pg_temp.id('agency'), 'admin', 'admin',      now()),
  -- Lowered to viewer in role_enum (the column every role check reads); the legacy column still says admin.
  (pg_temp.id('agency_viewer'), pg_temp.id('agency'), 'admin', 'viewer',     now());

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
INSERT INTO public.journal_entries (id, organization_id) VALUES (pg_temp.id('journal_l'), pg_temp.id('org_a'));
INSERT INTO public.chart_of_accounts (id, organization_id, code, name, account_type)
  VALUES (pg_temp.id('coa'), pg_temp.id('org_a'), '6100', 'Materials', 'expense');
INSERT INTO public.journal_lines (id, journal_entry_id, account_id, debit_cents) VALUES (pg_temp.id('line'), pg_temp.id('journal_l'), pg_temp.id('coa'), 1000);
INSERT INTO public.bank_connections (id, organization_id, provider, encrypted_access_token)
  VALUES (pg_temp.id('conn'), pg_temp.id('org_a'), 'manual', 'x');
INSERT INTO public.bank_accounts (id, organization_id, bank_connection_id, external_id, name)
  VALUES (pg_temp.id('bank_account'), pg_temp.id('org_a'), pg_temp.id('conn'), 'acct-1', 'Everyday');
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

-- Adjacent tables whose writes flow into invoices, bills and the bank: lines, payments, transactions, time and pay.
INSERT INTO public.invoice_line_items (id, invoice_id, organization_id, line_number, description, unit_price_cents, line_total_ex_gst_cents, line_total_inc_gst_cents)
  VALUES (pg_temp.id('inv_line'), pg_temp.id('invoice'), pg_temp.id('org_a'), 1, 'Fence panels', 9091, 9091, 10000);
INSERT INTO public.bank_transactions (id, organization_id, bank_account_id, external_id, posted_at, description, amount_cents)
  VALUES (pg_temp.id('txn'), pg_temp.id('org_a'), pg_temp.id('bank_account'), 'txn-1', now(), 'Customer payment', 10000);
INSERT INTO public.bill_line_items (id, organization_id, bill_id, line_number, description)
  VALUES (pg_temp.id('bill_line'), pg_temp.id('org_a'), pg_temp.id('bill'), 1, 'Posts');
INSERT INTO public.jobs (id, organization_id, job_number, name) VALUES (pg_temp.id('job'), pg_temp.id('org_a'), 'J-1', 'Back fence');
INSERT INTO public.timesheet_entries (id, organization_id, employee_id, work_date, hours)
  VALUES (pg_temp.id('timesheet'), pg_temp.id('org_a'), pg_temp.id('employee_row'), DATE '2030-01-06', 7.6);
INSERT INTO public.super_batch_lines (id, batch_id, organization_id, employee_id, employee_name, super_cents)
  VALUES (pg_temp.id('super_line'), pg_temp.id('super'), pg_temp.id('org_a'), pg_temp.id('employee_row'), 'Staff Member', 12000);

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
  ('journal_lines', 'insert', 'accountant', format('INSERT INTO public.journal_lines (journal_entry_id, account_id, credit_cents) VALUES (%L, %L, 1000)', pg_temp.id('journal_l'), pg_temp.id('coa'))),
  ('journal_lines', 'update', 'accountant', format('UPDATE public.journal_lines SET account_id = account_id WHERE id = %L', pg_temp.id('line'))),
  ('journal_lines', 'delete', 'accountant', format('DELETE FROM public.journal_lines WHERE id = %L', pg_temp.id('line'))),
  ('bank_accounts', 'insert', 'accountant', format('INSERT INTO public.bank_accounts (organization_id, bank_connection_id, external_id, name) VALUES (%L, %L, %L, %L)',
     pg_temp.id('org_a'), pg_temp.id('conn'), 'acct-2', 'Savings')),
  ('bank_accounts', 'update', 'accountant', format('UPDATE public.bank_accounts SET name = %L WHERE id = %L', 'Renamed', pg_temp.id('bank_account'))),
  ('bank_accounts', 'delete', NULL, format('DELETE FROM public.bank_accounts WHERE id = %L', pg_temp.id('bank_account'))),
  ('invoice_line_items', 'insert', 'accountant', format('INSERT INTO public.invoice_line_items (invoice_id, organization_id, line_number, description, unit_price_cents, line_total_ex_gst_cents, line_total_inc_gst_cents) VALUES (%L, %L, 2, %L, 100, 100, 110)',
     pg_temp.id('invoice'), pg_temp.id('org_a'), 'Extra')),
  ('invoice_line_items', 'update', 'accountant', format('UPDATE public.invoice_line_items SET unit_price_cents = 1, line_total_ex_gst_cents = 1, line_total_inc_gst_cents = 1 WHERE id = %L', pg_temp.id('inv_line'))),
  ('invoice_line_items', 'delete', 'accountant', format('DELETE FROM public.invoice_line_items WHERE id = %L', pg_temp.id('inv_line'))),
  ('invoice_payments', 'insert', 'accountant', format('INSERT INTO public.invoice_payments (organization_id, invoice_id, amount_cents) VALUES (%L, %L, 5000)', pg_temp.id('org_a'), pg_temp.id('invoice'))),
  ('bank_transactions', 'insert', 'accountant', format('INSERT INTO public.bank_transactions (organization_id, bank_account_id, external_id, posted_at, description, amount_cents) VALUES (%L, %L, %L, now(), %L, -500)',
     pg_temp.id('org_a'), pg_temp.id('bank_account'), 'txn-2', 'Fuel')),
  ('bank_transactions', 'update', 'accountant', format('UPDATE public.bank_transactions SET matched_invoice_id = %L WHERE id = %L', pg_temp.id('invoice'), pg_temp.id('txn'))),
  ('bill_line_items', 'insert', 'employee', format('INSERT INTO public.bill_line_items (organization_id, bill_id, line_number, description) VALUES (%L, %L, 2, %L)', pg_temp.id('org_a'), pg_temp.id('bill'), 'Rails')),
  ('bill_line_items', 'update', 'accountant', format('UPDATE public.bill_line_items SET description = %L WHERE id = %L', 'Renamed', pg_temp.id('bill_line'))),
  ('chart_of_accounts', 'insert', 'accountant', format('INSERT INTO public.chart_of_accounts (organization_id, code, name, account_type) VALUES (%L, %L, %L, %L)', pg_temp.id('org_a'), '6200', 'Fuel', 'expense')),
  ('chart_of_accounts', 'update', 'accountant', format('UPDATE public.chart_of_accounts SET name = %L WHERE id = %L', 'Materials and supplies', pg_temp.id('coa'))),
  ('jobs', 'insert', 'employee', format('INSERT INTO public.jobs (organization_id, job_number, name) VALUES (%L, %L, %L)', pg_temp.id('org_a'), 'J-2', 'Side fence')),
  ('jobs', 'update', 'employee', format('UPDATE public.jobs SET name = %L WHERE id = %L', 'Back fence (stage 2)', pg_temp.id('job'))),
  ('timesheet_entries', 'insert', 'employee', format('INSERT INTO public.timesheet_entries (organization_id, employee_id, work_date, hours) VALUES (%L, %L, %L, 4)', pg_temp.id('org_a'), pg_temp.id('employee_row'), DATE '2030-01-07')),
  ('timesheet_entries', 'update', 'employee', format('UPDATE public.timesheet_entries SET hours = 8 WHERE id = %L', pg_temp.id('timesheet'))),
  ('super_batch_lines', 'insert', 'admin', format('INSERT INTO public.super_batch_lines (batch_id, organization_id, employee_id, employee_name, super_cents) VALUES (%L, %L, %L, %L, 1)', pg_temp.id('super'), pg_temp.id('org_a'), pg_temp.id('employee_row'), 'Staff Member')),
  ('super_batch_lines', 'delete', 'admin', format('DELETE FROM public.super_batch_lines WHERE id = %L', pg_temp.id('super_line'))),
  ('wage_entries', 'insert', 'admin', format('INSERT INTO public.wage_entries (organization_id, employee_id, work_date, start_at, end_at, hours, loaded_hourly_rate_at_time_cents, total_cost_cents) VALUES (%L, %L, %L, %L, %L, 7.6, 5445, 41382)',
     pg_temp.id('org_a'), pg_temp.id('employee_row'), DATE '2030-01-06', TIMESTAMPTZ '2030-01-06 07:00+10', TIMESTAMPTZ '2030-01-06 15:06+10')),
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

-- Expected: an accepted member at or above the minimum role succeeds, as does an agency admin (admin-level) and the
-- organisation's own machine token (any write the permissive policies allow); everyone else is refused. A refused insert
-- raises an RLS error ('denied'); a refused update or delete sees no rows ('none'). A NULL minimum role means no one
-- may do it: bills, suppliers, customers, period locks and employees have no DELETE policy (they are soft-deleted).
CREATE TEMP TABLE results AS
SELECT c.tbl, c.op, u.who,
       CASE WHEN c.min_role IS NOT NULL AND u.rank IS NOT NULL AND u.rank >= (SELECT rank FROM ranks WHERE role = c.min_role) THEN 'ok'
            WHEN c.op = 'insert' THEN 'denied' ELSE 'none' END AS expected,
       pg_temp.probe(pg_temp.claims(u.who), c.sql) AS actual
  FROM cases c
 CROSS JOIN (VALUES ('owner', 4), ('admin', 3), ('accountant', 2), ('employee', 1), ('viewer', 0),
                    ('pending_admin', NULL), ('outsider', NULL), ('agency_admin', 3), ('agency_viewer', NULL),
                    ('machine_a', 99), ('machine_b', NULL)) AS u(who, rank);

-- Reads are unchanged: every accepted member (viewers included), the agency admin and org A's machine token still see
-- the books; pending invitees, outsiders and another organisation's machine token see nothing.
CREATE TEMP TABLE reads AS
SELECT u.who,
       (SELECT pg_temp.probe(pg_temp.claims(u.who), format('SELECT 1 FROM public.suppliers WHERE id = %L', pg_temp.id('supplier')))) AS supplier,
       (SELECT pg_temp.probe(pg_temp.claims(u.who), format('SELECT 1 FROM public.bills WHERE id = %L', pg_temp.id('bill')))) AS bill
  FROM (VALUES ('viewer'), ('employee'), ('owner'), ('agency_admin'), ('machine_a'), ('pending_admin'), ('outsider'),
               ('machine_b')) AS u(who);

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

-- Catalog audit: every organisation-scoped table any accepted member can write must carry the three restrictive
-- can_write_org policies, unless it is one of the deliberately open operational tables listed here.
CREATE TEMP TABLE open_tables (relname text PRIMARY KEY);
INSERT INTO open_tables VALUES
  ('organizations'), ('accountant_sessions'), ('accountant_activity_log'), ('notifications'), ('data_completeness_findings'),
  ('staged_entities'), ('receipt_identities'), ('tag_attachments'), ('tag_drafts'), ('tag_rate_limits'), ('tag_replies'), ('tag_staff'), ('tags'),
  ('automation_artifacts'), ('automation_dead_letters'), ('automation_decisions'), ('automation_feedback'), ('automation_job_steps'), ('automation_jobs'),
  ('confidence_policies'), ('xero_sync_log');
CREATE TEMP TABLE audit AS
SELECT c.relname,
       bool_or(p.permissive = 'RESTRICTIVE' AND (coalesce(p.qual,'') || coalesce(p.with_check,'')) ~ 'can_write_org') AS guarded
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_policies p ON p.schemaname = 'public' AND p.tablename = c.relname
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
   AND has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE')
   AND EXISTS (SELECT 1 FROM information_schema.columns ic WHERE ic.table_schema = 'public' AND ic.table_name = c.relname AND ic.column_name = 'organization_id')
   AND EXISTS (SELECT 1 FROM pg_policies q WHERE q.schemaname = 'public' AND q.tablename = c.relname AND q.permissive = 'PERMISSIVE'
                 AND q.cmd IN ('INSERT','UPDATE','DELETE','ALL')
                 AND NOT (coalesce(q.qual,'') || coalesce(q.with_check,'')) ~* 'require_role|can_write_org|service_role')
   AND c.relname NOT IN (SELECT relname FROM open_tables)
 GROUP BY c.relname;

DO $$
DECLARE
  r record;
  bad text := '';
  total int;
BEGIN
  SELECT count(*) INTO total FROM results;
  FOR r IN SELECT * FROM audit WHERE NOT coalesce(guarded, false) ORDER BY relname LOOP
    bad := bad || format(E'\n  audit: any accepted member can write %s (no can_write_org policy)', r.relname);
  END LOOP;
  FOR r IN SELECT * FROM results WHERE actual IS DISTINCT FROM expected ORDER BY tbl, op, who LOOP
    bad := bad || format(E'\n  %s %s as %s: expected %s, got %s', r.tbl, r.op, r.who, r.expected, r.actual);
  END LOOP;
  FOR r IN SELECT * FROM reads LOOP
    IF (r.who IN ('pending_admin', 'outsider', 'machine_b')) <> (r.supplier = 'none' AND r.bill = 'none')
       OR (r.who NOT IN ('pending_admin', 'outsider', 'machine_b') AND (r.supplier <> 'ok' OR r.bill <> 'ok')) THEN
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
  RAISE NOTICE 'money-table roles: % write probes, % read probes, % link checks and % audited tables as expected',
    total, (SELECT count(*) FROM reads), (SELECT count(*) FROM links), (SELECT count(*) FROM audit);
END $$;

ROLLBACK;
