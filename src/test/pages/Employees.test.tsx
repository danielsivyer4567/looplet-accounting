import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

const h = vi.hoisted(() => ({
  currentOrg: { id: 'org-1', name: 'Test Org', organization_type: 'standard' },
  loadError: null as string | null,
  dataByTable: {
    employees: [
      {
        id: 'emp-1',
        full_name: 'Alice Sparks',
        email: null,
        role: 'Electrician',
        is_active: true,
        wage_components: { base_hourly_rate: 45, super_pct: 11.5 },
        deleted_at: null,
      },
    ],
    jobs: [],
    timesheet_entries: [],
  } as Record<string, unknown[]>,
}));

vi.mock('@/lib/supabase', () => {
  const builder = (table: string) => {
    const chain: Record<string, unknown> = {};
    const pass = () => chain;
    ['select', 'eq', 'is', 'order', 'gte', 'limit'].forEach((m) => {
      chain[m] = pass;
    });
    chain.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve(
        h.loadError
          ? { data: null, error: { message: h.loadError } }
          : { data: h.dataByTable[table] ?? [], error: null },
      ).then(resolve);
    return chain;
  };
  return { supabase: { from: vi.fn((table: string) => builder(table)) } };
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

import { EmployeesPage } from '@/pages/Employees';

function renderPage() {
  return render(
    <MemoryRouter>
      <EmployeesPage />
    </MemoryRouter>,
  );
}

describe('EmployeesPage', () => {
  beforeEach(() => {
    h.loadError = null;
  });

  it('renders the staff roster from loaded employees', async () => {
    renderPage();
    // Rendered in both the desktop table and the mobile card deck.
    expect((await screen.findAllByText('Alice Sparks')).length).toBeGreaterThan(0);
  });

  it('renders employees as mobile cards alongside the desktop table', async () => {
    const { container } = renderPage();

    const cards = await screen.findByLabelText('Employee cards');
    expect(cards).toHaveClass('employees-card-view');
    expect(container.querySelector('.employee-mobile-card')).toBeInTheDocument();
    expect(within(cards).getByRole('link', { name: 'Alice Sparks' })).toHaveAttribute(
      'href',
      '/employees/emp-1',
    );
    expect(within(cards).getByText('Base rate')).toBeInTheDocument();
    expect(within(cards).getByText('Loaded rate')).toBeInTheDocument();

    const tables = screen.getAllByRole('table');
    expect(tables[0]?.closest('.employees-table-view')).toBeInTheDocument();
  });

  it('has a max-width: 768px breakpoint that swaps the employees table for the card deck', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.employees-table-view[\s\S]*?\{[\s\S]*?display: none/,
    );
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.employees-card-view[\s\S]*?\{[\s\S]*?display: grid/,
    );
  });

  it('shows a categorized load error instead of the false "no employees" empty state', async () => {
    h.loadError = 'JWT expired';
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      /could not load employees\. authentication or permission issue/i,
    );
    // A failed load must NOT show the "no employees added yet" empty copy.
    expect(screen.queryByText(/no employees added yet/i)).not.toBeInTheDocument();
  });
});
