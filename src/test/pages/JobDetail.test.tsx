import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const h = vi.hoisted(() => ({
  tables: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  currentOrg: { id: 'org-1', name: 'Test Org', organization_type: 'standard' },
}));

vi.mock('@/lib/supabase', () => {
  const builder = (table: string) => {
    const resolved = () => h.tables[table] ?? { data: [], error: null };
    const chain: Record<string, unknown> = {};
    const pass = () => chain;
    [
      'select',
      'eq',
      'neq',
      'gt',
      'lt',
      'gte',
      'lte',
      'like',
      'ilike',
      'in',
      'is',
      'not',
      'or',
      'filter',
      'order',
      'limit',
      'range',
      'match',
      'returns',
    ].forEach((method) => {
      chain[method] = pass;
    });
    chain.update = () => chain;
    chain.single = () => Promise.resolve(resolved());
    chain.maybeSingle = () => {
      const result = resolved();
      return Promise.resolve({
        data: Array.isArray(result.data) ? (result.data[0] ?? null) : result.data,
        error: result.error,
      });
    };
    chain.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve(resolved()).then(resolve);
    return chain;
  };

  return {
    supabase: {
      from: vi.fn((table: string) => builder(table)),
    },
  };
});

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    organizations: [h.currentOrg],
    currentOrg: h.currentOrg,
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('@/components/MoveToOrgButton', () => ({ MoveToOrgButton: () => null }));

import { JobDetailPage } from '@/pages/JobDetail';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/jobs/job-1']}>
      <Routes>
        <Route path="/jobs/:id" element={<JobDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('JobDetailPage', () => {
  beforeEach(() => {
    h.tables = {
      jobs: {
        data: [
          {
            id: 'job-1',
            organization_id: 'org-1',
            job_number: 'J0001',
            name: 'Fence install',
            description: null,
            status: 'active',
            budget_cents: 500000,
            currency_code: 'AUD',
            start_date: '2026-06-01',
            end_date: null,
            customer_id: 'customer-1',
            site_address: null,
            created_at: '2026-06-01T00:00:00Z',
            deleted_at: null,
          },
        ],
        error: null,
      },
      v_job_pnl: {
        data: [
          {
            revenue_inc_gst_cents: 900000,
            revenue_ex_gst_cents: 818182,
            gst_collected_cents: 81818,
            cost_bills_cents: 250000,
            cost_wages_cents: 150000,
            cost_overhead_cents: 50000,
            gst_input_credit_cents: 22727,
            total_cost_cents: 450000,
            gross_profit_cents: 450000,
          },
        ],
        error: null,
      },
      bills: {
        data: [
          {
            id: 'bill-1',
            invoice_number: 'B-100',
            invoice_date: '2026-06-03',
            total_inc_gst_cents: 250000,
            status: 'verified',
            supplier_id: 'supplier-1',
            supplier_name_raw: 'Steel Co',
          },
        ],
        error: null,
      },
      invoices: {
        data: [
          {
            id: 'invoice-1',
            invoice_date: '2026-06-10',
            total_inc_gst_cents: 900000,
            status: 'sent',
          },
        ],
        error: null,
      },
      customers: {
        data: [{ id: 'customer-1', name: 'Acme Homes', email: 'accounts@example.com' }],
        error: null,
      },
    };
  });

  it('renders the margin trend sparkline from job bills and invoices', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('Fence install')).toBeInTheDocument();
    });

    expect(screen.getByRole('img', { name: /job margin trend sparkline/i })).toBeInTheDocument();
    expect(screen.getByText(/Cumulative Revenue/i)).toBeInTheDocument();
    expect(screen.getByText(/Cumulative Cost/i)).toBeInTheDocument();
    expect(screen.getByText(/Cumulative Margin/i)).toBeInTheDocument();
  });
});
