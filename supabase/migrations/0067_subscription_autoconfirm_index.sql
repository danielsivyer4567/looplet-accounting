-- 0067: Index supporting subscriptions-autoconfirm candidate scans.
--
-- EPIC C3 — the auto-confirmer repeatedly scans for not-yet-confirmed
-- candidates within one organization:
--
--   SELECT ... FROM subscriptions
--   WHERE organization_id = $1
--     AND status IN ('detected','candidate')
--
-- This partial index keeps that scan cheap and bounded to unreviewed rows,
-- so the auto-confirm pass stays fast even as the confirmed/cancelled/dismissed
-- backlog grows.
--
-- Guarded against the subscriptions table not existing on a fresh repo-only DB.
-- (PR #18 backfills subscriptions at 0011, but we guard regardless so this
-- migration is a no-op rather than an error when the table is absent.)

DO $$
BEGIN
  IF to_regclass('public.subscriptions') IS NULL THEN
    RAISE NOTICE '0067: public.subscriptions not present, skipping candidate index';
    RETURN;
  END IF;

  CREATE INDEX IF NOT EXISTS subscriptions_org_candidate_idx
    ON public.subscriptions (organization_id)
    WHERE status = 'candidate';
END $$;
