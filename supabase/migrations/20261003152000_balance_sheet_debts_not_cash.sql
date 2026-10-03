-- ============================================================================
-- 20261003152000_balance_sheet_debts_not_cash.sql  (BS-01)
--
-- v_balance_sheet (0041) summed current_balance_cents of every active bank
-- account into "Cash at bank", including credit-card and loan accounts. Since
-- 20260702134500 every active credit-card/loan bank account also has a linked
-- debts row, which "Debts (loans / credit)" adds as a liability. The same
-- balance was therefore counted twice: once inside cash (usually negative) and
-- again as a debt, understating equity by the full card/loan balance.
-- "Debts" also still counted soft-deleted debts (deleted_at, 20260702131500).
--
-- Now:
--   * Cash at bank counts only non-liability accounts (not credit_card / loan),
--     with the same provider / recent-activity rule as before.
--   * Debts (loans / credit) counts business debts that are not deleted.
--   * An active credit-card or loan account with no debt record at all (for
--     example its debt row was deleted) is shown once, as its own liability line
--     at abs(balance), the amount the debts pipeline would record. A personal
--     debt row keeps its account out of the business balance sheet.
-- Output columns, types and security_invoker are unchanged.
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW public.v_balance_sheet
WITH (security_invoker = on) AS
WITH
  cash_manual_active AS (
    -- Manual bank accounts with txn activity in the last 90d count as live.
    SELECT DISTINCT ba.id
    FROM public.bank_accounts ba
    JOIN public.bank_connections bc ON bc.id = ba.bank_connection_id
    JOIN public.bank_transactions bt ON bt.bank_account_id = ba.id
    WHERE bc.provider = 'manual'
      AND bt.posted_at >= CURRENT_DATE - INTERVAL '90 days'
  ),
  live_accounts AS (
    SELECT ba.*
    FROM public.bank_accounts ba
    JOIN public.bank_connections bc ON bc.id = ba.bank_connection_id
    WHERE ba.is_active = true
      AND (
        bc.provider <> 'manual'
        OR ba.id IN (SELECT id FROM cash_manual_active)
      )
  ),
  cash_at_bank AS (
    SELECT
      la.organization_id,
      'asset'::text                                AS category,
      'Cash at bank'::text                         AS line_item,
      COALESCE(SUM(la.current_balance_cents), 0)   AS amount_cents
    FROM live_accounts la
    WHERE la.account_type NOT IN ('credit_card'::public.bank_account_type, 'loan'::public.bank_account_type)
    GROUP BY la.organization_id
  ),
  accounts_receivable AS (
    SELECT
      i.organization_id,
      'asset'::text                                AS category,
      'Accounts receivable'::text                  AS line_item,
      COALESCE(SUM(i.balance_due_cents), 0)        AS amount_cents
    FROM public.invoices i
    WHERE i.deleted_at IS NULL
      AND i.status NOT IN ('paid', 'void')
    GROUP BY i.organization_id
  ),
  unsettled_gst_credit AS (
    SELECT
      b.organization_id,
      'asset'::text                                AS category,
      'Unsettled GST credit (current quarter)'::text AS line_item,
      COALESCE(SUM(b.gst_cents), 0)                AS amount_cents
    FROM public.bills b
    CROSS JOIN LATERAL public.au_bas_quarter(CURRENT_DATE) q
    WHERE b.deleted_at IS NULL
      AND b.is_personal = false
      AND b.status NOT IN ('paid', 'void')
      AND b.invoice_date IS NOT NULL
      AND b.invoice_date BETWEEN q.quarter_start AND q.quarter_end
    GROUP BY b.organization_id
  ),
  accounts_payable AS (
    SELECT
      b.organization_id,
      'liability'::text                            AS category,
      'Accounts payable'::text                     AS line_item,
      COALESCE(SUM(b.total_inc_gst_cents), 0)      AS amount_cents
    FROM public.bills b
    WHERE b.deleted_at IS NULL
      AND b.is_personal = false
      AND b.status NOT IN ('paid', 'void')
    GROUP BY b.organization_id
  ),
  debts_business AS (
    SELECT
      d.organization_id,
      'liability'::text                            AS category,
      'Debts (loans / credit)'::text               AS line_item,
      COALESCE(SUM(d.current_balance_cents), 0)    AS amount_cents
    FROM public.debts d
    WHERE d.is_personal = false
      AND d.deleted_at IS NULL
      AND d.current_balance_cents IS NOT NULL
    GROUP BY d.organization_id
  ),
  liability_accounts_without_debt AS (
    SELECT
      la.organization_id,
      'liability'::text                            AS category,
      'Credit cards and loans (bank feed, no debt record)'::text AS line_item,
      COALESCE(SUM(abs(COALESCE(la.current_balance_cents, 0))), 0) AS amount_cents
    FROM live_accounts la
    WHERE la.account_type IN ('credit_card'::public.bank_account_type, 'loan'::public.bank_account_type)
      AND NOT EXISTS (
        SELECT 1
          FROM public.debts d
         WHERE d.organization_id = la.organization_id
           AND d.bank_account_id = la.id
           AND d.deleted_at IS NULL
      )
    GROUP BY la.organization_id
  ),
  gst_collected_owing AS (
    SELECT
      i.organization_id,
      'liability'::text                            AS category,
      'GST collected owing (current quarter)'::text AS line_item,
      COALESCE(SUM(i.gst_cents), 0)                AS amount_cents
    FROM public.invoices i
    CROSS JOIN LATERAL public.au_bas_quarter(CURRENT_DATE) q
    WHERE i.deleted_at IS NULL
      AND i.status NOT IN ('void')
      AND i.issue_date BETWEEN q.quarter_start AND q.quarter_end
    GROUP BY i.organization_id
  ),
  raw_lines AS (
    SELECT * FROM cash_at_bank
    UNION ALL SELECT * FROM accounts_receivable
    UNION ALL SELECT * FROM unsettled_gst_credit
    UNION ALL SELECT * FROM accounts_payable
    UNION ALL SELECT * FROM debts_business
    UNION ALL SELECT * FROM liability_accounts_without_debt
    UNION ALL SELECT * FROM gst_collected_owing
  ),
  totals AS (
    SELECT
      organization_id,
      SUM(amount_cents) FILTER (WHERE category = 'asset')     AS total_assets,
      SUM(amount_cents) FILTER (WHERE category = 'liability') AS total_liabilities
    FROM raw_lines
    GROUP BY organization_id
  ),
  equity_line AS (
    SELECT
      organization_id,
      'equity'::text                                          AS category,
      'Net equity (assets − liabilities)'::text               AS line_item,
      COALESCE(total_assets, 0) - COALESCE(total_liabilities, 0) AS amount_cents
    FROM totals
  )
SELECT
  organization_id,
  CURRENT_DATE                                            AS as_of_date,
  category,
  line_item,
  amount_cents
FROM raw_lines
UNION ALL
SELECT
  organization_id,
  CURRENT_DATE                                            AS as_of_date,
  category,
  line_item,
  amount_cents
FROM equity_line;

COMMENT ON VIEW public.v_balance_sheet IS
  'Approximate balance sheet. Per-org line items in three categories: asset, liability, '
  'equity (assets - liabilities). Credit-card and loan bank accounts are liabilities, '
  'never cash: they appear through their debt record, or once as their own line when '
  'they have none. Deleted debts are excluded. Unsettled GST and current-quarter GST '
  'collected are approximations until a proper GL ledger lands.';

NOTIFY pgrst, 'reload schema';

COMMIT;
