import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactElement } from 'react';

/**
 * UX-01: roles below an area's write threshold (lib/roles.ts) see a read-only notice and disabled
 * write controls instead of a "saved" that the database silently refused. The RESTRICTIVE policies
 * (20261003120000) make a refused UPDATE change 0 rows with no error, so pages also treat 0
 * changed rows as a failure. This mounts the seven pages the SEC-05 verifier named, as a viewer
 * and as an employee, with a per-table supabase mock.
 */

const h = vi.hoisted(() => ({
  role: 'viewer' as 'viewer' | 'employee' | 'accountant' | 'admin' | 'owner',
  tables: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  /** What `.update(...).eq(...).select('id')` resolves to: the changed rows. */
  updateResult: { data: [{ id: 'row-1' }] as unknown, error: null as { message: string } | null },
  updates: [] as { table: string; payload: unknown }[],
}));

vi.mock('@/lib/supabase', () => {
  const builder = (table: string) => {
    let operation: 'select' | 'insert' | 'update' | 'delete' = 'select';
    const resolved = () => h.tables[table] ?? { data: [], error: null };
    const terminal = () => {
      if (operation === 'update') return Promise.resolve(h.updateResult);
      if (operation === 'select') return Promise.resolve(resolved());
      return Promise.resolve({ data: [{ id: 'new-1' }], error: null });
    };
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
    chain['insert'] = () => {
      operation = 'insert';
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
    const single = () =>
      terminal().then((r) => ({
        data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data,
        error: r.error,
      }));
    chain['single'] = single;
    chain['maybeSingle'] = single;
    chain['then'] = (res: (v: unknown) => unknown) => terminal().then(res);
    return chain;
  };
  return {
    supabase: {
      from: (t: string) => builder(t),
      rpc: () => Promise.resolve({ data: null, error: null }),
      auth: {
        getUser: () => Promise.resolve({ data: { user: null }, error: null }),
        getSession: () => Promise.resolve({ data: { session: null }, error: null }),
      },
      storage: {
        from: () => ({
          createSignedUrl: () =>
            Promise.resolve({ data: { signedUrl: 'https://example.com/signed' }, error: null }),
        }),
      },
    },
  };
});

vi.mock('@/hooks/useOrg', () => {
  // One org object per role, so a page's refresh useCallback keeps its identity across renders.
  const orgs = Object.fromEntries(
    (['viewer', 'employee', 'accountant', 'admin', 'owner'] as const).map((role) => [
      role,
      { id: 'org-1', name: 'Test Org', organization_type: 'standard', role_enum: role },
    ]),
  );
  return {
    useOrg: () => {
      const currentOrg = orgs[h.role];
      return {
        organizations: [currentOrg],
        currentOrg,
        loading: false,
        setCurrentOrg: vi.fn(),
        createOrganization: vi.fn(),
        refresh: vi.fn(),
        accountantClientOrgs: [],
        isAccountantOnly: false,
      };
    },
  };
});

const BILL = {
  id: 'bill-1',
  organization_id: 'org-1',
  job_id: null,
  status: 'received' as const,
  source: 'email',
  storage_key: 'bills/bill-1.pdf',
  original_filename: 'invoice.pdf',
  mime_type: 'application/pdf',
  supplier_name_raw: 'Acme Supplies',
  supplier_abn: '12345678901',
  invoice_number: 'INV-001',
  invoice_date: '2026-06-01',
  due_date: '2026-07-01',
  total_inc_gst_cents: 110000,
  gst_cents: 10000,
  subtotal_ex_gst_cents: 100000,
  currency_code: 'AUD',
  job_reference_raw: null,
  notes: null,
  ocr_provider: 'veryfi',
  ocr_confidence: 0.95,
  xero_status: 'not_in_xero',
  xero_invoice_id: null,
  attached_at: null,
  is_personal: false,
  suggested_job_id: null,
  suggested_match_score: null,
  raw_extracted: { _extraction_method: 'ocr' },
  created_at: '2026-06-01T00:00:00Z',
  deleted_at: null,
  line_items: [],
};

vi.mock('@/hooks/useBill', () => ({
  useBill: () => ({ bill: BILL, loading: false, error: null, refresh: vi.fn() }),
  getBillFileUrl: vi.fn().mockResolvedValue('https://example.com/file.pdf'),
}));

vi.mock('@/hooks/useAllocationQueue', () => ({
  useAllocationQueue: () => ({
    queue: [
      {
        bill_id: 'bill-1',
        organization_id: 'org-1',
        status: 'received',
        supplier_name_raw: 'Steel Co',
        invoice_number: 'B-100',
        invoice_date: '2026-06-03',
        total_inc_gst_cents: 250000,
        job_reference_raw: 'J0001',
        suggested_job_id: 'job-1',
        score: 0.91,
        suggested_job_number: 'J0001',
        suggested_job_name: 'Fence install',
        suggested_job_status: 'active',
        created_at: '2026-06-03T00:00:00Z',
      },
    ],
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useJobs', () => ({
  useJobs: () => ({
    jobs: [{ id: 'job-1', job_number: 'J0001', name: 'Fence install', status: 'active' }],
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useCustomers', () => ({
  useCustomers: () => ({ customers: [], loading: false, error: null, refresh: vi.fn() }),
}));

vi.mock('@/hooks/useSuppliers', () => ({
  useSuppliers: () => ({
    suppliers: [],
    spendMap: new Map(),
    loading: false,
    loadingMore: false,
    error: null,
    hasMore: false,
    loadMore: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/usePaymentRuns', () => ({
  usePaymentRunDetail: () => ({
    run: {
      id: 'run-1',
      organization_id: 'org-1',
      pay_date: '2026-10-10',
      status: 'draft',
      total_cents: 250000,
      bill_count: 1,
      aba_file_generated_at: null,
      aba_file_size_bytes: null,
      notes: null,
      created_at: '2026-10-01T00:00:00Z',
      payer_bank_account_id: null,
    },
    items: [
      {
        id: 'item-1',
        bill_id: 'bill-1',
        amount_cents: 250000,
        payee_bsb: '062-000',
        payee_account_number: '12345678',
        payee_account_name: 'Steel Co',
        reference: 'B-100',
      },
    ],
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/lib/automationDecision', () => ({ recordOverride: vi.fn(), recordFeedback: vi.fn() }));
vi.mock('@/components/JobPicker', () => ({ JobPicker: () => null }));
vi.mock('@/components/MoveToOrgButton', () => ({ MoveToOrgButton: () => null }));
vi.mock('@/components/AllocationSplitButton', () => ({ AllocationSplitButton: () => null }));
vi.mock('@/components/ArchiveButton', () => ({ ArchiveButton: () => null }));
vi.mock('@/components/EmployeeMoveToOrgButton', () => ({
  EmployeeMoveToOrgButton: () => null,
}));

import { BillDetailPage } from '@/pages/BillDetail';
import { JobDetailPage } from '@/pages/JobDetail';
import { AllocationsPage } from '@/pages/Allocations';
import { PaymentRunDetailPage } from '@/pages/PaymentRunDetail';
import { EmployeeDetailPage } from '@/pages/EmployeeDetail';
import { CustomersPage } from '@/pages/Customers';
import { SuppliersPage } from '@/pages/Suppliers';

const JOB = {
  id: 'job-1',
  organization_id: 'org-1',
  job_number: 'J0001',
  name: 'Fence install',
  description: null,
  status: 'active',
  budget_cents: 500000,
  currency_code: 'AUD',
  start_date: '2026-06-01',
  end_date: null,
  customer_id: null,
  site_address: null,
  created_at: '2026-06-01T00:00:00Z',
  deleted_at: null,
};

const EMP = {
  id: 'emp-1',
  organization_id: 'org-1',
  full_name: 'Jane Doe',
  email: 'jane@example.com',
  role: 'Cook',
  is_active: true,
  modern_award: null,
  classification_level: null,
  wage_components: {
    base_hourly_rate: 24.0,
    super_pct: 12,
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
  job: { job_number: 'J0001', name: 'Fence install' },
};

function mount(path: string, route: string, element: ReactElement) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={route} element={element} />
      </Routes>
    </MemoryRouter>,
  );
}

const NOTICE = /you can view this page/i;

interface PageCase {
  name: string;
  mount: () => ReturnType<typeof render>;
  /** Text the page shows once its data has loaded. */
  loaded: RegExp;
  /** Accessible names of the write controls that must be disabled. */
  controls: RegExp[];
  /** Whether an employee is also read-only here (viewer always is). */
  employeeReadOnly: boolean;
}

const PAGES: PageCase[] = [
  {
    name: 'BillDetail',
    mount: () => mount('/bills/bill-1', '/bills/:id', <BillDetailPage />),
    loaded: /Acme Supplies/,
    controls: [/edit details/i, /personal/i],
    employeeReadOnly: true,
  },
  {
    name: 'JobDetail',
    mount: () => mount('/jobs/job-1', '/jobs/:id', <JobDetailPage />),
    loaded: /Fence install/,
    controls: [/^edit$/i],
    employeeReadOnly: false,
  },
  {
    name: 'Allocations',
    mount: () => mount('/allocations', '/allocations', <AllocationsPage />),
    loaded: /Steel Co/,
    controls: [/approve match/i, /^wrong$/i, /bulk-attach/i],
    employeeReadOnly: true,
  },
  {
    name: 'PaymentRunDetail',
    mount: () => mount('/payment-runs/run-1', '/payment-runs/:id', <PaymentRunDetailPage />),
    loaded: /Payment Run/,
    controls: [/^approve$/i],
    employeeReadOnly: true,
  },
  {
    name: 'EmployeeDetail',
    mount: () => mount('/employees/emp-1', '/employees/:id', <EmployeeDetailPage />),
    loaded: /Jane Doe/,
    controls: [/edit info/i],
    employeeReadOnly: true,
  },
  {
    name: 'Customers',
    mount: () => mount('/customers', '/customers', <CustomersPage />),
    loaded: /Customers/,
    controls: [/new customer/i],
    employeeReadOnly: true,
  },
  {
    name: 'Suppliers',
    mount: () => mount('/suppliers', '/suppliers', <SuppliersPage />),
    loaded: /Suppliers/,
    controls: [/new supplier/i],
    employeeReadOnly: true,
  },
];

function page(name: string): PageCase {
  const found = PAGES.find((p) => p.name === name);
  if (!found) throw new Error(`no page case named ${name}`);
  return found;
}

beforeEach(() => {
  h.role = 'viewer';
  h.updates = [];
  h.updateResult = { data: [{ id: 'row-1' }], error: null };
  h.tables = {
    jobs: { data: [JOB], error: null },
    v_job_pnl: { data: [], error: null },
    bills: { data: [], error: null },
    invoices: { data: [], error: null },
    customers: { data: [], error: null },
    employees: { data: [EMP], error: null },
    timesheet_entries: { data: [TIMESHEET], error: null },
    leave_balances: { data: [], error: null },
    pay_slips: { data: [], error: null },
    v_award_rate_exceptions: { data: [], error: null },
  };
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

async function expectReadOnly(page: PageCase) {
  page.mount();
  await waitFor(() => expect(screen.getAllByText(page.loaded).length).toBeGreaterThan(0));
  expect(screen.getByRole('status')).toHaveTextContent(NOTICE);
  for (const name of page.controls) {
    expect(screen.getByRole('button', { name }), `${page.name}: ${name}`).toBeDisabled();
  }
}

describe('read-only roles (UX-01)', () => {
  describe('as a viewer, every page shows the notice and disables its write controls', () => {
    for (const page of PAGES) {
      it(page.name, async () => {
        h.role = 'viewer';
        await expectReadOnly(page);
      });
    }
  });

  describe('as an employee', () => {
    for (const page of PAGES.filter((p) => p.employeeReadOnly)) {
      it(`${page.name} is read-only (books need accountant+, pay needs admin+)`, async () => {
        h.role = 'employee';
        await expectReadOnly(page);
      });
    }

    it('JobDetail can be edited: jobs and timesheets are employee+', async () => {
      h.role = 'employee';
      page('JobDetail').mount();
      await waitFor(() => expect(screen.getAllByText(/Fence install/).length).toBeGreaterThan(0));
      expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^edit$/i })).toBeEnabled();
    });

    it('EmployeeDetail lets an employee log time while employee details stay read-only', async () => {
      h.role = 'employee';
      page('EmployeeDetail').mount();
      await waitFor(() => expect(screen.getAllByText(/Jane Doe/).length).toBeGreaterThan(0));
      expect(screen.getByRole('status')).toHaveTextContent(/you can view this page and log time/i);
      expect(screen.getByRole('button', { name: /^log time$/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /edit info/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /edit timesheet/i })).toBeEnabled();
    });

    it('a viewer cannot log time or touch timesheets', async () => {
      h.role = 'viewer';
      page('EmployeeDetail').mount();
      await waitFor(() => expect(screen.getAllByText(/Jane Doe/).length).toBeGreaterThan(0));
      expect(screen.getByRole('button', { name: /^log time$/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /edit timesheet/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /delete timesheet/i })).toBeDisabled();
    });
  });

  describe('as an accountant', () => {
    it('BillDetail shows no notice and the controls are enabled', async () => {
      h.role = 'accountant';
      page('BillDetail').mount();
      await waitFor(() => expect(screen.getAllByText(/Acme Supplies/).length).toBeGreaterThan(0));
      expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /edit details/i })).toBeEnabled();
    });

    it('PaymentRunDetail is still read-only: payment runs need admin+', async () => {
      h.role = 'accountant';
      await expectReadOnly(page('PaymentRunDetail'));
    });
  });

  describe('an update the database refuses', () => {
    it('is reported as an error when 0 rows change, instead of a silent "saved"', async () => {
      // A membership whose role the client believes is enough, but the database refuses the
      // UPDATE: row-level security filters the row, so .select('id') returns no rows and no error.
      h.role = 'accountant';
      h.updateResult = { data: [], error: null };
      page('JobDetail').mount();
      await waitFor(() => expect(screen.getAllByText(/Fence install/).length).toBeGreaterThan(0));

      fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => expect(h.updates.some((u) => u.table === 'jobs')).toBe(true));
      expect(
        await screen.findByText(/could not save this job: nothing was changed/i),
      ).toHaveTextContent(/your role in this organisation does not allow it/i);
      // Still editing: the draft was not thrown away as if it had been saved.
      expect(screen.getByRole('button', { name: /^save$/i })).toBeInTheDocument();
    });

    it('succeeds when the changed row comes back', async () => {
      h.role = 'accountant';
      page('JobDetail').mount();
      await waitFor(() => expect(screen.getAllByText(/Fence install/).length).toBeGreaterThan(0));

      fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() =>
        expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument(),
      );
      expect(screen.queryByText(/nothing was changed/i)).not.toBeInTheDocument();
    });
  });
});
