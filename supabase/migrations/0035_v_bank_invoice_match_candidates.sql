-- 0035: Bank-to-invoice match candidates (mirror of v_bank_match_candidates for AR side).
-- Positive bank inflows scored against outstanding invoices (within $0.50 amount and 60d).

CREATE OR REPLACE VIEW public.v_bank_invoice_match_candidates AS
SELECT
  bt.id                       AS bank_transaction_id,
  bt.organization_id,
  bt.posted_at::date          AS bt_date,
  bt.amount_cents             AS bt_amount_cents,
  bt.description              AS bt_description,
  i.id                        AS invoice_id,
  i.invoice_number,
  i.issue_date                AS invoice_date,
  i.due_date,
  i.balance_due_cents         AS invoice_balance_due_cents,
  c.id                        AS customer_id,
  c.name                      AS customer_name,
  abs(bt.amount_cents - i.balance_due_cents) AS amount_diff_cents,
  abs(bt.posted_at::date - i.issue_date)     AS days_diff,
  CASE
    WHEN abs(bt.amount_cents - i.balance_due_cents) <= 50
     AND abs(bt.posted_at::date - i.issue_date) <= 60
    THEN
      0.5
      + 0.5 * GREATEST(0, 1 - abs(bt.posted_at::date - i.issue_date) / 60.0)
      + CASE WHEN c.name IS NOT NULL
              AND lower(bt.description) LIKE '%' || lower(c.name) || '%'
             THEN 0.2 ELSE 0 END
      + CASE WHEN i.invoice_number IS NOT NULL
              AND lower(bt.description) LIKE '%' || lower(i.invoice_number) || '%'
             THEN 0.3 ELSE 0 END
    ELSE 0
  END AS score
FROM public.bank_transactions bt
JOIN public.invoices i
  ON i.organization_id = bt.organization_id
 AND i.deleted_at IS NULL
 AND i.status NOT IN ('paid', 'void')
 AND i.balance_due_cents > 0
LEFT JOIN public.customers c ON c.id = i.customer_id
WHERE bt.matched_bill_id IS NULL
  AND bt.matched_invoice_id IS NULL
  AND bt.amount_cents > 0
  AND abs(bt.amount_cents - i.balance_due_cents) <= 50
  AND abs(bt.posted_at::date - i.issue_date) <= 60;
