import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchPreflightStatus,
  useWorkstreamTasks,
  type WorkstreamTask,
} from '@/hooks/useWorkstreamTasks';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(() => ({
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: vi.fn(() => Promise.resolve({ data: { blocking: false }, error: null })),
      })),
    })),
  })),
  org: {
    current: {
      id: 'org-1',
      name: 'Org One',
      organization_type: 'standard',
    } as {
      id: string;
      name: string;
      organization_type: 'standard' | 'agency' | 'sub_account';
    } | null,
  },
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: mocks.rpc,
    from: mocks.from,
  },
}));

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    organizations: mocks.org.current ? [mocks.org.current] : [],
    currentOrg: mocks.org.current,
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
  }),
}));

const baseTask: WorkstreamTask = {
  id: 'task-1',
  organization_id: 'org-1',
  task_kind: 'tax_obligation',
  owner_label: 'BAS — Q1 FY26',
  why_now: '14 days OVERDUE',
  source_refs: { table: 'v_tax_calendar' },
  suggested_action: 'Prepare and lodge BAS',
  confidence: 'advisor_required',
  impact_cents: 500000,
  due_at: '2026-04-21T00:00:00Z',
  blocking_reason: null,
  completion_event: { status: 'lodged' },
  urgency: 2,
  created_at: '2026-06-30T00:00:00Z',
};

function rpcOk(data: unknown) {
  return Promise.resolve({ data, error: null });
}

function rpcError(message: string) {
  return Promise.resolve({ data: null, error: { message } });
}

/**
 * Wires `supabase.rpc` for a fetch cycle: `get_workstream_tasks` resolves to
 * `tasks`, `period_close_checks` resolves to `checks` (defaults to an empty/
 * all-passing result so existing task-list assertions aren't perturbed by
 * the new preflight signal).
 */
function mockRpc(tasks: unknown, checks: unknown = []) {
  mocks.rpc.mockImplementation((fn: string) => {
    if (fn === 'get_workstream_tasks') return rpcOk(tasks);
    if (fn === 'period_close_checks') return rpcOk(checks);
    return rpcOk(null);
  });
}

/** Same as mockRpc, but get_workstream_tasks itself errors. */
function mockRpcTasksError(message: string) {
  mocks.rpc.mockImplementation((fn: string) => {
    if (fn === 'get_workstream_tasks') return rpcError(message);
    if (fn === 'period_close_checks') return rpcOk([]);
    return rpcOk(null);
  });
}

/**
 * Count of calls to a specific supabase.rpc function name. period_close_checks
 * is only called inside the month-end close window (wall-clock dependent), so
 * tests assert on this rather than the raw total call count.
 */
function rpcCallCount(fn: string): number {
  return mocks.rpc.mock.calls.filter((call) => call[0] === fn).length;
}

