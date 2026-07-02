import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NewPaymentRunPage } from '@/pages/NewPaymentRun';
import { PaymentRunDetailPage } from '@/pages/PaymentRunDetail';
import { PaymentRunsPage } from '@/pages/PaymentRuns';

const mocks = vi.hoisted(() => ({
  runsError: null as string | null,
  unpaidBillsError: null as string | null,
  detailError: null as string | null,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    functions: { invoke: vi.fn() },
  },
}));

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    organizations: [{ id: 'org-1', name: 'Test Org', organization_type: 'standard' }],
    currentOrg: { id: 'org-1', name: 'Test Org', organization_type: 'standard' },
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/usePaymentRuns', () => ({
  usePaymentRuns: () => ({
    runs: [],
    loading: false,
    error: mocks.runsError,
    refresh: vi.fn(),
  }),
  useUnpaidBillsForRun: () => ({
    bills: [],
    loading: false,
    error: mocks.unpaidBillsError,
    refresh: vi.fn(),
  }),
  usePaymentRunDetail: () => ({
    run: null,
    items: [],
    loading: false,
    error: mocks.detailError,
    refresh: vi.fn(),
  }),
}));

describe('Payment run load errors', () => {
  beforeEach(() => {
    mocks.runsError = null;
    mocks.unpaidBillsError = null;
    mocks.detailError = null;
  });

  it('classifies payment-run list errors', () => {
    mocks.runsError = 'failed to fetch payment runs';

    render(
      <MemoryRouter>
        <PaymentRunsPage />
      </MemoryRouter>,
    );

    expect(
      screen.getByText(
        /could not load payment runs\. network or server connection issue: failed to fetch payment runs/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^failed to load payment runs:/i)).not.toBeInTheDocument();
  });

  it('classifies unpaid-bill load errors on the new-run page', () => {
    mocks.unpaidBillsError = 'permission denied for table bills';

    render(
      <MemoryRouter>
        <NewPaymentRunPage />
      </MemoryRouter>,
    );

    expect(
      screen.getByText(
        /could not load unpaid bills\. authentication or permission issue: permission denied for table bills/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^failed to load unpaid bills:/i)).not.toBeInTheDocument();
  });

  it('classifies payment-run detail errors', () => {
    mocks.detailError = 'row-level security policy blocked payment_run_items';

    render(
      <MemoryRouter initialEntries={['/payment-runs/run-1']}>
        <Routes>
          <Route path="/payment-runs/:id" element={<PaymentRunDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      screen.getByText(
        /could not load payment run\. access policy blocked this request: row-level security policy blocked payment_run_items/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^error loading payment run:/i)).not.toBeInTheDocument();
  });
});
