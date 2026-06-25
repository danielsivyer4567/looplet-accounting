-- ============================================================================
-- 0100: period_close_checks — read-only pre-flight gate for month-end close
--       (ledger SC-1.J.01).
--
-- Returns ONE row per pre-flight check for the calendar month containing
-- p_period, each with a pass/fail boolean and a jsonb detail payload. This is
-- the cheap, side-effect-free probe that SC-1.J.02 close_period() calls before
-- it posts any month-end journal or writes a period_locks row, and that the
-- SC-1.K period-close UI renders as a checklist. NOTHING here mutates state.
--
-- Three checks (check_name -> meaning):
--
--   reconciliation_completeness : every BUSINESS bank_transaction dated in the
--       month is matched to a bill or invoice. The "reconciled" predicate is the
--       canonical one used across 0008/0043 and compute_books_health (0090):
--       matched_bill_id IS NOT NULL OR matched_invoice_id IS NOT NULL. Rows with
--       is_personal are EXCLUDED (is_personal IS NOT TRUE) — owner-personal
--       transactions are deliberately kept off the business books and never
--       receive a business match, so counting them would block close forever;
--       every business-book view (BAS/cash-flow/balance-sheet, 0032/0041/0047)
--       and the books-health unreconciled signal (0090) apply the same filter.
--       This check is the books-health unreconciled signal narrowed to the month
--       being closed.
--
--   trial_balance_balances : the org's double-entry ledger balances, i.e.
--       SUM(net_cents) over v_trial_balance (0074) = 0. This is intentionally a
--       WHOLE-LEDGER invariant, NOT period-scoped: v_trial_balance is cumulative
--       over all posted entries (it carries no date dimension) and a trial
--       balance balances by definition regardless of as-at date. post_journal_
--       entry() (0073) enforces debits=credits at post time, so this only fails
--       if an unbalanced entry reached 'posted' by bypassing the RPC — exactly
--       the corruption a close must refuse to lock over.
--
--   no_unposted_drafts : no journal_entries (0072) with status='draft' dated in
--       the month — a draft is an un-finalised transaction, so the month is not
--       ready to close while one exists.
--
-- p_period is interpreted as ANY day in the target calendar month; the derived
-- month bounds become period_locks.period_start/period_end when SC-1.J.02 locks.
--
-- SECURITY INVOKER + pinned search_path + GRANT authenticated — the read-only
-- function convention (0090/0094/0095/0098). RLS on bank_transactions /
-- journal_entries and v_trial_balance's own security_invoker scope results to
-- the caller's accessible orgs; a service_role backend bypasses RLS. Passing
-- another org's id simply yields empty/passing checks (no cross-tenant leak),
-- matching detect_capital_purchases' INVOKER posture.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.period_close_checks(
  p_org    uuid,
  p_period date
)
RETURNS TABLE (
  check_name text,
  passed     boolean,
  detail     jsonb
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH bounds AS (
    SELECT
      date_trunc('month', p_period)::date AS period_start,
      (date_trunc('month', p_period) + INTERVAL '1 month' - INTERVAL '1 day')::date AS period_end
  ),
  recon AS (
    SELECT count(*)::int AS unreconciled_count
    FROM public.bank_transactions bt
    CROSS JOIN bounds b
    WHERE bt.organization_id = p_org
      AND bt.is_personal IS NOT TRUE
      AND bt.matched_bill_id IS NULL
      AND bt.matched_invoice_id IS NULL
      AND bt.posted_at::date BETWEEN b.period_start AND b.period_end
  ),
  drafts AS (
    SELECT count(*)::int AS draft_count
    FROM public.journal_entries je
    CROSS JOIN bounds b
    WHERE je.organization_id = p_org
      AND je.status = 'draft'
      AND je.entry_date BETWEEN b.period_start AND b.period_end
  ),
  tb AS (
    SELECT COALESCE(sum(net_cents), 0)::bigint AS imbalance_cents
    FROM public.v_trial_balance
    WHERE organization_id = p_org
  )
  SELECT
    'reconciliation_completeness'::text,
    recon.unreconciled_count = 0,
    jsonb_build_object(
      'unreconciled_count', recon.unreconciled_count,
      'period_start',       b.period_start,
      'period_end',         b.period_end,
      'message', CASE WHEN recon.unreconciled_count = 0
        THEN 'All business bank transactions in the period are reconciled.'
        ELSE recon.unreconciled_count || ' business bank transaction(s) in the period are not matched to a bill or invoice.'
      END
    )
  FROM recon CROSS JOIN bounds b
  UNION ALL
  SELECT
    'trial_balance_balances'::text,
    tb.imbalance_cents = 0,
    jsonb_build_object(
      'imbalance_cents', tb.imbalance_cents,
      'scope',           'whole_ledger',
      'message', CASE WHEN tb.imbalance_cents = 0
        THEN 'Trial balance balances (total debits = total credits).'
        ELSE 'Trial balance is out by ' || tb.imbalance_cents || ' cents (debits minus credits).'
      END
    )
  FROM tb
  UNION ALL
  SELECT
    'no_unposted_drafts'::text,
    drafts.draft_count = 0,
    jsonb_build_object(
      'draft_count',  drafts.draft_count,
      'period_start', b.period_start,
      'period_end',   b.period_end,
      'message', CASE WHEN drafts.draft_count = 0
        THEN 'No unposted draft journal entries in the period.'
        ELSE drafts.draft_count || ' draft journal entries in the period are not yet posted.'
      END
    )
  FROM drafts CROSS JOIN bounds b;
$$;

COMMENT ON FUNCTION public.period_close_checks(uuid, date) IS
  'Read-only month-end close pre-flight (SC-1.J.01). Returns one row per check (reconciliation_completeness, trial_balance_balances, no_unposted_drafts) with passed boolean + detail jsonb, for the calendar month containing p_period. Consumed by SC-1.J.02 close_period() (refuses to lock unless all pass) and the SC-1.K period-close UI. SECURITY INVOKER — RLS scopes to the caller''s orgs.';

GRANT EXECUTE ON FUNCTION public.period_close_checks(uuid, date) TO authenticated;

-- New client-callable RPC: refresh PostgREST's schema cache so the SC-1.K
-- period-close hook can reach it via supabase.rpc() immediately on deploy
-- (matches 0094/0098, the other new client-facing RPCs).
NOTIFY pgrst, 'reload schema';
