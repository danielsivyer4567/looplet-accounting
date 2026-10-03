-- ============================================================================
-- 20261003150000_bas_credit_notes_cash_basis.sql  (BAS-01)
--
-- The BAS figures had three errors:
--   * only the accruals (non-cash) basis was supported;
--   * customer and supplier credit notes were left out;
--   * W3 and W4 were reported as 0 although Looplet records no such amounts
--     (and registered PAYG-I orgs got placeholder zeros for T7/5A/5B).
--
-- This migration puts every BAS GST figure on one source view,
-- v_bas_gst_source_rows, and rebuilds v_bas_quarterly, the label helpers, the
-- worksheet, the drilldown, the snapshot RPC, v_gst_reconciliation and the BAS
-- settlement posting on top of it.
--
-- ATO rules applied (all fetched 2026-10-03):
--   Cash basis: GST on a sale is reported in the period the payment is
--   received, and only for the part received; a GST credit is claimed in the
--   period the purchase is paid, only for the part paid. Non-cash (accruals):
--   the period of the invoice or of any payment, whichever is first.
--   https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/accounting-for-gst-in-your-business/choosing-an-accounting-method
--
--   Credit notes are adjustment events. If the sale or purchase has not been
--   reported yet (same BAS period), there is no adjustment: the final amended
--   price is reported, so the credit note reduces G1/1A (sales) or G10/G11/1B
--   (purchases). Otherwise the adjustment goes in the current period; on a cash
--   basis, in the period the refund is paid.
--   https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/completing-your-bas-for-gst/making-adjustments-on-your-activity-statements/when-to-make-adjustments
--   Accounts method: increasing adjustments at 1A, decreasing adjustments at 1B.
--   https://www.ato.gov.au/businesses-and-organisations/gst-excise-and-indirect-taxes/gst/completing-your-bas-for-gst/making-adjustments-on-your-activity-statements/how-to-make-adjustments
--   So a customer credit note dated in a later period is a decreasing adjustment
--   (1B); a supplier credit note dated in a later period is an increasing
--   adjustment (1A).
--
--   W3 (other amounts withheld) and W4 (no-ABN withholding): "If you have
--   nothing to report, leave W3/W4 blank." W5 = W2 + W4 + W3.
--   https://www.ato.gov.au/businesses-and-organisations/preparing-lodging-and-paying/business-activity-statements-bas/pay-as-you-go-payg-withholding
--   Looplet records neither, so both are returned as null with a not_recorded
--   list instead of a computed-looking zero.
--
-- GST accounting basis: new business_profile.gst_accounting_basis
-- ('accruals' | 'cash'). NULL means not chosen; the BAS then uses accruals, the
-- method used before this migration, and says so (basis_source = 'default').
--
-- Known limits (reported, not guessed):
--   * Bills record a single paid_at, so cash-basis purchases count when the
--     whole bill is paid; part payments of bills are not tracked.
--   * Refunds are not recorded. On a cash basis a credit note issued after the
--     customer paid, or after the bill was paid, is listed under needs_review
--     instead of being placed in a period.
--   * Dates of payments are taken in the organisation's state time zone
--     (business_profile.state_code; Australia/Sydney when not set).
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. GST accounting basis setting.
-- ---------------------------------------------------------------------------
ALTER TABLE public.business_profile
  ADD COLUMN IF NOT EXISTS gst_accounting_basis text;

ALTER TABLE public.business_profile
  DROP CONSTRAINT IF EXISTS business_profile_gst_accounting_basis_check;
ALTER TABLE public.business_profile
  ADD CONSTRAINT business_profile_gst_accounting_basis_check
  CHECK (gst_accounting_basis IS NULL OR gst_accounting_basis IN ('accruals', 'cash'));

COMMENT ON COLUMN public.business_profile.gst_accounting_basis IS
  'How the organisation accounts for GST: accruals (non-cash) or cash. NULL = not '
  'chosen; BAS figures then use accruals and report basis_source=default.';

CREATE OR REPLACE FUNCTION public.bas_gst_accounting_basis(p_org uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT bp.gst_accounting_basis FROM public.business_profile bp WHERE bp.organization_id = p_org),
    'accruals'
  );
$$;

COMMENT ON FUNCTION public.bas_gst_accounting_basis(uuid) IS
  'GST accounting basis used for BAS figures: business_profile.gst_accounting_basis, '
  'or accruals when not chosen. SECURITY INVOKER.';

