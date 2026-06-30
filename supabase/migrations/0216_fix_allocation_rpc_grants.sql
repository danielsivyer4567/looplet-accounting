-- ============================================================================
-- 0216_fix_allocation_rpc_grants.sql
--
-- Grants EXECUTE on bulk_accept_job_suggestions and rematch_unallocated_bills
-- to the authenticated role.
--
-- Context: 0210_allocation_batch.sql revoked EXECUTE from authenticated, but
-- the bills-allocate-batch edge function calls these RPCs via the caller's
-- user JWT (authenticated role via PostgREST). Without this grant the RPCs
-- return permission denied at runtime.
--
-- Both RPCs are SECURITY DEFINER and verify org membership internally via
-- get_accessible_org_ids(), so granting to authenticated is safe — callers
-- can only operate on orgs they belong to.
-- ============================================================================

GRANT EXECUTE ON FUNCTION public.bulk_accept_job_suggestions(uuid, numeric)
  TO authenticated;

GRANT EXECUTE ON FUNCTION public.rematch_unallocated_bills(uuid, integer)
  TO authenticated;
