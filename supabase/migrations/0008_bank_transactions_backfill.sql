-- 0008 (BACKFILL): bank_transactions.
--
-- RECONSTRUCTION NOTE: Exists in the LIVE DB but had no repo migration, yet later
-- migrations ALTER it (0030 adds matched_invoice_id FK + index, 0031 adds is_personal,
-- 0036 adds applied_intake_rule_id, 0043 adds perf indexes). Reconstructed verbatim from
-- the live schema (read-only MCP, 2026-06-20).
--
-- ORDERING: the FK matched_invoice_id -> invoices(id) is NOT created here because
-- public.invoices is created later (migration 0030). That FK is already added by the
-- EXISTING migration 0030 (guarded DO-block adding bank_transactions_matched_invoice_fkey),
-- which now runs against the table created here. All columns are created up front; later
-- ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS statements in 0030/0031/0036/0043
-- no-op. Idempotent and safe to apply. See docs/MIGRATION_GAP_AUDIT.md.

CREATE TABLE IF NOT EXISTS public.bank_transactions (
  id                     uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL,
  bank_account_id        uuid NOT NULL,
  external_id            text NOT NULL,
  posted_at              timestamptz NOT NULL,
  description            text NOT NULL,
  amount_cents           bigint NOT NULL,
  running_balance_cents  bigint,
  reference              text,
  category_external      text,
  matched_bill_id        uuid,
  matched_invoice_id     uuid,
  match_confidence       numeric(3,2),
  manually_matched       boolean NOT NULL DEFAULT false,
  auto_category_code     text,
  applied_intake_rule_id uuid,
  raw                    jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  is_personal            boolean NOT NULL DEFAULT false,
  CONSTRAINT bank_transactions_pkey PRIMARY KEY (id),
  CONSTRAINT bank_transactions_bank_account_id_external_id_key
    UNIQUE (bank_account_id, external_id),
  CONSTRAINT bank_transactions_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT bank_transactions_bank_account_id_fkey
    FOREIGN KEY (bank_account_id) REFERENCES public.bank_accounts(id) ON DELETE CASCADE,
  CONSTRAINT bank_transactions_matched_bill_id_fkey
    FOREIGN KEY (matched_bill_id) REFERENCES public.bills(id) ON DELETE SET NULL,
  CONSTRAINT bank_transactions_applied_intake_rule_id_fkey
    FOREIGN KEY (applied_intake_rule_id) REFERENCES public.intake_rules(id) ON DELETE SET NULL,
  CONSTRAINT bank_transactions_auto_category_code_fkey
    FOREIGN KEY (auto_category_code) REFERENCES public.intake_categories(code)
  -- bank_transactions_matched_invoice_fkey is added by EXISTING migration 0030
  -- (after public.invoices exists); not declared here to preserve ordering.
);

CREATE INDEX IF NOT EXISTS idx_bank_txn_acct_date
  ON public.bank_transactions USING btree (bank_account_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_bank_txn_amount
  ON public.bank_transactions USING btree (bank_account_id, amount_cents);
CREATE INDEX IF NOT EXISTS idx_bank_txn_org_date
  ON public.bank_transactions USING btree (organization_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_bank_txn_unmatched
  ON public.bank_transactions USING btree (organization_id)
  WHERE ((matched_bill_id IS NULL) AND (matched_invoice_id IS NULL));

ALTER TABLE public.bank_transactions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY bank_txn_select ON public.bank_transactions
    FOR SELECT TO authenticated
    USING (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY bank_txn_insert ON public.bank_transactions
    FOR INSERT TO authenticated
    WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY bank_txn_update ON public.bank_transactions
    FOR UPDATE TO authenticated
    USING (organization_id IN (SELECT public.get_accessible_org_ids()))
    WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
