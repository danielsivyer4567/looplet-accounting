-- ============================================================================
-- Migration: 0048_payment_runs
-- Purpose:   ABA (Cemtex) payment-run batch pay for AU internet banking.
--
-- Adds:
--   1. payment_run_status ENUM
--   2. payment_runs table (one per batch upload to bank)
--   3. payment_run_items table (one per bill/payee within a run)
--   4. bills.payment_run_id FK + index
--   5. suppliers payee bank columns (payee_bsb, payee_account_number, payee_account_name)
--   6. v_unpaid_bills_for_payment_run view
--   7. RLS policies
--   8. Grants
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Enum
-- ----------------------------------------------------------------------------

CREATE TYPE payment_run_status AS ENUM (
  'draft',
  'approved',
  'exported',
  'paid',
  'cancelled'
);

-- ----------------------------------------------------------------------------
-- 2. payment_runs
-- ----------------------------------------------------------------------------

CREATE TABLE payment_runs (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          UUID         NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- payer_bank_account_id is intentionally nullable: user may use payer details
  -- stored in org.settings (payer_bsb / payer_account / payer_name) instead.
  -- When set, the row id is recorded for display only; full account number lives
  -- in org.settings because bank_accounts.account_number_last4 is masked.
  payer_bank_account_id    UUID         REFERENCES bank_accounts(id) ON DELETE SET NULL,
  pay_date                 DATE         NOT NULL,
  status                   payment_run_status NOT NULL DEFAULT 'draft',
  total_cents              BIGINT       NOT NULL DEFAULT 0,
  bill_count               INTEGER      NOT NULL DEFAULT 0,
  aba_file_generated_at    TIMESTAMPTZ,
  aba_file_size_bytes      INTEGER,
  notes                    TEXT,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_by               UUID         REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at              TIMESTAMPTZ,
  approved_by              UUID         REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX idx_payment_runs_org         ON payment_runs(organization_id);
CREATE INDEX idx_payment_runs_org_status  ON payment_runs(organization_id, status);
CREATE INDEX idx_payment_runs_pay_date    ON payment_runs(organization_id, pay_date DESC);

COMMENT ON TABLE payment_runs IS
  'One ABA (Cemtex) batch payment file per row. Contains N payment_run_items.';

-- ----------------------------------------------------------------------------
-- 3. payment_run_items
-- ----------------------------------------------------------------------------

CREATE TABLE payment_run_items (
  id                    UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_run_id        UUID    NOT NULL REFERENCES payment_runs(id) ON DELETE CASCADE,
  organization_id       UUID    NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bill_id               UUID    NOT NULL REFERENCES bills(id) ON DELETE RESTRICT,
  amount_cents          BIGINT  NOT NULL CHECK (amount_cents > 0),
  -- ABA payee fields, stored at creation time (supplier bank details may change later)
  payee_bsb             TEXT    NOT NULL,            -- e.g. '062-001'
  payee_account_number  TEXT    NOT NULL,
  payee_account_name    TEXT    NOT NULL,            -- max 32 chars, uppercase ASCII
  reference             TEXT,                        -- bill invoice_number, max 18 chars
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_run_items_run_bill_uniq UNIQUE (payment_run_id, bill_id)
);

CREATE INDEX idx_payment_run_items_run    ON payment_run_items(payment_run_id);
CREATE INDEX idx_payment_run_items_org    ON payment_run_items(organization_id);
CREATE INDEX idx_payment_run_items_bill   ON payment_run_items(bill_id);

COMMENT ON TABLE payment_run_items IS
  'One line per payee in a payment run. Fields are snapshotted at creation time.';

-- ----------------------------------------------------------------------------
-- 4. bills.payment_run_id
-- ----------------------------------------------------------------------------

ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS payment_run_id UUID
    REFERENCES payment_runs(id) ON DELETE SET NULL;

CREATE INDEX bills_payment_run_idx
  ON bills(payment_run_id)
  WHERE payment_run_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 5. suppliers payee bank details
-- ----------------------------------------------------------------------------

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS payee_bsb             TEXT,
  ADD COLUMN IF NOT EXISTS payee_account_number  TEXT,
  ADD COLUMN IF NOT EXISTS payee_account_name    TEXT;

COMMENT ON COLUMN suppliers.payee_bsb IS
  'BSB in NNN-NNN format for ABA payment. Stored here as flat columns for fast query; also present in legacy bank_account JSONB.';
COMMENT ON COLUMN suppliers.payee_account_number IS
  'Full bank account number for ABA payment (not masked).';
COMMENT ON COLUMN suppliers.payee_account_name IS
  'Account name (max 32 ASCII chars) as it should appear in the ABA file.';

-- ----------------------------------------------------------------------------
-- 6. v_unpaid_bills_for_payment_run
-- ----------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_unpaid_bills_for_payment_run AS
SELECT
  b.id                       AS bill_id,
  b.organization_id,
  b.supplier_id,
  b.invoice_number,
  b.invoice_date,
  b.due_date,
  b.total_inc_gst_cents,
  b.supplier_name_raw,
  b.status,
  -- Supplier payee bank details (flat columns preferred, JSONB fallback)
  COALESCE(
    s.payee_bsb,
    s.bank_account->>'bsb'
  )                          AS payee_bsb,
  COALESCE(
    s.payee_account_number,
    s.bank_account->>'account_number'
  )                          AS payee_account_number,
  COALESCE(
    s.payee_account_name,
    s.name
  )                          AS payee_account_name,
  s.name                     AS supplier_name,
  -- flag: true when all three ABA fields are populated
  (
    COALESCE(s.payee_bsb, s.bank_account->>'bsb') IS NOT NULL
    AND COALESCE(s.payee_account_number, s.bank_account->>'account_number') IS NOT NULL
  )                          AS has_bank_details
FROM bills b
LEFT JOIN suppliers s ON s.id = b.supplier_id
WHERE b.status = 'attached'
  AND b.payment_run_id IS NULL
  AND b.deleted_at IS NULL
  AND (b.is_personal = false OR b.is_personal IS NULL)
  AND b.total_inc_gst_cents > 0;

COMMENT ON VIEW public.v_unpaid_bills_for_payment_run IS
  'Bills ready to be added to a payment run: status=attached, no payment_run_id, not personal, amount > 0.';

-- ----------------------------------------------------------------------------
-- 7. Triggers (updated_at on payment_runs)
-- ----------------------------------------------------------------------------

CREATE TRIGGER trg_payment_runs_set_updated_at
  BEFORE UPDATE ON payment_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- 8. RLS
-- ----------------------------------------------------------------------------

ALTER TABLE payment_runs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_run_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY payment_runs_org ON payment_runs
  FOR ALL TO authenticated
  USING      (organization_id IN (SELECT get_accessible_org_ids()))
  WITH CHECK (organization_id IN (SELECT get_accessible_org_ids()));

CREATE POLICY payment_run_items_org ON payment_run_items
  FOR ALL TO authenticated
  USING      (organization_id IN (SELECT get_accessible_org_ids()))
  WITH CHECK (organization_id IN (SELECT get_accessible_org_ids()));

-- ----------------------------------------------------------------------------
-- 9. Grants
-- ----------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON payment_runs      TO authenticated;
GRANT SELECT, INSERT, UPDATE ON payment_run_items TO authenticated;
GRANT ALL                    ON payment_runs      TO service_role;
GRANT ALL                    ON payment_run_items TO service_role;
GRANT SELECT ON public.v_unpaid_bills_for_payment_run TO authenticated, service_role;

COMMIT;

-- Acceptance check:
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema='public' AND table_name IN ('payment_runs','payment_run_items');
--   -- should return 2 rows
