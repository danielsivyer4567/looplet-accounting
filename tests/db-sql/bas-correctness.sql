-- BAS-01: BAS labels include credit notes, follow the organisation's GST accounting basis (accruals or cash), and
-- leave W3/W4 blank instead of reporting invented zeros.
-- Run with: node scripts/db/run-pg-sql-tests.mjs tests/db-sql/bas-correctness.sql
--
-- Setup runs as postgres. Every BAS read runs as the `authenticated` role with an owner's JWT claims, so grants and
-- RLS on the new view and functions are exercised too. Each check records (name, got, want); one exception at the
-- end lists every mismatch.
--
-- ATO rules under test (fetched 2026-10-03):
--   cash vs non-cash attribution: https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/accounting-for-gst-in-your-business/choosing-an-accounting-method
--   same-period changes vs adjustments: https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/completing-your-bas-for-gst/making-adjustments-on-your-activity-statements/when-to-make-adjustments
--   accounts method, increasing at 1A / decreasing at 1B: https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/completing-your-bas-for-gst/making-adjustments-on-your-activity-statements/how-to-make-adjustments
--   W3/W4 left blank when nothing to report: https://www.ato.gov.au/businesses-and-organisations/preparing-lodging-and-paying/business-activity-statements-bas/pay-as-you-go-payg-withholding

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
    -- Recorded, not raised, so one run reports every failing check.
    result := jsonb_build_object('error', SQLSTATE || ' ' || SQLERRM);
  END;
  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  RETURN result;
END $$;

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
INSERT INTO ids VALUES
  ('org_a', '0a000000-0000-4000-8000-0000000000a1'), ('org_c', '0c000000-0000-4000-8000-0000000000c1'),
  ('org_b', '0b000000-0000-4000-8000-0000000000b1'),
  ('owner_a', '1a000000-0000-4000-8000-000000000001'), ('owner_c', '1c000000-0000-4000-8000-000000000001'),
  ('outsider', '1b000000-0000-4000-8000-000000000001'),
  ('cust_a', '2a000000-0000-4000-8000-000000000001'), ('cust_c', '2c000000-0000-4000-8000-000000000001'),
  ('supp_a', '3a000000-0000-4000-8000-000000000001'), ('supp_c', '3c000000-0000-4000-8000-000000000001'),
  ('inv_a1', '4a000000-0000-4000-8000-000000000001'),
  ('inv_c1', '4c000000-0000-4000-8000-000000000001'), ('inv_c2', '4c000000-0000-4000-8000-000000000002'),
  ('inv_c3', '4c000000-0000-4000-8000-000000000003'), ('inv_c4', '4c000000-0000-4000-8000-000000000004'),
  ('bill_a1', '5a000000-0000-4000-8000-000000000001'), ('bill_a2', '5a000000-0000-4000-8000-000000000002'),
  ('bill_a3', '5a000000-0000-4000-8000-000000000003'),
  ('bill_c1', '5c000000-0000-4000-8000-000000000001'), ('bill_c2', '5c000000-0000-4000-8000-000000000002'),
  ('bill_c3', '5c000000-0000-4000-8000-000000000003'),
  ('conn_a', '6a000000-0000-4000-8000-000000000001'), ('acct_a', '6a000000-0000-4000-8000-000000000002'),
  ('tx_a', '6a000000-0000-4000-8000-000000000003');
CREATE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT v FROM ids WHERE k = p $$;

CREATE TEMP TABLE checks (name text, got text, want text);
CREATE FUNCTION pg_temp.check(p_name text, p_got anyelement, p_want anyelement) RETURNS void
LANGUAGE sql AS $$ INSERT INTO checks VALUES (p_name, p_got::text, p_want::text) $$;

INSERT INTO auth.users (id, email, aud, role)
SELECT v, k || '@example.test', 'authenticated', 'authenticated' FROM ids WHERE k IN ('owner_a', 'owner_c', 'outsider');
INSERT INTO public.organizations (id, name) VALUES
  (pg_temp.id('org_a'), 'Accruals Org'), (pg_temp.id('org_c'), 'Cash Org'), (pg_temp.id('org_b'), 'Outsider Org');