describe('useWorkstreamTasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.org.current = { id: 'org-1', name: 'Org One', organization_type: 'standard' };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns empty array when no org is selected', () => {
    mocks.org.current = null;
    const { result } = renderHook(() => useWorkstreamTasks());
    expect(result.current.tasks).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('calls rpc with org id and returns tasks', async () => {
    mockRpc([baseTask]);
    const { result } = renderHook(() => useWorkstreamTasks());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mocks.rpc).toHaveBeenCalledWith('get_workstream_tasks', {
      p_org_id: 'org-1',
    });
    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.tasks[0]).toBeDefined();
    if (result.current.tasks[0]) expect(result.current.tasks[0].task_kind).toBe('tax_obligation');
    expect(result.current.error).toBeNull();
  });

  it('fetchPreflightStatus reads the real close signal: period_close_checks + v_books_health.blocking', async () => {
    // Direct unit test (not through the hook) — the hook only calls this
    // inside the wall-clock-dependent month-end window; this assertion focuses
    // on the returned pre-flight state rather than the target period.
    mocks.rpc.mockImplementation((fn: string) =>
      fn === 'period_close_checks'
        ? rpcOk([
            {
              check_name: 'trial_balance_balances',
              passed: false,
              detail: { message: 'Trial balance is out by 500 cents.' },
            },
            { check_name: 'no_unposted_drafts', passed: true, detail: {} },
          ])
        : rpcOk(null),
    );
    mocks.from.mockReturnValueOnce({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(() => Promise.resolve({ data: { blocking: true }, error: null })),
        })),
      })),
    });

    const status = await fetchPreflightStatus('org-1');

    expect(mocks.rpc).toHaveBeenCalledWith(
      'period_close_checks',
      expect.objectContaining({ p_org: 'org-1' }),
    );
    expect(mocks.from).toHaveBeenCalledWith('v_books_health');
    expect(status.failedChecks).toEqual([
      {
        check_name: 'trial_balance_balances',
        passed: false,
        detail: { message: 'Trial balance is out by 500 cents.' },
      },
    ]);
    expect(status.booksHealthBlocking).toBe(true);
  });

  it('fetchPreflightStatus checks the current month during the lead-in window without UTC date drift', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 28, 12, 0, 0));
    mocks.rpc.mockImplementation((fn: string) =>
      fn === 'period_close_checks' ? rpcOk([]) : rpcOk(null),
    );

    await fetchPreflightStatus('org-1');

    expect(mocks.rpc).toHaveBeenCalledWith('period_close_checks', {
      p_org: 'org-1',
      p_period: '2026-07-01',
    });
  });

  it('fetchPreflightStatus checks the prior month during the first-three-day tail', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 2, 12, 0, 0));
    mocks.rpc.mockImplementation((fn: string) =>
      fn === 'period_close_checks' ? rpcOk([]) : rpcOk(null),
    );

    await fetchPreflightStatus('org-1');

    expect(mocks.rpc).toHaveBeenCalledWith('period_close_checks', {
      p_org: 'org-1',
      p_period: '2026-07-01',
    });
  });

  it('handles rpc error gracefully', async () => {
    mockRpcTasksError('Something went wrong');
    const { result } = renderHook(() => useWorkstreamTasks());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.tasks).toEqual([]);
    expect(result.current.error).toBe('Something went wrong');
  });

  it('re-fetches when org changes', async () => {
    mockRpc([baseTask]);
    const { result, rerender } = renderHook(() => useWorkstreamTasks());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(rpcCallCount('get_workstream_tasks')).toBe(1);

    mockRpc([]);
    mocks.org.current = { id: 'org-2', name: 'Org Two', organization_type: 'standard' };

    await act(async () => {
      rerender();
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(rpcCallCount('get_workstream_tasks')).toBe(2);
    expect(mocks.rpc).toHaveBeenCalledWith('get_workstream_tasks', {
      p_org_id: 'org-2',
    });
    expect(result.current.tasks).toEqual([]);
  });

  it('handles anomaly task kinds', async () => {
    const anomalyTasks: WorkstreamTask[] = [
      {
        ...baseTask,
        id: 'a1',
        task_kind: 'duplicate_bill',
        owner_label: '2 duplicate bills',
        confidence: 'review_needed',
      },
      {
        ...baseTask,
        id: 'a2',
        task_kind: 'low_confidence_bill',
        owner_label: 'Bill needs review',
        confidence: 'review_needed',
      },
      {
        ...baseTask,
        id: 'a3',
        task_kind: 'bas_coverage_gap',
        owner_label: 'BAS Q1 — GST gap',
        confidence: 'review_needed',
      },
    ];
    mockRpc(anomalyTasks);
    const { result } = renderHook(() => useWorkstreamTasks());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.tasks).toHaveLength(3);
    expect(result.current.tasks.map((t) => t.task_kind)).toEqual([
      'duplicate_bill',
      'low_confidence_bill',
      'bas_coverage_gap',
    ]);
  });

  it('handles multiple task kinds', async () => {
    const tasks: WorkstreamTask[] = [
      { ...baseTask, id: '1', task_kind: 'tax_obligation' },
      {
        ...baseTask,
        id: '2',
        task_kind: 'unapproved_bill',
        owner_label: '3 bills need approval',
        confidence: 'quick_confirm',
      },
      {
        ...baseTask,
        id: '3',
        task_kind: 'bas_blocker',
        owner_label: 'Books need attention',
        blocking_reason: 'Blocks BAS',
        confidence: 'blocked_external',
      },
    ];
    mockRpc(tasks);
    const { result } = renderHook(() => useWorkstreamTasks());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.tasks).toHaveLength(3);
    expect(result.current.tasks.map((t) => t.task_kind)).toEqual([
      'tax_obligation',
      'unapproved_bill',
      'bas_blocker',
    ]);
  });
});
