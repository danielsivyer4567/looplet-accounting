-- ============================================================================
-- Migration: 0209_period_lock_coverage
-- Project:   Looplet Accounting  (finish-line: P1-11)
-- Purpose:   Extend period-lock enforcement to the money-movement tables that
--            were never wired to a lock trigger, so a write that lands in (or
--            moves out of) a CLOSED accounting period is rejected at the DB.
--
--   Background — the period-lock primitive is the period_locks table + the
--   check_period_lock() BEFORE INSERT OR UPDATE trigger from 0001. The locked
--   predicate is the canonical one used across 0001/0090/0132/0183:
--       organization_id = <org>
--       AND <date> BETWEEN period_start AND period_end
--       AND unlocked_at IS NULL
--   The 0001 close mechanism (close_period, 0100) writes one period_locks row
--   per closed month. Today the trigger is attached only to three tables:
--     - bills            (bill_date)     ✔ 0001
--     - customer_invoices(invoice_date)  ✔ 0001  (legacy AR table)
--     - wage_entries     (work_date)     ✔ 0001
--   …yet every other money table can be written freely into a locked period:
--     - invoices ............ issue_date   (the live AR table, 0030)  GAP
--     - pay_runs ............ period_end   (0045)                     GAP
--     - pay_slips ........... <parent pay_run period> (0045)          GAP
--     - bank_transactions ... posted_at    (0008)                     GAP
--     - journal_entries ..... entry_date   (0072, the GL header)      GAP
--   A locked month must be immutable across ALL of these, or "closed" means
--   nothing — close_period freezes the books, but a stray invoice/journal
--   posted afterward silently changes a period the BAS/financials were built on.
--
--   Two gaps in the 0001 primitive this migration also closes:
--     1. DELETE was never guarded — check_period_lock() reads NEW (NULL on
--        DELETE) and is attached BEFORE INSERT OR UPDATE only, so a row in a
--        locked period could be deleted. The v2 guard fires on DELETE too and
--        reads OLD.
--     2. UPDATE only checked the NEW date, so a row could be MOVED OUT of a
--        locked period. The v2 guard checks BOTH the OLD and NEW date on UPDATE
--        — you cannot insert into, mutate within, OR move a row out of a lock.
--
--   check_period_lock_v2(date_column text): a table-agnostic BEFORE
--   INSERT OR UPDATE OR DELETE trigger fn. The date column to test is passed as
--   a trigger argument (TG_ARGV[0]) and read off the row via to_jsonb(...)::date
--   (so a timestamptz like bank_transactions.posted_at narrows to its date).
--   The special token '@pay_run' means "this row has no own date — resolve the
--   period from the parent pay_runs row", which is how pay_slips is covered.
--   It REUSES the existing period_locks table + locked predicate; no new lock
--   storage is introduced. The original check_period_lock() (0001) is left in
--   place on bills/customer_invoices/wage_entries — unchanged behaviour there.
--
--   No behavioural change for UNLOCKED periods: with no covering period_locks
--   row the EXISTS is false and the trigger RETURNs the row untouched, exactly
--   as before. The only new rejections are writes that touch a locked period.
--
--   Idempotent: CREATE OR REPLACE for the fn; the attach loop is guarded with
--   to_regclass() (so it runs whether or not each table exists in the target
--   DB) and uses DROP TRIGGER IF EXISTS ... CREATE TRIGGER under the dedicated
--   trg_<table>_period_lock_v2 name, so re-applying simply replaces the same
--   trigger. Mirrors the 0207 money-audit-coverage migration's structure.
--
--   LIVE PROOF (deploy-gated — no DB in this worktree): lock a month via
--   close_period(org, '<month>-15'), then INSERT a journal_entries /
--   bank_transactions / invoices / pay_runs row dated inside that month, or a
--   pay_slips row whose pay_run period overlaps it — each must raise
--   'Cannot modify record dated %: period is locked' (ERRCODE check_violation);
--   the same writes dated in an OPEN month succeed unchanged.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Table-agnostic guard. date_column is the row column to test (cast to
--    date); the special token '@pay_run' resolves the period from the parent
--    pay_runs row instead. Fires on INSERT / UPDATE / DELETE; on UPDATE both
--    the old and the new date are tested so a row cannot be moved out of a
--    locked period either.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_period_lock_v2()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_col      text := TG_ARGV[0];
  v_row      jsonb;
  v_org_id   uuid;
  v_date_new date;
  v_date_old date;
