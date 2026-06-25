-- 0103: Append-only audit trail on approvals.
--
-- Phase 2.A (SC-2.A.03). Attaches the existing audit_log_trigger_v2() (0039) to
-- public.approvals — the "append-only in audit_log" half of the §3.2 guardrail
-- contract. Split from SC-2.A.02 (0102) because the attach is independently
-- assertable and both states leave the build green.
--
-- NO new audit function: audit_log_trigger_v2() (SECURITY DEFINER) already logs
-- every INSERT/UPDATE/DELETE to audit_log, reading organization_id + id off the
-- row (approvals has both) and recording table_name='approvals', the operation,
-- and a per-column old/new `changes` diff on UPDATE. That diff is exactly the
-- approval-resolution trail we want: every pending->approved/rejected transition
-- (status, resolved_by, resolved_at, reject_reason) lands in audit_log immutably.
-- Attach pattern + trigger naming mirror 0092_coding_review_queue.

DROP TRIGGER IF EXISTS trg_approvals_audit ON public.approvals;
CREATE TRIGGER trg_approvals_audit
  AFTER INSERT OR UPDATE OR DELETE ON public.approvals
  FOR EACH ROW EXECUTE FUNCTION public.audit_log_trigger_v2();
