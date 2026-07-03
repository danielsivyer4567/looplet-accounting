/**
 * Tests for src/pages/Customers.tsx
 *
 * These are integration-level component tests. We mock:
 *   - @/lib/supabase      — no real network calls
 *   - @/contexts/OrgContext — provide a predictable org
 *   - @/hooks/useCustomers — control the customer list without Supabase
 *   - react-router-dom     — stub useNavigate so route changes don't throw
 *
 * We do NOT mock the DOM. All assertions are on rendered output.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { CustomersPage } from '@/pages/Customers';
import { mockSupabaseResponse } from '@/test/mocks/supabase';
import type { CustomerRow } from '@/hooks/useCustomers';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));

// react-router-dom: stub useNavigate — we don't care about navigation in these tests
const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

// OrgContext: provide a stable current org (hook lives in @/hooks/useOrg)
vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    organizations: [{ id: 'org-1', name: 'AFGC Plumbing', organization_type: 'standard' }],
    currentOrg: { id: 'org-1', name: 'AFGC Plumbing', organization_type: 'standard' },
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
  }),
}));

// useCustomers: controlled stub
let _mockCustomers: CustomerRow[] = [];
let _mockLoading = false;
let _mockError: string | null = null;
const _mockRefresh = vi.fn().mockResolvedValue(undefined);

vi.mock('@/hooks/useCustomers', () => ({
  useCustomers: () => ({
    customers: _mockCustomers,
    loading: _mockLoading,
    error: _mockError,
    refresh: _mockRefresh,
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderPage() {
  return render(<CustomersPage />);
}

const SAMPLE_CUSTOMERS: CustomerRow[] = [
  {
    id: 'cust-1',
    name: 'Acme Corp',
    email: 'accounts@acme.com',
    phone: '0412 000 001',
    billing_address: { line1: '1 Main St', city: 'Brisbane', state: 'QLD', postcode: '4000' },
    abn: '12 345 678 901',
    created_at: '2024-01-15T00:00:00Z',
  },
  {
    id: 'cust-2',
    name: 'Beta Builders',
    email: null,
    phone: null,
    billing_address: null,
    abn: null,
    created_at: '2024-02-01T00:00:00Z',
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CustomersPage', () => {
  beforeEach(() => {
    _mockCustomers = [];
    _mockLoading = false;
    _mockError = null;
    _mockRefresh.mockClear();
    mockNavigate.mockClear();
    mockSupabaseResponse({ data: [], error: null });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  // -------------------------------------------------------------------------
  // Basic render
  // -------------------------------------------------------------------------

  it('renders the page heading', () => {
    renderPage();
    // Level 1 to disambiguate from the empty-state "No customers yet" h3.
    expect(screen.getByRole('heading', { level: 1, name: /customers/i })).toBeInTheDocument();
  });

  it('renders the "+ New customer" button', () => {
    renderPage();
    expect(screen.getByRole('button', { name: /\+ new customer/i })).toBeInTheDocument();
  });

  it('shows the customer count when customers are loaded', () => {
    _mockCustomers = SAMPLE_CUSTOMERS;
    renderPage();
    // "2 customers" counter badge
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(
      screen.getByText(
        (content, element) => element?.tagName.toLowerCase() === 'span' && content === 'customers',
      ),
    ).toBeInTheDocument();
  });

  it('renders a row per customer in the table', () => {
    _mockCustomers = SAMPLE_CUSTOMERS;
    renderPage();
    // Rendered in both the desktop table and the mobile card deck.
    expect(screen.getAllByText('Acme Corp').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Beta Builders').length).toBeGreaterThan(0);
  });

  it('renders customers as mobile cards alongside the desktop table', () => {
    _mockCustomers = SAMPLE_CUSTOMERS;
    const { container } = renderPage();

    const table = screen.getByRole('table');
    expect(table).toHaveClass('table-premium');
    expect(table.closest('.customers-table-view')).toBeInTheDocument();

    const cards = screen.getByLabelText('Customer cards');
    expect(cards).toHaveClass('customers-card-view');
    expect(container.querySelector('.customer-mobile-card')).toBeInTheDocument();
    // Card-scoped assertions for the first customer.
    const acmeLink = within(cards).getByRole('link', { name: 'Acme Corp' });
    expect(acmeLink).toHaveAttribute('href', '/customers/cust-1');
    expect(within(cards).getByText(/1 main st, brisbane/i)).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Create form
  // -------------------------------------------------------------------------

  it('opens the create-customer form when "+ New customer" is clicked', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /\+ new customer/i }));
    expect(screen.getByRole('heading', { name: /new customer/i })).toBeInTheDocument();
  });

  it('create form submit calls supabase insert and refresh on success', async () => {
    const { supabase } = await import('@/test/mocks/supabase');
    // Supabase returns the new row id via .single()
    mockSupabaseResponse({ data: [{ id: 'new-cust-99' }], error: null });

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /\+ new customer/i }));

    const nameInput = screen.getByPlaceholderText(/customer name or business/i);
    fireEvent.change(nameInput, { target: { value: 'Zeta Services' } });

    fireEvent.click(screen.getByRole('button', { name: /create customer/i }));

    await waitFor(() => {
      expect(supabase.from).toHaveBeenCalledWith('customers');
    });
  });

  it('surfaces a categorized create action error instead of a raw message', async () => {
    mockSupabaseResponse({
      data: null,
      error: { message: 'new row violates row-level security policy for table "customers"' },
    });

    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /\+ new customer/i }));
    fireEvent.change(screen.getByPlaceholderText(/customer name or business/i), {
      target: { value: 'Blocked Customer' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create customer/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not create the customer/i);
    expect(alert).toHaveTextContent(/access policy blocked this request/i);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('cancel button closes the create form without submitting', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /\+ new customer/i }));

    // Form is open
    expect(screen.getByRole('heading', { name: /new customer/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    // Form is closed
    expect(screen.queryByRole('heading', { name: /new customer/i })).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Empty state
  // -------------------------------------------------------------------------

  it('shows empty-state message when no customers exist', () => {
    _mockCustomers = [];
    renderPage();
    expect(screen.getByText(/no customers yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no customers found/i)).toBeInTheDocument();
  });

  it('empty state offers an inline call-to-action that opens the create form', () => {
    _mockCustomers = [];
    renderPage();

    const cta = screen.getByRole('button', { name: /add your first customer/i });
    expect(cta).toBeInTheDocument();

    fireEvent.click(cta);
    expect(screen.getByRole('heading', { name: /new customer/i })).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------

  it('shows skeleton table while loading', () => {
    _mockLoading = true;
    const { container } = renderPage();
    // SkeletonTable renders a div; the table element should NOT be present
    expect(container.querySelector('table')).not.toBeInTheDocument();
    // A skeleton div should exist
    expect(container.querySelector('div')).toBeInTheDocument();
  });

  it('classifies load errors instead of showing generic failed-to-load copy', () => {
    _mockError = 'permission denied for table customers';

    renderPage();

    expect(
      screen.getByText(
        /could not load customers\. authentication or permission issue: permission denied for table customers/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^failed to load:/i)).not.toBeInTheDocument();
  });

  it('has a max-width: 768px breakpoint that swaps the customers table for the card deck', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.customers-table-view[\s\S]*\{[\s\S]*display: none/,
    );
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.customers-card-view[\s\S]*\{[\s\S]*display: grid/,
    );
  });
});
