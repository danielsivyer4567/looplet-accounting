-- 0041: Balance sheet report views.
--
-- Approximation balance sheet — we don't have a full general-ledger schema
-- yet, so rather than a true GL roll-up this view stitches together the four
-- domains we *do* track:
--
--   Assets:
--     - Cash at bank        : SUM(bank_accounts.current_balance_cents) for
--                             provider != 'manual', plus manual accounts that
--                             have had bank_transactions activity in the last
--                             90 days. Manual accounts with no recent activity
--                             are likely stale stubs and excluded.
--     - Accounts receivable : SUM(invoices.balance_due_cents) for non-paid,
--                             non-void, non-deleted invoices.
--     - Unsettled GST credit: SUM(bills.gst_cents) for current-quarter unpaid
--                             business bills (rough — flagged as approximate
--                             in the UI).
--
--   Liabilities:
--     - Accounts payable    : SUM(bills.total_inc_gst_cents) for non-paid /
--                             non-void / non-personal / non-deleted bills.
--     - Debts (loans/credit): SUM(debts.current_balance_cents) for non-personal.
--     - GST collected owing : SUM(invoices.gst_cents) for current-quarter
--                             non-void invoices (approximation).
--
--   Equity = Assets - Liabilities  (calculated, single line).
--
-- Output shape:
--   organization_id uuid, as_of_date date, category text, line_item text,
--   amount_cents bigint
--
-- category ∈ {'asset', 'liability', 'equity'}.
--
-- Caveats baked into the view name (`v_balance_sheet`) so callers know it is a
-- view and not a GL-derived materialised report. A future 0050+ migration that
-- introduces a true journal_entries / accounts ledger should replace this.

BEGIN;

-- ============================================================================
-- v_balance_sheet — line-item-level
-- ============================================================================

CREATE OR REPLACE VIEW public.v_balance_sheet AS
WITH
  -- ---------------------------------------------------------------------------
  -- Assets
  -- ---------------------------------------------------------------------------
  cash_manual_active AS (
    -- Manual bank accounts with txn activity in the last 90d count toward cash.
    SELECT DISTINCT ba.id
    FROM public.bank_accounts ba
    JOIN public.bank_connections bc ON bc.id = ba.bank_connection_id
    JOIN public.bank_transactions bt ON bt.bank_account_id = ba.id
    WHERE bc.provider = 'manual'
      AND bt.posted_at >= CURRENT_DATE - INTERVAL '90 days'
  ),
  cash_at_bank AS (
    SELECT
      ba.organization_id,
      'asset'::text                                AS category,
      'Cash at bank'::text                         AS line_item,
      COALESCE(SUM(ba.current_balance_cents), 0)   AS amount_cents
    FROM public.bank_accounts ba
    JOIN public.bank_connections bc ON bc.id = ba.bank_connection_id
    WHERE ba.is_active = true
      AND (
        bc.provider <> 'manual'
        OR ba.id IN (SELECT id FROM cash_manual_active)
      )
    GROUP BY ba.organization_id
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

  -- ---------------------------------------------------------------------------
  -- Liabilities
  -- ---------------------------------------------------------------------------
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
      AND d.current_balance_cents IS NOT NULL
    GROUP BY d.organization_id
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

  -- ---------------------------------------------------------------------------
  -- All asset/liability lines unioned, with a per-org scaffold so that orgs
  -- with no bills/invoices/debts still render a 0 row instead of disappearing.
  -- ---------------------------------------------------------------------------
  raw_lines AS (
    SELECT * FROM cash_at_bank
    UNION ALL SELECT * FROM accounts_receivable
    UNION ALL SELECT * FROM unsettled_gst_credit
    UNION ALL SELECT * FROM accounts_payable
    UNION ALL SELECT * FROM debts_business
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
  'Approximate balance sheet. Per-org line items in three categories: asset, liability, equity. Equity is calculated (assets - liabilities). Unsettled GST and current-quarter GST collected are approximations until a proper GL ledger lands.';

-- ============================================================================
-- v_balance_sheet_summary — category roll-up
-- ============================================================================

CREATE OR REPLACE VIEW public.v_balance_sheet_summary AS
SELECT
  organization_id,
  as_of_date,
  category,
  SUM(amount_cents) AS total_cents,
  COUNT(*)          AS line_count
FROM public.v_balance_sheet
GROUP BY organization_id, as_of_date, category;

COMMENT ON VIEW public.v_balance_sheet_summary IS
  'Per-category roll-up of v_balance_sheet (assets / liabilities / equity totals).';

COMMIT;
