import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const h = vi.hoisted(() => ({
  tables: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  inserts: [] as { table: string; payload: unknown }[],
  updates: [] as { table: string; payload: unknown }[],
  deletes: [] as { table: string }[],
  currentOrg: { id: 'org-1', name: 'Test Org', organization_type: 'standard' },
}));

vi.mock('@/lib/supabase', () => {
  const builder = (table: string) => {
    let operation: 'select' | 'insert' | 'update' | 'delete' = 'select';
    const resolved = () => h.tables[table] ?? { data: [], error: null };
    const terminal = () =>
      Promise.resolve(operation === 'select' ? resolved() : { data: null, error: null });
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
    chain.insert = (payload: unknown) => {
      operation = 'insert';
      h.inserts.push({ table, payload });
      return chain;
    };
    chain.update = (payload: unknown) => {
      operation = 'update';
      h.updates.push({ table, payload });
      return chain;
    };
    chain.delete = () => {
      operation = 'delete';
      h.deletes.push({ table });
      return chain;
    };
    const single = () => {
      const result = resolved();
      return Promise.resolve({
        data: Array.isArray(result.data) ? (result.data[0] ?? null) : result.data,
        error: result.error,
      });
    };
    chain.single = single;
    chain.maybeSingle = single;
    chain.then = (resolve: (value: unknown) => unknown) => terminal().then(resolve);
    return chain;
  };

  return {
    supabase: {
      from: vi.fn((table: string) => builder(table)),
      auth: {
        getUser: vi.fn(() => Promise.resolve({ data: { user: null }, error: null })),
        getSession: vi.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      },
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

import { DebtDetailPage } from '@/pages/DebtDetail';

const DEBT = {
  id: 'debt-1',
  organization_id: 'org-1',
  name: 'Visa Business Card',
  kind: 'credit_card',
  lender_name: 'Bank Test',
  account_number_last4: '1234',
  original_balance_cents: 1_000_000,
  current_balance_cents: 500_000,
  interest_rate_pct: 18.99,
  minimum_payment_cents: 12_500,
  payment_due_day: 15,
  start_date: '2025-01-01',
  end_date: null,
  is_personal: false,
  notes: 'Business card',
  deleted_at: null,
};

beforeEach(() => {
  h.tables = {
    debts: { data: [DEBT], error: null },
    debt_payments: { data: [], error: null },
  };
  h.inserts = [];
  h.updates = [];
  h.deletes = [];
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

async function renderLoaded() {
  render(
    <MemoryRouter initialEntries={['/debts/debt-1']}>
      <Routes>
        <Route path="/debts/:id" element={<DebtDetailPage />} />
        <Route path="/debts" element={<div>Debts index</div>} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(await screen.findByText('Visa Business Card')).toBeInTheDocument();
}

describe('DebtDetailPage', () => {
  it('records a payment and reduces the debt balance by the principal portion', async () => {
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: /record payment/i }));
    const modal = screen.getByRole('dialog', { name: /record debt payment/i });
    fireEvent.change(within(modal).getByLabelText(/payment date/i), {
      target: { value: '2026-06-15' },
    });
    fireEvent.change(within(modal).getByLabelText(/total amount/i), {
      target: { value: '250' },
    });
    fireEvent.change(within(modal).getByLabelText(/principal portion/i), {
      target: { value: '200' },
    });
    fireEvent.change(within(modal).getByLabelText(/interest portion/i), {
      target: { value: '45' },
    });
    fireEvent.change(within(modal).getByLabelText(/fees portion/i), {
      target: { value: '5' },
    });
    fireEvent.change(within(modal).getByLabelText(/notes/i), {
      target: { value: 'June payoff' },
    });

    fireEvent.click(within(modal).getByRole('button', { name: /^record payment$/i }));

    await waitFor(() => {
      expect(h.inserts).toContainEqual({
        table: 'debt_payments',
        payload: {
          organization_id: 'org-1',
          debt_id: 'debt-1',
          paid_at: '2026-06-15',
          total_cents: 25_000,
          principal_cents: 20_000,
          interest_cents: 4_500,
          fees_cents: 500,
          notes: 'June payoff',
        },
      });
    });

    expect(h.updates).toContainEqual({
      table: 'debts',
      payload: { current_balance_cents: 480_000 },
    });
  });

  it('archives the debt account with a deleted_at soft-delete', async () => {
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: /^archive$/i }));

    await waitFor(() => {
      expect(h.updates).toContainEqual({
        table: 'debts',
        payload: { deleted_at: expect.any(String) },
      });
    });
  });
});
