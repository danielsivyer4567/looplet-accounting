-- ============================================================================
-- 0075: General-ledger integrity — posted-entry immutability + same-org line
--       accounts.
--
-- Two independent integrity guards that the base GL schema (0072) left to RLS
-- alone, which is not sufficient:
--
--   1. IMMUTABILITY OF POSTED ENTRIES (review HIGH).
--      The 0072 RLS policies grant UPDATE/DELETE on journal_entries and
--      journal_lines with no status guard, so a posted (audited, reported-on)
--      entry could be silently edited or deleted. Accounting requires posted
--      entries to be immutable; a mistake is corrected with a *reversing*
--      entry, not by mutating history. We freeze posted entries and their
--      lines via BEFORE triggers. The ONLY permitted change to a posted header
--      is a status transition posted -> void (with posted_at preserved); every
--      other column, and any line INSERT/UPDATE/DELETE under a posted entry, is
--      rejected.
--
--   2. SAME-ORG LINE ACCOUNTS (review HIGH).
--      journal_lines.account_id only FKs chart_of_accounts(id) — there is no
--      tie back to the parent entry's organization_id. A user with access to
--      two orgs could attach org A's entry to a line referencing org B's
--      account, leaking the amount into org B's v_trial_balance. We validate at
--      write time that the line's account belongs to the same org as its entry.
--      (post_journal_entry in 0073 re-checks this at post time too; this trigger
--      stops the bad row from ever being written.)
--
-- All functions are plain (non-DEFINER) trigger functions running with the
-- writer's own privileges, SET search_path = public per repo convention.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1a. Freeze posted journal_entries headers.
--
-- BEFORE UPDATE: if the row was posted, the only allowed mutation is flipping
--   status to 'void' (a reversal/cancel workflow). Any other column change, or
--   any other target status, is rejected.
-- BEFORE DELETE: a posted entry can never be deleted.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_posted_journal_entry()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'posted' THEN
      RAISE EXCEPTION
        'journal entry % is posted and cannot be deleted; reverse it instead',
        OLD.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  IF OLD.status = 'posted' THEN
    -- Permit only posted -> void (cancellation). posted_at is preserved.
    IF NEW.status = 'posted' THEN
      -- No-op status; ensure nothing else changed.
      IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
         OR NEW.entry_date   IS DISTINCT FROM OLD.entry_date
         OR NEW.memo         IS DISTINCT FROM OLD.memo
         OR NEW.source_type  IS DISTINCT FROM OLD.source_type
         OR NEW.source_id    IS DISTINCT FROM OLD.source_id
         OR NEW.posted_at    IS DISTINCT FROM OLD.posted_at
         OR NEW.created_at   IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION
          'journal entry % is posted and is immutable; correct it with a reversing entry',
          OLD.id
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF NEW.status = 'void' THEN
      -- Allowed transition; freeze every other field.
      IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
         OR NEW.entry_date   IS DISTINCT FROM OLD.entry_date
         OR NEW.memo         IS DISTINCT FROM OLD.memo
         OR NEW.source_type  IS DISTINCT FROM OLD.source_type
         OR NEW.source_id    IS DISTINCT FROM OLD.source_id
         OR NEW.posted_at    IS DISTINCT FROM OLD.posted_at
         OR NEW.created_at   IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION
          'voiding journal entry % may change only status; other fields are immutable',
          OLD.id
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSE
      RAISE EXCEPTION
        'journal entry % is posted; status may only move to void',
        OLD.id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_journal_entries_guard_posted ON public.journal_entries;
CREATE TRIGGER trg_journal_entries_guard_posted
  BEFORE UPDATE OR DELETE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.guard_posted_journal_entry();

COMMENT ON FUNCTION public.guard_posted_journal_entry() IS
  'Trigger guard: a posted journal_entries row is immutable except for a status transition posted -> void (posted_at and all other columns preserved); posted rows cannot be deleted. Corrections go through a reversing entry.';

-- ----------------------------------------------------------------------------
-- 1b. Freeze journal_lines under a posted (or void) entry.
--
-- Once the parent entry is posted, its lines are part of the permanent record:
-- no INSERT, UPDATE, or DELETE. void entries are likewise frozen (they are
-- already excluded from reporting; they should not be re-edited into life).
-- We check the PARENT status. On INSERT/UPDATE we look at the (new) parent; on
-- DELETE we look at the old parent.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_posted_journal_line()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_entry_id uuid;
  v_status   public.journal_entry_status;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_entry_id := OLD.journal_entry_id;
  ELSE
    v_entry_id := NEW.journal_entry_id;
  END IF;

  SELECT status INTO v_status
    FROM public.journal_entries
   WHERE id = v_entry_id;

  IF v_status IN ('posted', 'void') THEN
    RAISE EXCEPTION
      '% on journal line is forbidden: parent entry % is %; reverse it instead',
      TG_OP, v_entry_id, v_status
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_journal_lines_guard_posted ON public.journal_lines;
CREATE TRIGGER trg_journal_lines_guard_posted
  BEFORE INSERT OR UPDATE OR DELETE ON public.journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.guard_posted_journal_line();

COMMENT ON FUNCTION public.guard_posted_journal_line() IS
  'Trigger guard: journal_lines may only be inserted/updated/deleted while their parent journal_entries row is still draft. Once the parent is posted or void the lines are frozen; corrections go through a reversing entry.';

-- ----------------------------------------------------------------------------
-- 2. Same-org tie between a line's account and its parent entry.
--
-- BEFORE INSERT OR UPDATE on journal_lines: the referenced account must belong
-- to the same organization as the parent entry. This closes the cross-org leak
-- where a multi-org user could point a line at another org's account.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_journal_line_same_org()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_entry_org   uuid;
  v_account_org uuid;
BEGIN
  SELECT organization_id INTO v_entry_org
    FROM public.journal_entries
   WHERE id = NEW.journal_entry_id;

  SELECT organization_id INTO v_account_org
    FROM public.chart_of_accounts
   WHERE id = NEW.account_id;

  IF v_entry_org IS NULL THEN
    RAISE EXCEPTION 'journal line references unknown entry %', NEW.journal_entry_id;
  END IF;

  IF v_account_org IS NULL THEN
    RAISE EXCEPTION 'journal line references unknown account %', NEW.account_id;
  END IF;

  IF v_account_org <> v_entry_org THEN
    RAISE EXCEPTION
      'journal line account % (org %) does not belong to the entry''s org %',
      NEW.account_id, v_account_org, v_entry_org
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_journal_lines_same_org ON public.journal_lines;
CREATE TRIGGER trg_journal_lines_same_org
  BEFORE INSERT OR UPDATE ON public.journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.enforce_journal_line_same_org();

COMMENT ON FUNCTION public.enforce_journal_line_same_org() IS
  'Trigger guard: a journal_lines.account_id must reference a chart_of_accounts row in the SAME organization as the line''s parent journal_entry. Prevents a multi-org user from leaking a line into another org''s v_trial_balance.';
