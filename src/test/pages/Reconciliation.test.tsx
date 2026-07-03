import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReconciliationPage } from '@/pages/Reconciliation';

const mocks = vi.hoisted(() => {
  interface QueryResult {
    data: unknown;
    error: { message: string } | null;
  }

  const state = {
    bankTransactionBuilders: 0,
  };

  const unmatchedTxn = {
    id: 'txn-1',
    posted_at: '2026-06-29T00:00:00Z',
    description: 'ACME paid invoice INV-0007',
    amount_cents: 1050,
    reference: 'INV-0007',
    matched_bill_id: null,
    matched_invoice_id: null,
    bank_account_id: 'bank-1',
  };

  const invoiceCandidate = {
    bank_transaction_id: 'txn-1',
    organization_id: 'org-1',
    invoice_id: 'inv-1',
    invoice_number: 'INV-0007',
    invoice_date: '2026-06-20',
    invoice_balance_due_cents: 1000,
    customer_id: 'cust-1',
    customer_name: 'ACME Pty Ltd',
    amount_diff_cents: 50,
    days_diff: 1,
    score: 0.95,
  };

  const matchedTxn = {
    id: 'txn-matched-1',
    posted_at: '2026-06-28T00:00:00Z',
    description: 'Customer paid INV-0006',
    amount_cents: 8800,
    reference: 'INV-0006',
    matched_bill_id: null,
    matched_invoice_id: 'inv-2',
    bank_account_id: 'bank-1',
    manually_matched: false,
  };

  const responseFor = (table: string, bankQueryNumber: number): QueryResult => {
    if (table === 'bank_transactions') {
      return {
        data: bankQueryNumber % 2 === 1 ? [unmatchedTxn] : [matchedTxn],
        error: null,
      };
    }
    if (table === 'v_bank_match_candidates') {
      return { data: [], error: null };
    }
    if (table === 'v_bank_invoice_match_candidates') {
      return { data: [invoiceCandidate], error: null };
    }
    return { data: [], error: null };
  };

  const makeBuilder = (table: string) => {
    const bankQueryNumber =
      table === 'bank_transactions' ? (state.bankTransactionBuilders += 1) : 0;
    const chain: Record<string, unknown> = {};
    const passthrough = () => chain;

    ['select', 'eq', 'is', 'or', 'gte', 'order', 'limit'].forEach((method) => {
      chain[method] = passthrough;
    });

    chain.then = (resolve: (value: QueryResult) => unknown) =>
      Promise.resolve(responseFor(table, bankQueryNumber)).then(resolve);

    return chain;
  };

  return {
    state,
    org: { id: 'org-1', name: 'Test Org', organization_type: 'standard' as const },
    from: vi.fn((table: string) => makeBuilder(table)),
    rpc: vi.fn().mockResolvedValue({ data: { ok: true }, error: null }),
  };
});

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: mocks.from,
    rpc: mocks.rpc,
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    },
  },
}));

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    organizations: [mocks.org],
    currentOrg: mocks.org,
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('@/components/AllocationSplitButton', () => ({
  AllocationSplitButton: () => null,
}));

function renderPage() {
  return render(
    <MemoryRouter>
      <ReconciliationPage />
    </MemoryRouter>,
  );
}

describe('ReconciliationPage', () => {
  beforeEach(() => {
    mocks.state.bankTransactionBuilders = 0;
    mocks.from.mockClear();
    mocks.rpc.mockClear();
    mocks.rpc.mockResolvedValue({ data: { ok: true }, error: null });
  });

  it('caps invoice match payments to the invoice balance when the bank inflow is higher', async () => {
    renderPage();

    expect(await screen.findByRole('link', { name: /ACME Pty Ltd/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Match \(95%\)/i }));

    await waitFor(() =>
      expect(mocks.rpc).toHaveBeenCalledWith(
        'reconcile_match_invoice',
        expect.objectContaining({
          p_bank_transaction_id: 'txn-1',
          p_invoice_id: 'inv-1',
          p_amount_cents: 1000,
          p_match_confidence: 1.0,
        }),
      ),
    );
  });

  it('renders recently matched transactions as mobile cards as well as a desktop table', async () => {
    renderPage();

    const cards = await screen.findByLabelText(/recently matched mobile cards/i);
    expect(cards).toHaveTextContent('Customer paid INV-0006');
    expect(cards).toHaveTextContent('Date');
    expect(cards).toHaveTextContent('Amount');
    expect(cards).toHaveTextContent('Matched to');
    expect(screen.getByRole('table')).toHaveClass('table-premium');
  });

  it('has a breakpoint contract for recently matched table-to-card layout', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.reconciliation-table-view\s*\{[\s\S]*display: none/,
    );
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.reconciliation-card-view\s*\{[\s\S]*display: grid/,
    );
  });
});
