/**
 * Tests for src/pages/Notifications.tsx — SC-2G tag-mention integration.
 *
 * The page already handled cross-org navigation in SC-1E. This covers the new
 * mention/category rendering and the tag deep-link click path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Organization } from '@/contexts/org-context';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

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

let _rows: Record<string, unknown>[] = [];
let _updates: Record<string, unknown>[] = [];

vi.mock('@/lib/supabase', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.update = (payload: Record<string, unknown>) => {
      _updates.push(payload);
      return chain;
    };
    chain.is = () => chain;
    chain.eq = () => chain;
    chain.in = () => chain;
    chain.order = () => chain;
    chain.limit = () => Promise.resolve({ data: _rows, error: null });
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null }).then(resolve);
    return chain;
  };

  return {
    supabase: {
      from: () => makeChain(),
    },
  };
});

import { NotificationsPage } from '@/pages/Notifications';

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

describe('NotificationsPage — tag mentions', () => {
  beforeEach(() => {
    _organizations = [];
    _accountantClientOrgs = [];
    _currentOrg = null;
    _rows = [];
    _updates = [];
    mockNavigate.mockClear();
    mockSetCurrentOrg.mockClear();
  });

  it('renders mention notifications as tag rows and navigates to the tag deep link', async () => {
    _organizations = [ACME, BETA];
    _accountantClientOrgs = [ACME, BETA];
    _currentOrg = ACME;
    _rows = [
      {
        id: 'n-tag',
        organization_id: 'org-beta',
        user_id: 'acct-1',
        category: 'mention',
        severity: 'info',
        title: 'Alice Accountant tagged you',
        body: 'Check the GST split',
        link: '/bills?tag=tag-1',
        resource_type: 'tag',
        resource_id: 'tag-1',
        read_at: null,
        dismissed_at: null,
        created_at: '2026-06-20T00:00:00Z',
        metadata: {},
      },
    ];

    render(<NotificationsPage />);

    expect(await screen.findByText('Alice Accountant tagged you')).toBeInTheDocument();
    expect(screen.getAllByText('Mentions').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Beta Builders')).toBeInTheDocument();
    expect(screen.getByText('View tag')).toBeInTheDocument();

    fireEvent.click(screen.getByText('View tag'));

    await waitFor(() =>
      expect(mockSetCurrentOrg).toHaveBeenCalledWith(expect.objectContaining({ id: 'org-beta' })),
    );
    expect(mockNavigate).toHaveBeenCalledWith('/bills?tag=tag-1');
    expect(_updates).toHaveLength(1);
    expect(_updates[0]).toEqual(expect.objectContaining({ read_at: expect.any(String) }));
  });
});
