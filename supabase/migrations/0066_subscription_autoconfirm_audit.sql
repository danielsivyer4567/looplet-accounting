-- 0066: Subscription auto-confirmation audit columns.
--
-- EPIC C3 — auto-confirm high-confidence subscription candidates.
--
-- The detector (subscriptions-detect) writes candidates into public.subscriptions
-- with status 'detected'/'candidate' and a numeric `confidence`. They then wait
-- for a human to promote them to status='confirmed'.
--
-- This migration adds the audit trail the auto-confirmer needs so that an
-- automatic promotion is distinguishable from a manual one and is idempotent:
--   * auto_confirmed_at    — when (and whether) the row was promoted by automation
--   * confirmed_at         — when the row reached status='confirmed' (manual OR auto)
--   * confirmed_by         — auth.users id for a manual confirm, NULL for automation
--   * confirmation_reason  — human-readable explanation of why it was confirmed
--
-- All additive + IF NOT EXISTS so this is safe to re-run and does not disturb
-- existing rows. No CHECK constraint exists on subscriptions.status today, so
-- no value needs to be added to an enum.

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS auto_confirmed_at   timestamptz,
  ADD COLUMN IF NOT EXISTS confirmed_at        timestamptz,
  ADD COLUMN IF NOT EXISTS confirmed_by        uuid,
  ADD COLUMN IF NOT EXISTS confirmation_reason text;

COMMENT ON COLUMN public.subscriptions.auto_confirmed_at IS
  'Set by subscriptions-autoconfirm when a high-confidence candidate is promoted automatically. NULL = never auto-confirmed (manual or still a candidate).';
COMMENT ON COLUMN public.subscriptions.confirmed_at IS
  'Timestamp the subscription reached status=confirmed (manual or automatic).';
COMMENT ON COLUMN public.subscriptions.confirmed_by IS
  'auth.users id that manually confirmed; NULL when confirmed by automation.';
COMMENT ON COLUMN public.subscriptions.confirmation_reason IS
  'Explanation of why the subscription was confirmed (e.g. auto-confirm rule that fired).';