REVOKE ALL ON FUNCTION public.bas_gst_accounting_basis(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bas_gst_accounting_basis(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Small helpers: local dates and the capital share of a bill.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.au_state_timezone(p_state_code text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE upper(COALESCE(p_state_code, ''))
    WHEN 'QLD' THEN 'Australia/Brisbane'
    WHEN 'NSW' THEN 'Australia/Sydney'
    WHEN 'ACT' THEN 'Australia/Sydney'
    WHEN 'VIC' THEN 'Australia/Melbourne'
    WHEN 'TAS' THEN 'Australia/Hobart'
    WHEN 'SA'  THEN 'Australia/Adelaide'
    WHEN 'NT'  THEN 'Australia/Darwin'
    WHEN 'WA'  THEN 'Australia/Perth'
    ELSE 'Australia/Sydney'
  END;
$$;

CREATE OR REPLACE FUNCTION public.bas_local_date(p_ts timestamptz, p_state_code text)
RETURNS date
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT (p_ts AT TIME ZONE public.au_state_timezone(p_state_code))::date;
$$;

COMMENT ON FUNCTION public.bas_local_date(timestamptz, text) IS
  'Calendar date of a timestamp in the organisation''s state time zone, used to place '
  'payments in BAS periods. Australia/Sydney when the state is unknown.';

REVOKE ALL ON FUNCTION public.au_state_timezone(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bas_local_date(timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.au_state_timezone(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bas_local_date(timestamptz, text) TO authenticated, service_role;

-- Share (0..1) of a bill that is a capital purchase (G10). Line-level evidence
-- (account, then supplier GST_ON_CAPITAL treatment) splits the bill
-- proportionally; otherwise a linked fixed asset, a capital auto-category or a
-- GST_ON_CAPITAL supplier makes the whole bill capital. Combines the 0222 and
-- 20260702103000 rules.
CREATE OR REPLACE FUNCTION public.bas_bill_capital_share(p_bill_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH bill AS (
    SELECT b.id, b.organization_id, b.auto_category_code, s.expected_gst_treatment AS supplier_treatment
      FROM public.bills b
      LEFT JOIN public.suppliers s
        ON s.id = b.supplier_id
       AND s.organization_id = b.organization_id
     WHERE b.id = p_bill_id
  ),
  lines AS (
    SELECT
      COALESCE(SUM(bli.total_cents), 0)::numeric AS line_total_cents,
      COALESCE(SUM(bli.total_cents) FILTER (
        WHERE COALESCE(coa.expected_gst_treatment, bill.supplier_treatment) = 'GST_ON_CAPITAL'
      ), 0)::numeric AS capital_line_total_cents
    FROM bill
    JOIN public.bill_line_items bli
      ON bli.bill_id = bill.id
    LEFT JOIN public.chart_of_accounts coa
      ON coa.organization_id = bli.organization_id
     AND coa.code = NULLIF(btrim(bli.account_code), '')
  )
  SELECT CASE
    WHEN lines.line_total_cents > 0 AND lines.capital_line_total_cents > 0
      THEN LEAST(lines.capital_line_total_cents / lines.line_total_cents, 1)
    WHEN bill.supplier_treatment = 'GST_ON_CAPITAL'
      OR bill.auto_category_code IN ('plant_equipment', 'motor_vehicle')
      OR EXISTS (
        SELECT 1 FROM public.fixed_assets fa
         WHERE fa.source_bill_id = bill.id AND fa.deleted_at IS NULL
      )
      THEN 1
    ELSE 0
  END::numeric
  FROM bill CROSS JOIN lines;
$$;

COMMENT ON FUNCTION public.bas_bill_capital_share(uuid) IS
  'Capital (G10) share of a bill, 0..1, from GST_ON_CAPITAL line accounts/supplier '
  'treatment, a linked fixed asset, or a capital auto-category. SECURITY INVOKER.';

REVOKE ALL ON FUNCTION public.bas_bill_capital_share(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bas_bill_capital_share(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. One source row per BAS contribution, for both bases.
--
-- Every row carries the label amounts it adds (negative for a credit note that
-- reduces a same-period figure). Rows exist for both bases for every org;
-- consumers keep rows where gst_accounting_basis = org_gst_accounting_basis.
-- v_gst_reconciliation reads the accruals rows of every org, because the
-- ledger posts GST on an accruals footing.
--
-- Scope (unchanged from v_bas_quarterly): invoices not deleted or void; bills
-- not deleted, personal or non-bill documents, split by
-- v_bill_effective_allocations. New: void bills are excluded; credit notes
-- count only when posted and not deleted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_bas_gst_source_rows
WITH (security_invoker = on) AS
-- 3a. Accruals: invoices, in the period of the invoice or the first payment.
SELECT
  i.organization_id,
  COALESCE(bp.gst_accounting_basis, 'accruals') AS org_gst_accounting_basis,
  'accruals'::text AS gst_accounting_basis,
  q.fy_start_year,
  q.quarter_num,
  a.attribution_date,
  'invoice'::text AS source_type,
  i.id AS source_id,
  i.id AS invoice_id,
  NULL::uuid AS bill_id,
  i.invoice_number AS document_number,
  i.total_inc_gst_cents::bigint AS sales_inc_gst_cents,
  l.export_inc_gst_cents AS export_sales_cents,
  l.gst_free_inc_gst_cents AS gst_free_sales_cents,
  0::bigint AS capital_purchases_cents,
  0::bigint AS noncapital_purchases_cents,
  i.gst_cents::bigint AS gst_on_sales_cents,
  0::bigint AS gst_on_purchases_cents,
  0::bigint AS increasing_adjustment_gst_cents,
  0::bigint AS decreasing_adjustment_gst_cents,
  NULL::text AS review_note
FROM public.invoices i
LEFT JOIN public.business_profile bp
  ON bp.organization_id = i.organization_id
CROSS JOIN LATERAL (
  SELECT LEAST(i.issue_date, MIN(public.bas_local_date(p.paid_at, bp.state_code))) AS attribution_date
    FROM public.invoice_payments p
   WHERE p.invoice_id = i.id
) a
CROSS JOIN LATERAL public.au_bas_quarter(a.attribution_date) q
CROSS JOIN LATERAL (
  SELECT
    COALESCE(SUM(ili.line_total_inc_gst_cents) FILTER (
      WHERE coa.expected_gst_treatment = 'EXPORT'
    ), 0)::bigint AS export_inc_gst_cents,
    COALESCE(SUM(ili.line_total_inc_gst_cents) FILTER (
      WHERE ili.gst_treatment = 'free'::public.invoice_gst_treatment
        AND COALESCE(coa.expected_gst_treatment, '') <> 'EXPORT'
    ), 0)::bigint AS gst_free_inc_gst_cents
  FROM public.invoice_line_items ili
  LEFT JOIN public.chart_of_accounts coa
    ON coa.organization_id = ili.organization_id
   AND coa.code = NULLIF(btrim(ili.account_code), '')
  WHERE ili.invoice_id = i.id
) l
WHERE i.deleted_at IS NULL
  AND i.status <> 'void'::public.invoice_status

UNION ALL

-- 3b. Accruals: customer credit notes. Same period as the invoice -> reduce
-- G1/1A (and G2/G3 for a GST-free note). Later period -> decreasing adjustment.
SELECT
  i.organization_id,
  COALESCE(bp.gst_accounting_basis, 'accruals'),
  'accruals'::text,
  cq.fy_start_year,
  cq.quarter_num,
  GREATEST(cn.credit_note_date, a.attribution_date),
  'customer_credit_note'::text,
  cn.id,
  i.id,
  NULL::uuid,
  cn.credit_note_number,
  CASE WHEN s.same_period THEN -cn.total_inc_gst_cents ELSE 0 END::bigint,
  CASE WHEN s.same_period AND cn.gst_cents = 0 AND coa.expected_gst_treatment = 'EXPORT'
       THEN -cn.total_inc_gst_cents ELSE 0 END::bigint,
  CASE WHEN s.same_period AND cn.gst_cents = 0 AND COALESCE(coa.expected_gst_treatment, '') <> 'EXPORT'
       THEN -cn.total_inc_gst_cents ELSE 0 END::bigint,
  0::bigint,
  0::bigint,
  CASE WHEN s.same_period THEN -cn.gst_cents ELSE 0 END::bigint,
  0::bigint,
  0::bigint,
  CASE WHEN s.same_period THEN 0 ELSE cn.gst_cents END::bigint,
  NULL::text
FROM public.customer_credit_notes cn
JOIN public.invoices i
  ON i.id = cn.invoice_id
 AND i.organization_id = cn.organization_id
LEFT JOIN public.business_profile bp
  ON bp.organization_id = i.organization_id
LEFT JOIN public.chart_of_accounts coa
  ON coa.organization_id = cn.organization_id
 AND coa.code = NULLIF(btrim(cn.revenue_account_code), '')
CROSS JOIN LATERAL (
  SELECT LEAST(i.issue_date, MIN(public.bas_local_date(p.paid_at, bp.state_code))) AS attribution_date
    FROM public.invoice_payments p
   WHERE p.invoice_id = i.id
) a
CROSS JOIN LATERAL public.au_bas_quarter(a.attribution_date) iq
CROSS JOIN LATERAL public.au_bas_quarter(GREATEST(cn.credit_note_date, a.attribution_date)) cq
CROSS JOIN LATERAL (
  SELECT (cq.fy_start_year, cq.quarter_num) = (iq.fy_start_year, iq.quarter_num) AS same_period
) s
WHERE cn.deleted_at IS NULL
  AND cn.status = 'posted'::public.credit_note_status
  AND i.deleted_at IS NULL
  AND i.status <> 'void'::public.invoice_status

UNION ALL

-- 3c. Accruals: bills, in the period of the supplier invoice or the payment.
SELECT
  bea.organization_id,
  COALESCE(bp.gst_accounting_basis, 'accruals'),
  'accruals'::text,
  q.fy_start_year,
  q.quarter_num,
  a.attribution_date,
  'bill'::text,
  b.id,
  NULL::uuid,
  b.id,
  b.invoice_number,
  0::bigint,
  0::bigint,
  0::bigint,
  ROUND(p.inc_gst_cents * p.capital_share)::bigint,
  (p.inc_gst_cents - ROUND(p.inc_gst_cents * p.capital_share))::bigint,
  0::bigint,
  COALESCE(bea.effective_gst_cents, 0)::bigint,
  0::bigint,
  0::bigint,
  NULL::text
FROM public.v_bill_effective_allocations bea
JOIN public.bills b
  ON b.id = bea.bill_id
LEFT JOIN public.business_profile bp
  ON bp.organization_id = bea.organization_id
CROSS JOIN LATERAL (
  SELECT LEAST(b.invoice_date, public.bas_local_date(b.paid_at, bp.state_code)) AS attribution_date
) a
CROSS JOIN LATERAL public.au_bas_quarter(a.attribution_date) q
CROSS JOIN LATERAL (
  SELECT
    (COALESCE(bea.effective_subtotal_ex_gst_cents, 0) + COALESCE(bea.effective_gst_cents, 0))::bigint AS inc_gst_cents,
    public.bas_bill_capital_share(b.id) AS capital_share
) p
WHERE b.deleted_at IS NULL
  AND b.status <> 'void'::public.bill_status
  AND b.is_personal = false
  AND b.is_probable_bill = true
  AND b.invoice_date IS NOT NULL

UNION ALL

-- 3d. Accruals: supplier credit notes, split like their bill. Same period as
-- the bill -> reduce G10/G11/1B. Later period -> increasing adjustment.
SELECT
  bea.organization_id,
  COALESCE(bp.gst_accounting_basis, 'accruals'),
  'accruals'::text,
  cq.fy_start_year,
  cq.quarter_num,
  GREATEST(scn.credit_note_date, a.attribution_date),
  'supplier_credit_note'::text,
  scn.id,
  NULL::uuid,
  b.id,
  scn.credit_note_number,
  0::bigint,
  0::bigint,
  0::bigint,
  CASE WHEN s.same_period THEN -ROUND(c.inc_gst_cents * c.capital_share) ELSE 0 END::bigint,
  CASE WHEN s.same_period THEN -(c.inc_gst_cents - ROUND(c.inc_gst_cents * c.capital_share)) ELSE 0 END::bigint,
  0::bigint,
  CASE WHEN s.same_period THEN -c.gst_cents ELSE 0 END::bigint,
  CASE WHEN s.same_period THEN 0 ELSE c.gst_cents END::bigint,
  0::bigint,
  NULL::text
FROM public.supplier_credit_notes scn
JOIN public.bills b
  ON b.id = scn.bill_id
 AND b.organization_id = scn.organization_id
JOIN public.v_bill_effective_allocations bea
  ON bea.bill_id = b.id
LEFT JOIN public.business_profile bp
  ON bp.organization_id = bea.organization_id
CROSS JOIN LATERAL (
  SELECT LEAST(b.invoice_date, public.bas_local_date(b.paid_at, bp.state_code)) AS attribution_date
) a
CROSS JOIN LATERAL public.au_bas_quarter(a.attribution_date) bq
CROSS JOIN LATERAL public.au_bas_quarter(GREATEST(scn.credit_note_date, a.attribution_date)) cq
CROSS JOIN LATERAL (
  SELECT (cq.fy_start_year, cq.quarter_num) = (bq.fy_start_year, bq.quarter_num) AS same_period
) s
CROSS JOIN LATERAL (
  SELECT
    ROUND(scn.total_inc_gst_cents * bea.percentage / 100)::bigint AS inc_gst_cents,
    ROUND(scn.gst_cents * bea.percentage / 100)::bigint AS gst_cents,
    public.bas_bill_capital_share(b.id) AS capital_share
) c
WHERE scn.deleted_at IS NULL
  AND scn.status = 'posted'::public.credit_note_status
  AND b.deleted_at IS NULL
  AND b.status <> 'void'::public.bill_status
  AND b.is_personal = false
  AND b.is_probable_bill = true
  AND b.invoice_date IS NOT NULL

UNION ALL

-- 3e. Cash: each payment received, in the period it was received. The GST
-- (and G2/G3) share follows the invoice's amended price: invoice totals less
-- the posted credit notes dated on or before the payment.
SELECT
  i.organization_id,
  COALESCE(bp.gst_accounting_basis, 'accruals'),
  'cash'::text,
  q.fy_start_year,
  q.quarter_num,
  d.paid_date,
  'invoice_payment'::text,
  p.id,
  i.id,
  NULL::uuid,
  i.invoice_number,
  p.amount_cents::bigint,
  COALESCE(ROUND(p.amount_cents * n.export_cents / n.total_cents), 0)::bigint,
  COALESCE(ROUND(p.amount_cents * n.gst_free_cents / n.total_cents), 0)::bigint,
  0::bigint,
  0::bigint,
  COALESCE(ROUND(p.amount_cents * n.gst_cents / n.total_cents), 0)::bigint,
  0::bigint,
  0::bigint,
  0::bigint,
  NULL::text
FROM public.invoice_payments p
JOIN public.invoices i
  ON i.id = p.invoice_id
LEFT JOIN public.business_profile bp
  ON bp.organization_id = i.organization_id
CROSS JOIN LATERAL (SELECT public.bas_local_date(p.paid_at, bp.state_code) AS paid_date) d
CROSS JOIN LATERAL public.au_bas_quarter(d.paid_date) q
CROSS JOIN LATERAL (
  SELECT
    COALESCE(SUM(ili.line_total_inc_gst_cents) FILTER (
      WHERE coa.expected_gst_treatment = 'EXPORT'
    ), 0)::bigint AS export_inc_gst_cents,
    COALESCE(SUM(ili.line_total_inc_gst_cents) FILTER (
      WHERE ili.gst_treatment = 'free'::public.invoice_gst_treatment
        AND COALESCE(coa.expected_gst_treatment, '') <> 'EXPORT'
    ), 0)::bigint AS gst_free_inc_gst_cents
  FROM public.invoice_line_items ili
  LEFT JOIN public.chart_of_accounts coa
    ON coa.organization_id = ili.organization_id
   AND coa.code = NULLIF(btrim(ili.account_code), '')
  WHERE ili.invoice_id = i.id
) l
CROSS JOIN LATERAL (
  SELECT
    COALESCE(SUM(cn.total_inc_gst_cents), 0)::bigint AS total_cents,
    COALESCE(SUM(cn.gst_cents), 0)::bigint AS gst_cents,
    COALESCE(SUM(cn.total_inc_gst_cents) FILTER (
      WHERE cn.gst_cents = 0 AND coa.expected_gst_treatment = 'EXPORT'
    ), 0)::bigint AS export_cents,
    COALESCE(SUM(cn.total_inc_gst_cents) FILTER (
      WHERE cn.gst_cents = 0 AND COALESCE(coa.expected_gst_treatment, '') <> 'EXPORT'
    ), 0)::bigint AS gst_free_cents
  FROM public.customer_credit_notes cn
  LEFT JOIN public.chart_of_accounts coa
    ON coa.organization_id = cn.organization_id
   AND coa.code = NULLIF(btrim(cn.revenue_account_code), '')
  WHERE cn.invoice_id = i.id
    AND cn.deleted_at IS NULL
    AND cn.status = 'posted'::public.credit_note_status
    AND cn.credit_note_date <= d.paid_date
) c
CROSS JOIN LATERAL (
  SELECT
    CASE WHEN i.total_inc_gst_cents - c.total_cents > 0
         THEN i.total_inc_gst_cents - c.total_cents
         ELSE NULLIF(i.total_inc_gst_cents, 0) END::numeric AS total_cents,
    CASE WHEN i.total_inc_gst_cents - c.total_cents > 0
         THEN GREATEST(i.gst_cents - c.gst_cents, 0)
         ELSE i.gst_cents END::numeric AS gst_cents,
    CASE WHEN i.total_inc_gst_cents - c.total_cents > 0
         THEN GREATEST(l.export_inc_gst_cents - c.export_cents, 0)
         ELSE l.export_inc_gst_cents END::numeric AS export_cents,
    CASE WHEN i.total_inc_gst_cents - c.total_cents > 0
         THEN GREATEST(l.gst_free_inc_gst_cents - c.gst_free_cents, 0)
         ELSE l.gst_free_inc_gst_cents END::numeric AS gst_free_cents
) n
WHERE i.deleted_at IS NULL
  AND i.status <> 'void'::public.invoice_status

UNION ALL

-- 3f. Cash: bills, in the period the bill was paid (bills record one paid_at,
-- so a bill counts once it is paid in full). Supplier credit notes dated on or
-- before the payment reduce the amount paid.
SELECT
  bea.organization_id,
  COALESCE(bp.gst_accounting_basis, 'accruals'),
  'cash'::text,
  q.fy_start_year,
  q.quarter_num,
  d.paid_date,
  'bill_payment'::text,
  b.id,
  NULL::uuid,
  b.id,
  b.invoice_number,
  0::bigint,
  0::bigint,
  0::bigint,
  ROUND(n.inc_gst_cents * n.capital_share)::bigint,
  (n.inc_gst_cents - ROUND(n.inc_gst_cents * n.capital_share))::bigint,
  0::bigint,
  n.gst_cents,
  0::bigint,
  0::bigint,
  NULL::text
FROM public.v_bill_effective_allocations bea
JOIN public.bills b
  ON b.id = bea.bill_id
LEFT JOIN public.business_profile bp
  ON bp.organization_id = bea.organization_id
CROSS JOIN LATERAL (SELECT public.bas_local_date(b.paid_at, bp.state_code) AS paid_date) d
CROSS JOIN LATERAL public.au_bas_quarter(d.paid_date) q
CROSS JOIN LATERAL (
  SELECT
    COALESCE(SUM(ROUND(scn.total_inc_gst_cents * bea.percentage / 100)), 0)::bigint AS total_cents,
    COALESCE(SUM(ROUND(scn.gst_cents * bea.percentage / 100)), 0)::bigint AS gst_cents
  FROM public.supplier_credit_notes scn
  WHERE scn.bill_id = b.id
    AND scn.deleted_at IS NULL
    AND scn.status = 'posted'::public.credit_note_status
    AND scn.credit_note_date <= d.paid_date
) c
CROSS JOIN LATERAL (
  SELECT
    GREATEST(
      COALESCE(bea.effective_subtotal_ex_gst_cents, 0) + COALESCE(bea.effective_gst_cents, 0) - c.total_cents,
      0
    )::bigint AS inc_gst_cents,
    GREATEST(COALESCE(bea.effective_gst_cents, 0) - c.gst_cents, 0)::bigint AS gst_cents,
    public.bas_bill_capital_share(b.id) AS capital_share
) n
WHERE b.paid_at IS NOT NULL
  AND b.deleted_at IS NULL
  AND b.status <> 'void'::public.bill_status
  AND b.is_personal = false
  AND b.is_probable_bill = true

UNION ALL

-- 3g. Cash: a customer credit note issued after the customer had paid more
-- than the amended price. The adjustment belongs to the period the refund is
-- paid; refunds are not recorded, so the note is listed for review only.
SELECT
  i.organization_id,
  COALESCE(bp.gst_accounting_basis, 'accruals'),
  'cash'::text,
  q.fy_start_year,
  q.quarter_num,
  cn.credit_note_date,
  'customer_credit_note'::text,
  cn.id,
  i.id,
  NULL::uuid,
  cn.credit_note_number,
  0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint,
  'Credit note issued after the customer paid. On a cash basis the GST adjustment belongs in the '
  'period the refund is paid, and Looplet has no record of the refund. Check it and adjust this BAS '
  'yourself if a refund was paid.'::text
FROM public.customer_credit_notes cn
JOIN public.invoices i
  ON i.id = cn.invoice_id
 AND i.organization_id = cn.organization_id
LEFT JOIN public.business_profile bp
  ON bp.organization_id = i.organization_id
CROSS JOIN LATERAL public.au_bas_quarter(cn.credit_note_date) q
CROSS JOIN LATERAL (
  SELECT COALESCE(SUM(p.amount_cents), 0)::bigint AS paid_cents
    FROM public.invoice_payments p
   WHERE p.invoice_id = i.id
     AND public.bas_local_date(p.paid_at, bp.state_code) <= cn.credit_note_date
) pd
CROSS JOIN LATERAL (
  SELECT COALESCE(SUM(c2.total_inc_gst_cents), 0)::bigint AS credited_cents
    FROM public.customer_credit_notes c2
   WHERE c2.invoice_id = i.id
     AND c2.deleted_at IS NULL
     AND c2.status = 'posted'::public.credit_note_status
     AND c2.credit_note_date <= cn.credit_note_date
) cr
WHERE cn.deleted_at IS NULL
  AND cn.status = 'posted'::public.credit_note_status
  AND i.deleted_at IS NULL
  AND i.status <> 'void'::public.invoice_status
  AND pd.paid_cents > i.total_inc_gst_cents - cr.credited_cents

UNION ALL

-- 3h. Cash: a supplier credit note dated after the bill was paid (a refund or
-- credit from the supplier). Listed for review only, as for 3g.
SELECT
  bea.organization_id,
  COALESCE(bp.gst_accounting_basis, 'accruals'),
  'cash'::text,
  q.fy_start_year,
  q.quarter_num,
  scn.credit_note_date,
  'supplier_credit_note'::text,
  scn.id,
  NULL::uuid,
  b.id,
  scn.credit_note_number,
  0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint,
  'Supplier credit note dated after the bill was paid. On a cash basis the GST adjustment belongs in '
  'the period the supplier refund is received, and Looplet has no record of the refund. Check it and '
  'adjust this BAS yourself if a refund was received.'::text
FROM public.supplier_credit_notes scn
JOIN public.bills b
  ON b.id = scn.bill_id
 AND b.organization_id = scn.organization_id
JOIN public.v_bill_effective_allocations bea
  ON bea.bill_id = b.id
LEFT JOIN public.business_profile bp
  ON bp.organization_id = bea.organization_id
CROSS JOIN LATERAL public.au_bas_quarter(scn.credit_note_date) q
WHERE scn.deleted_at IS NULL
  AND scn.status = 'posted'::public.credit_note_status
  AND b.paid_at IS NOT NULL
  AND scn.credit_note_date > public.bas_local_date(b.paid_at, bp.state_code)
  AND b.deleted_at IS NULL
  AND b.status <> 'void'::public.bill_status
  AND b.is_personal = false
  AND b.is_probable_bill = true;

COMMENT ON VIEW public.v_bas_gst_source_rows IS
  'One row per BAS GST contribution (invoice, payment, bill, credit note) for both the '
  'accruals and cash bases, with the BAS label amounts it adds. Keep rows where '
  'gst_accounting_basis = org_gst_accounting_basis for the organisation''s BAS. '
  'Credit notes reduce same-period figures or are adjustments (increasing -> 1A, '
  'decreasing -> 1B). review_note marks rows Looplet cannot place. SECURITY INVOKER.';

REVOKE ALL ON public.v_bas_gst_source_rows FROM PUBLIC, anon;
GRANT SELECT ON public.v_bas_gst_source_rows TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. v_bas_quarterly on the source rows (columns kept; new ones appended).
-- gst_collected_cents = label 1A and gst_paid_cents = label 1B, so the
-- quarterly table and the worksheet agree; period dates are now filled for
-- bills-only quarters too.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_bas_quarterly
WITH (security_invoker = on) AS
SELECT
  t.organization_id,
  t.fy_start_year,
  t.quarter_num,
  period.quarter_start,
  period.quarter_end,
  period.due_date,
  (t.gst_on_sales_cents + t.increasing_cents) AS gst_collected_cents,
  (t.gst_on_purchases_cents + t.decreasing_cents) AS gst_paid_cents,
  (t.gst_on_sales_cents + t.increasing_cents) - (t.gst_on_purchases_cents + t.decreasing_cents) AS net_gst_cents,
  (t.sales_inc_gst_cents - t.gst_on_sales_cents) AS sales_ex_gst_cents,
  (t.purchases_inc_gst_cents - t.gst_on_purchases_cents) AS purchases_ex_gst_cents,
  t.invoice_count,
  t.bill_count,
  t.gst_accounting_basis,
  t.increasing_cents AS increasing_adjustments_gst_cents,
  t.decreasing_cents AS decreasing_adjustments_gst_cents
FROM (
  SELECT
    r.organization_id,
    r.fy_start_year,
    r.quarter_num,
    MIN(r.org_gst_accounting_basis) AS gst_accounting_basis,
    COALESCE(SUM(r.sales_inc_gst_cents), 0)::numeric AS sales_inc_gst_cents,
    COALESCE(SUM(r.capital_purchases_cents + r.noncapital_purchases_cents), 0)::numeric AS purchases_inc_gst_cents,
    COALESCE(SUM(r.gst_on_sales_cents), 0)::numeric AS gst_on_sales_cents,
    COALESCE(SUM(r.gst_on_purchases_cents), 0)::numeric AS gst_on_purchases_cents,
    COALESCE(SUM(r.increasing_adjustment_gst_cents), 0)::numeric AS increasing_cents,
    COALESCE(SUM(r.decreasing_adjustment_gst_cents), 0)::numeric AS decreasing_cents,
    COUNT(DISTINCT r.invoice_id) FILTER (WHERE r.source_type IN ('invoice', 'invoice_payment'))::bigint AS invoice_count,
    COUNT(DISTINCT r.bill_id) FILTER (WHERE r.source_type IN ('bill', 'bill_payment'))::bigint AS bill_count
  FROM public.v_bas_gst_source_rows r
  WHERE r.gst_accounting_basis = r.org_gst_accounting_basis
  GROUP BY r.organization_id, r.fy_start_year, r.quarter_num
) t
CROSS JOIN LATERAL public.bas_quarter_period(t.fy_start_year, t.quarter_num) period;

COMMENT ON VIEW public.v_bas_quarterly IS
  'BAS GST per org and AU FY quarter on the organisation''s GST accounting basis '
  '(gst_accounting_basis), including credit notes. gst_collected_cents = 1A and '
  'gst_paid_cents = 1B (both include adjustments, also shown separately). '
  'SECURITY INVOKER.';

GRANT SELECT ON public.v_bas_quarterly TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. GL reconciliation compares the ledger with the accruals figures
-- (credit notes included) whatever basis the org reports on.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_gst_reconciliation
  WITH (security_invoker = true) AS
WITH bas AS (
  SELECT organization_id,
         SUM(gst_on_sales_cents + increasing_adjustment_gst_cents
             - gst_on_purchases_cents - decreasing_adjustment_gst_cents)::bigint AS bas_net_gst_owed_cents
  FROM public.v_bas_gst_source_rows
  WHERE gst_accounting_basis = 'accruals'
  GROUP BY organization_id
),
gl AS (
  SELECT sa.organization_id,
         (- SUM(tb.net_cents))::bigint AS gl_net_gst_owed_cents
  FROM public.system_accounts sa
  JOIN public.v_trial_balance tb ON tb.account_id = sa.account_id
  WHERE sa.role IN ('gst_collected', 'gst_paid')
    AND sa.deleted_at IS NULL
  GROUP BY sa.organization_id
),
joined AS (
  SELECT
    COALESCE(bas.organization_id, gl.organization_id) AS organization_id,
    COALESCE(bas.bas_net_gst_owed_cents, 0) AS bas_net_gst_owed_cents,
    COALESCE(gl.gl_net_gst_owed_cents, 0) AS gl_net_gst_owed_cents
  FROM bas
  FULL JOIN gl ON gl.organization_id = bas.organization_id
)
SELECT
  organization_id,
  bas_net_gst_owed_cents,
  gl_net_gst_owed_cents,
  bas_net_gst_owed_cents - gl_net_gst_owed_cents AS variance_cents,
  (bas_net_gst_owed_cents - gl_net_gst_owed_cents) = 0 AS is_reconciled
FROM joined;

COMMENT ON VIEW public.v_gst_reconciliation IS
  'Per-org GST reconciliation: accruals-basis net GST from v_bas_gst_source_rows '
  '(invoices, bills and credit notes, all quarters) vs the GL GST control-account '
  'balance. Uses accruals figures for cash-basis orgs too, because the ledger posts '
  'GST when documents are issued. variance_cents=0 when reconciled. SECURITY INVOKER.';

-- ---------------------------------------------------------------------------
-- 6. Label helpers (signatures unchanged).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_bas_worksheet_gst_labels(
  p_org uuid,
  p_fy_start_year integer,
  p_quarter integer
)
RETURNS TABLE (
  g1_total_sales_cents bigint,
  g2_export_sales_cents bigint,
  g3_gst_free_sales_cents bigint,
  g10_capital_purchases_cents bigint,
  g11_noncapital_purchases_cents bigint,
  label_1a_gst_on_sales_cents bigint,
  label_1b_gst_on_purchases_cents bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    COALESCE(SUM(r.sales_inc_gst_cents), 0)::bigint,
    COALESCE(SUM(r.export_sales_cents), 0)::bigint,
    COALESCE(SUM(r.gst_free_sales_cents), 0)::bigint,
    COALESCE(SUM(r.capital_purchases_cents), 0)::bigint,
    COALESCE(SUM(r.noncapital_purchases_cents), 0)::bigint,
    COALESCE(SUM(r.gst_on_sales_cents + r.increasing_adjustment_gst_cents), 0)::bigint,
    COALESCE(SUM(r.gst_on_purchases_cents + r.decreasing_adjustment_gst_cents), 0)::bigint
  FROM public.v_bas_gst_source_rows r
  WHERE r.organization_id = p_org
    AND r.fy_start_year = p_fy_start_year
    AND r.quarter_num = p_quarter
    AND r.gst_accounting_basis = r.org_gst_accounting_basis;
$$;

COMMENT ON FUNCTION public.generate_bas_worksheet_gst_labels(uuid, integer, integer) IS
  'BAS GST labels G1/G2/G3/G10/G11/1A/1B for an org + AU FY quarter on the org''s GST '
  'accounting basis, from v_bas_gst_source_rows. Credit notes reduce same-period '
  'figures; later-period credit notes are adjustments (supplier -> 1A, customer -> '
  '1B). SECURITY INVOKER and RLS scoped.';

REVOKE ALL ON FUNCTION public.generate_bas_worksheet_gst_labels(uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_bas_worksheet_gst_labels(uuid, integer, integer)
  TO authenticated, service_role;

-- The 0120 signature, as a wrapper again (20260702103000 had re-implemented it
-- without credit notes or the cash basis).
CREATE OR REPLACE FUNCTION public.generate_bas_worksheet_gst(
  p_org uuid,
  p_fy_start_year integer,
  p_quarter integer
)
RETURNS TABLE (
  g1_total_sales_cents bigint,
  g10_capital_purchases_cents bigint,
  g11_noncapital_purchases_cents bigint,
  label_1a_gst_on_sales_cents bigint,
  label_1b_gst_on_purchases_cents bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    g.g1_total_sales_cents,
    g.g10_capital_purchases_cents,
    g.g11_noncapital_purchases_cents,
    g.label_1a_gst_on_sales_cents,
    g.label_1b_gst_on_purchases_cents
  FROM public.generate_bas_worksheet_gst_labels(p_org, p_fy_start_year, p_quarter) g;
$$;

COMMENT ON FUNCTION public.generate_bas_worksheet_gst(uuid, integer, integer) IS
  'Compatibility wrapper for the 0120 GST helper signature over '
  'generate_bas_worksheet_gst_labels() (credit notes and GST accounting basis included).';

REVOKE ALL ON FUNCTION public.generate_bas_worksheet_gst(uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_bas_worksheet_gst(uuid, integer, integer)
  TO authenticated, service_role;

-- W3 and W4 have no source in Looplet: null, never 0. W5 and label 4 are W2
-- (the only withholding Looplet records).
CREATE OR REPLACE FUNCTION public.generate_bas_worksheet_payg_labels(
  p_org uuid,
  p_fy_start_year integer,
  p_quarter integer
)
RETURNS TABLE (
  w1_total_salary_wages_cents bigint,
  w2_payg_withheld_cents bigint,
  w3_other_withheld_cents bigint,
  w4_no_abn_withheld_cents bigint,
  w5_total_withheld_cents bigint,
  label_4_payg_withheld_cents bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    COALESCE(SUM(ps.gross_total_cents), 0)::bigint,
    COALESCE(SUM(ps.payg_tax_cents), 0)::bigint,
    NULL::bigint,
    NULL::bigint,
    COALESCE(SUM(ps.payg_tax_cents), 0)::bigint,
    COALESCE(SUM(ps.payg_tax_cents), 0)::bigint
  FROM public.pay_slips ps
  JOIN public.pay_runs pr
    ON pr.id = ps.pay_run_id
  CROSS JOIN LATERAL public.au_bas_quarter(pr.pay_date) q
  WHERE ps.organization_id = p_org
    AND pr.status IN ('approved', 'paid')
    AND q.fy_start_year = p_fy_start_year
    AND q.quarter_num = p_quarter;
$$;

COMMENT ON FUNCTION public.generate_bas_worksheet_payg_labels(uuid, integer, integer) IS
  'BAS PAYG withholding labels for finalised pay runs in the quarter. W3 and W4 are '
  'NULL: Looplet records no other or no-ABN withholding, and the ATO says to leave '
  'those labels blank when there is nothing to report. W5 and label 4 equal W2.';

REVOKE ALL ON FUNCTION public.generate_bas_worksheet_payg_labels(uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_bas_worksheet_payg_labels(uuid, integer, integer)
  TO authenticated, service_role;

-- PAYG instalment amounts are null (not 0) until the ATO-notified amount is entered.
CREATE OR REPLACE FUNCTION public.generate_bas_worksheet_payg_instalment(
  p_org uuid,
  p_fy_start_year integer,
  p_quarter integer
)
RETURNS TABLE (
  t7_payg_instalment_income_cents bigint,
  label_5a_payg_instalment_cents bigint,
  label_5b_payg_instalment_credit_cents bigint,
  source_status text,
  source_id uuid,
  source_reference text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    i.t7_payg_instalment_income_cents::bigint,
    i.label_5a_payg_instalment_cents::bigint,
    i.label_5b_payg_instalment_credit_cents::bigint,
    CASE WHEN i.id IS NULL THEN 'missing' ELSE 'provided' END::text,
    i.id,
    i.source_reference
  FROM (SELECT 1) base
  LEFT JOIN public.bas_payg_instalment_amounts i
    ON i.organization_id = p_org
   AND i.fy_start_year = p_fy_start_year
   AND i.quarter_num = p_quarter
   AND i.deleted_at IS NULL;
$$;

COMMENT ON FUNCTION public.generate_bas_worksheet_payg_instalment(uuid, integer, integer) IS
  'PAYG instalment labels T7/5A/5B for a BAS quarter from bas_payg_instalment_amounts. '
  'Amounts are NULL with source_status=missing until the ATO-notified amount is entered.';

REVOKE ALL ON FUNCTION public.generate_bas_worksheet_payg_instalment(uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_bas_worksheet_payg_instalment(uuid, integer, integer)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Source drilldown.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_bas_worksheet_source_drilldown(
  p_org uuid,
  p_fy_start_year integer,
  p_quarter integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH gst_rows AS (
    SELECT r.*,
      (jsonb_build_array()
        || CASE WHEN r.sales_inc_gst_cents <> 0 THEN '["G1"]'::jsonb ELSE '[]'::jsonb END
        || CASE WHEN r.export_sales_cents <> 0 THEN '["G2"]'::jsonb ELSE '[]'::jsonb END
        || CASE WHEN r.gst_free_sales_cents <> 0 THEN '["G3"]'::jsonb ELSE '[]'::jsonb END
        || CASE WHEN r.capital_purchases_cents <> 0 THEN '["G10"]'::jsonb ELSE '[]'::jsonb END
        || CASE WHEN r.noncapital_purchases_cents <> 0 THEN '["G11"]'::jsonb ELSE '[]'::jsonb END
        || CASE WHEN r.gst_on_sales_cents <> 0 OR r.increasing_adjustment_gst_cents <> 0
                THEN '["1A"]'::jsonb ELSE '[]'::jsonb END
        || CASE WHEN r.gst_on_purchases_cents <> 0 OR r.decreasing_adjustment_gst_cents <> 0
                THEN '["1B"]'::jsonb ELSE '[]'::jsonb END
      ) AS labels
    FROM public.v_bas_gst_source_rows r
    WHERE r.organization_id = p_org
      AND r.fy_start_year = p_fy_start_year
      AND r.quarter_num = p_quarter
      AND r.gst_accounting_basis = r.org_gst_accounting_basis
  ),
  payg_rows AS (
    SELECT
      pr.id AS pay_run_id,
      pr.pay_date,
      pr.status::text AS pay_run_status,
      ps.id AS pay_slip_id,
      ps.employee_id,
      ps.gross_total_cents::bigint AS gross_total_cents,
      ps.payg_tax_cents::bigint AS payg_tax_cents
    FROM public.pay_slips ps
    JOIN public.pay_runs pr
      ON pr.id = ps.pay_run_id
    CROSS JOIN LATERAL public.au_bas_quarter(pr.pay_date) q
    WHERE ps.organization_id = p_org
      AND pr.status IN ('approved', 'paid')
      AND q.fy_start_year = p_fy_start_year
      AND q.quarter_num = p_quarter
  ),
  paygi AS (
    SELECT * FROM public.generate_bas_worksheet_payg_instalment(p_org, p_fy_start_year, p_quarter)
  )
  SELECT jsonb_build_object(
    'gst_accounting_basis', public.bas_gst_accounting_basis(p_org),
    'sales', jsonb_build_object(
      'source_tables', jsonb_build_array('invoices', 'invoice_line_items', 'invoice_payments',
                                         'customer_credit_notes', 'chart_of_accounts'),
      'totals', jsonb_build_object(
        'G1', COALESCE((SELECT SUM(sales_inc_gst_cents) FROM gst_rows), 0),
        'G2', COALESCE((SELECT SUM(export_sales_cents) FROM gst_rows), 0),
        'G3', COALESCE((SELECT SUM(gst_free_sales_cents) FROM gst_rows), 0),
        '1A_gst_on_sales', COALESCE((SELECT SUM(gst_on_sales_cents) FROM gst_rows), 0)
      )
    ),
    'purchases', jsonb_build_object(
      'source_tables', jsonb_build_array('v_bill_effective_allocations', 'bills', 'bill_line_items',
                                         'supplier_credit_notes', 'fixed_assets', 'chart_of_accounts'),
      'totals', jsonb_build_object(
        'G10', COALESCE((SELECT SUM(capital_purchases_cents) FROM gst_rows), 0),
        'G11', COALESCE((SELECT SUM(noncapital_purchases_cents) FROM gst_rows), 0),
        '1B_gst_on_purchases', COALESCE((SELECT SUM(gst_on_purchases_cents) FROM gst_rows), 0)
      )
    ),
    'gst_adjustments', jsonb_build_object(
      'increasing_1A', COALESCE((SELECT SUM(increasing_adjustment_gst_cents) FROM gst_rows), 0),
      'decreasing_1B', COALESCE((SELECT SUM(decreasing_adjustment_gst_cents) FROM gst_rows), 0)
    ),
    'gst_rows', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'source_type', source_type,
          'source_id', source_id,
          'invoice_id', invoice_id,
          'bill_id', bill_id,
          'document_number', document_number,
          'attribution_date', attribution_date,
          'labels', labels,
          'G1', sales_inc_gst_cents,
          'G2', export_sales_cents,
          'G3', gst_free_sales_cents,
          'G10', capital_purchases_cents,
          'G11', noncapital_purchases_cents,
          'gst_on_sales_cents', gst_on_sales_cents,
          'gst_on_purchases_cents', gst_on_purchases_cents,
          'increasing_adjustment_gst_cents', increasing_adjustment_gst_cents,
          'decreasing_adjustment_gst_cents', decreasing_adjustment_gst_cents,
          'review_note', review_note
        )
        ORDER BY attribution_date, source_type, document_number, source_id
      )
      FROM gst_rows
    ), '[]'::jsonb),
    'payg_withholding', jsonb_build_object(
      'source_tables', jsonb_build_array('pay_runs', 'pay_slips'),
      'totals', jsonb_build_object(
        'W1', COALESCE((SELECT SUM(gross_total_cents) FROM payg_rows), 0),
        'W2', COALESCE((SELECT SUM(payg_tax_cents) FROM payg_rows), 0),
        'W3', NULL,
        'W4', NULL,
        'W5', COALESCE((SELECT SUM(payg_tax_cents) FROM payg_rows), 0),
        '4', COALESCE((SELECT SUM(payg_tax_cents) FROM payg_rows), 0)
      ),
      'not_recorded', jsonb_build_array('W3', 'W4'),
      'rows', COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'pay_run_id', pay_run_id,
            'pay_date', pay_date,
            'pay_run_status', pay_run_status,
            'pay_slip_id', pay_slip_id,
            'employee_id', employee_id,
            'labels', jsonb_build_array('W1', 'W2', 'W5', '4'),
            'gross_total_cents', gross_total_cents,
            'payg_tax_cents', payg_tax_cents
          )
          ORDER BY pay_date, pay_run_id, pay_slip_id
        )
        FROM payg_rows
      ), '[]'::jsonb)
    ),
    'payg_instalment', jsonb_build_object(
      'source_tables', jsonb_build_array('business_profile', 'bas_payg_instalment_amounts'),
      'source_status', COALESCE((SELECT source_status FROM paygi), 'missing'),
      'source_id', (SELECT source_id FROM paygi),
      'source_reference', (SELECT source_reference FROM paygi),
      'totals', jsonb_build_object(
        'T7', (SELECT t7_payg_instalment_income_cents FROM paygi),
        '5A', (SELECT label_5a_payg_instalment_cents FROM paygi),
        '5B', (SELECT label_5b_payg_instalment_credit_cents FROM paygi)
      )
    )
  );
$$;

COMMENT ON FUNCTION public.generate_bas_worksheet_source_drilldown(uuid, integer, integer) IS
  'BAS source drilldown for an org/FY quarter: every GST source row on the org''s basis '
  '(invoices, payments, bills, credit notes) with its label amounts, pay slips, and '
  'PAYG-I source amounts. SECURITY INVOKER and RLS scoped.';

REVOKE ALL ON FUNCTION public.generate_bas_worksheet_source_drilldown(uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_bas_worksheet_source_drilldown(uuid, integer, integer)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. The worksheet (generate_bas_worksheet:v3).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_bas_worksheet(
  p_org uuid,
  p_fy_start_year integer,
  p_quarter integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH period AS (
    SELECT * FROM public.bas_quarter_period(p_fy_start_year, p_quarter)
  ),
  basis AS (
    SELECT
      public.bas_gst_accounting_basis(p_org) AS basis,
      CASE WHEN EXISTS (
        SELECT 1 FROM public.business_profile bp
         WHERE bp.organization_id = p_org AND bp.gst_accounting_basis IS NOT NULL
      ) THEN 'business_profile' ELSE 'default' END AS basis_source
  ),
  source_rows AS (
    SELECT r.*
      FROM public.v_bas_gst_source_rows r
     WHERE r.organization_id = p_org
       AND r.fy_start_year = p_fy_start_year
       AND r.quarter_num = p_quarter
  ),
  adjustments AS (
    SELECT
      COALESCE(SUM(increasing_adjustment_gst_cents), 0)::bigint AS increasing_cents,
      COALESCE(SUM(decreasing_adjustment_gst_cents), 0)::bigint AS decreasing_cents
    FROM source_rows
    WHERE gst_accounting_basis = org_gst_accounting_basis
  ),
  review AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'source_type', source_type,
        'source_id', source_id,
        'document_number', document_number,
        'date', attribution_date,
        'note', review_note
      ) ORDER BY attribution_date, document_number
    ), '[]'::jsonb) AS items
    FROM source_rows
    WHERE gst_accounting_basis = org_gst_accounting_basis
      AND review_note IS NOT NULL
  ),
  -- What the ledger should show for the quarter: accruals GST, with customer
  -- credit notes reducing GST collected and supplier credit notes reducing
  -- GST paid, as the credit-note journals post them.
  accruals_expected AS (
    SELECT
      COALESCE(SUM(gst_on_sales_cents - decreasing_adjustment_gst_cents), 0)::bigint AS gst_collected_cents,
      COALESCE(SUM(gst_on_purchases_cents - increasing_adjustment_gst_cents), 0)::bigint AS gst_paid_cents
    FROM source_rows
    WHERE gst_accounting_basis = 'accruals'
  ),
  gst AS (
    SELECT * FROM public.generate_bas_worksheet_gst_labels(p_org, p_fy_start_year, p_quarter)
  ),
  payg AS (
    SELECT * FROM public.generate_bas_worksheet_payg_labels(p_org, p_fy_start_year, p_quarter)
  ),
  paygi AS (
    SELECT * FROM public.generate_bas_worksheet_payg_instalment(p_org, p_fy_start_year, p_quarter)
  ),
  profile AS (
    SELECT COALESCE(bool_or(is_paygi_registered), false) AS is_paygi_registered
      FROM public.business_profile
     WHERE organization_id = p_org
  ),
  gst_control_accounts AS (
    SELECT
      (SELECT sa.account_id FROM public.system_accounts sa
        WHERE sa.organization_id = p_org AND sa.role = 'gst_collected' AND sa.deleted_at IS NULL
        LIMIT 1) AS gst_collected_account_id,
      (SELECT sa.account_id FROM public.system_accounts sa
        WHERE sa.organization_id = p_org AND sa.role = 'gst_paid' AND sa.deleted_at IS NULL
        LIMIT 1) AS gst_paid_account_id
  ),
  gl_control_totals AS (
    SELECT
      COALESCE(SUM(CASE WHEN jl.account_id = gca.gst_collected_account_id
                        THEN jl.credit_cents - jl.debit_cents ELSE 0 END), 0)::bigint AS posted_gst_collected_cents,
      COALESCE(SUM(CASE WHEN jl.account_id = gca.gst_paid_account_id
                        THEN jl.debit_cents - jl.credit_cents ELSE 0 END), 0)::bigint AS posted_gst_paid_cents
    FROM period
    CROSS JOIN gst_control_accounts gca
    LEFT JOIN public.journal_entries je
      ON je.organization_id = p_org
     AND je.status = 'posted'
     AND je.entry_date >= period.quarter_start
     AND je.entry_date <= period.quarter_end
     AND je.source_type IS DISTINCT FROM 'bas_bank_transaction'
    LEFT JOIN public.journal_lines jl
      ON jl.journal_entry_id = je.id
     AND jl.account_id IN (gca.gst_collected_account_id, gca.gst_paid_account_id)
  ),
  paygi_in_summary AS (
    SELECT
      (SELECT is_paygi_registered FROM profile)
        AND paygi.source_status = 'provided' AS included,
      COALESCE(paygi.label_5a_payg_instalment_cents, 0)
        - COALESCE(paygi.label_5b_payg_instalment_credit_cents, 0) AS net_cents
    FROM paygi
  ),
  drilldown AS (
    SELECT public.generate_bas_worksheet_source_drilldown(p_org, p_fy_start_year, p_quarter) AS source_drilldown
  )
  SELECT jsonb_build_object(
    'organization_id', p_org,
    'fy_start_year', p_fy_start_year,
    'quarter', p_quarter,
    'quarter_start', period.quarter_start,
    'quarter_end', period.quarter_end,
    'due_date', period.due_date,
    'gst_accounting_basis', basis.basis,
    'gst_accounting_basis_source', basis.basis_source,
    'gst', jsonb_build_object(
      'G1', gst.g1_total_sales_cents,
      'G2', gst.g2_export_sales_cents,
      'G3', gst.g3_gst_free_sales_cents,
      'G10', gst.g10_capital_purchases_cents,
      'G11', gst.g11_noncapital_purchases_cents,
      '1A', gst.label_1a_gst_on_sales_cents,
      '1B', gst.label_1b_gst_on_purchases_cents
    ),
    'gst_adjustments', jsonb_build_object(
      'increasing_1A_cents', adjustments.increasing_cents,
      'decreasing_1B_cents', adjustments.decreasing_cents,
      'rule', 'Credit notes in the same BAS period as the invoice or bill reduce G1/1A or '
              'G10/G11/1B. Later credit notes are adjustments: supplier credit notes at 1A '
              '(increasing), customer credit notes at 1B (decreasing).'
    ),
    'gl_reconciliation', jsonb_build_object(
      'basis', 'accruals_figures_vs_posted_journal_lines',
      'note', CASE WHEN basis.basis = 'cash'
                   THEN 'The BAS uses the cash basis. The ledger posts GST when invoices and bills '
                        'are issued, so this check compares the ledger with the accruals figures '
                        'for the quarter, not with the cash labels.'
                   ELSE NULL END,
      'gst_collected_account_id', controls.gst_collected_account_id,
      'gst_paid_account_id', controls.gst_paid_account_id,
      'posted_gst_collected_cents', gl.posted_gst_collected_cents,
      'posted_gst_paid_cents', gl.posted_gst_paid_cents,
      'expected_gst_collected_cents', expected.gst_collected_cents,
      'expected_gst_paid_cents', expected.gst_paid_cents,
      'gst_collected_delta_cents', expected.gst_collected_cents - gl.posted_gst_collected_cents,
      'gst_paid_delta_cents', expected.gst_paid_cents - gl.posted_gst_paid_cents,
      'reconciles',
        expected.gst_collected_cents = gl.posted_gst_collected_cents
        AND expected.gst_paid_cents = gl.posted_gst_paid_cents
    ),
    'payg_withholding', jsonb_build_object(
      'W1', payg.w1_total_salary_wages_cents,
      'W2', payg.w2_payg_withheld_cents,
      'W3', payg.w3_other_withheld_cents,
      'W4', payg.w4_no_abn_withheld_cents,
      'W5', payg.w5_total_withheld_cents,
      '4', payg.label_4_payg_withheld_cents,
      'not_recorded', jsonb_build_array('W3', 'W4'),
      'note', 'Looplet does not record other withholding (W3) or no-ABN withholding (W4). '
              'W5 and label 4 show W2 only; add any W3 or W4 amounts yourself before lodging.'
    ),
    'payg_instalment',
      CASE WHEN (SELECT is_paygi_registered FROM profile)
           THEN jsonb_build_object(
             'T7', paygi.t7_payg_instalment_income_cents,
             '5A', paygi.label_5a_payg_instalment_cents,
             '5B', paygi.label_5b_payg_instalment_credit_cents,
             'source_status', paygi.source_status,
             'source_id', paygi.source_id,
             'source_reference', paygi.source_reference
           )
           ELSE NULL END,
    'summary', jsonb_build_object(
      '9_net_amount_cents',
        gst.label_1a_gst_on_sales_cents
        - gst.label_1b_gst_on_purchases_cents
        + payg.label_4_payg_withheld_cents
        + CASE WHEN paygi_in_summary.included THEN paygi_in_summary.net_cents ELSE 0 END,
      'includes_payg_instalment', paygi_in_summary.included
    ),
    'needs_review',
      review.items
      || CASE WHEN (SELECT is_paygi_registered FROM profile) AND paygi.source_status = 'missing'
              THEN jsonb_build_array(jsonb_build_object(
                     'source_type', 'payg_instalment',
                     'note', 'PAYG instalment amount for this quarter has not been entered, so '
                             'label 9 leaves out 5A and 5B.'))
              ELSE '[]'::jsonb END,
    'source_drilldown', drilldown.source_drilldown,
    'evidence', jsonb_build_object(
      'label_source', 'generate_bas_worksheet:v3',
      'gst_accounting_basis', basis.basis,
      'payg_instalment_source_status',
        CASE WHEN (SELECT is_paygi_registered FROM profile)
             THEN paygi.source_status
             ELSE 'not_registered' END,
      'snapshot_rpc', 'snapshot_bas_worksheet'
    )
  )
  FROM period
  CROSS JOIN basis
  CROSS JOIN gst
  CROSS JOIN payg
  CROSS JOIN paygi
  CROSS JOIN paygi_in_summary
  CROSS JOIN adjustments
  CROSS JOIN review
  CROSS JOIN accruals_expected expected
  CROSS JOIN gst_control_accounts controls
  CROSS JOIN gl_control_totals gl
  CROSS JOIN drilldown;
$$;

COMMENT ON FUNCTION public.generate_bas_worksheet(uuid, integer, integer) IS
  'BAS worksheet JSONB (generate_bas_worksheet:v3) for an org + AU FY quarter on the '
  'org''s GST accounting basis (business_profile.gst_accounting_basis, accruals by '
  'default). Credit notes included; W3/W4 null (not recorded); PAYG-I from '
  'bas_payg_instalment_amounts or null; label 9; needs_review; GL reconciliation of '
  'accruals figures; source drilldown. SECURITY INVOKER.';

REVOKE ALL ON FUNCTION public.generate_bas_worksheet(uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_bas_worksheet(uuid, integer, integer)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. Snapshots record the v3 source version.
-- ---------------------------------------------------------------------------
ALTER TABLE public.bas_worksheet_snapshots
  ALTER COLUMN source_version SET DEFAULT 'generate_bas_worksheet:v3';

CREATE OR REPLACE FUNCTION public.snapshot_bas_worksheet(
  p_org uuid,
  p_fy_start_year integer,
  p_quarter integer
)
RETURNS public.bas_worksheet_snapshots
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_quarter_start date;
  v_quarter_end date;
  v_due_date date;
  v_worksheet jsonb;
  v_drilldown jsonb;
  v_hash text;
  v_snapshot public.bas_worksheet_snapshots;
  v_source_version constant text := 'generate_bas_worksheet:v3';
BEGIN
  IF p_org IS NULL THEN
    RAISE EXCEPTION 'organization_id is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_fy_start_year IS NULL OR p_quarter NOT BETWEEN 1 AND 4 THEN
    RAISE EXCEPTION 'valid BAS FY start year and quarter are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_org NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RAISE EXCEPTION 'not authorized to snapshot BAS worksheet for org %', p_org
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT q.quarter_start, q.quarter_end, q.due_date
    INTO v_quarter_start, v_quarter_end, v_due_date
    FROM public.bas_quarter_period(p_fy_start_year, p_quarter) q;

  IF v_quarter_start IS NULL THEN
    RAISE EXCEPTION 'valid BAS FY start year and quarter are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_worksheet := public.generate_bas_worksheet(p_org, p_fy_start_year, p_quarter);

  IF v_worksheet IS NULL OR jsonb_typeof(v_worksheet) <> 'object' THEN
    RAISE EXCEPTION 'BAS worksheet did not return an object for org %, FY %, quarter %',
      p_org, p_fy_start_year, p_quarter
      USING ERRCODE = 'check_violation';
  END IF;

  v_drilldown := COALESCE(v_worksheet -> 'source_drilldown', '{}'::jsonb);

  -- pgcrypto lives in the extensions schema (0222 called digest() unqualified
  -- under search_path=public, which cannot resolve it).
  v_hash := encode(
    extensions.digest(
      jsonb_build_object(
        'organization_id', p_org,
        'fy_start_year', p_fy_start_year,
        'quarter', p_quarter,
        'worksheet', v_worksheet,
        'source_drilldown', v_drilldown,
        'source_version', v_source_version
      )::text,
      'sha256'
    ),
    'hex'
  );

  INSERT INTO public.bas_worksheet_snapshots (
    organization_id, fy_start_year, quarter_num, quarter_start, quarter_end, due_date,
    worksheet, source_drilldown, snapshot_hash, source_version, created_by
  )
  VALUES (
    p_org, p_fy_start_year, p_quarter, v_quarter_start, v_quarter_end, v_due_date,
    v_worksheet, v_drilldown, v_hash, v_source_version, auth.uid()
  )
  ON CONFLICT (organization_id, fy_start_year, quarter_num, snapshot_hash)
  DO NOTHING
  RETURNING * INTO v_snapshot;

  IF v_snapshot.id IS NULL THEN
    SELECT *
      INTO v_snapshot
      FROM public.bas_worksheet_snapshots
     WHERE organization_id = p_org
       AND fy_start_year = p_fy_start_year
       AND quarter_num = p_quarter
       AND snapshot_hash = v_hash
     ORDER BY created_at DESC
     LIMIT 1;
  END IF;

  IF v_snapshot.id IS NULL THEN
    RAISE EXCEPTION 'BAS worksheet snapshot insert/replay failed for org %, FY %, quarter %',
      p_org, p_fy_start_year, p_quarter
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN v_snapshot;
END;
$$;

COMMENT ON FUNCTION public.snapshot_bas_worksheet(uuid, integer, integer) IS
  'Creates or replays an immutable BAS worksheet snapshot for an org + AU FY quarter. '
  'Stores generate_bas_worksheet:v3 output, source drilldown, period metadata and a '
  'SHA-256 snapshot_hash for approval/lodgement payload binding.';

REVOKE ALL ON FUNCTION public.snapshot_bas_worksheet(uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.snapshot_bas_worksheet(uuid, integer, integer)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 10. BAS settlement posting clears the GST control accounts by what the
-- ledger holds for the quarter. A later-period customer credit note is in 1B
-- but was posted against GST collected (and a supplier one is in 1A but was
-- posted against GST paid), so both controls clear by their label less the
-- adjustments; the bank amount (label 9) is unchanged. PAYG instalments have no
-- posting account here, so a quarter that includes them is refused.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_bas_bank_transaction_journal(
  p_bank_transaction_id uuid,
  p_fy_start_year integer,
  p_quarter integer
)
RETURNS public.journal_entries
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_tx                         public.bank_transactions%ROWTYPE;
  v_entry                      public.journal_entries;
  v_worksheet                  jsonb;
  v_label_1a_cents             bigint;
  v_label_1b_cents             bigint;
  v_adjustments_cents          bigint;
  v_collected_clear_cents      bigint;
  v_paid_clear_cents           bigint;
  v_payg_w_cents               bigint;
  v_net_cents                  bigint;
  v_quarter_start              date;
  v_quarter_end                date;
  v_due_date                   date;
  v_gst_collected_account_id   uuid;
  v_gst_paid_account_id        uuid;
  v_payg_account_id            uuid;
  v_bank_account_id            uuid;
  v_lines                      jsonb := '[]'::jsonb;
BEGIN
  IF p_bank_transaction_id IS NULL THEN
    RAISE EXCEPTION 'bank_transaction_id is required'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_fy_start_year IS NULL OR p_quarter IS NULL OR p_quarter NOT BETWEEN 1 AND 4 THEN
    RAISE EXCEPTION 'valid BAS FY start year and quarter are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT *
    INTO v_tx
    FROM public.bank_transactions
   WHERE id = p_bank_transaction_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'bank transaction % not found or not accessible', p_bank_transaction_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_tx.is_personal IS TRUE THEN
    RAISE EXCEPTION 'bank transaction % is personal and cannot post BAS settlement',
      p_bank_transaction_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_tx.matched_bill_id IS NOT NULL OR v_tx.matched_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'bank transaction % is already reconciled to another source',
      p_bank_transaction_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_tx.amount_cents = 0 THEN
    RAISE EXCEPTION 'bank transaction % amount must be non-zero for BAS settlement',
      p_bank_transaction_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF COALESCE(v_tx.auto_category_code, '') <> 'ato_bas_super' THEN
    RAISE EXCEPTION
      'bank transaction % category % is not the dedicated ATO/BAS category',
      p_bank_transaction_id,
      v_tx.auto_category_code
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT public.generate_bas_worksheet(v_tx.organization_id, p_fy_start_year, p_quarter)
    INTO v_worksheet;

  IF v_worksheet IS NULL OR jsonb_typeof(v_worksheet) <> 'object' THEN
    RAISE EXCEPTION 'BAS worksheet did not return an object for org %, FY %, quarter %',
      v_tx.organization_id,
      p_fy_start_year,
      p_quarter
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF COALESCE((v_worksheet #>> ARRAY['summary', 'includes_payg_instalment'])::boolean, false) THEN
    RAISE EXCEPTION
      'BAS settlement for org %, FY %, quarter % includes PAYG instalments, which this posting does not cover; post it manually',
      v_tx.organization_id,
      p_fy_start_year,
      p_quarter
      USING ERRCODE = 'feature_not_supported';
  END IF;

  v_label_1a_cents := COALESCE((v_worksheet #>> ARRAY['gst', '1A'])::bigint, 0);
  v_label_1b_cents := COALESCE((v_worksheet #>> ARRAY['gst', '1B'])::bigint, 0);
  v_adjustments_cents :=
    COALESCE((v_worksheet #>> ARRAY['gst_adjustments', 'increasing_1A_cents'])::bigint, 0)
    + COALESCE((v_worksheet #>> ARRAY['gst_adjustments', 'decreasing_1B_cents'])::bigint, 0);
  v_collected_clear_cents := v_label_1a_cents - v_adjustments_cents;
  v_paid_clear_cents := v_label_1b_cents - v_adjustments_cents;
  v_payg_w_cents := COALESCE((v_worksheet #>> ARRAY['payg_withholding', '4'])::bigint, 0);
  v_net_cents := COALESCE(
    (v_worksheet #>> ARRAY['summary', '9_net_amount_cents'])::bigint,
    v_label_1a_cents - v_label_1b_cents + v_payg_w_cents
  );

  IF v_label_1a_cents < 0 OR v_label_1b_cents < 0 OR v_payg_w_cents < 0 THEN
    RAISE EXCEPTION 'BAS worksheet contains negative GST/PAYG labels for org %, FY %, quarter %',
      v_tx.organization_id,
      p_fy_start_year,
      p_quarter
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_net_cents = 0 THEN
    RAISE EXCEPTION 'BAS worksheet net amount is zero; no bank settlement journal is required'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_tx.amount_cents <> -v_net_cents THEN
    RAISE EXCEPTION
      'bank transaction % amount % does not equal BAS worksheet settlement amount %',
      p_bank_transaction_id,
      v_tx.amount_cents,
      -v_net_cents
      USING ERRCODE = 'check_violation';
  END IF;

  v_quarter_start := COALESCE(
    NULLIF(v_worksheet ->> 'quarter_start', '')::date,
    CASE p_quarter
      WHEN 1 THEN make_date(p_fy_start_year, 7, 1)
      WHEN 2 THEN make_date(p_fy_start_year, 10, 1)
      WHEN 3 THEN make_date(p_fy_start_year + 1, 1, 1)
      ELSE make_date(p_fy_start_year + 1, 4, 1)
    END
  );
  v_quarter_end := COALESCE(
    NULLIF(v_worksheet ->> 'quarter_end', '')::date,
    CASE p_quarter
      WHEN 1 THEN make_date(p_fy_start_year, 9, 30)
      WHEN 2 THEN make_date(p_fy_start_year, 12, 31)
      WHEN 3 THEN make_date(p_fy_start_year + 1, 3, 31)
      ELSE make_date(p_fy_start_year + 1, 6, 30)
    END
  );
  v_due_date := COALESCE(
    NULLIF(v_worksheet ->> 'due_date', '')::date,
    CASE p_quarter
      WHEN 1 THEN make_date(p_fy_start_year, 10, 28)
      WHEN 2 THEN make_date(p_fy_start_year + 1, 2, 28)
      WHEN 3 THEN make_date(p_fy_start_year + 1, 4, 28)
      ELSE make_date(p_fy_start_year + 1, 7, 28)
    END
  );

  IF v_collected_clear_cents <> 0 THEN
    SELECT coa.id
      INTO v_gst_collected_account_id
      FROM public.system_accounts sa
      JOIN public.chart_of_accounts coa
        ON coa.id = sa.account_id
       AND coa.organization_id = sa.organization_id
       AND coa.account_type = 'liability'::public.account_type
       AND coa.is_active = true
     WHERE sa.organization_id = v_tx.organization_id
       AND sa.role = 'gst_collected'
       AND sa.deleted_at IS NULL
     LIMIT 1;

    IF v_gst_collected_account_id IS NULL THEN
      SELECT coa.id
        INTO v_gst_collected_account_id
        FROM public.chart_of_accounts coa
       WHERE coa.organization_id = v_tx.organization_id
         AND coa.code = '2100'
         AND coa.account_type = 'liability'::public.account_type
         AND coa.is_active = true
       LIMIT 1;
    END IF;

    IF v_gst_collected_account_id IS NULL THEN
      RAISE EXCEPTION
        'BAS settlement % cannot post: gst_collected system account or active liability account 2100 is missing',
        p_bank_transaction_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_gst_collected_account_id,
        'debit_cents', GREATEST(v_collected_clear_cents, 0),
        'credit_cents', GREATEST(-v_collected_clear_cents, 0),
        'description', 'BAS GST on sales 1A (less GST adjustments)'
      )
    );
  END IF;

  IF v_payg_w_cents > 0 THEN
    SELECT coa.id
      INTO v_payg_account_id
      FROM public.chart_of_accounts coa
     WHERE coa.organization_id = v_tx.organization_id
       AND coa.code = '2200'
       AND coa.account_type = 'liability'::public.account_type
       AND coa.is_active = true
     LIMIT 1;

    IF v_payg_account_id IS NULL THEN
      RAISE EXCEPTION 'BAS settlement % cannot post: active liability account 2200 is missing',
        p_bank_transaction_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_payg_account_id,
        'debit_cents', v_payg_w_cents,
        'credit_cents', 0,
        'description', 'BAS PAYG withholding label 4'
      )
    );
  END IF;

  IF v_paid_clear_cents <> 0 THEN
    SELECT coa.id
      INTO v_gst_paid_account_id
      FROM public.system_accounts sa
      JOIN public.chart_of_accounts coa
        ON coa.id = sa.account_id
       AND coa.organization_id = sa.organization_id
       AND coa.account_type = 'asset'::public.account_type
       AND coa.is_active = true
     WHERE sa.organization_id = v_tx.organization_id
       AND sa.role = 'gst_paid'
       AND sa.deleted_at IS NULL
     LIMIT 1;

    IF v_gst_paid_account_id IS NULL THEN
      SELECT coa.id
        INTO v_gst_paid_account_id
        FROM public.chart_of_accounts coa
       WHERE coa.organization_id = v_tx.organization_id
         AND coa.code = '1200'
         AND coa.account_type = 'asset'::public.account_type
         AND coa.is_active = true
       LIMIT 1;
    END IF;

    IF v_gst_paid_account_id IS NULL THEN
      RAISE EXCEPTION
        'BAS settlement % cannot post: gst_paid system account or active asset account 1200 is missing',
        p_bank_transaction_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_gst_paid_account_id,
        'debit_cents', GREATEST(-v_paid_clear_cents, 0),
        'credit_cents', GREATEST(v_paid_clear_cents, 0),
        'description', 'BAS GST on purchases 1B (less GST adjustments)'
      )
    );
  END IF;

  SELECT coa.id
    INTO v_bank_account_id
    FROM public.chart_of_accounts coa
   WHERE coa.organization_id = v_tx.organization_id
     AND coa.code = '1000'
     AND coa.account_type = 'asset'::public.account_type
     AND coa.is_active = true
   LIMIT 1;

  IF v_bank_account_id IS NULL THEN
    RAISE EXCEPTION 'BAS settlement % cannot post: active asset account 1000 is missing',
      p_bank_transaction_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF v_net_cents > 0 THEN
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_bank_account_id,
        'debit_cents', 0,
        'credit_cents', v_net_cents,
        'description', 'BAS payment to ATO'
      )
    );
  ELSE
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object(
        'account_id', v_bank_account_id,
        'debit_cents', abs(v_net_cents),
        'credit_cents', 0,
        'description', 'BAS refund from ATO'
      )
    );
  END IF;

  SELECT *
    INTO v_entry
    FROM public.create_and_post_journal(
      v_tx.organization_id,
      v_tx.posted_at::date,
      'bas_bank_transaction',
      v_tx.id,
      'bas-settlement:v1',
      v_lines,
      'BAS settlement FY ' || p_fy_start_year || ' Q' || p_quarter,
      jsonb_build_object(
        'source_table', 'bank_transactions',
        'bank_transaction_id', v_tx.id,
        'bank_account_id', v_tx.bank_account_id,
        'external_id', v_tx.external_id,
        'auto_category_code', v_tx.auto_category_code,
        'fy_start_year', p_fy_start_year,
        'quarter', p_quarter,
        'quarter_start', v_quarter_start,
        'quarter_end', v_quarter_end,
        'due_date', v_due_date,
        'label_1a_gst_on_sales_cents', v_label_1a_cents,
        'label_1b_gst_on_purchases_cents', v_label_1b_cents,
        'gst_adjustments_cents', v_adjustments_cents,
        'gst_collected_cleared_cents', v_collected_clear_cents,
        'gst_paid_cleared_cents', v_paid_clear_cents,
        'label_4_payg_withheld_cents', v_payg_w_cents,
        'label_9_net_amount_cents', v_net_cents,
        'bank_amount_cents', v_tx.amount_cents,
        'bas_worksheet', v_worksheet
      )
    );

  RETURN v_entry;
END;
$$;

COMMENT ON FUNCTION public.post_bas_bank_transaction_journal(uuid, integer, integer) IS
  'Posts a BAS bank settlement through create_and_post_journal using idempotency '
  'key bas-settlement:v1. Requires the ato_bas_super bank transaction amount to be the '
  'exact opposite of label 9; clears GST collected by 1A and GST paid by 1B, each less '
  'the quarter''s GST adjustments (credit notes are posted against their own control '
  'account), and PAYG-W label 4, against bank 1000. Refuses quarters that include PAYG '
  'instalments, and personal, matched, wrong-category, missing-COA, zero-net, '
  'locked-period and inaccessible-org states.';

REVOKE ALL ON FUNCTION public.post_bas_bank_transaction_journal(uuid, integer, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_bas_bank_transaction_journal(uuid, integer, integer)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
