import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * EmployeeDetail award-underpayment badge (SC-3.K.03). Runtime look (Preview MCP
 * unavailable): mounts the real page with a per-table supabase mock and asserts the
 * ASSIST-ONLY badge renders (with the "illustrative / confirm / no auto pay change"
 * framing) when the employee is in v_award_rate_exceptions, and is ABSENT otherwise.
 * The page issues 7 distinct queries in one Promise.all, so the shared single-response
 * mock can't drive it — a table-routing mock returns per-table fixtures.
 */

const h = vi.hoisted(() => ({
  tables: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  inserts: [] as { table: string; payload: unknown }[],
  updates: [] as { table: string; payload: unknown }[],
  rpcs: [] as { fn: string; args: unknown }[],
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
      'upsert',
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
    ].forEach((m) => {
      chain[m] = pass;
    });
    chain['insert'] = (payload: unknown) => {
      operation = 'insert';
      h.inserts.push({ table, payload });
      return chain;
    };
    chain['update'] = (payload: unknown) => {
      operation = 'update';
      h.updates.push({ table, payload });
      return chain;
    };
    chain['delete'] = () => {
      operation = 'delete';
      return chain;
    };
    const single = () => {
      const r = resolved();
      return Promise.resolve({
        data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data,
        error: r.error,
      });
    };
    chain['single'] = single;
    chain['maybeSingle'] = single;
    chain['then'] = (res: (v: unknown) => unknown) => terminal().then(res);
    return chain;
  };
  return {
    supabase: {
      from: (t: string) => builder(t),
      rpc: (fn: string, args: unknown) => {
        h.rpcs.push({ fn, args });
        return Promise.resolve({ data: { ok: true }, error: null });
      },
      auth: {
        getUser: () => Promise.resolve({ data: { user: null }, error: null }),
        getSession: () => Promise.resolve({ data: { session: null }, error: null }),
      },
    },
  };
});
vi.mock('@/hooks/useOrg', () => {
  // Stable identity across renders — a fresh object each call would change the
  // page's refresh useCallback identity and re-fire its effect every render.
  const currentOrg = { id: 'org-1', name: 'Org', organization_type: 'standard' };
  const organizations = [
    currentOrg,
    { id: 'org-2', name: 'Second Org', organization_type: 'standard' },
  ];
  return { useOrg: () => ({ currentOrg, organizations }) };
});

import { EmployeeDetailPage } from '@/pages/EmployeeDetail';

const EMP = {
  id: 'emp-1',
  organization_id: 'org-1',
  full_name: 'Jane Doe',
  email: 'jane@example.com',
  role: 'Cook',
  is_active: true,
  modern_award: 'MA000003',
  classification_level: 'Level 1',
  wage_components: {
    base_hourly_rate: 24.0,
    super_pct: 11.5,
    workcover_pct: 1.5,
    leave_loading_pct: 8,
    loaded_hourly_rate_cents: 10000,
  },
  created_at: '2024-01-01T00:00:00Z',
  deleted_at: null,
};
const TIMESHEET = {
  id: 'ts-1',
  employee_id: 'emp-1',
  job_id: 'job-1',
  work_date: '2026-06-20',
  hours: 4,
  loaded_hourly_rate_cents: 10000,
  total_cost_cents: 40000,
  is_billable: true,
  notes: 'Initial install',
  entry_type: 'ordinary',
  job: { job_number: 'J-001', name: 'Fence repair' },
};
const JOB = {
  id: 'job-1',
  job_number: 'J-001',
  name: 'Fence repair',
};
const EXC = {
  modern_award: 'MA000003',
  classification_level: 'Level 1',
  base_hourly_rate_cents: 2400,
  award_min_hourly_rate_cents: 2622,
  shortfall_cents: 222,
};

beforeEach(() => {
  h.inserts = [];
  h.updates = [];
  h.rpcs = [];
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  h.tables = {
    employees: { data: [EMP], error: null },
    timesheet_entries: { data: [TIMESHEET], error: null },
    jobs: { data: [JOB], error: null },
    leave_balances: { data: [], error: null },
    pay_slips: { data: [], error: null },
    v_award_rate_exceptions: { data: [EXC], error: null },
  };
});

