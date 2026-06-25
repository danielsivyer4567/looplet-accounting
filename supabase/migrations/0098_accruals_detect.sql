-- 0098: Recurring-bill detection (ledger SC-1.I.01).
--
-- Read-only RPC that surfaces recurring bill *series* — a supplier billed on a
-- regular cadence for a roughly constant amount (rent, insurance, software,
-- retainers). SC-1.I.02 (straight-line accrual, same migration file) consumes
-- these series to spread a prepaid/accrued bill across the periods it covers and
-- post reversing journals. This slice writes NOTHING — splitting the cheap-to-
-- verify detection away from the journaling logic.
--
-- NUMBERING: the ledger Files line optimistically reserved 0097, but 0097 is
-- already taken by 0097_depreciation_accounts_seed (SC-1.G.02). The repo head is
-- 0097, so this migration is 0098 (next sequential). Forward note for the rest of
-- Phase 1.I/1.J: SC-1.I.03 accruals_cron -> 0099; SC-1.J.01/1.J.02 then need
-- 0100/0101, which overlaps Phase 2's planned 0100-0106 block — Phase 2 must shift
-- +2 when reached (verify the live head first, per the global drift rule).
--
-- HEURISTIC: ported from supabase/functions/subscriptions-detect/index.ts, which
-- clusters recurring *bank transactions*. The core algorithm is identical so the
-- two detectors agree on what "recurring" means; only the source differs (bills,
-- grouped by supplier, instead of bank txns grouped by canonical description):
--   1. Group org bills by a canonical supplier key — prefer the supplier_id FK,
--      else a cleaned supplier_name_raw (lowercased, entity-suffixes + punctuation
--      stripped, first 40 chars). Bills with neither identifier can't be grouped
--      and are dropped.
--   2. Keep groups with >= p_min_occurrences bills (default 3 — same as
--      subscriptions-detect; two points can't establish a cadence).
--   3. Compute the group's median amount and drop outliers > ±5% from it (a
--      one-off large bill from a recurring supplier shouldn't distort the series),
--      then re-require >= p_min_occurrences survivors.
--   4. Compute the median gap-in-days between consecutive bills and classify the
--      cadence with the SAME bands as subscriptions-detect (weekly … yearly).
--      A gap that fits no band => not a recurring series => dropped.
--   5. Return one row per surviving series with its cadence, median amount, span,
--      next-expected date, a confidence score and the member bill ids.
--
-- DELIBERATE PARAMETER DEVIATION (documented): p_lookback_months DEFAULT 24, vs
-- subscriptions-detect's hard-coded 18. Bills reach further back than the bank
-- feed and an *annual* accrual (insurance, ASIC fees) needs >= 3 yearly bills,
-- which span 24+ months. It stays a parameter — AU FY windows and review needs
-- vary — so callers focused on monthly series can pass a shorter window.
--
-- amount basis = COALESCE(total_inc_gst_cents, subtotal_ex_gst_cents): the gross
-- recurring outlay is what clusters consistently and what a reviewer recognises.
-- SC-1.I.02 re-derives the net/GST split per bill when it builds journals.
--
-- Security model: SECURITY INVOKER (matches 0090 compute_books_health / 0094
-- detect_capital_purchases). The function filters source rows with
-- organization_id = p_org; RLS on bills (organization_id IN get_accessible_org_ids())
-- scopes results to the caller under their own identity, while a service_role
-- backend bypasses RLS. No privilege-escalation surface, no new advisor class.
--
-- Once Phase 2 (SC-2.A/2.B) lands, the *accrual* path (SC-1.I.02) becomes a Tier-1
-- "notify" action; this detection RPC stays read-only and ungated.

CREATE OR REPLACE FUNCTION public.detect_recurring_bills(
  p_org             uuid,
  p_min_occurrences integer DEFAULT 3,   -- min bills (after outlier filter) to call it a series
  p_lookback_months integer DEFAULT 24   -- window; 24 so an annual cadence can reach 3 occurrences
)
RETURNS TABLE (
  supplier_key        text,    -- stable grouping key (sid:<uuid> | nm:<canonical>); SC-1.I.02 references the series by this
  supplier_id         uuid,    -- representative supplier FK (NULL for name-grouped series)
  supplier_name       text,    -- most-recent non-null supplier_name_raw in the series
  cadence             text,    -- weekly | fortnightly | monthly | quarterly | semi_annual | yearly
  occurrence_count    integer, -- bills in the series after the ±5% outlier filter
  median_amount_cents bigint,  -- gross (inc-GST) recurring amount
  median_gap_days     integer, -- median days between consecutive bills
  first_seen          date,
  last_seen           date,
  next_expected       date,    -- last_seen + median_gap_days
  confidence          numeric, -- 0..1: more observations + tighter gap variance = higher
  bill_ids            uuid[]   -- member bill ids (chronological)
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH base AS (
    SELECT
      b.id,
      b.supplier_id,
      b.supplier_name_raw,
      COALESCE(b.invoice_date, b.created_at::date)              AS bill_date,
      COALESCE(b.total_inc_gst_cents, b.subtotal_ex_gst_cents)  AS amount_cents,
      -- canonical supplier key: prefer the supplier_id FK; else a cleaned name.
      -- The name base reuses public.normalise_supplier_name (0028) — the same
      -- primitive that backs the suppliers unique index + autolink trigger — so the
      -- detector's "same supplier" notion can't drift from the DB's. On top of that
      -- base we additionally strip entity suffixes + punctuation and take the first
      -- 40 chars: a deliberate, *stronger* adaptation of subscriptions-detect's
      -- canonicaliseDescription() (different suffix list, 40- vs 32-char cap, and no
      -- long-number stripping — supplier names aren't bank-txn descriptions with
      -- card masks / refs to remove). The 'sid:'/'nm:' prefixes keep a uuid from
      -- colliding with a name. NULL when the bill has neither identifier (dropped
      -- by the `keyed` CTE below).
      COALESCE(
        'sid:' || b.supplier_id::text,
        'nm:' || NULLIF(
          LEFT(btrim(regexp_replace(
            regexp_replace(public.normalise_supplier_name(b.supplier_name_raw),
                           '\y(pty|ltd|limited|llc|inc|australia|aus)\y', ' ', 'g'),
            '[^a-z0-9]+', ' ', 'g')), 40),
          '')
      )                                                          AS supplier_key
    FROM public.bills b
    WHERE b.organization_id = p_org
      AND b.deleted_at IS NULL
      AND b.status::text <> 'void'
      AND b.is_personal IS NOT TRUE
      AND COALESCE(b.total_inc_gst_cents, b.subtotal_ex_gst_cents) IS NOT NULL
      AND COALESCE(b.invoice_date, b.created_at::date)
            >= (CURRENT_DATE - make_interval(months => p_lookback_months))::date
  ),
  keyed AS (
    SELECT * FROM base WHERE supplier_key IS NOT NULL
  ),
  group_median AS (
    -- groups large enough to bother with, and their median amount for outlier-pruning
    SELECT supplier_key,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY amount_cents) AS med_amt
    FROM keyed
    GROUP BY supplier_key
    HAVING count(*) >= p_min_occurrences
  ),
  filtered AS (
    -- drop bills whose amount is > ±5% from the group median
    SELECT k.*
    FROM keyed k
    JOIN group_median gm USING (supplier_key)
    WHERE abs(k.amount_cents - gm.med_amt) <= gm.med_amt * 0.05
  ),
  gapped AS (
    SELECT f.*,
           (f.bill_date - lag(f.bill_date) OVER (PARTITION BY f.supplier_key ORDER BY f.bill_date, f.id))
             AS gap_days
    FROM filtered f
  ),
  series AS (
    SELECT
      supplier_key,
      count(*)::integer                                                     AS occurrence_count,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY amount_cents)             AS median_amount_num,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_days)
        FILTER (WHERE gap_days IS NOT NULL)                                 AS median_gap_num,
      min(bill_date)                                                        AS first_seen,
      max(bill_date)                                                        AS last_seen,
      avg(gap_days) FILTER (WHERE gap_days IS NOT NULL)                     AS mean_gap,
      stddev_pop(gap_days) FILTER (WHERE gap_days IS NOT NULL)              AS sd_gap,
      (array_agg(supplier_id) FILTER (WHERE supplier_id IS NOT NULL))[1]    AS supplier_id,
      -- most-recent non-null name (DESC), not subscriptions-detect's first/oldest:
      -- supplier names get tidied over time, so the latest spelling reads best in review.
      (array_agg(supplier_name_raw ORDER BY bill_date DESC)
        FILTER (WHERE supplier_name_raw IS NOT NULL))[1]                    AS supplier_name,
      array_agg(id ORDER BY bill_date, id)                                  AS bill_ids
    FROM gapped
    GROUP BY supplier_key
    HAVING count(*) >= p_min_occurrences   -- survivors after outlier filter
  )
  SELECT
    s.supplier_key,
    s.supplier_id,
    s.supplier_name,
    cad.cadence,
    s.occurrence_count,
    round(s.median_amount_num)::bigint                       AS median_amount_cents,
    round(s.median_gap_num)::integer                         AS median_gap_days,
    s.first_seen,
    s.last_seen,
    (s.last_seen + round(s.median_gap_num)::integer)         AS next_expected,
    round(
      least(s.occurrence_count::numeric / 12, 1) * 0.5
      + greatest(0, 1 - CASE WHEN s.mean_gap > 0
                             THEN COALESCE(s.sd_gap, 0) / s.mean_gap
                             ELSE 1 END) * 0.5
    , 2)                                                     AS confidence,
    s.bill_ids
  FROM series s
  CROSS JOIN LATERAL (
    -- same cadence bands as subscriptions-detect classifyCadence()
    SELECT CASE
      WHEN s.median_gap_num >= 5   AND s.median_gap_num <= 8   THEN 'weekly'
      WHEN s.median_gap_num >= 9   AND s.median_gap_num <= 16  THEN 'fortnightly'
      WHEN s.median_gap_num >= 17  AND s.median_gap_num <= 45  THEN 'monthly'
      WHEN s.median_gap_num >= 46  AND s.median_gap_num <= 100 THEN 'quarterly'
      WHEN s.median_gap_num >= 101 AND s.median_gap_num <= 200 THEN 'semi_annual'
      WHEN s.median_gap_num >= 201 AND s.median_gap_num <= 400 THEN 'yearly'
      ELSE NULL
    END AS cadence
  ) cad
  WHERE cad.cadence IS NOT NULL
  ORDER BY s.occurrence_count DESC, median_amount_cents DESC;
