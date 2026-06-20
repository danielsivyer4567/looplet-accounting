-- ============================================================================
-- Migration: 0062_audit_triggers_money_tables
-- Project:   Looplet Accounting  (EPIC E — make it trustworthy)
-- Purpose:   Extend the append-only audit trail to the money-movement tables
--            that were not yet covered.
--
--   Migration 0001 attached a generic audit trigger to the core business
--   tables; migration 0039 replaced it with the richer `audit_log_trigger_v2()`
--   (column-level diff + actor email + resource_type) on bills, invoices, jobs,
--   customers, suppliers, employees, wage_entries, memberships.
--
--   It deliberately left out the tables that actually MOVE money in/out:
--     - bank_transactions   (excluded in 0039 as "too high-volume")
--     - invoice_payments    (created later, in migration 0030)
--     - payment_runs        (created later, in migration 0048)
--     - payment_run_items   (created later, in migration 0048)
--
--   For a "trustworthy" ledger these are the MOST important things to audit:
--   a payment recorded, reversed, or a payment run finalised must leave an
--   immutable trail of who did it and what changed. We attach the SAME
--   audit_log_trigger_v2() used everywhere else — it is table-agnostic (reads
--   `organization_id` and `id` via to_jsonb(NEW/OLD)), and every target table
--   has both columns.
--
--   Idempotent: each trigger is DROP TRIGGER IF EXISTS ... then CREATE.
--   bank_transactions is guarded with to_regclass() because that table is
--   created by a migration outside this branch's range.
--
--   Volume note: bank_transactions can be high-volume on bulk feed imports.
--   audit_log_trigger_v2 fires per row; if import throughput becomes a problem,
--   a follow-up can make the bank_transactions audit statement-level or scope
--   it to UPDATE/DELETE only. We keep full INSERT/UPDATE/DELETE coverage here
--   because correctness/traceability is the explicit goal of this epic.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- invoice_payments — AR cash receipts.
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_invoice_payments_audit_v2 ON public.invoice_payments;
CREATE TRIGGER trg_invoice_payments_audit_v2
  AFTER INSERT OR UPDATE OR DELETE ON public.invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger_v2();

-- ----------------------------------------------------------------------------
-- payment_runs — AP batch payment headers.
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_payment_runs_audit_v2 ON public.payment_runs;
CREATE TRIGGER trg_payment_runs_audit_v2
  AFTER INSERT OR UPDATE OR DELETE ON public.payment_runs
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger_v2();

-- ----------------------------------------------------------------------------
-- payment_run_items — individual bills within a payment run.
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_payment_run_items_audit_v2 ON public.payment_run_items;
CREATE TRIGGER trg_payment_run_items_audit_v2
  AFTER INSERT OR UPDATE OR DELETE ON public.payment_run_items
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger_v2();

-- ----------------------------------------------------------------------------
-- bank_transactions — the bank feed ledger (guarded; table defined out-of-branch).
-- ----------------------------------------------------------------------------
DO $bt$
BEGIN
  IF to_regclass('public.bank_transactions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_bank_transactions_audit_v2 ON public.bank_transactions;
    CREATE TRIGGER trg_bank_transactions_audit_v2
      AFTER INSERT OR UPDATE OR DELETE ON public.bank_transactions
      FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger_v2();
  ELSE
    RAISE NOTICE 'Skipping bank_transactions audit trigger (table not present in this database)';
  END IF;
END
$bt$;

COMMIT;
