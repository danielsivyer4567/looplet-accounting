-- 0102: Approvals table — the guardrail ledger every money-mover/lodgement reads.
--
-- Phase 2.A (SC-2.A.02). One row per gated action: its risk tier (0101 enums), its
-- resolution status, a polymorphic pointer to the resource being gated
-- (resource_type + resource_id), and the sha256 payload_hash that BINDS the approval
-- to the exact content approved (so approve-then-mutate-payload can't slip through —
-- is_action_approved() in SC-2.B.03 re-checks the hash).
--
-- Pure schema slice: NO request/approve logic here. request_approval (SC-2.B.01),
-- approve/reject (SC-2.B.02) and is_action_approved (SC-2.B.03) are the only writers
-- and the readers downstream (Phase 3 super-send, Phase 7 DSP lodge) all funnel
-- through that helper. The append-only audit trigger is split into SC-2.A.03 (0103)
-- because the attach is independently assertable and both states stay green.
--
-- SECURITY — backend-written, SELECT-only RLS (cf. 0092_coding_review_queue):
-- there is deliberately NO client INSERT/UPDATE policy. A member who could INSERT
-- their own approvals row could write status='approved'/risk_tier='tier2_approve'
-- and self-approve their own payment run or pay run — defeating the whole gate.
-- Every write therefore goes through the SECURITY DEFINER RPCs (which enforce the
-- role gate + the pending->approved transition); service_role/DEFINER bypass RLS.
--
-- Conventions mirror 0092: gen_random_uuid PK, org FK ON DELETE CASCADE,
-- set_updated_at() trigger, standard created_at/updated_at/created_by/deleted_at.
-- No money column (the payload is referenced by hash, not stored), so cents N/A.

-- -- approvals ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.approvals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  risk_tier        public.approval_risk_tier NOT NULL,
  status           public.approval_status NOT NULL DEFAULT 'pending',

  -- Polymorphic pointer to the gated row (e.g. 'payment_run', 'pay_run', later
  -- 'bas'/'lodgement'); resource_id is that row's uuid PK. The hash, not this
  -- pointer, is what authoritatively binds the approval to the approved content.
  resource_type    text NOT NULL,
  resource_id      uuid NOT NULL,
  payload_hash     text NOT NULL,   -- encode(digest(canonical_payload,'sha256'),'hex')

  -- Domain timestamps/actors (the RPC contract names these explicitly; created_*
  -- below are the row-audit equivalents — same value at insert, kept distinct so
  -- request_approval/approve can stamp domain semantics independently of audit).
  requested_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,  -- null for system/cron tier0
  requested_at     timestamptz NOT NULL DEFAULT now(),
  resolved_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at      timestamptz,
  reject_reason    text,            -- set by reject() (SC-2.B.02); declared up front to avoid a later ALTER

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid REFERENCES auth.users(id),
  deleted_at       timestamptz
);

-- At most one live approval per (resource, exact payload). Backs request_approval's
-- idempotency ("same resource_type+resource_id+hash returns the existing row, not a
-- duplicate") AND serves is_action_approved's exact (org,type,id,hash) lookup — so
-- no separate resource-lookup index is needed (this is its covering prefix).
CREATE UNIQUE INDEX IF NOT EXISTS approvals_resource_payload_uniq
  ON public.approvals (organization_id, resource_type, resource_id, payload_hash)
  WHERE deleted_at IS NULL;

-- Pending-queue listing (SC-2.E): live rows for an org by status, newest request first.
CREATE INDEX IF NOT EXISTS approvals_org_status_idx
  ON public.approvals (organization_id, status, requested_at DESC)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE public.approvals IS
  'Guardrail ledger: one row per gated action (risk_tier + status), pointing at the gated resource (resource_type/resource_id) and binding to its content via payload_hash. Backend-written only via request_approval/approve/reject DEFINER RPCs (SELECT-only RLS); is_action_approved() (SC-2.B.03) is the single read guard every money-mover/lodgement calls.';

-- -- triggers ------------------------------------------------------------------
-- updated_at maintenance only; the append-only audit trigger is SC-2.A.03 (0103).
DROP TRIGGER IF EXISTS trg_approvals_updated_at ON public.approvals;
CREATE TRIGGER trg_approvals_updated_at
  BEFORE UPDATE ON public.approvals
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- -- RLS -----------------------------------------------------------------------
-- SELECT-only for clients (see SECURITY note above). Writes flow through DEFINER
-- RPCs / service_role, which bypass RLS.
ALTER TABLE public.approvals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS approvals_select ON public.approvals;
CREATE POLICY approvals_select ON public.approvals
  FOR SELECT TO authenticated
  USING (organization_id IN (SELECT public.get_accessible_org_ids()));

GRANT SELECT ON public.approvals TO authenticated;

-- Make PostgREST pick up the new table immediately after deployment.
NOTIFY pgrst, 'reload schema';
