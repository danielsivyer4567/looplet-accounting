-- 0038 (BACKFILL): views v_bank_match_candidates and v_customer_pnl.
--
-- RECONSTRUCTION NOTE: Both exist in the LIVE DB but had no repo migration. v_customer_pnl
-- is even referenced by a comment in 0030 ("v_customer_pnl: see migration body in DB").
-- v_bank_match_candidates is queried by the Reconciliation page; v_customer_pnl by the
-- CustomerDetail page. Reconstructed from live via pg_views (read-only MCP, 2026-06-20);
-- pg_views reparses/normalizes the definition, so this is semantically equivalent rather
-- than a byte-for-byte copy. Placed after 0030 (invoices) and the bank_transactions
-- backfill (0008). CREATE OR REPLACE VIEW = safe. See docs/MIGRATION_GAP_AUDIT.md.
--
-- security_invoker = on is REQUIRED: both views are org-scoped and the live DB has it set
-- (verified via pg_class.reloptions, 2026-06-20). Without it the views run as the (owner)
-- definer and bypass RLS, leaking rows across organizations. Matches the 0055 security work.

CREATE OR REPLACE VIEW public.v_bank_match_candidates
  WITH (security_invoker = on) AS
 SELECT bt.id AS bank_transaction_id,
    bt.organization_id,
    (bt.posted_at)::date AS bt_date,
    bt.amount_cents AS bt_amount_cents,
    bt.description AS bt_description,
    b.id AS bill_id,
    b.invoice_date AS bill_date,
    b.total_inc_gst_cents AS bill_amount_cents,
    b.invoice_number AS bill_invoice_number,
    s.id AS supplier_id,
    s.name AS supplier_name,
    (abs(bt.amount_cents) - b.total_inc_gst_cents) AS amount_diff_cents,
    abs(((bt.posted_at)::date - b.invoice_date)) AS days_diff,
        CASE
            WHEN ((abs((abs(bt.amount_cents) - b.total_inc_gst_cents)) <= 50) AND (abs(((bt.posted_at)::date - b.invoice_date)) <= 14)) THEN ((0.5 + (0.5 * GREATEST((0)::numeric, ((1)::numeric - ((abs(((bt.posted_at)::date - b.invoice_date)))::numeric / 14.0))))) +
            CASE
                WHEN ((s.name IS NOT NULL) AND (lower(bt.description) ~~ (('%'::text || lower(s.name)) || '%'::text))) THEN 0.2
                ELSE (0)::numeric
            END)
            ELSE (0)::numeric
        END AS score
   FROM ((bank_transactions bt
     JOIN bills b ON (((b.organization_id = bt.organization_id) AND (b.deleted_at IS NULL) AND (b.total_inc_gst_cents IS NOT NULL) AND (b.invoice_date IS NOT NULL))))
     LEFT JOIN suppliers s ON ((s.id = b.supplier_id)))
  WHERE ((bt.matched_bill_id IS NULL) AND (bt.matched_invoice_id IS NULL) AND (bt.amount_cents < 0) AND (abs((abs(bt.amount_cents) - b.total_inc_gst_cents)) <= 50) AND (abs(((bt.posted_at)::date - b.invoice_date)) <= 14));

CREATE OR REPLACE VIEW public.v_customer_pnl
  WITH (security_invoker = on) AS
 SELECT c.id AS customer_id,
    c.organization_id,
    c.name AS customer_name,
    count(i.id) FILTER (WHERE (i.deleted_at IS NULL)) AS invoice_count,
    COALESCE(sum(i.total_inc_gst_cents) FILTER (WHERE ((i.deleted_at IS NULL) AND (i.status <> 'void'::invoice_status))), (0)::numeric) AS total_invoiced_cents,
    COALESCE(sum(i.amount_paid_cents) FILTER (WHERE (i.deleted_at IS NULL)), (0)::numeric) AS total_paid_cents,
    COALESCE(sum(i.balance_due_cents) FILTER (WHERE ((i.deleted_at IS NULL) AND (i.status <> ALL (ARRAY['void'::invoice_status, 'paid'::invoice_status])))), (0)::numeric) AS balance_owing_cents,
    COALESCE(sum(i.balance_due_cents) FILTER (WHERE ((i.deleted_at IS NULL) AND (i.status = 'overdue'::invoice_status))), (0)::numeric) AS overdue_cents
   FROM (customers c
     LEFT JOIN invoices i ON ((i.customer_id = c.id)))
  WHERE (c.deleted_at IS NULL)
  GROUP BY c.id, c.organization_id, c.name;
