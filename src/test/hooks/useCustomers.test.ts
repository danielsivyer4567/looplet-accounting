import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// Bespoke spyable supabase mock so we can assert the exact query filters the
// customers list applies (the shared mock treats .is() as a no-op passthrough).
const spies = vi.hoisted(() => ({
  select: vi.fn(),
  eq: vi.fn(),
  is: vi.fn(),
  order: vi.fn(),
  rows: [] as unknown[],
  queryError: null as { message: string } | null,
}));

// Stable reference so useCustomers' fetch useCallback identity doesn't churn.
const testOrg = vi.hoisted(() => ({ id: 'org-1', name: 'Org One', organization_type: 'standard' }));

vi.mock('@/lib/supabase', () => {
  const chain: Record<string, unknown> = {};
  chain.select = (...args: unknown[]) => {
    spies.select(...args);
    return chain;
  };
  chain.eq = (...args: unknown[]) => {
    spies.eq(...args);
    return chain;
  };
  chain.is = (...args: unknown[]) => {
    spies.is(...args);
    return chain;
  };
  // .order() is the terminal call in useCustomers; resolve the query here.
  chain.order = (...args: unknown[]) => {
    spies.order(...args);
    return Promise.resolve({ data: spies.rows, error: spies.queryError });
  };
  return { supabase: { from: vi.fn(() => chain) } };
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

import { useCustomers } from '@/hooks/useCustomers';

describe('useCustomers', () => {
  beforeEach(() => {
    spies.select.mockClear();
    spies.eq.mockClear();
    spies.is.mockClear();
    spies.order.mockClear();
    spies.queryError = null;
    spies.rows = [
      {
        id: 'c1',
        name: 'Active Co',
        email: 'a@example.com',
        phone: null,
        billing_address: null,
        abn: null,
        created_at: '2026-01-01T00:00:00Z',
      },
    ];
  });

  it('excludes soft-deleted customers by filtering deleted_at IS NULL', async () => {
    const { result } = renderHook(() => useCustomers());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // The archive/restore control writes deleted_at; the list must hide those rows.
    expect(spies.is).toHaveBeenCalledWith('deleted_at', null);
    expect(spies.eq).toHaveBeenCalledWith('organization_id', 'org-1');
    expect(result.current.customers).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it('surfaces the query error message when the customers load fails', async () => {
    spies.rows = [];
    spies.queryError = { message: 'permission denied for table customers' };

    const { result } = renderHook(() => useCustomers());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('permission denied for table customers');
    expect(result.current.customers).toHaveLength(0);
  });
});