// Render and let the page's Promise.all fetch settle (state updates land outside
// React's auto-act wrapper, so flush them deterministically before asserting).
async function renderLoaded() {
  render(
    <MemoryRouter initialEntries={['/employees/emp-1']}>
      <Routes>
        <Route path="/employees/:id" element={<EmployeeDetailPage />} />
        <Route path="/employees" element={<div>Employees index</div>} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

describe('EmployeeDetail award underpayment badge (SC-3.K.03)', () => {
  it('shows the assist-only underpayment badge when flagged, with no auto-correction', async () => {
    await renderLoaded();
    expect(screen.getByText(/Possible award underpayment/i)).toBeInTheDocument();
    // assist-only liability framing
    expect(screen.getByText(/illustrative/i)).toBeInTheDocument();
    expect(screen.getByText(/No pay change is made automatically/i)).toBeInTheDocument();
    // shows the award fields too (read-only Stat)
    expect(screen.getAllByText(/MA000003/).length).toBeGreaterThan(0);
  });

  it('does not show the badge for a compliant employee, but still shows the award field', async () => {
    h.tables['v_award_rate_exceptions'] = { data: [], error: null };
    await renderLoaded();
    expect(screen.getByText('Level 1')).toBeInTheDocument(); // award classification still shown
    expect(screen.queryByText(/Possible award underpayment/i)).not.toBeInTheDocument();
  });

  it('degrades gracefully when the exceptions view is unavailable (not deployed)', async () => {
    h.tables['v_award_rate_exceptions'] = {
      data: null,
      error: { message: 'relation does not exist' },
    };
    await renderLoaded();
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.queryByText(/Possible award underpayment/i)).not.toBeInTheDocument();
  });

  it('updates inline timesheet hours and recomputes total cost from the loaded rate', async () => {
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: /edit timesheet/i }));
    fireEvent.change(screen.getByLabelText(/timesheet hours/i), { target: { value: '6.5' } });
    fireEvent.change(screen.getByLabelText(/timesheet notes/i), {
      target: { value: 'Updated install' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save timesheet/i }));

    await waitFor(() => {
      expect(h.updates).toContainEqual({
        table: 'timesheet_entries',
        payload: {
          hours: 6.5,
          notes: 'Updated install',
          total_cost_cents: 65000,
        },
      });
    });
  });

  it('logs new job-attached time with the employee loaded rate', async () => {
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: /^log time$/i }));
    fireEvent.change(screen.getByLabelText(/work date/i), { target: { value: '2026-06-21' } });
    fireEvent.change(screen.getByLabelText(/hours worked/i), { target: { value: '3.5' } });
    fireEvent.change(screen.getByLabelText(/entry type/i), { target: { value: 'overtime' } });
    fireEvent.change(screen.getByLabelText(/^job$/i), { target: { value: 'job-1' } });
    fireEvent.change(screen.getByLabelText(/time entry notes/i), {
      target: { value: 'Overtime install' },
    });
    fireEvent.click(screen.getByRole('button', { name: /log entry/i }));

    await waitFor(() => {
      expect(h.inserts).toContainEqual({
        table: 'timesheet_entries',
        payload: {
          organization_id: 'org-1',
          employee_id: 'emp-1',
          job_id: 'job-1',
          work_date: '2026-06-21',
          hours: 3.5,
          loaded_hourly_rate_cents: 10000,
          notes: 'Overtime install',
          is_billable: true,
          entry_type: 'overtime',
        },
      });
    });
  });

  it('archives the employee with a deleted_at soft-delete', async () => {
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: /^archive$/i }));

    await waitFor(() => {
      expect(h.updates).toContainEqual({
        table: 'employees',
        payload: { deleted_at: expect.any(String) },
      });
    });
  });

  it('moves an employee through the org-safe move RPC', async () => {
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: /move employee/i }));
    fireEvent.click(screen.getByText('Second Org'));

    await waitFor(() => {
      expect(h.rpcs).toContainEqual({
        fn: 'move_employee_to_org',
        args: {
          p_employee_id: 'emp-1',
          p_target_org_id: 'org-2',
        },
      });
    });
  });
});
