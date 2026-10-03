import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * STP-01: an admin or owner can record an employee's TFN on the employee page, through the employee-tfn-save edge
 * function (which encrypts it into employee_tfn_vault). The page only ever shows the masked TFN from
 * employee_tfn_status(), clears the field once saved, and never reads the vault itself.
 */

const h = vi.hoisted(() => ({
  tables: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  tablesQueried: [] as string[],
  rpcs: [] as { fn: string; args: unknown }[],
  tfnStatus: [] as unknown[] | null,
  invokes: [] as { fn: string; options: unknown }[],
  invokeResult: { data: null, error: null } as { data: unknown; error: unknown },
}));

vi.mock('@/lib/supabase', () => {
  const builder = (table: string) => {
    h.tablesQueried.push(table);
    const resolved = () => h.tables[table] ?? { data: [], error: null };
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
      'in',
      'is',
      'not',
      'or',
      'order',
      'limit',
      'range',
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
      rpc: (fn: string, args: unknown) => {
        h.rpcs.push({ fn, args });
        if (fn === 'employee_tfn_status')
          return Promise.resolve({ data: h.tfnStatus, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      functions: {
        invoke: (fn: string, options: unknown) => {
          h.invokes.push({ fn, options });
          return Promise.resolve(h.invokeResult);
        },
      },
      auth: {
        getUser: () => Promise.resolve({ data: { user: null }, error: null }),
        getSession: () => Promise.resolve({ data: { session: null }, error: null }),
      },
    },
  };
});
vi.mock('@/hooks/useOrg', () => {
  const currentOrg = { id: 'org-1', name: 'Org', organization_type: 'standard' };
  return { useOrg: () => ({ currentOrg, organizations: [currentOrg] }) };
});

import { EmployeeDetailPage } from '@/pages/EmployeeDetail';

const EMP = {
  id: 'emp-1',
  organization_id: 'org-1',
  full_name: 'Jane Doe',
  email: null,
  role: 'Cook',
  is_active: true,
  modern_award: null,
  classification_level: null,
  wage_components: { base_hourly_rate: 30, super_pct: 12 },
  created_at: '2024-01-01T00:00:00Z',
  deleted_at: null,
};

const status = (masked: string | null) => [
  {
    employee_id: 'emp-1',
    employee_name: 'Jane Doe',
    has_tfn: masked != null,
    tfn_masked: masked,
    declaration_status: masked ? 'declared' : 'missing',
    updated_at: null,
  },
];

beforeEach(() => {
  h.tables = { employees: { data: [EMP], error: null } };
  h.tablesQueried = [];
  h.rpcs = [];
  h.invokes = [];
  h.tfnStatus = status(null);
  h.invokeResult = { data: null, error: null };
});

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

const tfnInput = () =>
  screen.getByLabelText('Tax file number', { selector: 'input' }) as HTMLInputElement;

/** Neither the page text nor any field may hold the full TFN, in any spacing. */
function expectNoFullTfn() {
  const inputs = Array.from(document.querySelectorAll('input')).map((i) => i.value);
  const text = `${document.body.textContent ?? ''} ${inputs.join(' ')}`.replace(/\s/g, '');
  expect(text).not.toContain('123456782');
}

describe('employee TFN capture (STP-01)', () => {
  it('saves a TFN through employee-tfn-save, clears the field and shows only the masked TFN', async () => {
    await renderLoaded();
    expect(screen.getByText(/No TFN recorded/)).toBeInTheDocument();
    expect(h.rpcs).toContainEqual({
      fn: 'employee_tfn_status',
      args: { p_org: 'org-1', p_employee_id: 'emp-1' },
    });
    // The TFN is typed into a masked field.
    expect(tfnInput().type).toBe('password');
    expect(tfnInput()).toHaveAttribute('autocomplete', 'off');

    h.invokeResult = {
      data: {
        ok: true,
        employee_id: 'emp-1',
        tfn_masked: '*****6782',
        declaration_status: 'declared',
      },
      error: null,
    };
    h.tfnStatus = status('*****6782');
    fireEvent.change(tfnInput(), { target: { value: '123 456 782' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save TFN' }));

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('TFN saved. On file: *****6782.'),
    );
    expect(h.invokes).toEqual([
      {
        fn: 'employee-tfn-save',
        options: { body: { organization_id: 'org-1', employee_id: 'emp-1', tfn: '123456782' } },
      },
    ]);
    expect(tfnInput().value).toBe('');
    // The status is re-read from the masked RPC.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Replace TFN' })).toBeInTheDocument(),
    );
    expect(h.rpcs.filter((r) => r.fn === 'employee_tfn_status')).toHaveLength(2);
    expectNoFullTfn();
    // The page never reads the vault table directly.
    expect(h.tablesQueried).not.toContain('employee_tfn_vault');
  });

  it('shows a TFN already on file masked, with a way to replace it', async () => {
    h.tfnStatus = status('*****6782');
    await renderLoaded();
    expect(screen.getByText('*****6782')).toBeInTheDocument();
    expect(
      screen.getByText(/stored encrypted and only the last four digits are shown/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace TFN' })).toBeInTheDocument();
    expect(tfnInput().value).toBe('');
  });

  it('checks the TFN has 8 or 9 digits before sending it', async () => {
    await renderLoaded();
    fireEvent.change(tfnInput(), { target: { value: '1234567' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save TFN' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A TFN has 8 or 9 digits.');
    expect(h.invokes).toEqual([]);
  });

  it("shows the function's refusal, such as a pending invite that is not yet an accepted admin", async () => {
    await renderLoaded();
    h.invokeResult = {
      data: null,
      error: {
        message: 'Edge Function returned a non-2xx status code',
        context: {
          json: () =>
            Promise.resolve({ ok: false, error: 'Only admin or owner can store employee TFNs' }),
        },
      },
    };
    fireEvent.change(tfnInput(), { target: { value: '123456782' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save TFN' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only admin or owner can store employee TFNs',
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText(/No TFN recorded/)).toBeInTheDocument();
  });

  it('offers no TFN field to someone who is not an admin or owner', async () => {
    h.tfnStatus = [];
    await renderLoaded();
    expect(
      screen.getByText(/Only an admin or owner can view or record this employee's TFN/),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText('Tax file number', { selector: 'input' }),
    ).not.toBeInTheDocument();
  });
});