INSERT INTO public.organization_memberships (user_id, organization_id, role, role_enum, accepted_at) VALUES
  (pg_temp.id('owner_a'), pg_temp.id('org_a'), 'owner', 'owner', now()),
  (pg_temp.id('owner_c'), pg_temp.id('org_c'), 'owner', 'owner', now()),
  (pg_temp.id('outsider'), pg_temp.id('org_b'), 'owner', 'owner', now());

-- Org A has no business_profile row: accruals by default. Org C chose the cash basis and is in Queensland.
INSERT INTO public.business_profile (organization_id, state_code, is_gst_registered, gst_accounting_basis, is_paygi_registered)
VALUES (pg_temp.id('org_c'), 'QLD', true, 'cash', true);

INSERT INTO public.customers (id, organization_id, name) VALUES
  (pg_temp.id('cust_a'), pg_temp.id('org_a'), 'Customer A'), (pg_temp.id('cust_c'), pg_temp.id('org_c'), 'Customer C');
INSERT INTO public.suppliers (id, organization_id, name) VALUES
  (pg_temp.id('supp_a'), pg_temp.id('org_a'), 'Supplier A'), (pg_temp.id('supp_c'), pg_temp.id('org_c'), 'Supplier C');

-- ---------------------------------------------------------------------------------------------------------------
-- Org A (accruals), FY2030. Q1 = Jul-Sep 2030, Q2 = Oct-Dec 2030.
-- INV-A1 (10 Jul): $1,100 taxable ($100 GST) + $500 GST-free = $1,600.
--   CN-A1 1 Aug  $220 ($20 GST)  same quarter  -> G1 -220, 1A -20
--   CN-A2 5 Nov  $110 ($10 GST)  later quarter -> Q2 decreasing adjustment, 1B +10
--   CN-A3 draft and CN-A4 void   -> ignored
-- BILL-A1 (15 Jul): $770 ($70 GST), non-capital.
--   SCN-A1 1 Sep  $110 ($10 GST) same quarter  -> G11 -110, 1B -10
--   SCN-A2 20 Oct $55 ($5 GST)   later quarter -> Q2 increasing adjustment, 1A +5
-- BILL-A2 (20 Aug): $2,200 ($200 GST) motor vehicle -> G10.
-- BILL-A3 (20 Jul): $330 void -> ignored.
-- ---------------------------------------------------------------------------------------------------------------
INSERT INTO public.invoices (id, organization_id, invoice_number, customer_id, issue_date, due_date, status)
VALUES (pg_temp.id('inv_a1'), pg_temp.id('org_a'), 'INV-A1', pg_temp.id('cust_a'), DATE '2030-07-10', DATE '2030-07-24', 'sent');
INSERT INTO public.invoice_line_items (invoice_id, organization_id, line_number, description, unit_price_cents, gst_treatment,
                                       line_total_ex_gst_cents, line_gst_cents, line_total_inc_gst_cents, account_code) VALUES
  (pg_temp.id('inv_a1'), pg_temp.id('org_a'), 1, 'Fencing', 100000, 'ex',   100000, 10000, 110000, '4000'),
  (pg_temp.id('inv_a1'), pg_temp.id('org_a'), 2, 'Exempt',   50000, 'free',  50000,     0,  50000, '4000');

INSERT INTO public.customer_credit_notes (organization_id, credit_note_number, invoice_id, customer_id, customer_name,
                                          credit_note_date, subtotal_ex_gst_cents, gst_cents, total_inc_gst_cents, status) VALUES
  (pg_temp.id('org_a'), 'CN-A1', pg_temp.id('inv_a1'), pg_temp.id('cust_a'), 'Customer A', DATE '2030-08-01', 20000, 2000, 22000, 'posted'),
  (pg_temp.id('org_a'), 'CN-A2', pg_temp.id('inv_a1'), pg_temp.id('cust_a'), 'Customer A', DATE '2030-11-05', 10000, 1000, 11000, 'posted'),
  (pg_temp.id('org_a'), 'CN-A3', pg_temp.id('inv_a1'), pg_temp.id('cust_a'), 'Customer A', DATE '2030-08-02',  5000,  500,  5500, 'draft'),
  (pg_temp.id('org_a'), 'CN-A4', pg_temp.id('inv_a1'), pg_temp.id('cust_a'), 'Customer A', DATE '2030-08-03',  5000,  500,  5500, 'void');

