import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { orgTimeZone, startOfMonth, todayLocal } from '@/lib/localDates';

// One pre-flight check row from period_close_checks (0100, SC-1.J.01): the
// reconciliation/trial-balance/no-draft probes for the closing month. `detail`
// carries the count/imbalance + a human `message`; `passed` is the gate.
export interface PeriodCheck {
  check_name: string;
  passed: boolean;
  detail: { message?: string } & Record<string, unknown>;
}

// Structured result of close_period (0100, SC-1.J.02). It never throws on a
// business refusal — success carries status='closed'; a refusal carries
// status='refused'/'already_locked' + a reason and the blocking detail
// (failed_checks / books_health / depreciation errors) for the UI to render.
export interface CloseResult {
  ok: boolean;
  status: 'closed' | 'already_locked' | 'refused';
  reason?: 'books_health_blocking' | 'preflight_failed' | 'month_end_journal_failed';
  message?: string;
  period_start?: string;
  period_end?: string;
  period_lock_id?: string;
  failed_checks?: { check_name: string; detail: Record<string, unknown> }[];
  books_health?: { score: number; blocking: boolean };
  depreciation?: Record<string, unknown>;
}

// First day of the current calendar month (in the org's time zone) as YYYY-MM-DD.
// close_period / period_close_checks treat p_period as ANY day in the target
// month, so the 1st is a canonical handle for "this month".
function currentMonthStart(timeZone: string): string {
  return startOfMonth(todayLocal(timeZone));
}

// Drives the month-end period-close checklist for the active org: reads the
// pre-flight checks (SC-1.J.01) for the target month and exposes a close()
// mutation that posts month-end depreciation + locks the period (SC-1.J.02).
//
// `period` is any day in the month to close (defaults to the current month).
// `blockers` are the failed checks — what's stopping the close; `canClose` is
// true once every check passes. close() returns close_period's structured
// result (it resolves on a business refusal rather than throwing, so the caller
// can show the reason) and refreshes the checks so a closed/changed period
// re-reads its state. Books-health blocking is a separate close-time gate
// surfaced via the result; the score itself lives in useBooksHealth, which the
// same workspace already renders, so we don't re-read it here.
export function usePeriodClose(period?: string) {
  const { currentOrg } = useOrg();
  const targetPeriod = period ?? currentMonthStart(orgTimeZone(currentOrg));
  const [checks, setChecks] = useState<PeriodCheck[]>([]);
  const [loading, setLoading] = useState(true);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg) {
      setChecks([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { data, error: rpcErr } = await supabase.rpc('period_close_checks', {
      p_org: currentOrg.id,
      p_period: targetPeriod,
    });
    if (rpcErr) {
      setError(rpcErr.message);
      setChecks([]);
    } else {
      setChecks((data as PeriodCheck[]) ?? []);
    }
    setLoading(false);
  }, [currentOrg, targetPeriod]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Attempt the close. Throws only on a transport/RPC error; a business refusal
  // (blocking books health, failed check, depreciation post error) comes back
  // as a resolved CloseResult with ok=false for the caller to surface.
  const close = useCallback(async (): Promise<CloseResult> => {
    if (!currentOrg) throw new Error('No organization selected');
    setClosing(true);
    try {
      const { data, error: rpcErr } = await supabase.rpc('close_period', {
        p_org: currentOrg.id,
        p_period: targetPeriod,
      });
      if (rpcErr) throw new Error(rpcErr.message);
      await refresh();
      return data as CloseResult;
    } finally {
      setClosing(false);
    }
  }, [currentOrg, targetPeriod, refresh]);

  const blockers = checks.filter((c) => !c.passed);
  const canClose = checks.length > 0 && blockers.length === 0;

  return {
    period: targetPeriod,
    checks,
    blockers,
    canClose,
    close,
    closing,
    loading,
    error,
    refresh,
  };
}
