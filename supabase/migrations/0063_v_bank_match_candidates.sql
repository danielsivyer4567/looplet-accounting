-- 0063: Bank-to-bill match candidates (AP side) — codify the live definition.
--
-- This view already exists in production (it is the AP mirror of
-- v_bank_invoice_match_candidates from 0035) but its DDL was never committed to
-- the repo. EPIC C2's auto-reconciler reads it, so we capture the exact live
-- definition here (fetched via pg_get_viewdef) before depending on it.
--
-- Negative bank outflows scored against outstanding bills (within $0.50 amount
-- and 14 days). Scoring (max 1.2):
--   base 0.5            (amount within $0.50 AND date within 14d)
--   + up to 0.5         recency bonus (linear over the 14-day window)
--   + 0.2               supplier-name substring hit in the bank description
-- NOTE: unlike the AR view there is NO invoice/reference-number bonus, so the
-- AP max is 1.2 (the AR view maxes at 1.5).
--
-- security_invoker = on so the view honours the caller's RLS (matches live and
-- the AR view in 0035).

CREATE OR REPLACE VIEW public.v_bank_match_candidates
WITH (security_invoker = on) AS
SELECT
  bt.id                       AS bank_transaction_id,
  bt.organization_id,
  bt.posted_at::date          AS bt_date,
  bt.amount_cents             AS bt_amount_cents,
  bt.description              AS bt_description,
  b.id                        AS bill_id,
  b.invoice_date              AS bill_date,
  b.total_inc_gst_cents       AS bill_amount_cents,
  b.invoice_number            AS bill_invoice_number,
  s.id                        AS supplier_id,
  s.name                      AS supplier_name,
  abs(bt.amount_cents) - b.total_inc_gst_cents AS amount_diff_cents,
  abs(bt.posted_at::date - b.invoice_date)     AS days_diff,
  CASE
    WHEN abs(abs(bt.amount_cents) - b.total_inc_gst_cents) <= 50
     AND abs(bt.posted_at::date - b.invoice_date) <= 14
    THEN
      0.5
      + 0.5 * GREATEST(0::numeric, 1::numeric - abs(bt.posted_at::date - b.invoice_date)::numeric / 14.0)
      + CASE WHEN s.name IS NOT NULL
              AND lower(bt.description) LIKE '%' || lower(s.name) || '%'
             THEN 0.2 ELSE 0::numeric END
    ELSE 0::numeric
  END AS score
FROM public.bank_transactions bt
JOIN public.bills b
  ON b.organization_id = bt.organization_id
 AND b.deleted_at IS NULL
 AND b.total_inc_gst_cents IS NOT NULL
 AND b.invoice_date IS NOT NULL
LEFT JOIN public.suppliers s ON s.id = b.supplier_id
WHERE bt.matched_bill_id IS NULL
  AND bt.matched_invoice_id IS NULL
  AND bt.amount_cents < 0
  AND abs(abs(bt.amount_cents) - b.total_inc_gst_cents) <= 50
  AND abs(bt.posted_at::date - b.invoice_date) <= 14;