INSERT INTO public.bills (id, organization_id, supplier_id, source, storage_key, original_filename, mime_type, status,
                          invoice_number, invoice_date, subtotal_ex_gst_cents, gst_cents, total_inc_gst_cents,
                          auto_category_code, paid_at) VALUES
  (pg_temp.id('bill_a1'), pg_temp.id('org_a'), pg_temp.id('supp_a'), 'manual_upload', 'a/1', 'a1.pdf', 'application/pdf',
   'attached', 'BILL-A1', DATE '2030-07-15',  70000,  7000,  77000, NULL, NULL),
  (pg_temp.id('bill_a2'), pg_temp.id('org_a'), pg_temp.id('supp_a'), 'manual_upload', 'a/2', 'a2.pdf', 'application/pdf',
   'attached', 'BILL-A2', DATE '2030-08-20', 200000, 20000, 220000, 'motor_vehicle', NULL),
  (pg_temp.id('bill_a3'), pg_temp.id('org_a'), pg_temp.id('supp_a'), 'manual_upload', 'a/3', 'a3.pdf', 'application/pdf',
   'void', 'BILL-A3', DATE '2030-07-20',  30000,  3000,  33000, NULL, NULL);

INSERT INTO public.supplier_credit_notes (organization_id, credit_note_number, bill_id, supplier_id, supplier_name,
                                          credit_note_date, subtotal_ex_gst_cents, gst_cents, total_inc_gst_cents, status) VALUES
  (pg_temp.id('org_a'), 'SCN-A1', pg_temp.id('bill_a1'), pg_temp.id('supp_a'), 'Supplier A', DATE '2030-09-01', 10000, 1000, 11000, 'posted'),
  (pg_temp.id('org_a'), 'SCN-A2', pg_temp.id('bill_a1'), pg_temp.id('supp_a'), 'Supplier A', DATE '2030-10-20',  5000,  500,  5500, 'posted');

-- ---------------------------------------------------------------------------------------------------------------
-- Org C (cash, QLD = Australia/Brisbane, UTC+10), FY2030.
-- INV-C1 (5 Jul) $1,100: $440 paid 10 Aug (Q1), $660 paid 3 Oct (Q2).
-- INV-C2 (20 Sep) $2,200 unpaid -> not reported.
-- INV-C3 (25 Sep) $110 paid 2030-09-30 15:30 UTC = 1 Oct 01:30 Brisbane -> Q2.
--   CN-C1 10 Oct $11 after full payment -> needs review (refund not recorded), labels unchanged.
-- INV-C4 (1 Aug) $1,100 taxable + $500 GST-free; CN-C2 5 Aug credits the $500 GST-free part; customer pays $1,100 on
--   20 Aug -> G1 1100, 1A 100, G3 0 (amended price).
-- BILL-C1 (20 Jul) $330 paid 15 Oct -> Q2.
-- BILL-C2 (1 Aug) $550 with SCN-C1 $110 on 15 Aug, paid 10 Sep -> Q1 G11 440, 1B 40.
-- BILL-C3 (2 Aug) $11 unpaid -> not reported.
-- ---------------------------------------------------------------------------------------------------------------
INSERT INTO public.invoices (id, organization_id, invoice_number, customer_id, issue_date, due_date, status) VALUES
  (pg_temp.id('inv_c1'), pg_temp.id('org_c'), 'INV-C1', pg_temp.id('cust_c'), DATE '2030-07-05', DATE '2030-07-19', 'sent'),
  (pg_temp.id('inv_c2'), pg_temp.id('org_c'), 'INV-C2', pg_temp.id('cust_c'), DATE '2030-09-20', DATE '2030-10-04', 'sent'),
  (pg_temp.id('inv_c3'), pg_temp.id('org_c'), 'INV-C3', pg_temp.id('cust_c'), DATE '2030-09-25', DATE '2030-10-09', 'sent'),
  (pg_temp.id('inv_c4'), pg_temp.id('org_c'), 'INV-C4', pg_temp.id('cust_c'), DATE '2030-08-01', DATE '2030-08-15', 'sent');
