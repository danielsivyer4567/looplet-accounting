import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
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
}));

vi.mock('@/lib/supabase', () => {
  const builder = (table: string) => {
    const resolved = () => h.tables[table] ?? { data: [], error: null };
    const chain: Record<string, unknown> = {};
    const pass = () => chain;
    [
      'select',
      'insert',
      'update',
      'delete',
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
    const single = () => {
      const r = resolved();
      return Promise.resolve({
        data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data,
        error: r.error,
      });
    };
    chain['single'] = single;
    chain['maybeSingle'] = single;
    chain['then'] = (res: (v: unknown) => unknown) => Promise.resolve(resolved()).then(res);
    return chain;
  };
  return {
    supabase: {
      from: (t: string) => builder(t),
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
  const currentOrg = { id: 'org-1', name: 'Org' };
  return { useOrg: () => ({ currentOrg }) };
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
  },
  created_at: '2024-01-01T00:00:00Z',
};
const EXC = {
  modern_award: 'MA000003',
  classification_level: 'Level 1',
  base_hourly_rate_cents: 2400,
  award_min_hourly_rate_cents: 2622,
  shortfall_cents: 222,
};

beforeEach(() => {
  h.tables = {
    employees: { data: [EMP], error: null },
    timesheet_entries: { data: [], error: null },
    jobs: { data: [], error: null },
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
});
