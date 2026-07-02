-- 20260702090000: Period-lock enforcement for later money-moving tables.
--
-- The original 0001 trigger only saw early tables/date names
-- (invoice_date, bill_date, transaction_date, work_date) and only attached to
-- bills/customer_invoices/wage_entries. Later AR, bank, payroll, timesheet,
-- and ABA payment tables and journal headers need the same close-period guard.

BEGIN;

CREATE OR REPLACE FUNCTION public.check_period_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row jsonb;
  v_record_date date;
  v_org_id uuid;
BEGIN
  v_row := to_jsonb(NEW);
  v_org_id := nullif(v_row ->> 'organization_id', '')::uuid;

  v_record_date := CASE TG_TABLE_NAME
    WHEN 'bills' THEN nullif(v_row ->> 'invoice_date', '')::date
    WHEN 'customer_invoices' THEN nullif(v_row ->> 'invoice_date', '')::date
    WHEN 'invoices' THEN nullif(v_row ->> 'issue_date', '')::date
    WHEN 'invoice_payments' THEN (nullif(v_row ->> 'paid_at', '')::timestamptz)::date
    WHEN 'bank_transactions' THEN (nullif(v_row ->> 'posted_at', '')::timestamptz)::date
    WHEN 'wage_entries' THEN nullif(v_row ->> 'work_date', '')::date
    WHEN 'timesheet_entries' THEN nullif(v_row ->> 'work_date', '')::date
    WHEN 'pay_runs' THEN COALESCE(
      nullif(v_row ->> 'pay_date', '')::date,
      nullif(v_row ->> 'period_end', '')::date
    )
    WHEN 'payment_runs' THEN nullif(v_row ->> 'pay_date', '')::date
    WHEN 'journal_entries' THEN nullif(v_row ->> 'entry_date', '')::date
    ELSE COALESCE(
      nullif(v_row ->> 'invoice_date', '')::date,
      nullif(v_row ->> 'bill_date', '')::date,
      nullif(v_row ->> 'transaction_date', '')::date,
      nullif(v_row ->> 'work_date', '')::date,
      nullif(v_row ->> 'issue_date', '')::date,
      (nullif(v_row ->> 'paid_at', '')::timestamptz)::date,
      (nullif(v_row ->> 'posted_at', '')::timestamptz)::date,
      nullif(v_row ->> 'pay_date', '')::date,
      nullif(v_row ->> 'period_end', '')::date,
      nullif(v_row ->> 'entry_date', '')::date
    )
  END;

  IF v_record_date IS NULL OR v_org_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.period_locks pl
     WHERE pl.organization_id = v_org_id
       AND v_record_date BETWEEN pl.period_start AND pl.period_end
       AND pl.unlocked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot modify % dated %: period is locked',
      TG_TABLE_NAME, v_record_date
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.check_period_lock() IS
  'Trigger guard that blocks writes dated inside active period_locks across bills, invoices, bank transactions, payroll/timesheet rows, payment runs, and journal entries.';

REVOKE ALL ON FUNCTION public.check_period_lock() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_period_lock() TO authenticated, service_role;

DO $$
DECLARE
  t text;
  rel regclass;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'bills',
    'customer_invoices',
    'wage_entries',
    'timesheet_entries',
    'invoices',
    'invoice_payments',
    'bank_transactions',
    'pay_runs',
    'payment_runs',
    'journal_entries'
  ]
  LOOP
    rel := to_regclass(format('public.%I', t));
    IF rel IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s;', 'trg_' || t || '_period_lock', rel);
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION public.check_period_lock();',
        'trg_' || t || '_period_lock',
        rel
      );
    END IF;
  END LOOP;
END $$;

COMMIT;
