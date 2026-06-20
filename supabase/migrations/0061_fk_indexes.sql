-- ============================================================================
-- Migration: 0061_fk_indexes
-- Project:   Looplet Accounting  (EPIC E — make it trustworthy)
-- Purpose:   Add covering indexes for foreign-key columns that currently have
--            none.
--
--   Postgres does NOT auto-create an index on the *referencing* side of a
--   foreign key. An unindexed FK column means:
--     - slow `ON DELETE` / `ON UPDATE` cascade checks on the parent table
--       (every parent delete sequentially scans the child table), and
--     - slow joins/lookups that filter on the FK.
--   Supabase's `unindexed_foreign_keys` performance advisor flags exactly these.
--
--   A composite index whose LEADING column is something else (e.g.
--   `(organization_id, customer_id)`) does NOT cover a lookup/cascade on the
--   trailing column alone, so those FKs still need a dedicated index.
--
--   All statements use CREATE INDEX IF NOT EXISTS (idempotent). The
--   bank_transactions block is additionally guarded with to_regclass() because
--   that table is created by a migration outside this branch's range — the
--   guard makes this file safe to run whether or not the table is present yet.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- invoices: job_id and customer_id FKs.
--   Existing indexes are composite with organization_id LEADING
--   (invoices_org_customer_idx, invoices_org_job_idx) and therefore do NOT
--   serve a cascade/lookup on customer_id or job_id alone.
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS invoices_customer_id_idx
  ON public.invoices (customer_id);

CREATE INDEX IF NOT EXISTS invoices_job_id_idx
  ON public.invoices (job_id)
  WHERE job_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- invoice_payments: organization_id and bank_transaction_id FKs.
--   Only invoice_payments_invoice_idx (invoice_id) exists today.
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS invoice_payments_organization_id_idx
  ON public.invoice_payments (organization_id);

CREATE INDEX IF NOT EXISTS invoice_payments_bank_transaction_id_idx
  ON public.invoice_payments (bank_transaction_id)
  WHERE bank_transaction_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- *_line_items: organization_id FKs.
--   bill_line_items / customer_invoice_line_items / invoice_line_items each
--   index only their parent (bill_id / invoice_id) — the organization_id FK to
--   organizations(id) is uncovered.
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS bill_line_items_organization_id_idx
  ON public.bill_line_items (organization_id);

CREATE INDEX IF NOT EXISTS customer_invoice_line_items_organization_id_idx
  ON public.customer_invoice_line_items (organization_id);

CREATE INDEX IF NOT EXISTS invoice_line_items_organization_id_idx
  ON public.invoice_line_items (organization_id);

-- ----------------------------------------------------------------------------
-- bank_transactions: matched_bill_id / matched_invoice_id FKs.
--   The reconciliation flow filters on these (and they back the FK from
--   migration 0030). The table is defined outside this branch's migration
--   range, so guard on existence. Both columns are nullable and usually NULL
--   (only matched rows are set), so partial indexes keep them small.
-- ----------------------------------------------------------------------------
DO $bt$
BEGIN
  IF to_regclass('public.bank_transactions') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS bank_transactions_matched_bill_id_idx
      ON public.bank_transactions (matched_bill_id)
      WHERE matched_bill_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS bank_transactions_matched_invoice_id_idx
      ON public.bank_transactions (matched_invoice_id)
      WHERE matched_invoice_id IS NOT NULL;
  ELSE
    RAISE NOTICE 'Skipping bank_transactions FK indexes (table not present in this database)';
  END IF;
END
$bt$;

COMMIT;