BEGIN
  -- Resolve the org + candidate date(s) for the row(s) this op touches.
  -- INSERT/UPDATE -> NEW, DELETE -> OLD. On UPDATE we evaluate BOTH so the
  -- write is rejected if it touches a locked period on either side.
  IF v_col = '@pay_run' THEN
    -- pay_slips has no own date column: a slip belongs to a locked period iff
    -- its parent pay_run's [period_start, period_end] overlaps any active lock.
    IF TG_OP <> 'DELETE' THEN
      v_org_id := (to_jsonb(NEW)->>'organization_id')::uuid;
      IF EXISTS (
        SELECT 1
          FROM public.pay_runs pr
          JOIN public.period_locks pl
            ON pl.organization_id = pr.organization_id
           AND pl.unlocked_at IS NULL
           AND pr.period_start <= pl.period_end
           AND pr.period_end   >= pl.period_start
         WHERE pr.id = (to_jsonb(NEW)->>'pay_run_id')::uuid
      ) THEN
        RAISE EXCEPTION 'Cannot modify pay slip in a locked pay-run period'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF TG_OP <> 'INSERT' THEN
      IF EXISTS (
        SELECT 1
          FROM public.pay_runs pr
          JOIN public.period_locks pl
            ON pl.organization_id = pr.organization_id
           AND pl.unlocked_at IS NULL
           AND pr.period_start <= pl.period_end
           AND pr.period_end   >= pl.period_start
         WHERE pr.id = (to_jsonb(OLD)->>'pay_run_id')::uuid
      ) THEN
        RAISE EXCEPTION 'Cannot modify pay slip in a locked pay-run period'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Generic case: the row carries its own org + date column.
  IF TG_OP <> 'DELETE' THEN
    v_org_id   := (to_jsonb(NEW)->>'organization_id')::uuid;
    v_date_new := (to_jsonb(NEW)->>v_col)::date;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    v_org_id   := COALESCE(v_org_id, (to_jsonb(OLD)->>'organization_id')::uuid);
    v_date_old := (to_jsonb(OLD)->>v_col)::date;
  END IF;

  IF v_org_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Canonical locked predicate (0001/0090): any active lock whose range covers
  -- either the new or the old date for this org rejects the write.
  IF EXISTS (
    SELECT 1
      FROM public.period_locks pl
     WHERE pl.organization_id = v_org_id
       AND pl.unlocked_at IS NULL
       AND (
            (v_date_new IS NOT NULL AND v_date_new BETWEEN pl.period_start AND pl.period_end)
         OR (v_date_old IS NOT NULL AND v_date_old BETWEEN pl.period_start AND pl.period_end)
       )
  ) THEN
    RAISE EXCEPTION 'Cannot modify record dated %: period is locked',
      COALESCE(v_date_new, v_date_old)
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.check_period_lock_v2() IS
  'Period-lock guard (P1-11). BEFORE INSERT/UPDATE/DELETE trigger fn: rejects a write that touches a locked accounting period (period_locks, unlocked_at IS NULL). TG_ARGV[0] names the date column to test (cast to date); the token ''@pay_run'' resolves the period from the parent pay_runs row (for pay_slips, which has no own date). On UPDATE both old and new dates are checked so a row cannot be moved out of a lock; DELETE is guarded via OLD. Reuses the 0001 period_locks primitive — no behaviour change for unlocked periods.';

-- ----------------------------------------------------------------------------
-- 2. Attach the guard to every money table that was missing it. Each entry is
--    'table:date_column' (or 'pay_slips:@pay_run'). Guarded with to_regclass()
--    and DROP TRIGGER IF EXISTS so the migration is idempotent and tolerant of
--    a table not existing in a given database. The trg_<table>_period_lock_v2
--    name is distinct from the 0001 trg_<table>_period_lock, so this never
--    collides with the original trigger on bills/customer_invoices/wage_entries.
--
--    customer_invoices is RE-asserted here (with DELETE/move-out coverage) even
--    though 0001 already guards its INSERT/UPDATE — the legacy 0001 trigger does
--    not cover DELETE or move-out. Both triggers can coexist; v2 simply adds the
--    stronger checks. invoices is the live AR table the app actually writes to.
-- ----------------------------------------------------------------------------
DO $period_lock$
DECLARE
  spec    text;
  v_table text;
  v_col   text;
BEGIN
  FOR spec IN SELECT unnest(ARRAY[
    'invoices:issue_date',
    'customer_invoices:invoice_date',
    'pay_runs:period_end',
    'pay_slips:@pay_run',
    'bank_transactions:posted_at',
    'journal_entries:entry_date'
  ])
  LOOP
    v_table := split_part(spec, ':', 1);
    v_col   := split_part(spec, ':', 2);

    IF to_regclass(format('public.%I', v_table)) IS NOT NULL THEN
      EXECUTE format(
        'DROP TRIGGER IF EXISTS trg_%I_period_lock_v2 ON public.%I;', v_table, v_table
      );
      EXECUTE format(
        'CREATE TRIGGER trg_%I_period_lock_v2
           BEFORE INSERT OR UPDATE OR DELETE ON public.%I
           FOR EACH ROW EXECUTE FUNCTION public.check_period_lock_v2(%L);',
        v_table, v_table, v_col
      );
    ELSE
      RAISE NOTICE 'Skipping % period-lock trigger (table not present in this database)', v_table;
    END IF;
  END LOOP;
END
$period_lock$;

COMMIT;
