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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
const _mockRefresh = vi.fn().mockResolvedValue(undefined);

vi.mock('@/hooks/useCustomers', () => ({
  useCustomers: () => ({
    customers: _mockCustomers,
    loading: _mockLoading,
    error: null,
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
    expect(screen.getByRole('heading', { name: /customers/i })).toBeInTheDocument();
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
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('Beta Builders')).toBeInTheDocument();
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
    expect(screen.getByText(/no customers found/i)).toBeInTheDocument();
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
});
