import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
      loadingMore: false,
      error: null,
      refresh: vi.fn(),
      hasMore: false,
      loadMore: vi.fn(),
    });

    renderPage();
    // Rendered in both the desktop table and the mobile card deck.
    await waitFor(() => expect(screen.getAllByText('Quick').length).toBeGreaterThan(0));
  });

  it('shows dash when automation_confidence is null', async () => {
    const { useBills } = await import('@/hooks/useBills');
    vi.mocked(useBills).mockReturnValue({
      bills: [makeBill({ automation_confidence: null })],
      loading: false,
      loadingMore: false,
      error: null,
      refresh: vi.fn(),
      hasMore: false,
      loadMore: vi.fn(),
    });

    renderPage();
    await waitFor(() => expect(screen.getAllByText('Reece Plumbing').length).toBeGreaterThan(0));
    // The "Conf." column shows a dash for bills without a decision
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThan(0);
  });

  it('shows review badge for review_needed bills', async () => {
    const { useBills } = await import('@/hooks/useBills');
    vi.mocked(useBills).mockReturnValue({
      bills: [makeBill({ automation_confidence: 'review_needed' })],
      loading: false,
      loadingMore: false,
      error: null,
      refresh: vi.fn(),
      hasMore: false,
      loadMore: vi.fn(),
    });

    renderPage();
    await waitFor(() => expect(screen.getAllByText('Review').length).toBeGreaterThan(0));
  });

  it('shows and dispatches the load-more control when another bill page exists', async () => {
    const { useBills } = await import('@/hooks/useBills');
    const loadMore = vi.fn();
    vi.mocked(useBills).mockReturnValue({
      bills: [makeBill()],
      loading: false,
      loadingMore: false,
      error: null,
      refresh: vi.fn(),
      hasMore: true,
      loadMore,
    });

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /load more bills/i }));

    expect(loadMore).toHaveBeenCalledTimes(1);
  });
});

describe('BillsPage — mobile card layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders bills as mobile cards alongside the desktop table', async () => {
    const { useBills } = await import('@/hooks/useBills');
    vi.mocked(useBills).mockReturnValue({
      bills: [
        makeBill({
          supplier_name_raw: 'Reece Plumbing',
          total_inc_gst_cents: 110000,
          automation_confidence: 'review_needed',
        }),
      ],
      loading: false,
      loadingMore: false,
      error: null,
      refresh: vi.fn(),
      hasMore: false,
      loadMore: vi.fn(),
    });

    const { container } = renderPage();

    // Desktop table still present.
    const table = await screen.findByRole('table');
    expect(table).toHaveClass('table-premium');
    expect(table.closest('.bills-table-view')).toBeInTheDocument();

    // Mobile card deck present with the same bill's core fields and a document action.
    const cards = screen.getByLabelText('Bill cards');
    expect(cards).toHaveClass('bills-card-view');
    expect(container.querySelector('.bill-mobile-card')).toBeInTheDocument();
    expect(within(cards).getByText('Reece Plumbing')).toBeInTheDocument();
    expect(within(cards).getByText('Total')).toBeInTheDocument();
    expect(within(cards).getByText('$1,100.00')).toBeInTheDocument();
    expect(within(cards).getByRole('button', { name: /view document/i })).toBeInTheDocument();
  });

  it('has a max-width: 768px breakpoint that swaps the bills table for the card deck', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

    // Tolerant of grouped selector lists (.bills-table-view, .suppliers-table-view, … { … }).
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.bills-table-view[\s\S]*?\{[\s\S]*?display: none/,
    );
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.bills-card-view[\s\S]*?\{[\s\S]*?display: grid/,
    );
  });
});
