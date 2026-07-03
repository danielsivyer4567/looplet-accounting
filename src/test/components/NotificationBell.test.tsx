/**
 * Tests for src/components/NotificationBell.tsx — focus on the SC-1E
 * cross-tenant accountant behaviour.
 *
 * We mock:
 *   - @/hooks/useOrg     — toggle accountantClientOrgs to flip cross-org mode
 *   - react-router-dom   — stub useNavigate to assert link navigation
 *   - @/lib/supabase     — a recording chainable mock that captures eq filters
 *                          and returns configurable notification rows
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NotificationBell } from '@/components/NotificationBell';
import type { Organization } from '@/contexts/org-context';

// --- react-router ----------------------------------------------------------
const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

// --- useOrg ----------------------------------------------------------------
const mockSetCurrentOrg = vi.fn();
let _organizations: Organization[] = [];
let _accountantClientOrgs: Organization[] = [];
let _currentOrg: Organization | null = null;

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    organizations: _organizations,
    accountantClientOrgs: _accountantClientOrgs,
    currentOrg: _currentOrg,
    setCurrentOrg: mockSetCurrentOrg,
    isAccountantOnly: false,
    loading: false,
    refresh: vi.fn(),
    createOrganization: vi.fn(),
  }),
}));

// --- supabase (recording chain) -------------------------------------------
let _rows: Record<string, unknown>[] = [];
let _selectEqCols: string[] = []; // organization_id appears here iff a single-org filter was applied

vi.mock('@/lib/supabase', () => {
  const makeChain = (isSelect: boolean) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => makeChain(true);
    chain.update = () => makeChain(false);
    chain.is = () => chain;
    chain.eq = (col: string) => {
      if (isSelect) _selectEqCols.push(col);
      return chain;
    };
    chain.order = () => chain;
    chain.limit = () => Promise.resolve({ data: _rows, error: null });
    // count query (head:true) + update().eq() both await the chain directly
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: _rows, error: null, count: _rows.length }).then(resolve);
    return chain;
  };
  return {
    supabase: {
      from: () => makeChain(false),
    },
  };
});

const ACME: Organization = {
  id: 'org-acme',
  name: 'Acme Plumbing',
  organization_type: 'standard',
  abn: null,
  role_enum: 'accountant',
  accepted_at: '2026-06-01T00:00:00Z',
  entity_type: null,
};
const BETA: Organization = {
  id: 'org-beta',
  name: 'Beta Builders',
  organization_type: 'standard',
  abn: null,
  role_enum: 'accountant',
  accepted_at: '2026-06-02T00:00:00Z',
  entity_type: null,
};

describe('NotificationBell — cross-tenant accountant view', () => {
  beforeEach(() => {
    _organizations = [];
    _accountantClientOrgs = [];
    _currentOrg = null;
    _rows = [];
    _selectEqCols = [];
    mockNavigate.mockClear();
    mockSetCurrentOrg.mockClear();
  });

  it('drops the single-org filter and shows client org names for an accountant', async () => {
    _organizations = [ACME, BETA];
    _accountantClientOrgs = [ACME, BETA];
    _currentOrg = ACME;
    _rows = [
      {
        id: 'n1',
        organization_id: 'org-beta',
        category: 'bas_due',
        severity: 'warning',
        title: 'BAS due for Beta',
        body: null,
        link: '/bas',
        read_at: null,
        created_at: '2026-06-20T00:00:00Z',
      },
    ];

    render(<NotificationBell />);
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));

    await waitFor(() => expect(screen.getByText('BAS due for Beta')).toBeInTheDocument());
    // org name surfaced for the cross-tenant row
    expect(screen.getByText('Beta Builders')).toBeInTheDocument();
    // no organization_id filter was applied on the list/count selects
    expect(_selectEqCols).not.toContain('organization_id');
  });

  it('switches into the notification org then navigates when clicked', async () => {
    _organizations = [ACME, BETA];
    _accountantClientOrgs = [ACME, BETA];
    _currentOrg = ACME;
    _rows = [
      {
        id: 'n1',
        organization_id: 'org-beta',
        category: 'bas_due',
        severity: 'warning',
        title: 'BAS due for Beta',
        body: null,
        link: '/bas',
        read_at: '2026-06-19T00:00:00Z',
        created_at: '2026-06-20T00:00:00Z',
      },
    ];

    render(<NotificationBell />);
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
    await waitFor(() => expect(screen.getByText('BAS due for Beta')).toBeInTheDocument());

    fireEvent.click(screen.getByText('BAS due for Beta'));

    await waitFor(() =>
      expect(mockSetCurrentOrg).toHaveBeenCalledWith(expect.objectContaining({ id: 'org-beta' })),
    );
    expect(mockNavigate).toHaveBeenCalledWith('/bas');
  });

  it('renders tag mentions with a View tag affordance and follows the deep link', async () => {
    _organizations = [ACME, BETA];
    _accountantClientOrgs = [ACME, BETA];
    _currentOrg = ACME;
    _rows = [
      {
        id: 'n-tag',
        organization_id: 'org-beta',
        category: 'mention',
        severity: 'info',
        title: 'Alice Accountant tagged you',
        body: 'Check the GST split',
        link: '/bills?tag=tag-1',
        resource_type: 'tag',
        resource_id: 'tag-1',
        read_at: '2026-06-19T00:00:00Z',
        created_at: '2026-06-20T00:00:00Z',
      },
    ];

    render(<NotificationBell />);
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));

    await waitFor(() =>
      expect(screen.getByText('Alice Accountant tagged you')).toBeInTheDocument(),
    );
    expect(screen.getByText('View tag')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Alice Accountant tagged you'));

    await waitFor(() =>
      expect(mockSetCurrentOrg).toHaveBeenCalledWith(expect.objectContaining({ id: 'org-beta' })),
    );
    expect(mockNavigate).toHaveBeenCalledWith('/bills?tag=tag-1');
  });

  it('keeps the single-org filter and hides org names for a non-accountant', async () => {
    _organizations = [ACME];
    _accountantClientOrgs = []; // not an accountant
    _currentOrg = ACME;
    _rows = [
      {
        id: 'n1',
        organization_id: 'org-acme',
        category: 'bas_due',
        severity: 'warning',
        title: 'BAS due',
        body: null,
        link: '/bas',
        read_at: null,
        created_at: '2026-06-20T00:00:00Z',
      },
    ];

    render(<NotificationBell />);
    fireEvent.click(screen.getByRole('button', { name: /notifications/i }));
    await waitFor(() => expect(screen.getByText('BAS due')).toBeInTheDocument());

    // org filter applied; org name chip not rendered
    expect(_selectEqCols).toContain('organization_id');
    expect(screen.queryByText('Acme Plumbing')).not.toBeInTheDocument();
  });
});
