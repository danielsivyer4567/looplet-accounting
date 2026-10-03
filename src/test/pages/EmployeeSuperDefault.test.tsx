import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SG_RATE_TABLE, statutorySuperRatePct } from '@/lib/superGuarantee';
import { SG_RATE_TABLE as PAY_RUN_SG_RATE_TABLE } from '../../../supabase/functions/payroll-create-pay-run/super.ts';

// New employees default to the statutory super guarantee (SG) rate for today, not a hard-coded 11.5%.
// SG is 12% for wages paid from 1 July 2025 (SGAA 1992 s 19(2); s 17A(2) from 1 July 2026).

const h = vi.hoisted(() => ({
  currentOrg: { id: 'org-1', name: 'Test Org', organization_type: 'standard' },
  dataByTable: {} as Record<string, unknown[]>,
  inserts: [] as { table: string; payload: unknown }[],
  updates: [] as { table: string; payload: unknown }[],
}));

vi.mock('@/lib/supabase', () => {
  const builder = (table: string) => {
    const chain: Record<string, unknown> = {};
    const pass = () => chain;
    ['select', 'eq', 'is', 'in', 'not', 'order', 'gte', 'lte', 'limit'].forEach((m) => {
      chain[m] = pass;
    });
    chain.insert = (payload: unknown) => {
      h.inserts.push({ table, payload });
      return chain;
    };
    chain.update = (payload: unknown) => {
      h.updates.push({ table, payload });
      return chain;
    };
    const rows = () => h.dataByTable[table] ?? [];
    chain.maybeSingle = () => Promise.resolve({ data: rows()[0] ?? null, error: null });
    chain.single = chain.maybeSingle;
    chain.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: rows(), error: null }).then(resolve);
    return chain;
  };
  return {
    supabase: {
      from: vi.fn((table: string) => builder(table)),
      rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
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

import { EmployeesPage } from '@/pages/Employees';
import { EmployeeDetailPage } from '@/pages/EmployeeDetail';

/** Freeze only the clock (local noon), so the page's "today" is fixed but React timers still run. */
function today(year: number, monthIndex: number, day: number) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(year, monthIndex, day, 12, 0, 0));
}

async function openAddEmployee() {
  render(
    <MemoryRouter>
      <EmployeesPage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: /add employee/i }));
  return screen.getByLabelText('Super (%)') as HTMLInputElement;
}

beforeEach(() => {
  h.inserts = [];
  h.updates = [];
  h.dataByTable = { employees: [], jobs: [], timesheet_entries: [] };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('new employee super default', () => {
  it('defaults to 12% on and after 1 July 2025 and saves it with the loaded rate', async () => {
    today(2025, 9, 3);
    const superInput = await openAddEmployee();
    expect(superInput.value).toBe('12');
    expect(screen.queryByText(/below the 12% super guarantee/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('John Doe'), { target: { value: 'Sam Nail' } });
    // The header button and the form's submit share the label; the submit is the last one.
    const buttons = screen.getAllByRole('button', { name: /^add employee$/i });
    fireEvent.click(buttons[buttons.length - 1] as HTMLElement);

    await waitFor(() => expect(h.inserts).toHaveLength(1));
    const payload = h.inserts[0]?.payload as { wage_components: Record<string, number> };
    expect(payload.wage_components.super_pct).toBe(12);
    // $45 x (1 + 12% super + 1.5% WorkCover + 8% leave) = $54.68; the old 11.5% default gave $54.45.
    expect(payload.wage_components.loaded_hourly_rate_cents).toBe(5468);
  });

  it('follows the date: 11.5% for wages paid before 1 July 2025', async () => {
    today(2025, 5, 30);
    expect((await openAddEmployee()).value).toBe('11.5');
  });

  it('warns that a rate below the SG rate is raised in pay runs', async () => {
    today(2025, 9, 3);
    const superInput = await openAddEmployee();
    fireEvent.change(superInput, { target: { value: '11.5' } });
    expect(screen.getByText('Below the 12% super guarantee. Pay runs use at least 12%.')).toBeInTheDocument();
  });
});

describe('employee detail super default', () => {
  it('shows and costs an employee with no super rate at the statutory 12%', async () => {
    today(2025, 9, 3);
    h.dataByTable = {
      employees: [
        {
          id: 'emp-1',
          organization_id: 'org-1',
          full_name: 'Jane Doe',
          email: null,
          role: 'Cook',
          is_active: true,
          modern_award: null,
          classification_level: null,
          wage_components: { base_hourly_rate: 24, workcover_pct: 1.5, leave_loading_pct: 8 },
          created_at: '2024-01-01T00:00:00Z',
          deleted_at: null,
        },
      ],
    };
    render(
      <MemoryRouter initialEntries={['/employees/emp-1']}>
        <Routes>
          <Route path="/employees/:id" element={<EmployeeDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    fireEvent.click(screen.getByRole('button', { name: /edit info/i }));
    expect((screen.getByLabelText('Super %') as HTMLInputElement).value).toBe('12');

    fireEvent.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(h.updates).toHaveLength(1));
    const payload = h.updates[0]?.payload as { wage_components: Record<string, number> };
    // $24 x (1 + 12% + 1.5% + 8%) = $29.16; the old 11.5% default gave $29.04.
    expect(payload.wage_components.loaded_hourly_rate_cents).toBe(2916);
  });
});

describe('statutory rate table', () => {
  it('is 12% from 1 July 2025 and matches the table pay runs use as a floor', () => {
    expect(statutorySuperRatePct('2025-07-01')).toBe(12);
    expect(statutorySuperRatePct('2026-07-01')).toBe(12);
    expect(statutorySuperRatePct('2025-06-30')).toBe(11.5);
    expect(SG_RATE_TABLE).toEqual(PAY_RUN_SG_RATE_TABLE);
  });
});
