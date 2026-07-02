/**
 * Tests for src/pages/InvoiceDetail.tsx
 *
 * Focused proof for invoice line GST treatment handling.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type * as ReactRouterDom from 'react-router-dom';
import { InvoiceDetailPage } from '@/pages/InvoiceDetail';
import {
  clearSupabaseOperations,
  getSupabaseOperations,
  mockSupabaseResponse,
} from '@/test/mocks/supabase';

vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof ReactRouterDom>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('@/hooks/useOrg', () => {
  const currentOrg = { id: 'org-1', name: 'AFGC Plumbing', organization_type: 'standard' };
  const orgValue = {
    organizations: [currentOrg],
    currentOrg,
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
  };
  return { useOrg: () => orgValue };
});

function renderNewInvoice() {
  return render(
    <MemoryRouter initialEntries={['/invoices/new']}>
      <Routes>
        <Route path="/invoices/new" element={<InvoiceDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('InvoiceDetailPage', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    clearSupabaseOperations();
    mockSupabaseResponse({
      data: [{ id: 'cust-1', name: 'Acme Homes', email: 'accounts@example.com' }],
      error: null,
    });
  });

  it('persists zero-rated invoice lines as zero instead of collapsing them to GST-free', async () => {
    renderNewInvoice();

    await waitFor(() => {
      expect(screen.queryByText(/loading invoice details/i)).not.toBeInTheDocument();
    });

    fireEvent.change(screen.getByRole('combobox', { name: /customer/i }), {
      target: { value: 'cust-1' },
    });
    fireEvent.change(screen.getByPlaceholderText(/fence install/i), {
      target: { value: 'Exported advisory service' },
    });
    fireEvent.change(screen.getByDisplayValue('0.00'), { target: { value: '100.00' } });
    fireEvent.change(screen.getByRole('combobox', { name: /gst/i }), {
      target: { value: 'zero' },
    });

    expect(screen.getAllByText('$0.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$100.00').length).toBeGreaterThan(0);

    mockSupabaseResponse({ data: [{ id: 'invoice-1' }], error: null });
    fireEvent.click(screen.getByRole('button', { name: /create invoice/i }));

    await waitFor(() => {
      const lineInsert = getSupabaseOperations().find(
        (op) => op.table === 'invoice_line_items' && op.method === 'insert',
      );
      expect(lineInsert).toBeTruthy();
      expect(lineInsert?.payload).toEqual([
        expect.objectContaining({
          invoice_id: 'invoice-1',
          organization_id: 'org-1',
          description: 'Exported advisory service',
          unit_price_cents: 10000,
          gst_treatment: 'zero',
          line_total_ex_gst_cents: 10000,
          line_gst_cents: 0,
          line_total_inc_gst_cents: 10000,
        }),
      ]);
    });
    expect(mockNavigate).toHaveBeenCalledWith('/invoices/invoice-1');
  });
});
