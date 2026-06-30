import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { BillDetailPage } from '@/pages/BillDetail';

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
vi.mock('@/lib/automationDecision', () => ({ recordOverride: vi.fn() }));

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
});
