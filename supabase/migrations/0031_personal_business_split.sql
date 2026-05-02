-- 0031: Personal vs business split for sole traders.
-- Adds is_personal flag to bills + bank_transactions and a per-org rollup view.
-- Personal-flagged rows are excluded from business P&L, BAS calculations, and tax set-aside.

ALTER TABLE public.bills ADD COLUMN IF NOT EXISTS is_personal boolean NOT NULL DEFAULT false;
ALTER TABLE public.bank_transactions ADD COLUMN IF NOT EXISTS is_personal boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS bills_is_personal_idx
  ON public.bills (organization_id, is_personal)
  WHERE deleted_at IS NULL AND is_personal = true;

CREATE INDEX IF NOT EXISTS bank_txns_is_personal_idx
  ON public.bank_transactions (organization_id, is_personal)
  WHERE is_personal = true;

-- Owner personal rollup view (counts + cents totals, both sides)
CREATE OR REPLACE VIEW public.v_personal_expenses AS
SELECT
  organization_id,
  COUNT(*) FILTER (WHERE is_personal = true)                                         AS personal_bill_count,
  COALESCE(SUM(total_inc_gst_cents) FILTER (WHERE is_personal = true), 0)            AS personal_bill_total_cents,
  COUNT(*) FILTER (WHERE is_personal = false)                                        AS business_bill_count,
  COALESCE(SUM(total_inc_gst_cents) FILTER (WHERE is_personal = false), 0)           AS business_bill_total_cents
FROM public.bills
WHERE deleted_at IS NULL
GROUP BY organization_id;

CREATE OR REPLACE VIEW public.v_personal_bank_expenses AS
SELECT
  organization_id,
  COUNT(*) FILTER (WHERE is_personal = true AND amount_cents < 0)                            AS personal_txn_count,
  COALESCE(SUM(-amount_cents) FILTER (WHERE is_personal = true AND amount_cents < 0), 0)     AS personal_outflow_cents
FROM public.bank_transactions
GROUP BY organization_id;
