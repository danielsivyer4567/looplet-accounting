import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BankConnect } from '@/components/settings/BankConnect';
import { GmailConnect } from '@/components/settings/GmailConnect';

const mocks = vi.hoisted(() => ({
  currentOrg: { id: 'org-1', name: 'Test Org', organization_type: 'standard' },
  bankConnections: [
    {
      id: 'bank-1',
      provider: 'redbark',
      institution_name: 'NAB Business',
      status: 'active',
      last_synced_at: '2026-07-01T02:30:00Z',
      last_error: null,
      metadata: {},
    },
  ],
  bankAccounts: [
    {
      id: 'acct-1',
      bank_connection_id: 'bank-1',
      name: 'Operating Account',
      account_number_last4: '1234',
      bsb: '082001',
      account_type: 'checking',
      current_balance_cents: 123456,
      available_balance_cents: 120000,
      currency_code: 'AUD',
      is_primary: true,
      is_active: true,
      updated_at: '2026-07-01T02:31:00Z',
    },
  ],
  gmailIntegrations: [
    {
      id: 'gmail-1',
      gmail_address: 'accounts@example.com',
      last_synced_at: '2026-07-01T01:15:00Z',
      watch_expires_at: '2026-07-08T01:15:00Z',
      is_active: true,
      last_error: null,
    },
  ],
  refreshGmail: vi.fn(),
  enqueueJob: vi.fn(),
  operations: [] as { table: string; method: string; payload?: unknown }[],
  loadError: null as string | null,
  pending: false,
}));

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    organizations: [mocks.currentOrg],
    currentOrg: mocks.currentOrg,
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
    accountantClientOrgs: [],
    isAccountantOnly: false,
  }),
}));

vi.mock('@/hooks/useGmailIntegrations', () => ({
  useGmailIntegrations: () => ({
    integrations: mocks.gmailIntegrations,
    loading: false,
    refresh: mocks.refreshGmail,
  }),
}));

vi.mock('@/lib/automationJobs', () => ({
  enqueueJob: mocks.enqueueJob,
}));

vi.mock('@/components/settings/BankCsvImport', () => ({
  BankCsvImport: () => <div data-testid="bank-csv-import" />,
}));

vi.mock('@/components/settings/BankStatementImport', () => ({
  BankStatementImport: () => <div data-testid="bank-statement-import" />,
}));

vi.mock('@/lib/supabase', () => {
  const rowsFor = (table: string) => {
    if (table === 'bank_accounts') return mocks.bankAccounts;
    if (table === 'bank_connections') return mocks.bankConnections;
    return [];
  };

  const makeQuery = (table: string) => {
    const chain: Record<string, unknown> = {};
    const pass = () => chain;
    ['select', 'eq', 'order'].forEach((method) => {
      chain[method] = pass;
    });
    chain.update = (payload: unknown) => {
      mocks.operations.push({ table, method: 'update', payload });
      return chain;
    };
    chain.then = (resolve: (value: unknown) => unknown) => {
      // Never-resolving query keeps the component in its loading state.
      if (mocks.pending) {
        return new Promise(() => {
          /* never resolves — holds the loading frame */
        });
      }
      return Promise.resolve(
        mocks.loadError
          ? { data: null, error: { message: mocks.loadError } }
          : { data: rowsFor(table), error: null },
      ).then(resolve);
    };
    return chain;
  };

  return {
    supabase: {
      from: vi.fn((table: string) => makeQuery(table)),
      auth: {
        getSession: vi.fn(() =>
          Promise.resolve({
            data: { session: { access_token: 'test-token' } },
            error: null,
          }),
        ),
      },
    },
  };
});

describe('Settings connector responsive layouts', () => {
  beforeEach(() => {
    mocks.refreshGmail.mockReset();
    mocks.enqueueJob.mockReset();
    mocks.operations.length = 0;
    mocks.loadError = null;
    mocks.pending = false;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('shows an aria-busy skeleton while bank connections are loading', () => {
    mocks.pending = true;
    render(
      <MemoryRouter>
        <BankConnect />
      </MemoryRouter>,
    );

    const loading = screen.getByLabelText('Loading bank connections');
    expect(loading).toBeInTheDocument();
    expect(loading).toHaveAttribute('aria-busy', 'true');
    // While loading, neither the bank-feed panel nor a load error should show.
    expect(screen.queryByRole('button', { name: /show redbark accounts/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a categorized load error instead of the connect CTA when bank connections fail to load', async () => {
    mocks.loadError = 'new row violates row-level security policy';
    render(
      <MemoryRouter>
        <BankConnect />
      </MemoryRouter>,
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      /could not load bank connections\. access policy blocked this request/i,
    );
    // A failed load must NOT fall through to the "no bank connected yet" bank-feed panel.
    expect(screen.queryByRole('button', { name: /show redbark accounts/i })).not.toBeInTheDocument();
  });

  it('renders Gmail integrations as mobile cards as well as the desktop table', () => {
    render(<GmailConnect />);

    const cards = screen.getByLabelText(/gmail integrations mobile cards/i);
    expect(within(cards).getByText('accounts@example.com')).toBeInTheDocument();
    expect(within(cards).getByText('Last synced')).toBeInTheDocument();
    expect(within(cards).getByText('Watch expires')).toBeInTheDocument();
    expect(screen.getByRole('table')).toHaveClass('settings-responsive-table');
  });

  it('renders bank connections as mobile cards as well as the desktop table', async () => {
    render(
      <MemoryRouter>
        <BankConnect />
      </MemoryRouter>,
    );

    const cards = await screen.findByLabelText(/bank connections mobile cards/i);
    expect(cards).toHaveTextContent('NAB Business');
    expect(cards).toHaveTextContent('Provider');
    expect(cards).toHaveTextContent('Last sync');
    expect(cards).toHaveTextContent('Operating Account');
    expect(cards).toHaveTextContent('BSB 082001');
    expect(cards).toHaveTextContent('•••• 1234');
    expect(cards).toHaveTextContent('$1,234.56');
    expect(screen.getByRole('table')).toHaveClass('settings-responsive-table');
    await waitFor(() => expect(screen.queryByLabelText(/loading bank connections/i)).toBeNull());
  });

  it('disables a Redbark feed via bank-disconnect, which unlinks it in Looplet only', async () => {
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    render(
      <MemoryRouter>
        <BankConnect />
      </MemoryRouter>,
    );

    const disableButtons = await screen.findAllByRole('button', { name: /disable feed/i });
    const firstDisableButton = disableButtons[0];
    if (!firstDisableButton) throw new Error('Disable feed button was not rendered');
    fireEvent.click(firstDisableButton);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/functions/v1/bank-disconnect');
    expect(JSON.parse(init.body as string)).toEqual({
      organization_id: 'org-1',
      bank_connection_id: 'bank-1',
    });
    // Disabling is server-mediated (signed-in users cannot write Redbark links directly), and the
    // confirmation says plainly that the bank connection in Redbark itself is not changed.
    expect(mocks.operations).toEqual([]);
    expect(vi.mocked(window.confirm).mock.calls[0]?.[0]).toMatch(/connection in Redbark is not changed/);

    fetchMock.mockRestore();
  });

  it('has a breakpoint contract that swaps settings connector tables to cards on mobile', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.settings-responsive-table\s*\{[\s\S]*display: none/,
    );
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.settings-card-view\s*\{[\s\S]*display: grid/,
    );
  });
});
