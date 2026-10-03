import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { BillDetailPage } from '@/pages/BillDetail';
import {
  clearSupabaseOperations,
  getSupabaseOperations,
  mockSupabaseResponse,
} from '@/test/mocks/supabase';

vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));

vi.mock('@/hooks/useOrg', () => ({
  useOrg: vi.fn(() => ({
    organizations: [{ id: 'org-1', name: 'Test', organization_type: 'standard' as const }],
    currentOrg: { id: 'org-1', name: 'Test', organization_type: 'standard' as const },
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
  })),
}));

vi.mock('@/hooks/useBill', () => ({
  useBill: vi.fn(),
  getBillFileUrl: vi.fn().mockResolvedValue('https://example.com/file.pdf'),
}));

vi.mock('@/components/JobPicker', () => ({ JobPicker: () => null }));
vi.mock('@/components/MoveToOrgButton', () => ({ MoveToOrgButton: () => null }));
vi.mock('@/components/AllocationSplitButton', () => ({ AllocationSplitButton: () => null }));
const { mockRecordFeedback } = vi.hoisted(() => ({
  mockRecordFeedback: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/automationDecision', () => ({
  recordOverride: vi.fn(),
  recordFeedback: mockRecordFeedback,
}));

const mockBill = {
  id: 'bill-1',
  organization_id: 'org-1',
  job_id: null,
  status: 'received' as const,
  source: 'email',
  storage_key: 'bills/bill-1.pdf',
  original_filename: 'invoice.pdf',
  mime_type: 'application/pdf',
  supplier_name_raw: 'Acme Supplies',
  supplier_abn: '12345678901',
  invoice_number: 'INV-001',
  invoice_date: '2026-06-01',
  due_date: '2026-07-01',
  total_inc_gst_cents: 110000,
  gst_cents: 10000,
  subtotal_ex_gst_cents: 100000,
  currency_code: 'AUD',
  job_reference_raw: null,
  notes: null,
  ocr_provider: 'veryfi',
  ocr_confidence: 0.95,
  xero_status: 'not_in_xero',
  xero_invoice_id: null,
  attached_at: null,
  is_personal: false,
  suggested_job_id: null,
  suggested_match_score: null,
  raw_extracted: { _extraction_method: 'ocr' },
  created_at: '2026-06-01T00:00:00Z',
  deleted_at: null,
  line_items: [],
};

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/bills/bill-1']}>
      <Routes>
        <Route path="/bills/:id" element={<BillDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe('BillDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSupabaseOperations();
    mockSupabaseResponse({ data: [], error: null });
  });

  it('renders a structured detail skeleton while the bill is loading', async () => {
    const { useBill } = await import('@/hooks/useBill');
    vi.mocked(useBill).mockReturnValue({
      bill: null,
      loading: true,
      error: null,
      refresh: vi.fn(),
    });

    renderPage();

    expect(screen.getByRole('region', { name: /loading page/i })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(screen.queryByText(/loading bill details/i)).not.toBeInTheDocument();
  });

  it('renders the bill supplier name', async () => {
    const { useBill } = await import('@/hooks/useBill');
    vi.mocked(useBill).mockReturnValue({
      bill: mockBill,
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    renderPage();
    await waitFor(() => expect(screen.getAllByText('Acme Supplies').length).toBeGreaterThan(0));
  });

  it('shows decision badge when get_bill_decisions returns data', async () => {
    const { useBill } = await import('@/hooks/useBill');
    vi.mocked(useBill).mockReturnValue({
      bill: mockBill,
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
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

    renderPage();
    await waitFor(() => expect(screen.getByText('Quick')).toBeInTheDocument());
  });

  it('shows Quick Confirm button for quick_confirm', async () => {
    const { useBill } = await import('@/hooks/useBill');
    vi.mocked(useBill).mockReturnValue({
      bill: mockBill,
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
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

    renderPage();
    await waitFor(() => expect(screen.getByText('Quick Confirm')).toBeInTheDocument());
  });

  it('shows Review badge for review_needed, no Quick Confirm', async () => {
    const { useBill } = await import('@/hooks/useBill');
    vi.mocked(useBill).mockReturnValue({
      bill: mockBill,
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
    const { supabase } = await import('@/lib/supabase');
    vi.mocked(supabase.rpc).mockImplementation(
      () =>
        Promise.resolve({
          data: [
            {
              bill_id: 'bill-1',
              decision_id: 'dec-1',
              confidence: 'review_needed',
              decision_kind: 'supplier_match',
              suggested_treatment: { supplier_id: 's-1' },
            },
          ],
          error: null,
        }) as never,
    );

    renderPage();
    await waitFor(() => expect(screen.getByText('Review')).toBeInTheDocument());
    expect(screen.queryByText('Quick Confirm')).not.toBeInTheDocument();
  });

  it('edits extracted bill fields and saves the normalized update payload', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const { useBill } = await import('@/hooks/useBill');
    vi.mocked(useBill).mockReturnValue({
      bill: mockBill,
      loading: false,
      error: null,
      refresh,
    });

    renderPage();
    await waitFor(() => expect(screen.getAllByText('Acme Supplies').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: /edit details/i }));
    fireEvent.change(screen.getByLabelText(/^supplier$/i), {
      target: { value: 'Updated Supplies' },
    });
    fireEvent.change(screen.getByLabelText(/invoice #/i), { target: { value: 'INV-999' } });
    fireEvent.change(screen.getByLabelText(/total inc gst/i), { target: { value: '2200.00' } });
    fireEvent.change(screen.getByLabelText(/gst share/i), { target: { value: '200.00' } });
    fireEvent.change(screen.getByLabelText(/subtotal ex gst/i), { target: { value: '2000.00' } });
    fireEvent.change(screen.getByLabelText(/job reference/i), { target: { value: 'JOB-123' } });
    fireEvent.change(screen.getByLabelText(/internal notes/i), {
      target: { value: 'Reviewed against supplier PDF' },
    });

    // The update's .select('id') must return the changed row, or the page reports a refused save.
    mockSupabaseResponse({ data: [{ id: 'bill-1' }], error: null });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      const update = getSupabaseOperations().find(
        (op) => op.table === 'bills' && op.method === 'update',
      );
      expect(update).toBeTruthy();
      expect(update?.payload).toMatchObject({
        supplier_name_raw: 'Updated Supplies',
        supplier_abn: '12345678901',
        invoice_number: 'INV-999',
        invoice_date: '2026-06-01',
        due_date: '2026-07-01',
        total_inc_gst_cents: 220000,
        gst_cents: 20000,
        subtotal_ex_gst_cents: 200000,
        job_reference_raw: 'JOB-123',
        notes: 'Reviewed against supplier PDF',
      });
    });
    expect(refresh).toHaveBeenCalled();
    expect(mockRecordFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        sourceKind: 'supplier',
        sourceId: 'bill-1',
        newValue: 'Updated Supplies',
        correctionReason: 'user_edit',
      }),
    );
  });
});