INSERT INTO public.invoice_line_items (invoice_id, organization_id, line_number, description, unit_price_cents, gst_treatment,
                                       line_total_ex_gst_cents, line_gst_cents, line_total_inc_gst_cents, account_code) VALUES
  (pg_temp.id('inv_c1'), pg_temp.id('org_c'), 1, 'Work',   100000, 'ex',   100000, 10000, 110000, '4000'),
  (pg_temp.id('inv_c2'), pg_temp.id('org_c'), 1, 'Work',   200000, 'ex',   200000, 20000, 220000, '4000'),
  (pg_temp.id('inv_c3'), pg_temp.id('org_c'), 1, 'Work',    10000, 'ex',    10000,  1000,  11000, '4000'),
  (pg_temp.id('inv_c4'), pg_temp.id('org_c'), 1, 'Work',   100000, 'ex',   100000, 10000, 110000, '4000'),
  (pg_temp.id('inv_c4'), pg_temp.id('org_c'), 2, 'Exempt',  50000, 'free',  50000,     0,  50000, '4000');
INSERT INTO public.invoice_payments (organization_id, invoice_id, paid_at, amount_cents) VALUES
  (pg_temp.id('org_c'), pg_temp.id('inv_c1'), TIMESTAMPTZ '2030-08-10 02:00:00+00',  44000),
  (pg_temp.id('org_c'), pg_temp.id('inv_c1'), TIMESTAMPTZ '2030-10-03 02:00:00+00',  66000),
  (pg_temp.id('org_c'), pg_temp.id('inv_c3'), TIMESTAMPTZ '2030-09-30 15:30:00+00',  11000);
INSERT INTO public.customer_credit_notes (organization_id, credit_note_number, invoice_id, customer_id, customer_name,
                                          credit_note_date, subtotal_ex_gst_cents, gst_cents, total_inc_gst_cents, status) VALUES
  (pg_temp.id('org_c'), 'CN-C1', pg_temp.id('inv_c3'), pg_temp.id('cust_c'), 'Customer C', DATE '2030-10-10',  1000, 100,  1100, 'posted'),
  (pg_temp.id('org_c'), 'CN-C2', pg_temp.id('inv_c4'), pg_temp.id('cust_c'), 'Customer C', DATE '2030-08-05', 50000,   0, 50000, 'posted');
INSERT INTO public.invoice_payments (organization_id, invoice_id, paid_at, amount_cents) VALUES
  (pg_temp.id('org_c'), pg_temp.id('inv_c4'), TIMESTAMPTZ '2030-08-20 02:00:00+00', 110000);

INSERT INTO public.bills (id, organization_id, supplier_id, source, storage_key, original_filename, mime_type, status,
                          invoice_number, invoice_date, subtotal_ex_gst_cents, gst_cents, total_inc_gst_cents, paid_at) VALUES
  (pg_temp.id('bill_c1'), pg_temp.id('org_c'), pg_temp.id('supp_c'), 'manual_upload', 'c/1', 'c1.pdf', 'application/pdf',
   'paid', 'BILL-C1', DATE '2030-07-20', 30000, 3000, 33000, TIMESTAMPTZ '2030-10-15 02:00:00+00'),
  (pg_temp.id('bill_c2'), pg_temp.id('org_c'), pg_temp.id('supp_c'), 'manual_upload', 'c/2', 'c2.pdf', 'application/pdf',
   'paid', 'BILL-C2', DATE '2030-08-01', 50000, 5000, 55000, TIMESTAMPTZ '2030-09-10 02:00:00+00'),
  (pg_temp.id('bill_c3'), pg_temp.id('org_c'), pg_temp.id('supp_c'), 'manual_upload', 'c/3', 'c3.pdf', 'application/pdf',
   'attached', 'BILL-C3', DATE '2030-08-02', 1000, 100, 1100, NULL);
