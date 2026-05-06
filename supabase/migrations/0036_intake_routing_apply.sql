-- 0036: Auto-routing rules engine support.
--
-- Adds:
--   1. A composite index for fast active-rule lookup by org + priority.
--   2. bank_transactions.applied_intake_rule_id so we can record which rule
--      auto-categorised a given txn (parallel to bills.applied_intake_rule_id).
--
-- Companion edge function: supabase/functions/intake-routing-apply
-- which evaluates intake_rules against a bill or bank_transaction at intake
-- time and applies the first matching rule's non-null fields.

-- 1. Active-rules-by-priority index
--    Used by intake-routing-apply to walk rules in priority order. Partial
--    index keeps it tiny (only active rules) and skips the WHERE clause cost
--    at query time.
CREATE INDEX IF NOT EXISTS intake_rules_org_priority_idx
  ON public.intake_rules (organization_id, matcher_priority DESC)
  WHERE is_active = true;

-- 2. bank_transactions.applied_intake_rule_id
--    Mirrors bills.applied_intake_rule_id. Set by intake-routing-apply when a
--    bank txn auto-categorises against a descriptor_regex / amount_range rule.
ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS applied_intake_rule_id UUID
    REFERENCES public.intake_rules(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS bank_txns_applied_intake_rule_idx
  ON public.bank_transactions (applied_intake_rule_id)
  WHERE applied_intake_rule_id IS NOT NULL;

COMMENT ON COLUMN public.bank_transactions.applied_intake_rule_id IS
  'The intake_rule that auto-applied supplier/job/category to this txn. NULL = unrouted (manual or not yet matched).';
