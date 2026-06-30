import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

export type TaskConfidence =
  | 'auto_post'
  | 'quick_confirm'
  | 'review_needed'
  | 'advisor_required'
  | 'blocked_external';

export type TaskKind =
  | 'onboarding_triage'
  | 'tax_obligation'
  | 'bas_blocker'
  | 'unapproved_bill'
  | 'overdue_invoice'
  | 'unmatched_bank_item'
  | 'missing_document'
  | 'pending_approval'
  | 'advisor_proof_reminder';

export interface WorkstreamTask {
  id: string;
  organization_id: string;
  task_kind: TaskKind;
  owner_label: string;
  why_now: string;
  source_refs: unknown;
  suggested_action: string;
  confidence: TaskConfidence;
  impact_cents: number | null;
  due_at: string | null;
  blocking_reason: string | null;
  completion_event: unknown;
  urgency: number;
  created_at: string;
}

export function useWorkstreamTasks() {
  const { currentOrg } = useOrg();
  const [tasks, setTasks] = useState<WorkstreamTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentOrg) {
      setTasks([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void supabase
      .rpc('get_workstream_tasks', { p_org_id: currentOrg.id })
      .then(({ data, error: rpcError }) => {
        if (rpcError) {
          setError(rpcError.message);
          setTasks([]);
        } else {
          setTasks((data ?? []) as WorkstreamTask[]);
        }
        setLoading(false);
      });
  }, [currentOrg]);

  return { tasks, loading, error };
}
