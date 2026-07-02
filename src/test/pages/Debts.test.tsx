import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

const h = vi.hoisted(() => ({
  calls: [] as { table: string; method: string; args: unknown[] }[],
  currentOrg: { id: 'org-1', name: 'Test Org', organization_type: 'standard' },
  loadError: null as string | null,
}));

vi.mock('@/lib/supabase', () => {
  const dataByTable: Record<string, unknown[]> = {
    debts: [
      {
        id: 'debt-1',
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
      },
    ],
    debt_payments: [],
  };

  const builder = (table: string) => {
    const chain: Record<string, unknown> = {};
    const record =
      (method: string) =>
      (...args: unknown[]) => {
        h.calls.push({ table, method, args });
        return chain;
      };

    ['select', 'eq', 'is', 'order', 'limit'].forEach((method) => {
      chain[method] = record(method);
    });
    chain.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve(
        h.loadError
          ? { data: null, error: { message: h.loadError } }
          : { data: dataByTable[table] ?? [], error: null },
      ).then(resolve);
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

import { DebtsPage } from '@/pages/Debts';

describe('DebtsPage', () => {
  beforeEach(() => {
    h.calls = [];
    h.loadError = null;
  });

  it('shows a categorized load error instead of the false "no debts" empty state', async () => {
    h.loadError = 'new row violates row-level security policy';
    render(
      <MemoryRouter>
        <DebtsPage />
      </MemoryRouter>,
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not load debts\. access policy blocked this request/i);
    // A failed load must NOT show the "no debts tracked yet" empty copy.
    expect(screen.queryByText(/no debts tracked yet/i)).not.toBeInTheDocument();
  });

  it('loads only active debt accounts', async () => {
    render(
      <MemoryRouter>
        <DebtsPage />
      </MemoryRouter>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect((await screen.findAllByText('Visa Business Card')).length).toBeGreaterThan(0);
    expect(h.calls).toContainEqual({
      table: 'debts',
      method: 'is',
      args: ['deleted_at', null],
    });
  });

  it('renders debts as mobile cards alongside the desktop table', async () => {
    const { container } = render(
      <MemoryRouter>
        <DebtsPage />
      </MemoryRouter>,
    );

    const cards = await screen.findByLabelText('Debt account cards');
    expect(cards).toHaveClass('debts-card-view');
    expect(container.querySelector('.debt-mobile-card')).toBeInTheDocument();
    expect(within(cards).getByRole('link', { name: 'Visa Business Card' })).toHaveAttribute(
      'href',
      '/debts/debt-1',
    );
    expect(within(cards).getByText('Min payment')).toBeInTheDocument();
    expect(within(cards).getByText('18.99%')).toBeInTheDocument();

    const tables = screen.getAllByRole('table');
    expect(tables[0]?.closest('.debts-table-view')).toBeInTheDocument();
  });

  it('has a max-width: 768px breakpoint that swaps the debts table for the card deck', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.debts-table-view[\s\S]*?\{[\s\S]*?display: none/,
    );
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.debts-card-view[\s\S]*?\{[\s\S]*?display: grid/,
    );
  });
});
