import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as ReactRouterDom from 'react-router-dom';
import { SuppliersPage } from '@/pages/Suppliers';
import {
  clearSupabaseOperations,
  getSupabaseOperations,
  mockSupabaseResponse,
} from '@/test/mocks/supabase';

vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));

const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof ReactRouterDom>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

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

vi.mock('@/hooks/useSuppliers', () => ({
  useSuppliers: vi.fn(),
}));

const supplier = {
  id: 'supplier-1',
  name: 'Reece Plumbing',
  abn: '12345678901',
  email: 'accounts@example.com',
  contact_phone: '0400 000 000',
  default_account_code: '6-1000',
  current_balance_owing_cents: 55000,
  created_at: '2026-07-01T00:00:00Z',
};

function renderPage() {
  return render(
    <MemoryRouter>
      <SuppliersPage />
    </MemoryRouter>,
  );
}

describe('SuppliersPage pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSupabaseOperations();
    mockNavigate.mockClear();
    mockSupabaseResponse({ data: [], error: null });
  });

  it('shows and dispatches the load-more control when another supplier page exists', async () => {
    const { useSuppliers } = await import('@/hooks/useSuppliers');
    const loadMore = vi.fn();
    vi.mocked(useSuppliers).mockReturnValue({
      suppliers: [supplier],
      spendMap: new Map([[supplier.id, 55000]]),
      loading: false,
      loadingMore: false,
      error: null,
      refresh: vi.fn(),
      hasMore: true,
      loadMore,
    });

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /load more suppliers/i }));

    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('disables the load-more control while the next supplier page is loading', async () => {
    const { useSuppliers } = await import('@/hooks/useSuppliers');
    vi.mocked(useSuppliers).mockReturnValue({
      suppliers: [supplier],
      spendMap: new Map([[supplier.id, 55000]]),
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

  it('classifies load errors instead of showing generic failed-to-load copy', async () => {
    const { useSuppliers } = await import('@/hooks/useSuppliers');
    vi.mocked(useSuppliers).mockReturnValue({
      suppliers: [],
      spendMap: new Map(),
      loading: false,
      loadingMore: false,
      error: 'new row violates row-level security policy',
      refresh: vi.fn(),
      hasMore: false,
      loadMore: vi.fn(),
    });

    renderPage();

    expect(
      screen.getByText(
        /could not load suppliers\. access policy blocked this request: new row violates row-level security policy/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^failed to load:/i)).not.toBeInTheDocument();
  });

  it('opens and submits a new supplier form with normalized insert payload', async () => {
    const { useSuppliers } = await import('@/hooks/useSuppliers');
    const refresh = vi.fn();
    vi.mocked(useSuppliers).mockReturnValue({
      suppliers: [],
      spendMap: new Map(),
      loading: false,
      loadingMore: false,
      error: null,
      refresh,
      hasMore: false,
      loadMore: vi.fn(),
    });
    mockSupabaseResponse({ data: [{ id: 'supplier-new-1' }], error: null });

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /\+ new supplier/i }));
    fireEvent.change(screen.getByPlaceholderText(/supplier business name/i), {
      target: { value: '  Apollo Electrical  ' },
    });
    fireEvent.change(screen.getByPlaceholderText(/12 345 678 901/i), {
      target: { value: '12345678901' },
    });
    fireEvent.change(screen.getByPlaceholderText(/accounts@supplier\.com/i), {
      target: { value: 'accounts@apollo.example' },
    });
    fireEvent.change(screen.getByPlaceholderText(/0400 000 000/i), {
      target: { value: '0400 111 222' },
    });
    fireEvent.change(screen.getByPlaceholderText(/6-1000/i), {
      target: { value: '6-2000' },
    });

    fireEvent.click(screen.getByRole('button', { name: /create supplier/i }));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(getSupabaseOperations()).toContainEqual({
      table: 'suppliers',
      method: 'insert',
      payload: {
        organization_id: 'org-1',
        name: 'Apollo Electrical',
        abn: '12345678901',
        email: 'accounts@apollo.example',
        contact_phone: '0400 111 222',
        default_account_code: '6-2000',
        payment_terms_days: 30,
      },
    });
    expect(mockNavigate).toHaveBeenCalledWith('/suppliers/supplier-new-1');
  });

  it('closes the new supplier form without inserting when cancelled', async () => {
    const { useSuppliers } = await import('@/hooks/useSuppliers');
    vi.mocked(useSuppliers).mockReturnValue({
      suppliers: [],
      spendMap: new Map(),
      loading: false,
      loadingMore: false,
      error: null,
      refresh: vi.fn(),
      hasMore: false,
      loadMore: vi.fn(),
    });

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /\+ new supplier/i }));
    expect(screen.getByRole('heading', { name: /new supplier/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(screen.queryByRole('heading', { name: /new supplier/i })).not.toBeInTheDocument();
    expect(getSupabaseOperations()).toHaveLength(0);
  });

  it('surfaces a categorized create action error instead of a mislabeled load error', async () => {
    const { useSuppliers } = await import('@/hooks/useSuppliers');
    vi.mocked(useSuppliers).mockReturnValue({
      suppliers: [],
      spendMap: new Map(),
      loading: false,
      loadingMore: false,
      error: null,
      refresh: vi.fn(),
      hasMore: false,
      loadMore: vi.fn(),
    });
    mockSupabaseResponse({
      data: null,
      error: { message: 'new row violates row-level security policy for table "suppliers"' },
    });

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /\+ new supplier/i }));
    fireEvent.change(screen.getByPlaceholderText(/supplier business name/i), {
      target: { value: 'Blocked Supplier' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create supplier/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not create the supplier/i);
    expect(alert).toHaveTextContent(/access policy blocked this request/i);
    // Must not use the load-oriented phrasing for a write.
    expect(screen.queryByText(/could not load supplier\b/i)).not.toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('renders suppliers as mobile cards alongside the desktop table', async () => {
    const { useSuppliers } = await import('@/hooks/useSuppliers');
    vi.mocked(useSuppliers).mockReturnValue({
      suppliers: [supplier],
      // Distinct from the supplier's 55000 balance so each metric is uniquely assertable.
      spendMap: new Map([[supplier.id, 120000]]),
      loading: false,
      loadingMore: false,
      error: null,
      refresh: vi.fn(),
      hasMore: false,
      loadMore: vi.fn(),
    });

    const { container } = renderPage();

    const table = await screen.findByRole('table');
    expect(table).toHaveClass('table-premium');
    expect(table.closest('.suppliers-table-view')).toBeInTheDocument();

    const cards = screen.getByLabelText('Supplier cards');
    expect(cards).toHaveClass('suppliers-card-view');
    expect(container.querySelector('.supplier-mobile-card')).toBeInTheDocument();
    expect(within(cards).getByText('Reece Plumbing')).toBeInTheDocument();
    expect(within(cards).getByText('Balance owing')).toBeInTheDocument();
    expect(within(cards).getByText('Total spend')).toBeInTheDocument();
    // Balance owing 55000c → $550.00, total spend 120000c → $1,200.00 in the card metrics.
    expect(within(cards).getByText('$550.00')).toBeInTheDocument();
    expect(within(cards).getByText('$1,200.00')).toBeInTheDocument();
  });

  it('has a max-width: 768px breakpoint that swaps the suppliers table for the card deck', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.suppliers-table-view[\s\S]*\{[\s\S]*display: none/,
    );
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.suppliers-card-view[\s\S]*\{[\s\S]*display: grid/,
    );
  });
});
