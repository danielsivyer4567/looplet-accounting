-- 0092: Continuous coding classifier — suggestions store + review queue.
--
-- Phase 1.C foundation. One table (coding_suggestions) records every automated
-- coding classification for a bill — the proposed GL account code, the proposed
-- GST/tax code, a [0,1] confidence, and a lifecycle status — plus one view
-- (coding_review_queue) exposing only the rows a human still needs to look at.
--
-- Pure schema slice: NO classifier logic here. The classifier edge fn lands in
-- SC-1.C.02 and is the only writer of the auto-post path; the review-queue UI is
-- SC-1.D. account_code is the proposed chart_of_accounts.code (0071) and tax_code
-- is the GST code — both stored as advisory text (a proposal a human/edge-fn
-- validates before it ever posts), so neither carries a hard FK that could reject
-- a suggestion referencing a since-renamed/deactivated account.
--
-- Conventions mirror 0088_receipt_hub: RLS via get_accessible_org_ids(),
-- set_updated_at() + audit_log_trigger_v2() triggers, security_invoker view (0082).

-- -- status enum --------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.coding_suggestion_status AS ENUM (
    'needs_review',  -- low-confidence; waiting on a human (the queue)
    'auto_posted',   -- high-confidence; classifier already posted the journal
    'accepted',      -- human accepted the proposal as-is, then posted
    'overridden',    -- human corrected the code, then posted
    'rejected'       -- human rejected the suggestion (no posting)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -- coding_suggestions --------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.coding_suggestions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  bill_id          uuid NOT NULL REFERENCES public.bills(id) ON DELETE CASCADE,
  account_code     text,        -- proposed chart_of_accounts.code (advisory; no hard FK)
  tax_code         text,        -- proposed GST code (advisory; no hard FK)
  confidence       numeric NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  status           public.coding_suggestion_status NOT NULL DEFAULT 'needs_review',
  rationale        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- matcher signals / why (filled by SC-1.C.02)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES auth.users(id),
  deleted_at       timestamptz
);

-- At most one live suggestion per bill — lets the classifier (SC-1.C.02) upsert
-- idempotently ("writes exactly one row" / no double-suggest on re-run).
CREATE UNIQUE INDEX IF NOT EXISTS coding_suggestions_bill_uniq
  ON public.coding_suggestions (bill_id)
  WHERE deleted_at IS NULL;

-- Queue listing: live rows for an org by status, newest first.
CREATE INDEX IF NOT EXISTS coding_suggestions_org_status_idx
  ON public.coding_suggestions (organization_id, status, created_at DESC)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE public.coding_suggestions IS
  'Every automated coding classification for a bill: proposed GL account_code (chart_of_accounts.code) + GST tax_code, a [0,1] confidence, and a lifecycle status. account_code/tax_code are advisory text (validated before posting), not FKs. Written by the classifier edge fn (SC-1.C.02); low-confidence rows surface via coding_review_queue.';

-- -- triggers ------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_coding_suggestions_updated_at ON public.coding_suggestions;
CREATE TRIGGER trg_coding_suggestions_updated_at
  BEFORE UPDATE ON public.coding_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_coding_suggestions_audit ON public.coding_suggestions;
CREATE TRIGGER trg_coding_suggestions_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.coding_suggestions
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger_v2();

-- -- RLS -----------------------------------------------------------------------
-- Clients read only; writes happen through the classifier edge fn / DEFINER RPCs
-- (service_role bypasses RLS), matching the receipt_events backend-written model.
ALTER TABLE public.coding_suggestions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS coding_suggestions_select ON public.coding_suggestions;
CREATE POLICY coding_suggestions_select ON public.coding_suggestions
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

GRANT SELECT ON public.coding_suggestions TO authenticated;

-- -- coding_review_queue (security_invoker, 0082 convention) -------------------
-- Thin filter to the rows a human still owns. security_invoker => the caller's
-- coding_suggestions RLS (above) scopes the view to their orgs.
DROP VIEW IF EXISTS public.coding_review_queue;
CREATE VIEW public.coding_review_queue
  WITH (security_invoker = true) AS
SELECT
  id,
  organization_id,
  bill_id,
  account_code,
  tax_code,
  confidence,
  status,
  rationale,
  created_at,
  updated_at,
  created_by
FROM public.coding_suggestions
WHERE status = 'needs_review'
  AND deleted_at IS NULL;

GRANT SELECT ON public.coding_review_queue TO authenticated;

-- Make PostgREST pick up the new table/view immediately after deployment.
NOTIFY pgrst, 'reload schema';
