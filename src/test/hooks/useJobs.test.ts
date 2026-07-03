import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// Table-aware supabase mock: the jobs list and v_job_pnl resolve independently
// so we can prove the costing-pipeline merge and its error handling in isolation.
const state = vi.hoisted(() => ({
  jobs: { data: [] as unknown[], error: null as { message: string } | null },
  pnl: { data: [] as unknown[], error: null as { message: string } | null },
}));

// Stable org reference so the hook's fetch useCallback identity is stable.
const testOrg = vi.hoisted(() => ({ id: 'org-1', name: 'Org One', organization_type: 'standard' }));

vi.mock('@/lib/supabase', () => {
  function makeChain(table: string) {
    const result = table === 'v_job_pnl' ? state.pnl : state.jobs;
    const chain: Record<string, unknown> = {};
    // Non-terminal builder methods return the chain.
    for (const m of ['select', 'eq', 'order', 'limit']) {
      chain[m] = () => chain;
    }
    // Awaiting the builder resolves to the table's configured response.
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return chain;
  }
  return { supabase: { from: vi.fn((table: string) => makeChain(table)) } };
});

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    organizations: [testOrg],
    currentOrg: testOrg,
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
  }),
}));

import { useJobs } from '@/hooks/useJobs';

describe('useJobs costing pipeline', () => {
  beforeEach(() => {
    state.jobs = {
      data: [
        {
          id: 'job-1',
          job_number: 'J0001',
          name: 'Fence install',
          status: 'active',
          created_at: '2026-06-01T00:00:00Z',
          attached_bills: [{ count: 2 }],
          suggested_bills: [],
        },
      ],
      error: null,
    };
    state.pnl = { data: [], error: null };
  });

  it('merges v_job_pnl financials into the matching job rows', async () => {
    state.pnl = {
      data: [
        {
          job_id: 'job-1',
          organization_id: 'org-1',
          cost_bills_cents: 40000,
          cost_wages_cents: 25000,
          total_cost_cents: 65000,
          revenue_inc_gst_cents: 110000,
          gross_profit_cents: 45000,
        },
      ],
      error: null,
    };

    const { result } = renderHook(() => useJobs());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeNull();
    expect(result.current.pnlError).toBeNull();
    const job = result.current.jobs[0];
    expect(job?.total_cost_cents).toBe(65000);
    expect(job?.revenue_inc_gst_cents).toBe(110000);
    expect(job?.gross_profit_cents).toBe(45000);
    // Base job fields survive the merge.
    expect(job?.job_number).toBe('J0001');
  });

  it('still renders jobs but reports pnlError when the P&L pipeline fails (no silent zeros)', async () => {
    state.pnl = {
      data: null as unknown as unknown[],
      error: { message: 'permission denied for view v_job_pnl' },
    };

    const { result } = renderHook(() => useJobs());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // The list is not blanked...
    expect(result.current.error).toBeNull();
    expect(result.current.jobs).toHaveLength(1);
    // ...but the P&L pipeline failure is observable rather than silently zeroed.
    expect(result.current.pnlError).toBe('permission denied for view v_job_pnl');
  });

  it('blanks the list and sets error when the jobs query itself fails', async () => {
    state.jobs = { data: null as unknown as unknown[], error: { message: 'Failed to fetch' } };

    const { result } = renderHook(() => useJobs());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('Failed to fetch');
    expect(result.current.jobs).toHaveLength(0);
  });
});
