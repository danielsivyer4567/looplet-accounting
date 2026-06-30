import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BillsPage } from '@/pages/Bills';

vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));

vi.mock('@/hooks/useOrg', () => ({
  useOrg: vi.fn(() => ({
    organizations: [{ id: 'org-1', name: 'Test Org', organization_type: 'standard' as const }],
    currentOrg: { id: 'org-1', name: 'Test Org', organization_type: 'standard' as const },
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
  })),
}));

vi.mock('@/hooks/useBills', () => ({
  useBills: vi.fn(),
}));

vi.mock('@/components/DocumentPreviewModal', () => ({ DocumentPreviewModal: () => null }));
vi.mock('@/components/InsightCharts', () => ({
  InsightAreaChart: () => null,
  InsightBarList: () => null,
  InsightPanel: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const makeBill = (overrides = {}) => ({
  id: 'bill-1',
  status: 'received' as const,
  source: 'manual_upload',
  supplier_name_raw: 'Reece Plumbing',
  invoice_number: 'INV-100',
  invoice_date: '2026-06-01',
  total_inc_gst_cents: 110000,
  job_reference_raw: null,
  ocr_provider: 'veryfi',
  xero_status: 'not_in_xero',
  created_at: '2026-06-01T00:00:00Z',
  document_kind: 'invoice',
  is_probable_bill: true,
  storage_key: 'org-1/2026-06-01/bill.pdf',
  mime_type: 'application/pdf',
  original_filename: 'invoice.pdf',
  attached_job: null,
  automation_confidence: null as string | null,
  decision_id: null as string | null,
  ...overrides,
});

const renderPage = () =>
  render(
    <MemoryRouter>
      <BillsPage />
    </MemoryRouter>,
  );

describe('BillsPage — confidence badges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows confidence badge when automation_confidence is quick_confirm', async () => {
    const { useBills } = await import('@/hooks/useBills');
    vi.mocked(useBills).mockReturnValue({
      bills: [makeBill({ automation_confidence: 'quick_confirm' })],
      loading: false,
      error: null,
      refresh: vi.fn(),
      hasMore: false,
      loadMore: vi.fn(),
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('Quick')).toBeInTheDocument());
  });

  it('shows dash when automation_confidence is null', async () => {
    const { useBills } = await import('@/hooks/useBills');
    vi.mocked(useBills).mockReturnValue({
      bills: [makeBill({ automation_confidence: null })],
      loading: false,
      error: null,
      refresh: vi.fn(),
      hasMore: false,
      loadMore: vi.fn(),
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('Reece Plumbing')).toBeInTheDocument());
    // The "Conf." column shows a dash for bills without a decision
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThan(0);
  });

  it('shows review badge for review_needed bills', async () => {
    const { useBills } = await import('@/hooks/useBills');
    vi.mocked(useBills).mockReturnValue({
      bills: [makeBill({ automation_confidence: 'review_needed' })],
      loading: false,
      error: null,
      refresh: vi.fn(),
      hasMore: false,
      loadMore: vi.fn(),
    });

    renderPage();
    await waitFor(() => expect(screen.getByText('Review')).toBeInTheDocument());
  });
});