INSERT INTO public.supplier_credit_notes (organization_id, credit_note_number, bill_id, supplier_id, supplier_name,
                                          credit_note_date, subtotal_ex_gst_cents, gst_cents, total_inc_gst_cents, status) VALUES
  (pg_temp.id('org_c'), 'SCN-C1', pg_temp.id('bill_c2'), pg_temp.id('supp_c'), 'Supplier C', DATE '2030-08-15', 10000, 1000, 11000, 'posted');

-- ---------------------------------------------------------------------------------------------------------------
-- Worksheets, read as each org's owner.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TEMP TABLE ws (k text PRIMARY KEY, doc jsonb);
INSERT INTO ws VALUES
  ('a_q1', pg_temp.as_user(pg_temp.id('owner_a'), format('SELECT public.generate_bas_worksheet(%L, 2030, 1)', pg_temp.id('org_a')))),
  ('a_q2', pg_temp.as_user(pg_temp.id('owner_a'), format('SELECT public.generate_bas_worksheet(%L, 2030, 2)', pg_temp.id('org_a')))),
  ('c_q1', pg_temp.as_user(pg_temp.id('owner_c'), format('SELECT public.generate_bas_worksheet(%L, 2030, 1)', pg_temp.id('org_c')))),
  ('c_q2', pg_temp.as_user(pg_temp.id('owner_c'), format('SELECT public.generate_bas_worksheet(%L, 2030, 2)', pg_temp.id('org_c')))),
  ('b_reads_a', pg_temp.as_user(pg_temp.id('outsider'), format('SELECT public.generate_bas_worksheet(%L, 2030, 1)', pg_temp.id('org_a'))));
CREATE FUNCTION pg_temp.ws(p_k text, p_path text[]) RETURNS text LANGUAGE sql AS $$ SELECT doc #>> p_path FROM ws WHERE k = p_k $$;

-- Org A, Q1 (accruals): same-quarter credit notes reduce the figures; draft, void and void-bill rows are ignored.
SELECT pg_temp.check('A Q1 basis', pg_temp.ws('a_q1', '{gst_accounting_basis}'), 'accruals');
SELECT pg_temp.check('A Q1 basis source', pg_temp.ws('a_q1', '{gst_accounting_basis_source}'), 'default');
SELECT pg_temp.check('A Q1 G1', pg_temp.ws('a_q1', '{gst,G1}'), '138000');
SELECT pg_temp.check('A Q1 G2', pg_temp.ws('a_q1', '{gst,G2}'), '0');
SELECT pg_temp.check('A Q1 G3', pg_temp.ws('a_q1', '{gst,G3}'), '50000');
SELECT pg_temp.check('A Q1 1A', pg_temp.ws('a_q1', '{gst,1A}'), '8000');
SELECT pg_temp.check('A Q1 G10', pg_temp.ws('a_q1', '{gst,G10}'), '220000');
SELECT pg_temp.check('A Q1 G11', pg_temp.ws('a_q1', '{gst,G11}'), '66000');
SELECT pg_temp.check('A Q1 1B', pg_temp.ws('a_q1', '{gst,1B}'), '26000');
SELECT pg_temp.check('A Q1 label 9', pg_temp.ws('a_q1', '{summary,9_net_amount_cents}'), '-18000');
SELECT pg_temp.check('A Q1 expected ledger GST collected', pg_temp.ws('a_q1', '{gl_reconciliation,expected_gst_collected_cents}'), '8000');

-- Org A, Q2: later credit notes are adjustments, customer -> 1B (decreasing), supplier -> 1A (increasing).
SELECT pg_temp.check('A Q2 G1', pg_temp.ws('a_q2', '{gst,G1}'), '0');
SELECT pg_temp.check('A Q2 G11', pg_temp.ws('a_q2', '{gst,G11}'), '0');
SELECT pg_temp.check('A Q2 1A', pg_temp.ws('a_q2', '{gst,1A}'), '500');
SELECT pg_temp.check('A Q2 1B', pg_temp.ws('a_q2', '{gst,1B}'), '1000');
SELECT pg_temp.check('A Q2 increasing adjustments', pg_temp.ws('a_q2', '{gst_adjustments,increasing_1A_cents}'), '500');
SELECT pg_temp.check('A Q2 decreasing adjustments', pg_temp.ws('a_q2', '{gst_adjustments,decreasing_1B_cents}'), '1000');
SELECT pg_temp.check('A Q2 label 9', pg_temp.ws('a_q2', '{summary,9_net_amount_cents}'), '-500');
SELECT pg_temp.check('A Q2 expected ledger GST collected', pg_temp.ws('a_q2', '{gl_reconciliation,expected_gst_collected_cents}'), '-1000');
SELECT pg_temp.check('A Q2 expected ledger GST paid', pg_temp.ws('a_q2', '{gl_reconciliation,expected_gst_paid_cents}'), '-500');

