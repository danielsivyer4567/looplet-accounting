-- 0012 (BACKFILL): debts, debt_payments.
--
-- RECONSTRUCTION NOTE: Exist in the LIVE DB but had no repo migration. Used by the
-- Debts / DebtDetail frontend pages (.from('debts'), .from('debt_payments')).
-- Reconstructed verbatim from the live schema (read-only MCP, 2026-06-20). Idempotent
-- and safe. See docs/MIGRATION_GAP_AUDIT.md.

DO $$ BEGIN
  CREATE TYPE public.debt_kind AS ENUM
    ('credit_card','mortgage','personal_loan','car_loan','equipment_finance','line_of_credit','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.debts (
  id                     uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id        uuid NOT NULL,
  name                   text NOT NULL,
  kind                   public.debt_kind NOT NULL,
  lender_name            text,
  account_number_last4   text,
  bank_account_id        uuid,
  original_balance_cents bigint,
  current_balance_cents  bigint,
  interest_rate_pct      numeric(7,4),
  minimum_payment_cents  bigint,
  payment_due_day        integer,
  start_date             date,
  end_date               date,
  is_personal            boolean NOT NULL DEFAULT false,
  notes                  text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT debts_pkey PRIMARY KEY (id),
  CONSTRAINT debts_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT debts_bank_account_id_fkey
    FOREIGN KEY (bank_account_id) REFERENCES public.bank_accounts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_debts_org_kind
  ON public.debts USING btree (organization_id, kind);

CREATE TABLE IF NOT EXISTS public.debt_payments (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL,
  debt_id             uuid NOT NULL,
  bank_transaction_id uuid,
  paid_at             timestamptz NOT NULL,
  total_cents         bigint NOT NULL,
  principal_cents     bigint NOT NULL DEFAULT 0,
  interest_cents      bigint NOT NULL DEFAULT 0,
  fees_cents          bigint NOT NULL DEFAULT 0,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT debt_payments_pkey PRIMARY KEY (id),
  CONSTRAINT debt_payments_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE,
  CONSTRAINT debt_payments_debt_id_fkey
    FOREIGN KEY (debt_id) REFERENCES public.debts(id) ON DELETE CASCADE,
  CONSTRAINT debt_payments_bank_transaction_id_fkey
    FOREIGN KEY (bank_transaction_id) REFERENCES public.bank_transactions(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_debt_pay_debt_date
  ON public.debt_payments USING btree (debt_id, paid_at DESC);

ALTER TABLE public.debts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.debt_payments ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY debts_all ON public.debts
    FOR ALL TO authenticated
    USING (organization_id IN (SELECT public.get_accessible_org_ids()))
    WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY debt_pay_all ON public.debt_payments
    FOR ALL TO authenticated
    USING (organization_id IN (SELECT public.get_accessible_org_ids()))
    WITH CHECK (organization_id IN (SELECT public.get_accessible_org_ids()));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
