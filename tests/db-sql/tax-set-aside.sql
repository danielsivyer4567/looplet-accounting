-- TAX-01: the dashboard tax set-aside is a percentage of GST-exclusive net profit for one Australian financial year.
-- Run with: node scripts/db/run-pg-sql-tests.mjs tests/db-sql/tax-set-aside.sql
--
-- Setup runs as postgres; the P&L view is read as the org owner (authenticated) so RLS and grants apply. Dates are
-- placed relative to the current FY (1 July, today in Brisbane for this QLD org), so the test holds on any run date.
-- Each check records (name, got, want); one exception at the end lists every mismatch.

BEGIN;

CREATE FUNCTION pg_temp.as_user(p_user uuid, p_sql text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  result jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    EXECUTE p_sql INTO result;
  EXCEPTION WHEN others THEN
    result := jsonb_build_object('error', SQLSTATE || ' ' || SQLERRM);
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  RETURN result;
END $$;

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
INSERT INTO ids VALUES
  ('org', '0a000000-0000-4000-8000-0000000000f1'), ('owner', '1a000000-0000-4000-8000-0000000000f1'),
  ('cust', '2a000000-0000-4000-8000-0000000000f1'), ('supp', '3a000000-0000-4000-8000-0000000000f1'),
  ('inv_fy', '4a000000-0000-4000-8000-0000000000f1'), ('inv_prior', '4a000000-0000-4000-8000-0000000000f2'),
  ('bill_fy', '5a000000-0000-4000-8000-0000000000f1'), ('bill_prior', '5a000000-0000-4000-8000-0000000000f2'),
  ('bill_noise', '5a000000-0000-4000-8000-0000000000f3'),
  ('job', '6a000000-0000-4000-8000-0000000000f1'), ('emp', '7a000000-0000-4000-8000-0000000000f1');
CREATE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT v FROM ids WHERE k = p $$;

CREATE TEMP TABLE checks (name text, got text, want text);
CREATE FUNCTION pg_temp.check(p_name text, p_got anyelement, p_want anyelement) RETURNS void
LANGUAGE sql AS $$ INSERT INTO checks VALUES (p_name, p_got::text, p_want::text) $$;

-- Current FY start for a QLD org: 1 July of this year if today (Brisbane) is July or later, else last year.
CREATE TEMP TABLE fy AS
SELECT make_date(CASE WHEN extract(month FROM d) >= 7 THEN extract(year FROM d)::int ELSE extract(year FROM d)::int - 1 END, 7, 1) AS start_date
FROM (SELECT (now() AT TIME ZONE 'Australia/Brisbane')::date AS d) t;
CREATE FUNCTION pg_temp.in_fy(p_days int) RETURNS date LANGUAGE sql AS $$ SELECT start_date + p_days FROM fy $$;
CREATE FUNCTION pg_temp.prior_fy(p_days int) RETURNS date LANGUAGE sql AS $$ SELECT start_date - p_days FROM fy $$;

INSERT INTO auth.users (id, email, aud, role) VALUES (pg_temp.id('owner'), 'owner@example.test', 'authenticated', 'authenticated');
INSERT INTO public.organizations (id, name, settings) VALUES (pg_temp.id('org'), 'Set-aside Org', '{"tax_set_aside_pct": 25}');
INSERT INTO public.organization_memberships (user_id, organization_id, role, role_enum, accepted_at)
VALUES (pg_temp.id('owner'), pg_temp.id('org'), 'owner', 'owner', now());
INSERT INTO public.business_profile (organization_id, state_code) VALUES (pg_temp.id('org'), 'QLD');
INSERT INTO public.customers (id, organization_id, name) VALUES (pg_temp.id('cust'), pg_temp.id('org'), 'Customer');
INSERT INTO public.suppliers (id, organization_id, name) VALUES (pg_temp.id('supp'), pg_temp.id('org'), 'Supplier');
INSERT INTO public.jobs (id, organization_id, job_number, name) VALUES (pg_temp.id('job'), pg_temp.id('org'), 'J-1', 'Job 1');
INSERT INTO public.employees (id, organization_id, full_name) VALUES (pg_temp.id('emp'), pg_temp.id('org'), 'Worker');

-- This FY: invoice $10,000 + $1,000 GST; customer credit note $1,000 + $100 GST.
-- Prior FY: invoice $5,000 + $500 GST (excluded).
INSERT INTO public.invoices (id, organization_id, invoice_number, customer_id, issue_date, due_date, status) VALUES
  (pg_temp.id('inv_fy'), pg_temp.id('org'), 'INV-FY', pg_temp.id('cust'), pg_temp.in_fy(10), pg_temp.in_fy(24), 'sent'),
  (pg_temp.id('inv_prior'), pg_temp.id('org'), 'INV-PRIOR', pg_temp.id('cust'), pg_temp.prior_fy(30), pg_temp.prior_fy(16), 'sent');
INSERT INTO public.invoice_line_items (invoice_id, organization_id, line_number, description, unit_price_cents, gst_treatment,
                                       line_total_ex_gst_cents, line_gst_cents, line_total_inc_gst_cents) VALUES
  (pg_temp.id('inv_fy'), pg_temp.id('org'), 1, 'Work', 1000000, 'ex', 1000000, 100000, 1100000),
  (pg_temp.id('inv_prior'), pg_temp.id('org'), 1, 'Work', 500000, 'ex', 500000, 50000, 550000);
INSERT INTO public.customer_credit_notes (organization_id, credit_note_number, invoice_id, customer_id, customer_name,
                                          credit_note_date, subtotal_ex_gst_cents, gst_cents, total_inc_gst_cents, status)
VALUES (pg_temp.id('org'), 'CN-1', pg_temp.id('inv_fy'), pg_temp.id('cust'), 'Customer', pg_temp.in_fy(20), 100000, 10000, 110000, 'posted');

-- This FY: bill $3,000 + $300 GST; supplier credit note $300 + $30 GST; a classified non-bill (photo) with an amount.
-- Prior FY: bill $2,000 + $200 GST (excluded).
INSERT INTO public.bills (id, organization_id, supplier_id, source, storage_key, original_filename, mime_type, status,
                          invoice_number, invoice_date, subtotal_ex_gst_cents, gst_cents, total_inc_gst_cents, is_probable_bill) VALUES
  (pg_temp.id('bill_fy'), pg_temp.id('org'), pg_temp.id('supp'), 'manual_upload', 'f/1', 'b1.pdf', 'application/pdf', 'attached',
   'B-FY', pg_temp.in_fy(12), 300000, 30000, 330000, true),
  (pg_temp.id('bill_prior'), pg_temp.id('org'), pg_temp.id('supp'), 'manual_upload', 'f/2', 'b2.pdf', 'application/pdf', 'attached',
   'B-PRIOR', pg_temp.prior_fy(20), 200000, 20000, 220000, true),
  (pg_temp.id('bill_noise'), pg_temp.id('org'), pg_temp.id('supp'), 'manual_upload', 'f/3', 'photo.jpg', 'image/jpeg', 'received',
   'B-NOISE', pg_temp.in_fy(13), 90000, 9000, 99000, false);
INSERT INTO public.supplier_credit_notes (organization_id, credit_note_number, bill_id, supplier_id, supplier_name,
                                          credit_note_date, subtotal_ex_gst_cents, gst_cents, total_inc_gst_cents, status)
VALUES (pg_temp.id('org'), 'SCN-1', pg_temp.id('bill_fy'), pg_temp.id('supp'), 'Supplier', pg_temp.in_fy(25), 30000, 3000, 33000, 'posted');

-- Job wages: $2,000 this FY (8h x $250), $5,000 prior FY (8h x $625, excluded). Overhead: $500 this FY, $300 prior.
INSERT INTO public.timesheet_entries (organization_id, employee_id, job_id, work_date, hours, loaded_hourly_rate_cents) VALUES
  (pg_temp.id('org'), pg_temp.id('emp'), pg_temp.id('job'), pg_temp.in_fy(15), 8, 25000),
  (pg_temp.id('org'), pg_temp.id('emp'), pg_temp.id('job'), pg_temp.prior_fy(15), 8, 62500);
INSERT INTO public.overhead_allocations (organization_id, job_id, allocation_date, amount_cents) VALUES
  (pg_temp.id('org'), pg_temp.id('job'), pg_temp.in_fy(15), 50000),
  (pg_temp.id('org'), pg_temp.id('job'), pg_temp.prior_fy(15), 30000);

CREATE TEMP TABLE pnl AS
SELECT pg_temp.as_user(pg_temp.id('owner'), format(
  'SELECT to_jsonb(p) FROM public.v_organization_realtime_pnl p WHERE organization_id = %L', pg_temp.id('org'))) AS doc;
CREATE FUNCTION pg_temp.pnl(p_key text) RETURNS text LANGUAGE sql AS $$ SELECT doc ->> p_key FROM pnl $$;

SELECT pg_temp.check('read error', pg_temp.pnl('error'), NULL::text);
SELECT pg_temp.check('fy_start_date', pg_temp.pnl('fy_start_date'), (SELECT start_date::text FROM fy));
-- Revenue ex GST 10,000 - 1,000 = 9,000.00; bills ex GST 3,000 - 300 = 2,700.00; wages 2,000.00; overhead 500.00.
SELECT pg_temp.check('revenue_ex_gst_cents', pg_temp.pnl('revenue_ex_gst_cents'), '900000');
SELECT pg_temp.check('cost_bills_ex_gst_cents', pg_temp.pnl('cost_bills_ex_gst_cents'), '270000');
SELECT pg_temp.check('cost_wages_cents (this FY only)', pg_temp.pnl('cost_wages_cents'), '200000');
SELECT pg_temp.check('cost_overhead_cents (this FY only)', pg_temp.pnl('cost_overhead_cents'), '50000');
-- Net profit ex GST 9,000 - 2,700 - 2,000 - 500 = 3,800.00; 25% = 950.00.
SELECT pg_temp.check('net_profit_ex_gst_cents', pg_temp.pnl('net_profit_ex_gst_cents'), '380000');
SELECT pg_temp.check('tax_set_aside_cents = 25% of ex-GST FY profit', pg_temp.pnl('tax_set_aside_cents'), '95000');
-- GST owed this FY: (1,000 - 100) - (300 - 30) = 630.00. Gross (GST-inclusive) profit 9,900 - 2,970 - 2,500 = 4,430.00.
SELECT pg_temp.check('gst_set_aside_cents', pg_temp.pnl('gst_set_aside_cents'), '63000');
SELECT pg_temp.check('gross_profit_cents', pg_temp.pnl('gross_profit_cents'), '443000');
SELECT pg_temp.check('really_yours_cents = gross - GST - tax', pg_temp.pnl('really_yours_cents'), '285000');

-- A loss year sets nothing aside.
-- (Inserted rather than updated: UPDATE on overhead_allocations fails on its updated_at trigger, a separate defect.)
INSERT INTO public.overhead_allocations (organization_id, job_id, allocation_date, amount_cents)
VALUES (pg_temp.id('org'), pg_temp.id('job'), pg_temp.in_fy(16), 1000000);
SELECT pg_temp.check('loss year sets aside 0',
  pg_temp.as_user(pg_temp.id('owner'), format(
    'SELECT to_jsonb(tax_set_aside_cents) FROM public.v_organization_realtime_pnl WHERE organization_id = %L', pg_temp.id('org')))::text,
  '0');

DO $$
DECLARE
  bad text;
  n int;
BEGIN
  SELECT count(*), string_agg(format('%s: got %s, want %s', name, coalesce(got, 'NULL'), coalesce(want, 'NULL')), E'\n')
    INTO n, bad
    FROM checks WHERE got IS DISTINCT FROM want;
  IF n > 0 THEN
    RAISE EXCEPTION E'Tax set-aside: % of % checks failed:\n%', n, (SELECT count(*) FROM checks), bad;
  END IF;
  RAISE NOTICE 'Tax set-aside: % checks passed (GST-exclusive base, one financial year, credit notes, loss year)',
    (SELECT count(*) FROM checks);
END $$;

ROLLBACK;