-- W3 and W4 are blank (JSON null) and listed as not recorded; W1/W2/W5/4 are computed (no pay runs here).
SELECT pg_temp.check('A Q1 W3 is null', (SELECT jsonb_typeof(doc -> 'payg_withholding' -> 'W3') FROM ws WHERE k = 'a_q1'), 'null');
SELECT pg_temp.check('A Q1 W4 is null', (SELECT jsonb_typeof(doc -> 'payg_withholding' -> 'W4') FROM ws WHERE k = 'a_q1'), 'null');
SELECT pg_temp.check('A Q1 W3/W4 not recorded', (SELECT doc -> 'payg_withholding' -> 'not_recorded' FROM ws WHERE k = 'a_q1'), '["W3", "W4"]'::jsonb);
SELECT pg_temp.check('A Q1 W5', pg_temp.ws('a_q1', '{payg_withholding,W5}'), '0');
SELECT pg_temp.check('A Q1 drilldown W3 is null',
  (SELECT jsonb_typeof(doc #> '{source_drilldown,payg_withholding,totals,W3}') FROM ws WHERE k = 'a_q1'), 'null');

-- Org C, Q1 (cash): payments received and bills paid in the quarter only.
SELECT pg_temp.check('C Q1 basis', pg_temp.ws('c_q1', '{gst_accounting_basis}'), 'cash');
SELECT pg_temp.check('C Q1 basis source', pg_temp.ws('c_q1', '{gst_accounting_basis_source}'), 'business_profile');
SELECT pg_temp.check('C Q1 G1', pg_temp.ws('c_q1', '{gst,G1}'), '154000');
SELECT pg_temp.check('C Q1 G3', pg_temp.ws('c_q1', '{gst,G3}'), '0');
SELECT pg_temp.check('C Q1 1A', pg_temp.ws('c_q1', '{gst,1A}'), '14000');
SELECT pg_temp.check('C Q1 G10', pg_temp.ws('c_q1', '{gst,G10}'), '0');
SELECT pg_temp.check('C Q1 G11', pg_temp.ws('c_q1', '{gst,G11}'), '44000');
SELECT pg_temp.check('C Q1 1B', pg_temp.ws('c_q1', '{gst,1B}'), '4000');

-- PAYG-I registered with no amount entered: amounts null, label 9 leaves them out and says so.
SELECT pg_temp.check('C Q1 5A is null', (SELECT jsonb_typeof(doc -> 'payg_instalment' -> '5A') FROM ws WHERE k = 'c_q1'), 'null');
SELECT pg_temp.check('C Q1 PAYG-I status', pg_temp.ws('c_q1', '{payg_instalment,source_status}'), 'missing');
SELECT pg_temp.check('C Q1 label 9', pg_temp.ws('c_q1', '{summary,9_net_amount_cents}'), '10000');
SELECT pg_temp.check('C Q1 PAYG-I in review list',
  (SELECT count(*) FROM ws, jsonb_array_elements(doc -> 'needs_review') e WHERE k = 'c_q1' AND e ->> 'source_type' = 'payg_instalment'), 1::bigint);

-- Org C, Q2: the 30 Sep 15:30 UTC payment is 1 Oct in Brisbane; the credit note after full payment is only flagged.
SELECT pg_temp.check('C Q2 G1', pg_temp.ws('c_q2', '{gst,G1}'), '77000');
SELECT pg_temp.check('C Q2 1A', pg_temp.ws('c_q2', '{gst,1A}'), '7000');
SELECT pg_temp.check('C Q2 G11', pg_temp.ws('c_q2', '{gst,G11}'), '33000');
SELECT pg_temp.check('C Q2 1B', pg_temp.ws('c_q2', '{gst,1B}'), '3000');
SELECT pg_temp.check('C Q2 label 9', pg_temp.ws('c_q2', '{summary,9_net_amount_cents}'), '4000');
SELECT pg_temp.check('C Q2 refund credit note flagged',
  (SELECT count(*) FROM ws, jsonb_array_elements(doc -> 'needs_review') e WHERE k = 'c_q2' AND e ->> 'document_number' = 'CN-C1'), 1::bigint);

-- An outsider asking for org A's worksheet sees nothing of it.
SELECT pg_temp.check('outsider G1', pg_temp.ws('b_reads_a', '{gst,G1}'), '0');
SELECT pg_temp.check('outsider 1B', pg_temp.ws('b_reads_a', '{gst,1B}'), '0');

-- PAYG-I amount entered for org C Q1: label 9 now includes 5A.
INSERT INTO public.bas_payg_instalment_amounts (organization_id, fy_start_year, quarter_num, label_5a_payg_instalment_cents, source_reference)
VALUES (pg_temp.id('org_c'), 2030, 1, 150000, 'ATO instalment notice');
SELECT pg_temp.check('C Q1 label 9 with 5A',
  pg_temp.as_user(pg_temp.id('owner_c'), format('SELECT public.generate_bas_worksheet(%L, 2030, 1)', pg_temp.id('org_c'))) #>> '{summary,9_net_amount_cents}',
  '160000');

-- ---------------------------------------------------------------------------------------------------------------
-- v_bas_quarterly (the BAS page table) uses the same figures; v_gst_reconciliation compares the ledger with the
-- accruals figures, also for the cash-basis org.
-- ---------------------------------------------------------------------------------------------------------------
CREATE TEMP TABLE vq AS
SELECT * FROM jsonb_to_recordset(pg_temp.as_user(pg_temp.id('owner_a'),
  'SELECT coalesce(jsonb_agg(to_jsonb(q)), ''[]'') FROM public.v_bas_quarterly q')) AS x(
  organization_id uuid, fy_start_year int, quarter_num int, quarter_start date, gst_collected_cents numeric,
  gst_paid_cents numeric, net_gst_cents numeric, sales_ex_gst_cents numeric, purchases_ex_gst_cents numeric,
  invoice_count bigint, bill_count bigint, gst_accounting_basis text, increasing_adjustments_gst_cents numeric,
  decreasing_adjustments_gst_cents numeric);
SELECT pg_temp.check('v_bas_quarterly rows visible to owner A', (SELECT count(*) FROM vq), 2::bigint);
SELECT pg_temp.check('v_bas_quarterly only org A', (SELECT count(*) FROM vq WHERE organization_id <> pg_temp.id('org_a')), 0::bigint);
SELECT pg_temp.check('v_bas_quarterly A Q1', (SELECT row(gst_collected_cents, gst_paid_cents, net_gst_cents, sales_ex_gst_cents,
  purchases_ex_gst_cents, invoice_count, bill_count, quarter_start)::text FROM vq WHERE quarter_num = 1),
  row(8000, 26000, -18000, 130000, 260000, 1, 2, DATE '2030-07-01')::text);
SELECT pg_temp.check('v_bas_quarterly A Q2', (SELECT row(gst_collected_cents, gst_paid_cents, net_gst_cents,
  increasing_adjustments_gst_cents, decreasing_adjustments_gst_cents, gst_accounting_basis, quarter_start)::text FROM vq WHERE quarter_num = 2),
  row(500, 1000, -500, 500, 1000, 'accruals', DATE '2030-10-01')::text);
SELECT pg_temp.check('v_bas_quarterly C Q1 net',
  pg_temp.as_user(pg_temp.id('owner_c'), format(
    'SELECT to_jsonb(net_gst_cents) FROM public.v_bas_quarterly WHERE organization_id = %L AND fy_start_year = 2030 AND quarter_num = 1',
    pg_temp.id('org_c')))::text, '10000');
-- Accruals net for org C over all quarters: invoices 41000 - CN-C1 100 - bills 8100 + SCN-C1 1000 = 33800.
SELECT pg_temp.check('v_gst_reconciliation C uses accruals figures',
  pg_temp.as_user(pg_temp.id('owner_c'), format(
    'SELECT to_jsonb(bas_net_gst_owed_cents) FROM public.v_gst_reconciliation WHERE organization_id = %L', pg_temp.id('org_c')))::text,
  '33800');
SELECT pg_temp.check('v_bas_gst_source_rows is security_invoker',
  (SELECT 'security_invoker=on' = ANY (reloptions) FROM pg_class WHERE oid = to_regclass('public.v_bas_gst_source_rows')), true);

-- Snapshot evidence records the v3 source.
SELECT pg_temp.check('snapshot source version',
  pg_temp.as_user(pg_temp.id('owner_a'), format('SELECT to_jsonb(public.snapshot_bas_worksheet(%L, 2030, 2))', pg_temp.id('org_a'))) ->> 'source_version',
  'generate_bas_worksheet:v3');

-- ---------------------------------------------------------------------------------------------------------------
-- BAS settlement for org A Q2 (refund of $5): the control accounts clear by what the credit-note journals posted to
-- them (GST collected credited $10, GST paid debited $5), not by labels 1A/1B.
-- ---------------------------------------------------------------------------------------------------------------
INSERT INTO public.chart_of_accounts (organization_id, code, name, account_type) VALUES
  (pg_temp.id('org_a'), '1000', 'Bank', 'asset'), (pg_temp.id('org_a'), '1200', 'GST paid', 'asset'),
  (pg_temp.id('org_a'), '2100', 'GST collected', 'liability');
INSERT INTO public.bank_connections (id, organization_id, provider, encrypted_access_token, status)
VALUES (pg_temp.id('conn_a'), pg_temp.id('org_a'), 'manual', '', 'active');
INSERT INTO public.bank_accounts (id, organization_id, bank_connection_id, external_id, name)
VALUES (pg_temp.id('acct_a'), pg_temp.id('org_a'), pg_temp.id('conn_a'), 'acct-a', 'Business account');
INSERT INTO public.bank_transactions (id, organization_id, bank_account_id, external_id, posted_at, description, amount_cents, auto_category_code)
VALUES (pg_temp.id('tx_a'), pg_temp.id('org_a'), pg_temp.id('acct_a'), 'tx-a', TIMESTAMPTZ '2031-01-20 00:00:00+00', 'ATO BAS refund', 500, 'ato_bas_super');

CREATE TEMP TABLE settlement AS
SELECT pg_temp.as_user(pg_temp.id('owner_a'),
  format('SELECT to_jsonb(public.post_bas_bank_transaction_journal(%L, 2030, 2))', pg_temp.id('tx_a'))) AS entry;
SELECT pg_temp.check('settlement error', (SELECT entry ->> 'error' FROM settlement), NULL::text);
SELECT pg_temp.check('settlement lines (code, debit, credit)',
  (SELECT string_agg(format('%s:%s/%s', coa.code, jl.debit_cents, jl.credit_cents), ' ' ORDER BY coa.code)
     FROM public.journal_lines jl JOIN public.chart_of_accounts coa ON coa.id = jl.account_id
    WHERE jl.journal_entry_id = (SELECT (entry ->> 'id')::uuid FROM settlement)),
  '1000:500/0 1200:500/0 2100:0/1000');

DO $$
DECLARE
  bad text;
  n int;
BEGIN
  SELECT count(*), string_agg(format('%s: got %s, want %s', name, coalesce(got, 'NULL'), coalesce(want, 'NULL')), E'\n')
    INTO n, bad
    FROM checks WHERE got IS DISTINCT FROM want;
  IF n > 0 THEN
    RAISE EXCEPTION E'BAS correctness: % of % checks failed:\n%', n, (SELECT count(*) FROM checks), bad;
  END IF;
  RAISE NOTICE 'BAS correctness: % checks passed (credit notes, cash basis, W3/W4 blank, PAYG-I, settlement)',
    (SELECT count(*) FROM checks);
END $$;

ROLLBACK;