$$;

COMMENT ON FUNCTION public.detect_recurring_bills(uuid, integer, integer) IS
  'SC-1.I.01: read-only detection of recurring bill series (supplier billed on a regular cadence for a ~constant amount). Ports subscriptions-detect''s clustering to bills grouped by supplier. Feeds SC-1.I.02 straight-line accruals. amount = inc-GST gross; p_lookback_months defaults to 24 (annual cadences need >= 3 occurrences). SECURITY INVOKER — RLS on bills scopes the caller.';

GRANT EXECUTE ON FUNCTION public.detect_recurring_bills(uuid, integer, integer) TO authenticated;


-- ============================================================================
-- SC-1.I.02: straight-line accrual with reversing journals.
--
-- For a *detected* recurring bill that covers more than one accounting period
-- (a quarterly / half-yearly / annual outlay billed as one lump — rent paid in
-- advance, annual insurance, ASIC fees), spread the expense evenly across the N
-- monthly periods it covers using the standard REVERSING-ACCRUAL technique:
--
--   for each month i in the window (straight-line share = total / N):
--     ACCRUAL  (dated last day of month i):
--         Dr <expense>   share   /   Cr <accrued expenses>   share
--     REVERSAL (dated first day of month i+1):
--         Dr <accrued expenses>   share   /   Cr <expense>   share
--
-- Each entry balances (one debit = one credit). Each (accrual, reversal) pair is
-- self-cancelling, so SUMMED ACROSS THE WINDOW every account nets to ZERO — the
-- correctness anchor. That is the point of a reversing accrual: the monthly
-- accrual lets interim management accounts show the expense as it is incurred,
-- and the auto-reversal at the next month-start clears it so that when the ACTUAL
-- recurring bill is posted (separately, by the coding classifier) the expense is
-- not double-counted. The accrual stream is timing-only; real P&L impact comes
-- from the actual bills.
--
-- The ONLY sanctioned posting path is post_journal_entry() (0073; GL immutable,
-- 0075) — we build a balanced draft then post it.
--
-- AMOUNT BASIS: net ex-GST where known (COALESCE(subtotal_ex_gst_cents,
-- total_inc_gst_cents)). GST is recovered against the actual tax invoice, it is
-- not part of the accrued expense — same "ex-GST where known" convention as
-- detect_capital_purchases / propose_capitalisation.
--
-- PERIODS: pass p_periods explicitly, or leave it NULL to DERIVE it from the
-- recurring-series cadence via detect_recurring_bills (SC-1.I.01) — so the NULL
-- path only accrues a genuinely *detected* recurring bill (yearly->12,
-- semi_annual->6, quarterly->3, monthly/fortnightly/weekly->1). This is how the
-- slice consumes SC-1.I.01; the explicit override keeps the journal math
-- self-contained and independently assertable.
--
-- SECURITY INVOKER (matches detect_recurring_bills above): RLS on bills /
-- journal_entries / journal_lines scopes the caller, and post_journal_entry
-- (SECURITY DEFINER) re-checks organization_id IN get_accessible_org_ids().
-- For an authenticated USER session auth.uid() resolves the org; for a backend
-- caller it resolves ONLY from the integration `organization_id` JWT claim
-- (0069). So the SC-1.I.03 cron driver MUST call this through a short-lived
-- org-scoped token (exactly like depreciation-run / api-gateway via
-- CONNECTOR_JWT_SECRET) — a RAW service-role call has no claim, RLS is bypassed
-- on the inserts but post_journal_entry fails closed ("not authorized"). No new
-- privilege-escalation surface, no new advisor class.
--
-- Once Phase 2 (SC-2.A/2.B) lands this becomes a Tier-1 "notify" action.
--
-- COA: the accrual posts to a liability "Accrued expenses" account. 0073's seed
-- (and 0097's depreciation extension) never created one, so — exactly as 0097 did
-- for the depreciation accounts, and because the plan allocated no separate seed
-- migration for accruals — section 1 below extends seed_default_chart_of_accounts
-- with 2600 Accrued expenses and backfills existing orgs. Without it the default
-- accrued account would never resolve and the engine would fail closed forever.
-- ============================================================================

-- 1. Accrued-expenses liability account in the default COA. ------------------
--    New orgs: extend the template (full 0097 body preserved + the 2600 row).
--    Idempotent via ON CONFLICT (organization_id, code) DO NOTHING.
CREATE OR REPLACE FUNCTION public.seed_default_chart_of_accounts(p_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Caller must have access to the target org.
  IF p_org_id NOT IN (SELECT public.get_accessible_org_ids()) THEN
    RAISE EXCEPTION 'not authorized to seed chart of accounts for org %', p_org_id;
  END IF;

  INSERT INTO public.chart_of_accounts (organization_id, code, name, account_type)
  VALUES
    -- Assets (1000-1999)
    (p_org_id, '1000', 'Business bank account',        'asset'),
    (p_org_id, '1010', 'Cash on hand',                 'asset'),
    (p_org_id, '1100', 'Accounts receivable',          'asset'),
    (p_org_id, '1200', 'GST receivable (input credits)','asset'),
    (p_org_id, '1500', 'Tools & equipment',            'asset'),
    (p_org_id, '1600', 'Motor vehicles',               'asset'),
    (p_org_id, '1900', 'Accumulated depreciation',     'asset'),  -- contra-asset (credit balance)
    -- Liabilities (2000-2999)
    (p_org_id, '2000', 'Accounts payable',             'liability'),
    (p_org_id, '2100', 'GST payable (collected)',       'liability'),
    (p_org_id, '2200', 'PAYG withholding payable',      'liability'),
    (p_org_id, '2300', 'Superannuation payable',        'liability'),
    (p_org_id, '2400', 'Credit card',                   'liability'),
    (p_org_id, '2500', 'Loans & finance',               'liability'),
    (p_org_id, '2600', 'Accrued expenses',              'liability'),  -- SC-1.I.02 reversing accruals
    -- Equity (3000-3999)
    (p_org_id, '3000', 'Owner capital',                 'equity'),
    (p_org_id, '3100', 'Owner drawings',                'equity'),
    (p_org_id, '3900', 'Retained earnings',             'equity'),
    -- Income (4000-4999)
    (p_org_id, '4000', 'Job revenue',                   'income'),
    (p_org_id, '4100', 'Materials recharged',           'income'),
    (p_org_id, '4900', 'Other income',                  'income'),
    -- Expenses (5000-6999)
    (p_org_id, '5000', 'Materials & supplies',          'expense'),
    (p_org_id, '5100', 'Subcontractors',                'expense'),
    (p_org_id, '5200', 'Equipment hire',                'expense'),
    (p_org_id, '6000', 'Wages & salaries',              'expense'),
    (p_org_id, '6010', 'Superannuation expense',        'expense'),
    (p_org_id, '6100', 'Fuel & vehicle running',        'expense'),
    (p_org_id, '6200', 'Insurance',                     'expense'),
    (p_org_id, '6300', 'Phone & internet',              'expense'),
    (p_org_id, '6400', 'Software & subscriptions',      'expense'),
    (p_org_id, '6500', 'Accounting & legal',            'expense'),
    (p_org_id, '6600', 'Bank fees & interest',          'expense'),
    (p_org_id, '6700', 'Depreciation expense',          'expense'),
    (p_org_id, '6900', 'Other expenses',                'expense')
  ON CONFLICT (organization_id, code) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_default_chart_of_accounts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.seed_default_chart_of_accounts(uuid) TO authenticated;

COMMENT ON FUNCTION public.seed_default_chart_of_accounts(uuid) IS
  'Idempotent template that seeds a default Australian trades-business chart of accounts for the given org (insert-if-not-exists on organization_id+code). Includes 6700/1900 (depreciation, SC-1.G) and 2600 Accrued expenses (reversing accruals, SC-1.I.02). Call at onboarding. Not prescriptive accounting advice — codes/names are a starting point.';

-- Existing orgs: backfill 2600 wherever a COA already exists (idempotent).
INSERT INTO public.chart_of_accounts (organization_id, code, name, account_type)
SELECT o.organization_id, '2600', 'Accrued expenses', 'liability'::public.account_type
FROM (SELECT DISTINCT organization_id FROM public.chart_of_accounts) o
ON CONFLICT (organization_id, code) DO NOTHING;


-- 2. accrue_recurring_bill: straight-line a bill across N periods, posting a
--    self-cancelling accrual+reversal pair per period via post_journal_entry.
CREATE OR REPLACE FUNCTION public.accrue_recurring_bill(
  p_bill_id              uuid,
  p_periods              integer DEFAULT NULL,   -- N monthly periods; NULL => derive from cadence (SC-1.I.01)
  p_expense_account_code text    DEFAULT '6900', -- expense leg (advisory default; caller overrides per bill)
  p_accrued_account_code text    DEFAULT '2600', -- accrued-expenses liability leg
  p_start_period         date    DEFAULT NULL    -- first period month; default = bill month
)
RETURNS TABLE (
  period_index     integer,  -- 0-based month within the window
  leg              text,     -- 'accrual' | 'reversal'
  entry_date       date,     -- month-end (accrual) / next month-start (reversal)
  amount_cents     bigint,   -- straight-line share for the period
  journal_entry_id uuid,     -- posted (or pre-existing) journal entry
  reused           boolean   -- true when an idempotent prior posting was found
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_bill       public.bills;
  v_org        uuid;
  v_total      bigint;
  v_periods    integer;
  v_start      date;
  v_expense_id uuid;
  v_accrued_id uuid;
  v_supplier   text;
  v_base       bigint;
  v_i          integer;
  v_share      bigint;
  v_accr_date  date;
  v_rev_date   date;
  v_leg        record;
  v_entry_id   uuid;
  v_existing   uuid;
BEGIN
  -- Load the bill (RLS scopes to the caller's accessible orgs under INVOKER).
  SELECT * INTO v_bill FROM public.bills WHERE id = p_bill_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bill % not found or not accessible', p_bill_id;
  END IF;
  IF v_bill.status::text = 'void' THEN
    RAISE EXCEPTION 'bill % is void; cannot accrue', p_bill_id;
  END IF;

  v_org   := v_bill.organization_id;
  v_total := COALESCE(v_bill.subtotal_ex_gst_cents, v_bill.total_inc_gst_cents);
  IF v_total IS NULL OR v_total <= 0 THEN
    RAISE EXCEPTION 'bill % has no positive amount to accrue', p_bill_id;
  END IF;

  -- Periods: explicit, else derived from the recurring-series cadence so only a
  -- *detected* recurring bill accrues (consumes detect_recurring_bills, SC-1.I.01).
  v_periods := p_periods;
  IF v_periods IS NULL THEN
    SELECT CASE
             WHEN d.cadence = 'yearly'      THEN 12
             WHEN d.cadence = 'semi_annual' THEN 6
             WHEN d.cadence = 'quarterly'   THEN 3
             WHEN d.cadence IN ('monthly', 'fortnightly', 'weekly') THEN 1
             ELSE NULL
           END
      INTO v_periods
      FROM public.detect_recurring_bills(v_org) d
      WHERE p_bill_id = ANY (d.bill_ids)
      ORDER BY d.occurrence_count DESC
      LIMIT 1;
    IF v_periods IS NULL THEN
      RAISE EXCEPTION
        'bill % is not part of a detected recurring series; pass p_periods to accrue explicitly',
        p_bill_id;
    END IF;
  END IF;
  IF v_periods < 1 THEN
    RAISE EXCEPTION 'p_periods must be >= 1 (got %)', v_periods;
  END IF;

  -- First period = first day of the chosen month (default = bill's month).
  v_start := date_trunc('month',
               COALESCE(p_start_period, v_bill.invoice_date, v_bill.created_at::date))::date;

  -- Resolve both legs' accounts in the bill's org; fail closed if missing/inactive
  -- (mirrors depreciation-run). Codes are advisory; same-org + active is re-checked
  -- again at post time by post_journal_entry / the 0075 triggers.
  SELECT id INTO v_expense_id FROM public.chart_of_accounts
   WHERE organization_id = v_org AND code = p_expense_account_code AND is_active;
  IF v_expense_id IS NULL THEN
    RAISE EXCEPTION 'expense account % not found/active for org %', p_expense_account_code, v_org;
  END IF;
  SELECT id INTO v_accrued_id FROM public.chart_of_accounts
   WHERE organization_id = v_org AND code = p_accrued_account_code AND is_active;
  IF v_accrued_id IS NULL THEN
    RAISE EXCEPTION 'accrued-expenses account % not found/active for org %', p_accrued_account_code, v_org;
  END IF;

  v_supplier := COALESCE(NULLIF(btrim(v_bill.supplier_name_raw), ''), 'bill ' || left(p_bill_id::text, 8));
  v_base     := v_total / v_periods;   -- integer floor; remainder lands on the final period

  FOR v_i IN 0 .. v_periods - 1 LOOP
    v_share := CASE WHEN v_i = v_periods - 1
                    THEN v_total - v_base * (v_periods - 1)
                    ELSE v_base END;
    -- A 0-cent share (only when total < periods) would violate the one-side line
    -- CHECK (0072); skip the degenerate period — net-to-zero is unaffected.
    CONTINUE WHEN v_share = 0;

    v_rev_date  := (v_start + make_interval(months => v_i + 1))::date; -- first day of the next month
    v_accr_date := v_rev_date - 1;                                     -- last day of period month (its pair)

    -- Two legs per period. Each is a balanced 2-line entry; the pair cancels.
    FOR v_leg IN
      SELECT * FROM (VALUES
        ('accrual',  'bill_accrual',          v_accr_date, v_expense_id, v_accrued_id,
           format('Accrual %s/%s — %s', v_i + 1, v_periods, v_supplier)),
        ('reversal', 'bill_accrual_reversal', v_rev_date,  v_accrued_id, v_expense_id,
           format('Accrual reversal %s/%s — %s', v_i + 1, v_periods, v_supplier))
      ) AS t(leg, src_type, e_date, debit_acct, credit_acct, memo)
    LOOP
      -- Idempotency per (source_type, bill, entry_date): a posted/void entry from
      -- a prior run is reused, never re-posted (treat void as handled — an operator
      -- may have reversed it). Safe to re-run the whole window. Columns are aliased
      -- (je.*) so they bind to the table, not the same-named RETURNS TABLE OUT vars.
      SELECT je.id INTO v_existing
        FROM public.journal_entries je
       WHERE je.source_type = v_leg.src_type
         AND je.source_id   = p_bill_id
         AND je.entry_date  = v_leg.e_date
         AND je.status IN ('posted', 'void')
       LIMIT 1;

      -- Output fields common to both branches; only journal_entry_id + reused differ.
      period_index := v_i; leg := v_leg.leg; entry_date := v_leg.e_date; amount_cents := v_share;

      IF v_existing IS NOT NULL THEN
        journal_entry_id := v_existing; reused := true;
      ELSE
        INSERT INTO public.journal_entries
          (organization_id, entry_date, memo, source_type, source_id, status)
        VALUES (v_org, v_leg.e_date, v_leg.memo, v_leg.src_type, p_bill_id, 'draft')
        RETURNING id INTO v_entry_id;

        INSERT INTO public.journal_lines
          (journal_entry_id, account_id, debit_cents, credit_cents, description)
        VALUES
          (v_entry_id, v_leg.debit_acct,  v_share, 0,       v_leg.memo),
          (v_entry_id, v_leg.credit_acct, 0,       v_share, v_leg.memo);

        PERFORM public.post_journal_entry(v_entry_id);

        journal_entry_id := v_entry_id; reused := false;
      END IF;

      RETURN NEXT;
    END LOOP;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.accrue_recurring_bill(uuid, integer, text, text, date) IS
  'SC-1.I.02: straight-lines a (detected) recurring bill''s net ex-GST amount across N monthly periods, posting a self-cancelling accrual (Dr expense / Cr accrued) at each month-end and a reversal (Dr accrued / Cr expense) at the next month-start via post_journal_entry. Each entry balances; summed across the window every account nets to zero. p_periods NULL derives N from the detect_recurring_bills cadence. Idempotent per (source_type, bill, entry_date). SECURITY INVOKER — RLS scopes the caller; a backend driver must call through an org-scoped token.';

GRANT EXECUTE ON FUNCTION public.accrue_recurring_bill(uuid, integer, text, text, date) TO authenticated;

-- Expose the new RPCs to PostgREST immediately.
NOTIFY pgrst, 'reload schema';
