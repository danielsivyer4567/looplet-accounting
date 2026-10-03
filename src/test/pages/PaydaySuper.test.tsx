import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

// PAY-05: the pay run list shows when each run's super guarantee must reach the fund, from v_pay_run_super_due
// (Payday Super from 1 July 2026, quarterly before; tested in tests/db-sql/payday-super.sql).

const h = vi.hoisted(() => ({
  currentOrg: { id: 'org-1', name: 'Test Org', organization_type: 'standard' },
  dataByTable: {} as Record<string, unknown[]>,
  errorByTable: {} as Record<string, string>,
  queried: [] as { table: string; columns: string; filters: [string, unknown][] }[],
}));

vi.mock('@/lib/supabase', () => {
  const builder = (table: string) => {
    const query = { table, columns: '', filters: [] as [string, unknown][] };
    h.queried.push(query);
    const chain: Record<string, unknown> = {};
    const pass = () => chain;
    chain.select = (columns: string) => {
      query.columns = columns;
      return chain;
    };
    chain.eq = (column: string, value: unknown) => {
      query.filters.push([column, value]);
      return chain;
    };
    ['is', 'in', 'order', 'gte', 'lte', 'limit'].forEach((m) => {
      chain[m] = pass;
    });
    chain.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve(
        h.errorByTable[table]
          ? { data: null, error: { message: h.errorByTable[table] } }
          : { data: h.dataByTable[table] ?? [], error: null },
      ).then(resolve);
    return chain;
  };
  return { supabase: { from: vi.fn((table: string) => builder(table)) } };
});

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({ organizations: [h.currentOrg], currentOrg: h.currentOrg, loading: false }),
}));

vi.mock('@/hooks/useSuperBatch', () => ({
  useSuperBatch: () => ({
    batch: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
    generate: vi.fn(),
    send: vi.fn(),
  }),
}));

import { PayrollPage } from '@/pages/Payroll';

const run = (id: string, periodStart: string, periodEnd: string, payDate: string) => ({
  id,
  period_start: periodStart,
  period_end: periodEnd,
  pay_date: payDate,
  status: 'approved',
  total_gross_cents: 171000,
  total_tax_cents: 26000,
  total_super_cents: 20520,
  total_net_cents: 145000,
  created_at: `${payDate}T00:00:00Z`,
});

beforeEach(() => {
  h.queried = [];
  h.errorByTable = {};
  h.dataByTable = {
    pay_runs: [
      run('run-jul', '2026-06-29', '2026-07-05', '2026-07-03'),
      run('run-jun', '2026-06-22', '2026-06-28', '2026-06-30'),
    ],
    employees: [],
    v_pay_run_super_due: [
      { pay_run_id: 'run-jul', super_due_rule: 'payday_super', super_due_date: '2026-07-14' },
      { pay_run_id: 'run-jun', super_due_rule: 'quarterly', super_due_date: '2026-07-28' },
    ],
  };
});

function renderPage() {
  return render(
    <MemoryRouter>
      <PayrollPage />
    </MemoryRouter>,
  );
}

/** The table row for the pay run whose period link has this text. */
async function rowFor(period: string) {
  const link = await screen.findByRole('link', { name: period });
  const row = link.closest('tr');
  if (!row) throw new Error(`no table row for ${period}`);
  return row;
}

describe('Payday Super due dates on the pay run list', () => {
  it('shows each run’s super due date and the rule it comes from', async () => {
    renderPage();
    expect(await screen.findByRole('columnheader', { name: 'Super due' })).toBeInTheDocument();

    const july = within(await rowFor('2026-06-29 → 2026-07-05'));
    expect(july.getByText('2026-07-14')).toBeInTheDocument();
    expect(july.getByText('Payday Super')).toBeInTheDocument();

    const june = within(await rowFor('2026-06-22 → 2026-06-28'));
    expect(june.getByText('2026-07-28')).toBeInTheDocument();
    expect(june.getByText('Quarterly')).toBeInTheDocument();

    // Due dates come from the database view, for this organisation only.
    expect(h.queried).toContainEqual({
      table: 'v_pay_run_super_due',
      columns: 'pay_run_id, super_due_rule, super_due_date',
      filters: [['organization_id', 'org-1']],
    });
  });

  it('explains the rule honestly, including that unrecorded public holidays can only make a date early', async () => {
    renderPage();
    expect(
      await screen.findByText(
        /For pay\s+dates from 1 July 2026 \(Payday Super\) that is 7 business days after payday/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/20 for a\s+new employee's first contribution to a fund/),
    ).toBeInTheDocument();
    expect(screen.getByText(/28 days after the end\s+of the quarter/)).toBeInTheDocument();
    expect(
      screen.getByText(/can\s+be earlier than the legal deadline but never later/),
    ).toBeInTheDocument();
  });

  it('shows a dash rather than a guessed date when due dates are unavailable', async () => {
    h.errorByTable = { v_pay_run_super_due: 'relation "v_pay_run_super_due" does not exist' };
    renderPage();
    const july = within(await rowFor('2026-06-29 → 2026-07-05'));
    expect(july.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('Payday Super')).not.toBeInTheDocument();
  });
});
