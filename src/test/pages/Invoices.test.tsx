import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { InvoicesPage } from '@/pages/Invoices';

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

vi.mock('@/hooks/useInvoices', () => ({
  useInvoices: vi.fn(),
}));

vi.mock('@/components/InsightCharts', () => ({
  InsightAreaChart: () => null,
  InsightBarList: () => null,
  InsightPanel: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const invoice = {
  id: 'invoice-1',
  invoice_number: 'INV-0001',
  status: 'draft',
  issue_date: '2026-07-01',
  due_date: '2026-07-15',
  total_inc_gst_cents: 110000,
  amount_paid_cents: 0,
  balance_due_cents: 110000,
  customer_id: 'customer-1',
  job_id: null,
  customer: { id: 'customer-1', name: 'Acme Homes' },
  job: null,
};

function renderPage() {
  return render(
    <MemoryRouter>
      <InvoicesPage />
    </MemoryRouter>,
  );
}

describe('InvoicesPage pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows and dispatches the load-more control when another invoice page exists', async () => {
    const { useInvoices } = await import('@/hooks/useInvoices');
    const loadMore = vi.fn();
    vi.mocked(useInvoices).mockReturnValue({
      invoices: [invoice],
      loading: false,
      loadingMore: false,
      error: null,
      refresh: vi.fn(),
      hasMore: true,
      loadMore,
    });

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /load more invoices/i }));

    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('disables the load-more control while the next invoice page is loading', async () => {
    const { useInvoices } = await import('@/hooks/useInvoices');
    vi.mocked(useInvoices).mockReturnValue({
      invoices: [invoice],
      loading: false,
      loadingMore: true,
      error: null,
      refresh: vi.fn(),
      hasMore: true,
      loadMore: vi.fn(),
    });

    renderPage();

    expect(screen.getByRole('button', { name: /loading more/i })).toBeDisabled();
  });

  it('classifies load errors instead of showing the raw error string', async () => {
    const { useInvoices } = await import('@/hooks/useInvoices');
    vi.mocked(useInvoices).mockReturnValue({
      invoices: [],
      loading: false,
      loadingMore: false,
      error: 'new row violates row-level security policy',
      refresh: vi.fn(),
      hasMore: false,
      loadMore: vi.fn(),
    });

    renderPage();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      /could not load invoices\. access policy blocked this request: new row violates row-level security policy/i,
    );
    // The bare, uncategorized error string must no longer appear on its own.
    expect(alert).not.toHaveTextContent(/^new row violates/i);
  });

  it('renders invoices as mobile cards alongside the desktop table', async () => {
    const { useInvoices } = await import('@/hooks/useInvoices');
    vi.mocked(useInvoices).mockReturnValue({
      invoices: [invoice],
      loading: false,
      loadingMore: false,
      error: null,
      refresh: vi.fn(),
      hasMore: false,
      loadMore: vi.fn(),
    });

    const { container } = renderPage();

    const table = screen.getByRole('table');
    expect(table).toHaveClass('table-premium');
    expect(table.closest('.invoices-table-view')).toBeInTheDocument();

    const cards = screen.getByLabelText('Invoice cards');
    expect(cards).toHaveClass('invoices-card-view');
    expect(container.querySelector('.invoice-mobile-card')).toBeInTheDocument();
    const link = within(cards).getByRole('link', { name: 'INV-0001' });
    expect(link).toHaveAttribute('href', '/invoices/invoice-1');
    expect(within(cards).getByText('Acme Homes')).toBeInTheDocument();
    expect(within(cards).getByText('Balance')).toBeInTheDocument();
  });

  it('has a max-width: 768px breakpoint that swaps the invoices table for the card deck', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.invoices-table-view[\s\S]*\{[\s\S]*display: none/,
    );
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.invoices-card-view[\s\S]*\{[\s\S]*display: grid/,
    );
  });
});
