import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  org: { id: 'org-1', name: 'Test Org' },
  flowRows: [
    { week_start: '2026-07-06', source_type: 'invoice', amount_cents: 110000 },
    { week_start: '2026-07-06', source_type: 'bill', amount_cents: -44000 },
    { week_start: '2026-08-03', source_type: 'bill', amount_cents: -12000 },
  ],
  bankRows: [{ current_balance_cents: 50000 }],
  flowError: null as { message: string } | null,
  bankError: null as { message: string } | null,
  from: vi.fn(),
  downloadCsv: vi.fn(),
}));

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({ currentOrg: h.org }),
}));

vi.mock('@/lib/csv', () => ({
  downloadCsv: h.downloadCsv,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: h.from,
  },
}));

import { CashFlowPage } from '@/pages/reports/CashFlow';

function queryBuilder(data: unknown[], error: { message: string } | null = null) {
  const chain: Record<string, unknown> = {};
  ['select', 'eq', 'is', 'order'].forEach((method) => {
    chain[method] = vi.fn(() => chain);
  });
  chain['then'] = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data, error }).then(resolve);
  return chain;
}

async function waitForPageText(needles: string[]) {
  await waitFor(() => {
    const text = document.body.textContent ?? '';
    if (needles.every((needle) => text.includes(needle))) return;
    const missing = needles.filter((needle) => !text.includes(needle));
    const excerpt = text.replace(/\s+/g, ' ').slice(0, 500);
    throw new Error(`Missing Cash Flow text: ${missing.join(', ')}. Text: ${excerpt}`);
  });
}

describe('CashFlowPage', () => {
  beforeEach(() => {
    h.downloadCsv.mockReset();
    h.from.mockReset();
    h.flowError = null;
    h.bankError = null;
    h.from.mockImplementation((table: string) => {
      if (table === 'v_cash_flow_weekly') return queryBuilder(h.flowRows, h.flowError);
      if (table === 'bank_accounts') return queryBuilder(h.bankRows, h.bankError);
      return queryBuilder([]);
    });
  });

  it('aggregates weekly cash flow and exports the CSV with running balance', async () => {
    render(
      <MemoryRouter>
        <CashFlowPage />
      </MemoryRouter>,
    );

    await waitForPageText(['2026-07-06', '2026-08-03', '$500.00', '$1,160.00']);

    fireEvent.click(screen.getByRole('button', { name: /Export cash flow data as CSV/i }));

    expect(h.downloadCsv).toHaveBeenCalledTimes(1);
    expect(h.downloadCsv).toHaveBeenCalledWith('cash-flow-202607-to-202608.csv', [
      {
        'Week start': '2026-07-06',
        'Inflow (AUD)': '1100.00',
        'Outflow (AUD)': '440.00',
        'Net (AUD)': '660.00',
        'Running balance (AUD)': '1160.00',
      },
      {
        'Week start': '2026-08-03',
        'Inflow (AUD)': '0.00',
        'Outflow (AUD)': '120.00',
        'Net (AUD)': '-120.00',
        'Running balance (AUD)': '1040.00',
      },
    ]);
  });

  it('shows a categorized load error when the cash flow query is blocked', async () => {
    h.flowError = { message: 'new row violates row-level security policy' };

    render(
      <MemoryRouter>
        <CashFlowPage />
      </MemoryRouter>,
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load cash flow forecast');
    expect(alert).toHaveTextContent('Access policy blocked this request');
    expect(screen.queryByText(/nothing committed yet/i)).not.toBeInTheDocument();
  });

  it('renders weekly cash flow as mobile cards alongside the desktop table', async () => {
    const { container } = render(
      <MemoryRouter>
        <CashFlowPage />
      </MemoryRouter>,
    );

    await waitForPageText(['2026-07-06']);

    const table = screen.getByRole('table');
    expect(table.closest('.cashflow-table-view')).toBeInTheDocument();

    const cards = screen.getByLabelText('Cash flow week cards');
    expect(cards).toHaveClass('cashflow-card-view');
    expect(container.querySelector('.cashflow-mobile-card')).toBeInTheDocument();
    expect(within(cards).getByText('Week 2026-07-06')).toBeInTheDocument();
    expect(within(cards).getAllByText('Projected running').length).toBeGreaterThan(0);
  });

  it('has a max-width: 768px breakpoint that swaps the cash flow table for the card deck', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.cashflow-table-view[\s\S]*\{[\s\S]*display: none/,
    );
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.cashflow-card-view[\s\S]*\{[\s\S]*display: grid/,
    );
  });
});
