import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

export interface ApprovalRow {
  id: string;
  organization_id: string;
  risk_tier: 'tier0_silent' | 'tier1_notify' | 'tier2_approve';
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  resource_type: string;
  resource_id: string;
  payload_hash: string;
  requested_by: string | null;
  requested_at: string;
  resolved_by: string | null;
  resolved_at: string | null;
  reject_reason: string | null;
  created_at: string;
}

const APPROVAL_COLS =
  'id, organization_id, risk_tier, status, resource_type, resource_id, payload_hash, ' +
  'requested_by, requested_at, resolved_by, resolved_at, reject_reason, created_at';

/**
 * Pending Tier-2 approvals queue + resolve mutations (SC-2.E.01).
 *
 * Reads the `approvals` table (0102) scoped to the current org, newest request first.
 * The table is SELECT-only for clients; `approve`/`reject` therefore route through the
 * SECURITY DEFINER RPCs (0105) — never a direct table write. A resolved row drops out
 * of the queue on the follow-up refresh. Mirrors usePaymentRuns (query + org scope +
 * hand-typed row + `as unknown as` cast — the repo has no generated Supabase types).
 */
export function useApprovals() {
  const { currentOrg } = useOrg();
  const [pending, setPending] = useState<ApprovalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!currentOrg) {
      setPending([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data, error: err } = await supabase
      .from('approvals')
      .select(APPROVAL_COLS)
      .eq('organization_id', currentOrg.id)
      .eq('status', 'pending')
      .is('deleted_at', null)
      .order('requested_at', { ascending: false })
      .limit(100);

    if (err) {
      setError(err.message);
    } else {
      setError(null);
      setPending((data ?? []) as unknown as ApprovalRow[]);
    }
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  // approve/reject go through the role-gated DEFINER RPCs (0105); reject requires a
  // non-empty reason (the RPC raises otherwise). Both share the resolve path: throw on
  // failure so the page can surface the real message; refresh so the row leaves the queue.
  const resolve = useCallback(
    async (rpc: string, args: Record<string, unknown>) => {
      const { error: err } = await supabase.rpc(rpc, args);
      if (err) throw new Error(err.message);
      await fetch();
    },
    [fetch],
  );

  const approve = useCallback(
    (approvalId: string) => resolve('approve', { p_approval_id: approvalId }),
    [resolve],
  );
  const reject = useCallback(
    (approvalId: string, reason: string) =>
      resolve('reject', { p_approval_id: approvalId, p_reason: reason }),
    [resolve],
  );

  // Open an approval for a gated action (request_approval, 0104). The payload is passed
  // as jsonb and hashed server-side — never serialise it in JS, so this request and the
  // matching is_action_approved check below bind to the SAME hash (the 0106 jsonb-overload
  // contract; avoids the JSON.stringify-vs-jsonb::text parity trap). Refreshes the pending
  // queue so a freshly-opened request shows up. Throws so the caller can surface the error.
  const requestApproval = useCallback(
    async (
      resourceType: string,
      resourceId: string,
      payload: Record<string, unknown>,
      riskTier: ApprovalRow['risk_tier'] = 'tier2_approve',
    ): Promise<void> => {
      if (!currentOrg) throw new Error('No organisation selected.');
      const { error: err } = await supabase.rpc('request_approval', {
        p_org: currentOrg.id,
        p_resource_type: resourceType,
        p_resource_id: resourceId,
        p_risk_tier: riskTier,
        p_payload: payload,
      });
      if (err) throw new Error(err.message);
      await fetch();
    },
    [currentOrg, fetch],
  );

  // The single Tier-2 guard (is_action_approved jsonb overload, 0106): TRUE only when a
  // live, human-approved tier2 row binds to this EXACT payload — so editing the resource
  // after approval (a different payload) re-gates it. Same jsonb shape as requestApproval.
  const isApproved = useCallback(
    async (
      resourceType: string,
      resourceId: string,
      payload: Record<string, unknown>,
    ): Promise<boolean> => {
      if (!currentOrg) return false;
      const { data, error: err } = await supabase.rpc('is_action_approved', {
        p_org: currentOrg.id,
        p_resource_type: resourceType,
        p_resource_id: resourceId,
        p_payload: payload,
      });
      if (err) throw new Error(err.message);
      return data === true;
    },
    [currentOrg],
  );

  return { pending, loading, error, refresh: fetch, approve, reject, requestApproval, isApproved };
}
