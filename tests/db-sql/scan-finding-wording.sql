-- FAKE-02: run_data_completeness_scan says only what each check tests.
-- Run with: node scripts/db/run-pg-sql-tests.mjs tests/db-sql/scan-finding-wording.sql
--
-- Setup runs as postgres (no request JWT, so the function's member guard is skipped, as for service
-- role). A bill over $1,000 that is not attached to a job and a bill whose GST is not 1/11 of the
-- total must produce findings that describe exactly that, and a re-run must refresh old wording.

BEGIN;

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
INSERT INTO ids VALUES
  ('org', '0c000000-0000-4000-8000-000000000001'),
  ('big_bill', '3c000000-0000-4000-8000-000000000001'),
  ('gst_bill', '3c000000-0000-4000-8000-000000000002');
CREATE FUNCTION pg_temp.id(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT v FROM ids WHERE k = p $$;

INSERT INTO public.organizations (id, name) VALUES (pg_temp.id('org'), 'Scan Org');

CREATE TEMP TABLE bill_source AS
SELECT e.enumlabel AS label
  FROM pg_attribute a JOIN pg_enum e ON e.enumtypid = a.atttypid
 WHERE a.attrelid = 'public.bills'::regclass AND a.attname = 'source'
 ORDER BY e.enumsortorder LIMIT 1;

DO $$
DECLARE src text := (SELECT label FROM bill_source);
BEGIN
  EXECUTE format(
    'INSERT INTO public.bills (id, organization_id, source, storage_key, original_filename, mime_type,'
    ' total_inc_gst_cents, gst_cents, subtotal_ex_gst_cents, auto_category_code, attached_at) VALUES '
    '(%L, %L, %L, %L, %L, %L, 220000, 20000, 200000, %L, NULL),'
    '(%L, %L, %L, %L, %L, %L, 33000, 1000, 32000, %L, now())',
    pg_temp.id('big_bill'), pg_temp.id('org'), src, 's/1', 'big.pdf', 'application/pdf', 'materials',
    pg_temp.id('gst_bill'), pg_temp.id('org'), src, 's/2', 'mixed.pdf', 'application/pdf', 'materials');
END $$;

-- An old finding with the previous, misleading wording; the next run must reword it.
INSERT INTO public.data_completeness_findings
  (organization_id, check_code, resource_type, resource_id, severity, title, description, fix_url, fix_action, last_seen_at)
VALUES
  (pg_temp.id('org'), 'bill_high_value_no_attachment', 'bill', pg_temp.id('big_bill'), 'warning',
   'Bill > $1000 has no attached invoice/receipt', 'no source document attached', '/bills/x', 'Attach receipt', now());

SELECT public.run_data_completeness_scan(pg_temp.id('org'));

DO $$
DECLARE
  f record;
BEGIN
  SELECT title, description, fix_action INTO f FROM public.data_completeness_findings
   WHERE organization_id = pg_temp.id('org') AND check_code = 'bill_high_value_no_attachment'
     AND resource_id = pg_temp.id('big_bill');
  IF f.title IS DISTINCT FROM 'Bill over $1,000 is not attached to a job' THEN
    RAISE EXCEPTION 'high-value finding title: %', f.title;
  END IF;
  IF f.description ILIKE '%source document%' OR f.description ILIKE '%TR 95/14%' OR f.fix_action <> 'Attach to job' THEN
    RAISE EXCEPTION 'high-value finding still claims a missing document: % / %', f.description, f.fix_action;
  END IF;

  SELECT title, description INTO f FROM public.data_completeness_findings
   WHERE organization_id = pg_temp.id('org') AND check_code = 'bill_gst_mismatch'
     AND resource_id = pg_temp.id('gst_bill');
  IF f.title IS DISTINCT FROM 'GST is not 1/11 of the total' THEN
    RAISE EXCEPTION 'GST finding title: %', f.title;
  END IF;
  IF f.description NOT LIKE 'Recorded GST is $10.00; 1/11 of the $330.00 total would be $30.00.%'
     OR f.description NOT ILIKE '%mixes taxable and GST-free items%'
     OR f.description ILIKE '%should be%' THEN
    RAISE EXCEPTION 'GST finding description: %', f.description;
  END IF;

  RAISE NOTICE 'scan-finding-wording: high-value and GST-mismatch findings say what they test';
END $$;

ROLLBACK;
