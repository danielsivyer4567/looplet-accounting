import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import type { PeriodCheck } from '@/hooks/usePeriodClose';

export type TaskConfidence =
  'auto_post' | 'quick_confirm' | 'review_needed' | 'advisor_required' | 'blocked_external';

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
 * The calendar month (YYYY-MM-01) whose close readiness the proactive
 * derived task should check: the CURRENT month during the lead-in window
 * (last 5 days), or the PRIOR month once we've rolled into the first-3-days
 * tail — the month that actually needs closing at that point.
 */
function targetCloseMonthStart(): string {
  const now = new Date();
  if (now.getDate() <= 3) {
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return prev.toISOString().slice(0, 10);
  }
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
}

const EMPTY_PREFLIGHT_STATUS = { failedChecks: [] as PeriodCheck[], booksHealthBlocking: false };

/**
 * Fetches the real month-end close pre-flight signal — the same
 * period_close_checks (0100) + v_books_health.blocking (0091) gates
 * close_period() itself refuses on — so the derived task reflects whether a
 * close would actually succeed, not an unrelated proxy heuristic. Callers
 * should skip this outside the close window (see EMPTY_PREFLIGHT_STATUS):
 * period_close_checks scans the month's bank_transactions/journal_entries,
 * so it isn't cheap to run on every task-feed load when the result would go
 * unused anyway.
 */
export async function fetchPreflightStatus(
  orgId: string,
): Promise<{ failedChecks: PeriodCheck[]; booksHealthBlocking: boolean }> {
  const [checksResult, booksHealthResult] = await Promise.all([
    supabase.rpc('period_close_checks', { p_org: orgId, p_period: targetCloseMonthStart() }),
    supabase.from('v_books_health').select('blocking').eq('organization_id', orgId).maybeSingle(),
  ]);

  const checks = (checksResult.data ?? []) as PeriodCheck[];
  return {
    failedChecks: checks.filter((c) => !c.passed),
    booksHealthBlocking: booksHealthResult.data?.blocking === true,
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
    const windowOpen = isMonthEndWindow();

    void Promise.all([
      supabase.rpc('get_workstream_tasks', { p_org_id: orgId }),
      windowOpen ? fetchPreflightStatus(orgId) : Promise.resolve(EMPTY_PREFLIGHT_STATUS),
    ]).then(([{ data, error: rpcError }, { failedChecks, booksHealthBlocking }]) => {
      if (rpcError) {
        setError(rpcError.message);
        setTasks([]);
        setLoading(false);
        return;
      }

      const base = (data ?? []) as WorkstreamTask[];

      // Derive a month_end_close task when the real close pre-flight is
      // failing (a period_close_checks row or books-health blocking).
      // fetchPreflightStatus only fetches inside the month-end close window
      // (last 5 days or first 3 days of the new month) — outside it, both
      // are always empty/false, so no separate window check is needed here.
      // arm 12 of get_workstream_tasks (period_close) only fires once the
      // prior month is actually unlocked, so this proactive signal covers
      // the lead-in before that — de-duped against it here.
      const alreadyHasCloseTask = base.some(
        (t) => t.task_kind === 'month_end_close' || t.task_kind === 'period_close',
      );

      const derivedTasks: WorkstreamTask[] = [];

      if (!alreadyHasCloseTask && (failedChecks.length > 0 || booksHealthBlocking)) {
        const monthLabel = currentMonthLabel();
        const checkSummary = failedChecks
          .map((c) => c.detail?.message ?? c.check_name)
          .join('; ');
        const whyNow = failedChecks.length > 0
          ? `Month-end close window is open and pre-flight checks are failing: ${checkSummary}.`
          : 'Month-end close window is open and books-health is below the close threshold.';

        derivedTasks.push({
          id: `derived-month-end-close-${orgId}`,
          organization_id: orgId,
          task_kind: 'month_end_close',
          owner_label: `Close out ${monthLabel} books — pre-flight checks need attention`,
          why_now: whyNow,
          source_refs: {
            failed_checks: failedChecks.map((c) => c.check_name),
            books_health_blocking: booksHealthBlocking,
          },
          suggested_action: 'Resolve the failing pre-flight checks, then run the period close.',
          confidence: 'blocked_external',
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
