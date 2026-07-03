-- ============================================================================
-- Migration: 0202_fk_indexes
-- Project:   Looplet Accounting  (finish-line: high-impact FK index sweep)
-- Purpose:   Add covering indexes for foreign-key columns on high-traffic tables
--            that STILL lack one after 0061_fk_indexes.
--
--   Postgres does NOT auto-create an index on the *referencing* side of a
--   foreign key. An unindexed FK column means:
--     - slow `ON DELETE` / `ON UPDATE` cascade checks on the parent table
--       (every parent delete sequentially scans the child table), and
--     - slow joins/lookups that filter on the FK.
--   Supabase's `unindexed_foreign_keys` performance advisor flags exactly these.
--
--   A composite index whose LEADING column is something else (e.g.
--   `(organization_id, status)` on bills) does NOT cover a lookup/cascade on a
--   trailing/other FK column, so those FKs still need a dedicated index.
--
--   This sweep targets the FKs left uncovered after 0061 on the hottest tables:
--     bills / customer_invoices  : actor FKs (created_by, attached_by) to auth.users
--     bank_transactions          : auto_category_code -> intake_categories(code)
--     pay_runs / pay_slips        : approver/payer FKs to auth.users
--     tags                        : approved_by -> auth.users
--     tag_drafts                  : organization_id + job_id (had only user_id)
--
--   Already covered elsewhere and intentionally NOT duplicated here:
--     invoices.customer_id / invoices.job_id / invoice_payments.* / *_line_items
--       .organization_id / bank_transactions.matched_bill_id /
--       .matched_invoice_id                                   (0061)
--     bank_transactions.applied_intake_rule_id                (0036)
--     bills.payment_run_id                                    (0048)
--     bills.supplier_id / bills.job_id                        (0001)
--
--   All statements use CREATE INDEX IF NOT EXISTS (idempotent). Nullable actor
--   FKs use partial indexes (WHERE col IS NOT NULL) so they stay small. Tables
--   created by migrations outside / around this range (bank_transactions,
--   tag_drafts, ...) are guarded with to_regclass() so the file is safe to run
--   against a drifted live history. Pure additive DDL — no RLS / data changes.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- bills: actor FKs to auth.users.
--   Existing indexes lead on organization_id / supplier_id / job_id; the
--   created_by and attached_by FKs are uncovered, so a user deletion (or a
--   "bills I created / attached" lookup) has no supporting index. Both are
--   nullable -> partial.
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS bills_created_by_idx
  ON public.bills (created_by)
  WHERE created_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS bills_attached_by_idx
  ON public.bills (attached_by)
  WHERE attached_by IS NOT NULL;

-- ----------------------------------------------------------------------------
-- customer_invoices / invoices: created_by FK to auth.users.
--   customer_invoices is a legacy AR table that 0042 drops on current
--   databases; guard it so this finish-line sweep stays safe against both old
--   and consolidated schemas. invoices is the current AR table.
-- ----------------------------------------------------------------------------
DO $ci$
BEGIN
  IF to_regclass('public.customer_invoices') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS customer_invoices_created_by_idx
      ON public.customer_invoices (created_by)
      WHERE created_by IS NOT NULL;
  ELSE
    RAISE NOTICE 'Skipping customer_invoices FK index (legacy table not present in this database)';
  END IF;
END
$ci$;

CREATE INDEX IF NOT EXISTS invoices_created_by_idx
  ON public.invoices (created_by)
  WHERE created_by IS NOT NULL;

-- ----------------------------------------------------------------------------
-- bank_transactions: auto_category_code FK to intake_categories(code).
--   matched_bill_id / matched_invoice_id (0061) and applied_intake_rule_id
--   (0036) are covered; the auto_category_code FK is not, so re-coding a
--   category sequentially scans the (large) bank_transactions table. Guard on
--   existence — the table is reconstructed by 0008 and may be absent on a
--   partially-applied DB.
-- ----------------------------------------------------------------------------
DO $bt$
BEGIN
  IF to_regclass('public.bank_transactions') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS bank_transactions_auto_category_code_idx
      ON public.bank_transactions (auto_category_code)
      WHERE auto_category_code IS NOT NULL;
  ELSE
    RAISE NOTICE 'Skipping bank_transactions FK index (table not present in this database)';
  END IF;
END
$bt$;

-- ----------------------------------------------------------------------------
-- pay_runs / pay_slips: approver/payer FKs to auth.users.
--   pay_runs is indexed on (organization_id, ...) and status; the approved_by /
--   paid_by actor FKs are uncovered. (pay_slips' org / pay_run_id / employee_id
--   FKs are already indexed by 0045.) Guard the block — payroll may not be
--   present on every database.
-- ----------------------------------------------------------------------------
DO $pr$
BEGIN
  IF to_regclass('public.pay_runs') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS pay_runs_approved_by_idx
      ON public.pay_runs (approved_by)
      WHERE approved_by IS NOT NULL;

    CREATE INDEX IF NOT EXISTS pay_runs_paid_by_idx
      ON public.pay_runs (paid_by)
      WHERE paid_by IS NOT NULL;
  ELSE
    RAISE NOTICE 'Skipping pay_runs FK indexes (table not present in this database)';
  END IF;
END
$pr$;

-- ----------------------------------------------------------------------------
-- tags: approved_by FK to auth.users.
--   tags already indexes organization_id / creator_id (0200); the approval-
--   workflow actor FK approved_by is uncovered. Guard on existence — the tag
--   schema is landed in 0200.
-- ----------------------------------------------------------------------------
DO $tg$
BEGIN
  IF to_regclass('public.tags') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS tags_approved_by_idx
      ON public.tags (approved_by)
      WHERE approved_by IS NOT NULL;
  ELSE
    RAISE NOTICE 'Skipping tags FK index (table not present in this database)';
  END IF;
END
$tg$;

-- ----------------------------------------------------------------------------
-- tag_drafts: organization_id and job_id FKs.
--   0200 created only idx_tag_drafts_user (user_id). The organization_id FK
--   (org-scoped reads / org cascade) and the job_id FK (-> jobs, nullable) are
--   both uncovered. Guard on existence — schema landed in 0200.
-- ----------------------------------------------------------------------------
DO $td$
BEGIN
  IF to_regclass('public.tag_drafts') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_tag_drafts_organization
      ON public.tag_drafts (organization_id);

    CREATE INDEX IF NOT EXISTS idx_tag_drafts_job
      ON public.tag_drafts (job_id)
      WHERE job_id IS NOT NULL;
  ELSE
    RAISE NOTICE 'Skipping tag_drafts FK indexes (table not present in this database)';
  END IF;
END
$td$;

COMMIT;
