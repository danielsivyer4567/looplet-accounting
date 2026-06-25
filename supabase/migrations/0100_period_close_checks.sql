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


-- ============================================================================
-- SC-1.J.02: close_period(p_org, p_period) — post month-end journals + lock.
--
-- The authoritative month-end close. For the calendar month containing p_period
-- it (in order):
--   1. resolves the month bounds + the org's books-health row (v_books_health,
--      0091; SECURITY INVOKER means a non-accessible org yields no row -> raise);
--   2. REFUSES if the month is already covered by an active period_locks row
--      (idempotent: returns the existing lock, posts nothing);
--   3. REFUSES if v_books_health.blocking is true — the SC-1.A.02 foundation gate
--      (score < 80): if the books aren't healthy enough we don't even detail the
--      per-check results, we return the blocker;
--   4. REFUSES if any period_close_checks (SC-1.J.01) row failed, returning those
--      rows in failed_checks;
--   5. posts the "standard month-end journals" — depreciation for the month — then
--   6. writes the period_locks row and returns success.
--
-- Every refusal writes NO lock and returns a structured jsonb payload (no throw):
-- the SC-1.K hook renders it, and once Phase 7 SC-7.I lands the orchestrator turns
-- the exceptions into tasks. There is no approvals dependency — period close is a
-- Tier-1 "notify" action (plan §Tier 1), not a Tier-2 gated money-mover, so it does
-- not wait on an approvals row (SC-2.x is Phase 2).
--
-- MONTH-END JOURNALS = DEPRECIATION. The depreciation posting here is byte-for-byte
-- the same contract as the depreciation-run edge fn (SC-1.G.02): for every active
-- schedule (depreciation_schedules.deleted_at IS NULL whose parent fixed_assets is
-- status='active' and not soft-deleted) it computes compute_depreciation(schedule,
-- period) (0095) and, when > 0 and not already posted, posts the balanced journal
--   Dr 6700 Depreciation expense  /  Cr 1900 Accumulated depreciation
-- via the SOLE sanctioned path post_journal_entry() (0073; GL immutable, 0075).
-- The idempotency key is IDENTICAL to the edge fn's — source_type=
-- 'depreciation_schedule', source_id=<schedule>, entry_date=<month-end>, status IN
-- ('posted','void') — so a cron post and a close post can NEVER double-post each
-- other: whichever runs first posts the month; the other finds it and skips. close
-- is the backstop that guarantees the month's depreciation is captured before the
-- books are frozen, even if the cron is lagging or disabled. (Accruals are NOT
-- re-posted at close: the reversing-accrual engine, SC-1.I, owns which bills accrue
-- and runs on its own cron; close does not second-guess that selection.)
--
-- Ordering note: the pre-flight checks run BEFORE the depreciation post, yet posting
-- can never invalidate a check that just passed — a depreciation journal is balanced
-- by construction (post_journal_entry rejects unbalanced), so trial_balance_balances
-- stays true; it posts draft->posted atomically, so no_unposted_drafts stays true;
-- and it touches no bank_transactions, so reconciliation_completeness is unaffected.
-- So there is no need to re-validate after posting. Conversely we post BEFORE the
-- lock (the plan's order) so the lock witnesses the completed month.
--
-- A depreciation post that ERRORS (accounts 6700/1900 missing/inactive, or
-- post_journal_entry raises) does NOT abort the whole close: it is caught per
-- schedule (subtransaction rolls back that one draft), recorded, and makes close
-- REFUSE to lock — locking a month with un-posted depreciation is exactly the
-- "books not right" state close exists to prevent. Schedules that DID post stay
-- posted; a re-run skips them (idempotent) and posts the rest, then locks.
--
-- SECURITY INVOKER + pinned search_path + GRANT authenticated (matches
-- period_close_checks above / accrue_recurring_bill 0098). RLS scopes every read
-- and the journal_entries/journal_lines/period_locks writes to the caller's orgs;
-- post_journal_entry (SECURITY DEFINER) re-checks organization_id IN
-- get_accessible_org_ids(), which for a USER session resolves from auth.uid() and
-- for a BACKEND caller resolves ONLY from the integration org JWT claim (0069) — so
-- a backend driver (the Phase 7 orchestrator) must call this through a short-lived
-- org-scoped token, exactly like depreciation-run / accrue_recurring_bill; a raw
-- service-role call has no claim and post_journal_entry fails closed.
--
-- FORWARD NOTES (from the SC-1.J.02 altitude review — both out of scope here):
--   * 6700/1900 are the THIRD hardcoded system-account site (after coding-classifier
--     1000/1200/2000 and depreciation-run 6700/1900). When the SC-3.B per-org
--     system-account map lands, replace these literals with a type->account lookup
--     in all three places at once.
--   * close_period and the depreciation-run edge fn now hold TWO copies of the
--     depreciation posting loop, kept consistent only by the shared idempotency key.
--     The non-fragile version is a SQL post_period_depreciation(org, period) RPC that
--     close_period calls directly and depreciation-run calls via rpc(); deferred
--     because it would touch the already-shipped SC-1.G.02 edge fn.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.close_period(
  p_org    uuid,
  p_period date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_start            date;
  v_end              date;
  v_score            integer;
  v_blocking         boolean;
  v_existing_lock    uuid;
  v_new_lock         uuid;
  v_failed           jsonb;
  v_exp_acct         uuid;     -- 6700 Depreciation expense
  v_acc_acct         uuid;     -- 1900 Accumulated depreciation
  v_sched            record;
  v_amt              bigint;
  v_entry_id         uuid;
  v_memo             text;
  v_dep_scanned      integer := 0;
  v_dep_posted       integer := 0;
  v_dep_reused       integer := 0;
  v_dep_skipped_zero integer := 0;
  v_dep_errors       jsonb   := '[]'::jsonb;
BEGIN
  -- Month bounds for the calendar month containing p_period (period_locks range).
  v_start := date_trunc('month', p_period)::date;
  v_end   := (date_trunc('month', p_period) + INTERVAL '1 month' - INTERVAL '1 day')::date;

  -- Books-health row. Under SECURITY INVOKER, v_books_health only exposes the
  -- caller's accessible orgs, so a missing row == not authorized for this org.
  SELECT score, blocking INTO v_score, v_blocking
    FROM public.v_books_health
   WHERE organization_id = p_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'close_period: org % not found or not accessible', p_org;
  END IF;

  -- 1. Already locked? Return the covering lock; post nothing (idempotent close).
  SELECT id INTO v_existing_lock
    FROM public.period_locks
   WHERE organization_id = p_org
     AND unlocked_at IS NULL
     AND period_start <= v_start
     AND period_end   >= v_end
   LIMIT 1;
  IF v_existing_lock IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'status', 'already_locked',
      'period_start', v_start, 'period_end', v_end,
      'period_lock_id', v_existing_lock,
      'message', format('Period %s to %s is already locked.', v_start, v_end)
    );
  END IF;

  -- 2. Books-health blocking gate (SC-1.A.02). Refuse with the blocker; no lock.
  IF v_blocking THEN
    RETURN jsonb_build_object(
      'ok', false, 'status', 'refused', 'reason', 'books_health_blocking',
      'period_start', v_start, 'period_end', v_end,
      'books_health', jsonb_build_object('score', v_score, 'blocking', true),
      'message', format(
        'Books-health score %s is below the close threshold; resolve coding/reconciliation gaps first.',
        v_score)
    );
  END IF;

  -- 3. Pre-flight checks (SC-1.J.01). Collect the failures; refuse if any. No lock.
  SELECT jsonb_agg(jsonb_build_object('check_name', c.check_name, 'detail', c.detail) ORDER BY c.check_name)
    INTO v_failed
    FROM public.period_close_checks(p_org, p_period) c
   WHERE c.passed = false;
  IF v_failed IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'status', 'refused', 'reason', 'preflight_failed',
      'period_start', v_start, 'period_end', v_end,
      'failed_checks', v_failed,
      'message', format('%s pre-flight check(s) failed; period not closed.',
                        jsonb_array_length(v_failed))
    );
  END IF;

  -- 4. Post the month-end depreciation journals (the "standard month-end journals").
  --    Resolve both advisory COA codes (seeded by 0097) in ONE scan — the (org, code)
  --    unique index means each FILTER yields at most one id; a NULL only matters if
  --    there is actually a schedule to post (handled per-schedule below).
  SELECT (array_agg(id) FILTER (WHERE code = '6700'))[1],
         (array_agg(id) FILTER (WHERE code = '1900'))[1]
    INTO v_exp_acct, v_acc_acct
    FROM public.chart_of_accounts
   WHERE organization_id = p_org AND is_active AND code IN ('6700', '1900');

  FOR v_sched IN
    SELECT ds.id AS schedule_id, fa.name AS asset_name
      FROM public.depreciation_schedules ds
      JOIN public.fixed_assets fa ON fa.id = ds.fixed_asset_id
     WHERE ds.organization_id = p_org
       AND ds.deleted_at IS NULL
       AND fa.status = 'active'
       AND fa.deleted_at IS NULL
  LOOP
    v_dep_scanned := v_dep_scanned + 1;
    v_amt := public.compute_depreciation(v_sched.schedule_id, p_period);

    -- Nothing to depreciate this month (before start_date / fully written down).
    IF v_amt IS NULL OR v_amt <= 0 THEN
      v_dep_skipped_zero := v_dep_skipped_zero + 1;
      CONTINUE;
    END IF;

    -- Idempotency: this (schedule, month) already has a posted/void entry (cron or
    -- a prior close run). Treat void as handled — an operator may have reversed it.
    PERFORM 1 FROM public.journal_entries
      WHERE source_type = 'depreciation_schedule'
        AND source_id   = v_sched.schedule_id
        AND entry_date  = v_end
        AND status IN ('posted', 'void')
      LIMIT 1;
    IF FOUND THEN
      v_dep_reused := v_dep_reused + 1;
      CONTINUE;
    END IF;

    -- Accounts must resolve to post; otherwise record an error (refuses the lock).
    IF v_exp_acct IS NULL OR v_acc_acct IS NULL THEN
      v_dep_errors := v_dep_errors || jsonb_build_object(
        'schedule_id', v_sched.schedule_id,
        'error', 'depreciation accounts 6700/1900 not found/active for org');
      CONTINUE;
    END IF;

    -- Build the balanced draft and post it. A per-schedule subtransaction so one
    -- bad schedule (e.g. post_journal_entry raising) rolls back only its own draft.
    BEGIN
      v_memo := 'Depreciation ' || v_end::text || COALESCE(' — ' || v_sched.asset_name, '');
      INSERT INTO public.journal_entries
        (organization_id, entry_date, memo, source_type, source_id, status)
      VALUES (p_org, v_end, v_memo, 'depreciation_schedule', v_sched.schedule_id, 'draft')
      RETURNING id INTO v_entry_id;

      INSERT INTO public.journal_lines
        (journal_entry_id, account_id, debit_cents, credit_cents, description)
      VALUES
        (v_entry_id, v_exp_acct, v_amt, 0, v_memo),
        (v_entry_id, v_acc_acct, 0, v_amt, v_memo);

      PERFORM public.post_journal_entry(v_entry_id);
      v_dep_posted := v_dep_posted + 1;
    EXCEPTION WHEN OTHERS THEN
      v_dep_errors := v_dep_errors || jsonb_build_object(
        'schedule_id', v_sched.schedule_id, 'error', SQLERRM);
    END;
  END LOOP;

  -- A month-end journal failed to post -> refuse to lock (books not yet right).
  IF jsonb_array_length(v_dep_errors) > 0 THEN
    RETURN jsonb_build_object(
      'ok', false, 'status', 'refused', 'reason', 'month_end_journal_failed',
      'period_start', v_start, 'period_end', v_end,
      'depreciation', jsonb_build_object(
        'scanned', v_dep_scanned, 'posted', v_dep_posted,
        'reused', v_dep_reused, 'skipped_zero', v_dep_skipped_zero,
        'errors', v_dep_errors),
      'message', 'Could not post all month-end depreciation journals; period not closed.'
    );
  END IF;

  -- 5. Lock the period. reason is NOT NULL (0001); locked_by = the acting user
  --    (NULL for a backend org-token caller — the column is nullable).
  INSERT INTO public.period_locks
    (organization_id, period_start, period_end, reason, locked_by)
  VALUES
    (p_org, v_start, v_end,
     format('Month-end close %s', to_char(v_start, 'Mon YYYY')),
     auth.uid())
  RETURNING id INTO v_new_lock;

  RETURN jsonb_build_object(
    'ok', true, 'status', 'closed',
    'period_start', v_start, 'period_end', v_end,
    'period_lock_id', v_new_lock,
    'depreciation', jsonb_build_object(
      'scanned', v_dep_scanned, 'posted', v_dep_posted,
      'reused', v_dep_reused, 'skipped_zero', v_dep_skipped_zero),
    'message', format('Period %s to %s closed; %s depreciation journal(s) posted.',
                      v_start, v_end, v_dep_posted)
  );
END;
$$;

COMMENT ON FUNCTION public.close_period(uuid, date) IS
  'SC-1.J.02: month-end close for the calendar month of p_period. Refuses (structured jsonb, no lock) if already locked, if v_books_health.blocking, or if any period_close_checks row failed; otherwise posts the month''s depreciation journals (same Dr 6700/Cr 1900 + idempotency key as the depreciation-run edge fn, so cron and close never double-post) via post_journal_entry, then writes a period_locks row. A depreciation post error refuses the lock. SECURITY INVOKER — RLS scopes the caller; a backend driver must call through an org-scoped token. Period close is Tier-1 notify, not an approvals-gated money-mover.';

GRANT EXECUTE ON FUNCTION public.close_period(uuid, date) TO authenticated;

-- New client-callable RPCs (period_close_checks + close_period): refresh
-- PostgREST's schema cache so the SC-1.K period-close hook can reach them via
-- supabase.rpc() immediately on deploy (matches 0094/0098).
NOTIFY pgrst, 'reload schema';
