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
  | 'advisor_proof_reminder'
  | 'duplicate_bill'
  | 'low_confidence_bill'
  | 'bas_coverage_gap'
  | 'period_close'
  | 'month_end_close';

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

/**
 * Returns the last day of the current calendar month as an ISO date string
 * (YYYY-MM-DD). Used to compute whether we are near or past month-end.
 */
function lastDayOfCurrentMonth(): string {
  const now = new Date();
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return last.toISOString().slice(0, 10);
}

/**
 * Returns the ISO date string (YYYY-MM-DD) for today.
 */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Returns a human-readable month label like "June 2026".
 */
function currentMonthLabel(): string {
  return new Date().toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
}

/**
 * The month-end close task fires when we are within the last 5 days of the
 * month OR already past month-end (i.e. we are in the next month and the
 * prior-month books need closing).  Returns true when the close window is open.
 */
function isMonthEndWindow(): boolean {
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  // Within last 5 days of month or day 1-3 of the next month.
  return now.getDate() >= daysInMonth - 4 || now.getDate() <= 3;
}

/**
 * Fetches two lightweight counts needed for the month-end close derived task:
 *   1. Overdue bills (past due_date, status not 'paid' or 'void')
 *   2. Unmatched bank transactions posted in the current calendar month
 *      (coding_status not in ('coded', 'ignored'))
 *
 * Both queries use `count` aggregation — no row data is returned.
 */
async function fetchMonthEndCounts(
  orgId: string,
): Promise<{ overdueBills: number; unmatchedBank: number }> {
  const today = todayIso();
  // Start of current calendar month
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);

  const [billsResult, bankResult] = await Promise.all([
    supabase
      .from('bills')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .is('deleted_at', null)
      .lt('invoice_date', today)
      .not('status', 'in', '("paid","void")'),

    supabase
      .from('bank_transactions')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', orgId)
      .gte('posted_at', monthStart)
      .not('coding_status', 'in', '("coded","ignored")'),
  ]);

  return {
    overdueBills: billsResult.count ?? 0,
    unmatchedBank: bankResult.count ?? 0,
  };
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

    const orgId = currentOrg.id;

    void Promise.all([
      supabase.rpc('get_workstream_tasks', { p_org_id: orgId }),
      fetchMonthEndCounts(orgId),
    ]).then(([{ data, error: rpcError }, { overdueBills, unmatchedBank }]) => {
      if (rpcError) {
        setError(rpcError.message);
        setTasks([]);
        setLoading(false);
        return;
      }

      const base = (data ?? []) as WorkstreamTask[];

      // Derive a month_end_close task when:
      //   a) there are overdue bills, OR
      //   b) there are unmatched bank rows from this month
      // AND we are inside the month-end close window (last 5 days or first 3 days of new month).
      const totalAttentionItems = overdueBills + unmatchedBank;
      const alreadyHasCloseTask = base.some(
        (t) => t.task_kind === 'month_end_close' || t.task_kind === 'period_close',
      );

      const derivedTasks: WorkstreamTask[] = [];

      if (!alreadyHasCloseTask && totalAttentionItems > 0 && isMonthEndWindow()) {
        const monthLabel = currentMonthLabel();
        const parts: string[] = [];
        if (overdueBills > 0)
          parts.push(`${overdueBills} overdue bill${overdueBills === 1 ? '' : 's'}`);
        if (unmatchedBank > 0)
          parts.push(
            `${unmatchedBank} unmatched bank transaction${unmatchedBank === 1 ? '' : 's'}`,
          );
        const itemsSummary = parts.join(' and ');

        derivedTasks.push({
          id: `derived-month-end-close-${orgId}`,
          organization_id: orgId,
          task_kind: 'month_end_close',
          owner_label: `Close out ${monthLabel} books — ${itemsSummary} need attention`,
          why_now: `Month-end close window is open and ${totalAttentionItems} item${totalAttentionItems === 1 ? '' : 's'} must be resolved before the period can be locked.`,
          source_refs: { overdue_bills: overdueBills, unmatched_bank: unmatchedBank },
          suggested_action: 'Review and clear overdue bills and unmatched bank transactions, then run the period close.',
          confidence: 'review_needed',
          impact_cents: null,
          due_at: lastDayOfCurrentMonth(),
          blocking_reason: null,
          completion_event: null,
          urgency: 80,
          created_at: new Date().toISOString(),
        });
      }

      setTasks([...base, ...derivedTasks]);
      setLoading(false);
    });
  }, [currentOrg]);

  return { tasks, loading, error };
}
