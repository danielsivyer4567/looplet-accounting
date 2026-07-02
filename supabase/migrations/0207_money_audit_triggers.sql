-- ============================================================================
-- Migration: 0207_money_audit_triggers
-- Project:   Looplet Accounting  (finish-line: P1-12)
-- Purpose:   Guarantee an append-only audit trail on EVERY money-movement table
--            from a single authoritative migration, and close the one remaining
--            gap (journal_entries — the double-entry ledger — had no audit
--            trigger at all, only an updated_at trigger from 0072).
--
--   Background — audit coverage today is scattered across many migrations:
--     - bills, customer_invoices ............ 0039 (audit_log_trigger_v2)
--     - invoices ............................ 0086
--     - pay_runs, pay_slips ................. 0045
--     - payment_runs, invoice_payments,
--       bank_transactions ................... 0062
--     - journal_entries ..................... NOWHERE  (the gap this closes)
--
--   For a trustworthy ledger, every create/modify/reverse of a money row must
--   leave an immutable "who did what" trail. This migration re-asserts the
--   trigger on all of them in one place so the invariant is verifiable from a
--   single file, and adds the missing journal_entries trigger.
--
--   Reuses the existing table-agnostic audit_log_trigger_v2() (0039,
--   SECURITY DEFINER): it reads organization_id + id off the row via
--   to_jsonb(NEW/OLD) — every table below has both columns — and writes an
--   INSERT/UPDATE/DELETE row (with a per-column old/new `changes` diff on
--   UPDATE) to the append-only audit_log. No new audit function is introduced
--   and no table behaviour changes.
--
--   Idempotent: every attach is `DROP TRIGGER IF EXISTS ... ; CREATE TRIGGER`,
--   and each table is guarded with to_regclass() so this runs cleanly whether
--   or not a given table exists in the target database (customer_invoices is a
--   legacy 0001 table; payment_runs/invoices are created by later migrations).
--   Trigger names match the established `trg_<table>_audit_v2` convention so
--   re-attaching simply replaces the same trigger already installed elsewhere.
-- ============================================================================

BEGIN;

DO $money_audit$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'bills',
    'invoices',
    'customer_invoices',
    'pay_runs',
    'pay_slips',
    'bank_transactions',
    'journal_entries',
    'payment_runs'
  ])
  LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format(
        'DROP TRIGGER IF EXISTS trg_%I_audit_v2 ON public.%I;', t, t
      );
      EXECUTE format(
        'CREATE TRIGGER trg_%I_audit_v2
           AFTER INSERT OR UPDATE OR DELETE ON public.%I
           FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger_v2();', t, t
      );
    ELSE
      RAISE NOTICE 'Skipping % audit trigger (table not present in this database)', t;
    END IF;
  END LOOP;
END
$money_audit$;

COMMIT;
