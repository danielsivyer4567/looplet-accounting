import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkstreamTasks, type WorkstreamTask } from '@/hooks/useWorkstreamTasks';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
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

describe('useWorkstreamTasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.org.current = { id: 'org-1', name: 'Org One', organization_type: 'standard' };
  });

  it('returns empty array when no org is selected', () => {
    mocks.org.current = null;
    const { result } = renderHook(() => useWorkstreamTasks());
    expect(result.current.tasks).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('calls rpc with org id and returns tasks', async () => {
    mocks.rpc.mockReturnValue(rpcOk([baseTask]));
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

  it('handles rpc error gracefully', async () => {
    mocks.rpc.mockReturnValue(rpcError('Something went wrong'));
    const { result } = renderHook(() => useWorkstreamTasks());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.tasks).toEqual([]);
    expect(result.current.error).toBe('Something went wrong');
  });

  it('re-fetches when org changes', async () => {
    mocks.rpc.mockReturnValue(rpcOk([baseTask]));
    const { result, rerender } = renderHook(() => useWorkstreamTasks());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mocks.rpc).toHaveBeenCalledTimes(1);

    mocks.rpc.mockReturnValue(rpcOk([]));
    mocks.org.current = { id: 'org-2', name: 'Org Two', organization_type: 'standard' };

    await act(async () => {
      rerender();
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).toHaveBeenLastCalledWith('get_workstream_tasks', {
      p_org_id: 'org-2',
    });
    expect(result.current.tasks).toEqual([]);
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
    mocks.rpc.mockReturnValue(rpcOk(tasks));
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
