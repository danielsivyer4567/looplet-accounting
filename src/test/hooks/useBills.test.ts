import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useBills } from '@/hooks/useBills';
import { mockSupabaseResponse } from '@/test/mocks/supabase';

vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));

vi.mock('@/hooks/useOrg', () => ({
  useOrg: vi.fn(),
}));

const testOrg = { id: 'org-1', name: 'Org One', organization_type: 'standard' as const };

async function setOrg(org: typeof testOrg | null) {
  const { useOrg } = await import('@/hooks/useOrg');
  vi.mocked(useOrg).mockReturnValue({
    organizations: org ? [org] : [],
    currentOrg: org,
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
  });
}

describe('useBills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty when no org', async () => {
    await setOrg(null);
    const { result } = renderHook(() => useBills());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.bills).toHaveLength(0);
  });

  it('fetches bills and enriches with decisions', async () => {
    await setOrg(testOrg);

    const mockBillRows = [
      {
        id: 'bill-1',
        status: 'received',
        source: 'email',
        supplier_name_raw: 'Acme Supplies',
        invoice_number: 'INV-001',
        invoice_date: '2026-06-01',
        total_inc_gst_cents: 110000,
        job_reference_raw: null,
        ocr_provider: 'veryfi',
        xero_status: 'not_in_xero',
        created_at: '2026-06-01T00:00:00Z',
      },
    ];
    mockSupabaseResponse({ data: mockBillRows, error: null });
    const { supabase } = await import('@/lib/supabase');
    vi.mocked(supabase.rpc).mockImplementation(
      () =>
        Promise.resolve({
          data: [
            {
              bill_id: 'bill-1',
              decision_id: 'dec-1',
              confidence: 'quick_confirm',
              decision_kind: 'supplier_match',
              suggested_treatment: { supplier_id: 's-1' },
            },
          ],
          error: null,
        }) as never,
    );

    const { result } = renderHook(() => useBills());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.bills).toHaveLength(1);
    expect(result.current.bills[0]?.automation_confidence).toBe('quick_confirm');
    expect(result.current.bills[0]?.decision_id).toBe('dec-1');
  });

  it('handles bills without automation decisions', async () => {
    await setOrg(testOrg);

    const mockBillRows = [
      {
        id: 'bill-2',
        status: 'verified',
        source: 'upload',
        supplier_name_raw: 'OfficeMax',
        invoice_number: 'OM-2026',
        invoice_date: '2026-06-15',
        total_inc_gst_cents: 55000,
        job_reference_raw: null,
        ocr_provider: 'veryfi',
        xero_status: 'synced',
        created_at: '2026-06-15T00:00:00Z',
      },
    ];
    mockSupabaseResponse({ data: mockBillRows, error: null });
    const { supabase } = await import('@/lib/supabase');
    vi.mocked(supabase.rpc).mockImplementation(
      () => Promise.resolve({ data: [], error: null }) as never,
    );

    const { result } = renderHook(() => useBills());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.bills).toHaveLength(1);
    expect(result.current.bills[0]?.automation_confidence).toBeUndefined();
  });
});
