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
--   * confirmed_by         — auth.users id for a manual confirm (FK); NULL otherwise
--   * confirmation_source  — 'auto' | 'manual', the AUTHORITATIVE marker of who
--                            decided. We do NOT overload a NULL confirmed_by to mean
--                            "automation": confirmed_by is purely the acting user
--                            (and may legitimately be NULL), while confirmation_source
--                            is the explicit, CHECK-constrained intent.
--   * confirmation_reason  — human-readable explanation of why it was confirmed
--
-- All additive + IF NOT EXISTS so this is safe to re-run and does not disturb
-- existing rows. No CHECK constraint exists on subscriptions.status today, so
-- no value needs to be added to an enum.
--
-- Guarded against the subscriptions table not existing on a fresh repo-only DB.
-- (PR #18 backfills subscriptions at 0011, but we guard regardless so this
-- migration is a no-op rather than an error when the table is absent.)

DO $$
BEGIN
  IF to_regclass('public.subscriptions') IS NULL THEN
    RAISE NOTICE '0066: public.subscriptions not present, skipping autoconfirm audit columns';
    RETURN;
  END IF;

  ALTER TABLE public.subscriptions
    ADD COLUMN IF NOT EXISTS auto_confirmed_at   timestamptz,
    ADD COLUMN IF NOT EXISTS confirmed_at        timestamptz,
    ADD COLUMN IF NOT EXISTS confirmed_by        uuid,
    ADD COLUMN IF NOT EXISTS confirmation_source text,
    ADD COLUMN IF NOT EXISTS confirmation_reason text;

  -- FK: confirmed_by must reference a real auth.users row (NULL allowed).
  -- ON DELETE SET NULL so deleting a user doesn't block / orphan audit rows.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_confirmed_by_fkey'
  ) THEN
    ALTER TABLE public.subscriptions
      ADD CONSTRAINT subscriptions_confirmed_by_fkey
      FOREIGN KEY (confirmed_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;

  -- CHECK: confirmation_source is constrained to the known sources.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_confirmation_source_check'
  ) THEN
    ALTER TABLE public.subscriptions
      ADD CONSTRAINT subscriptions_confirmation_source_check
      CHECK (confirmation_source IS NULL OR confirmation_source IN ('auto', 'manual'));
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.subscriptions') IS NULL THEN
    RETURN;
  END IF;

  COMMENT ON COLUMN public.subscriptions.auto_confirmed_at IS
    'Set by subscriptions-autoconfirm when a high-confidence candidate is promoted automatically. NULL = never auto-confirmed (manual or still a candidate).';
  COMMENT ON COLUMN public.subscriptions.confirmed_at IS
    'Timestamp the subscription reached status=confirmed (manual or automatic).';
  COMMENT ON COLUMN public.subscriptions.confirmed_by IS
    'auth.users id of the human who confirmed (FK, ON DELETE SET NULL). NULL when no specific user acted (e.g. automation). Use confirmation_source to determine auto vs manual — do NOT infer it from this being NULL.';
  COMMENT ON COLUMN public.subscriptions.confirmation_source IS
    'Authoritative marker of who confirmed: ''auto'' (subscriptions-autoconfirm) or ''manual'' (a user). NULL until confirmed.';
  COMMENT ON COLUMN public.subscriptions.confirmation_reason IS
    'Explanation of why the subscription was confirmed (e.g. auto-confirm rule that fired).';
END $$;
