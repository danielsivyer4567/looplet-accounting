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

CREATE INDEX IF NOT EXISTS subscriptions_org_candidate_idx
  ON public.subscriptions (organization_id)
  WHERE status IN ('detected', 'candidate');
