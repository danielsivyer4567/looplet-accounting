-- Add the same soft-delete convention used by other operational records to debts.
-- Debt payments stay attached for audit/history; active lists filter debts.deleted_at.

ALTER TABLE public.debts
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_debts_org_active_balance
  ON public.debts (organization_id, current_balance_cents DESC)
  WHERE deleted_at IS NULL;
