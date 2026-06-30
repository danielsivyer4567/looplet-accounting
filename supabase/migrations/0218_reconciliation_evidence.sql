-- 0218: Reconciliation evidence — per-decision audit trail for auto-reconcile.
--
-- Every auto-apply (auto_applied=true) and every ambiguous skip (auto_applied=false,
-- skipped_reason set) writes one row. Multiple rows accumulate across runs (append-only).
-- The UI reads this to surface "Why Looplet picked this" and user overrides feed into
-- automation_feedback (0205) as labelled training signal.
--
-- RLS: org members read-only via SELECT policy; service_role writes via admin client
-- in the auto-reconcile edge fn. REVOKE follows the DEFINER grant pattern (AUDIT.md §4).

CREATE TABLE IF NOT EXISTS public.reconciliation_evidence (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_transaction_id uuid        NOT NULL REFERENCES public.bank_transactions(id) ON DELETE CASCADE,
  organization_id     uuid        NOT NULL REFERENCES public.organizations(id),
  reason_codes        text[]      NOT NULL DEFAULT '{}',
  score_components    jsonb       NOT NULL DEFAULT '{}',
  auto_applied        boolean     NOT NULL DEFAULT false,
  skipped_reason      text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reconciliation_evidence_txn_idx
  ON public.reconciliation_evidence (bank_transaction_id);
CREATE INDEX IF NOT EXISTS reconciliation_evidence_org_created_idx
  ON public.reconciliation_evidence (organization_id, created_at DESC);

ALTER TABLE public.reconciliation_evidence ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.reconciliation_evidence TO authenticated;

CREATE POLICY "org_members_read_reconciliation_evidence"
  ON public.reconciliation_evidence
  FOR SELECT
  USING (organization_id IN (SELECT get_accessible_org_ids()));

-- Writes go through service_role only (auto-reconcile edge fn uses admin client).
REVOKE INSERT, UPDATE, DELETE
  ON public.reconciliation_evidence FROM authenticated, anon;
