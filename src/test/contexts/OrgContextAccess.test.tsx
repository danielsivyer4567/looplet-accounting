/**
 * Tests for the P0-01 pending-membership access gate in OrgProvider.
 *
 * What we prove (client side of the gate; the RLS side is migration 0203,
 * verified by a rolled-back impersonated read — see the slice's live_proof):
 *   1. A PENDING membership (accepted_at IS NULL) never appears in the
 *      provider's organizations list and is not auto-selected as currentOrg.
 *   2. An ACCEPTED membership IS present and becomes the default currentOrg.
 *   3. An accepted *accountant* membership is preserved (role is not the gate;
 *      accepted_at is).
 *   4. The membership query applies the server-side accepted-only filter
 *      `.not('accepted_at', 'is', null)`.
 *
 * We mock @/lib/supabase with a chainable builder that (a) records the filter
 * calls so we can assert the accepted-only filter is issued, and (b) resolves
 * to a configurable dataset. The client-side guard in OrgProvider is exercised
 * by feeding the builder a dataset that still contains a pending row (i.e. as
 * if the server filter were bypassed): it must still be dropped.
 *
 * useAuth is mocked so no AuthProvider is needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { OrgProvider } from '@/contexts/OrgContext';
import { useOrg } from '@/hooks/useOrg';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Return a STABLE user object — a fresh object each render would change
// refresh()'s [user] dependency every render and loop the effect forever.
// Defined via vi.hoisted so it exists when the hoisted vi.mock factory runs.
const auth = vi.hoisted(() => ({ user: { id: 'user-1' } }));
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: auth.user }),
}));

// Hoisted mutable state for the supabase mock.
const sb = vi.hoisted(() => {
  return {
    // Rows the membership query resolves to (set per test).
    rows: [] as unknown[],
    // Filter calls recorded as [method, ...args] for assertions.
    filterCalls: [] as [string, ...unknown[]][],
  };
});

vi.mock('@/lib/supabase', () => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {};
    const record =
      (name: string) =>
      (...args: unknown[]) => {
        sb.filterCalls.push([name, ...args]);
        return chain;
      };
    chain.select = record('select');
    chain.eq = record('eq');
    chain.not = record('not');
    chain.is = record('is');
    chain.filter = record('filter');
    chain.order = record('order');
    // Resolve when awaited — like the real PostgREST builder.
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: sb.rows, error: null }).then(resolve);
    return chain;
  };
  return {
    supabase: {
      from: vi.fn(() => makeChain()),
      rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
    },
  };
});

// ---------------------------------------------------------------------------
// Test consumer — renders the provider's org list + current org for assertions.
// ---------------------------------------------------------------------------

function OrgListProbe() {
  const { organizations, currentOrg, loading } = useOrg();
  if (loading) return <div>loading</div>;
  return (
    <div>
      <ul data-testid="org-list">
        {organizations.map((o) => (
          <li key={o.id} data-testid={o.id}>
            {o.name}
          </li>
        ))}
      </ul>
      <div data-testid="current-org">{currentOrg ? currentOrg.id : 'none'}</div>
    </div>
  );
}

const ACCEPTED_OWNER = {
  role_enum: 'owner',
  accepted_at: '2026-06-01T00:00:00Z',
  organizations: {
    id: 'org-accepted',
    name: 'Accepted Co',
    abn: '12 345 678 901',
    organization_type: 'standard',
    business_profile: { entity_type: 'company' },
  },
};

const PENDING_INVITE = {
  role_enum: 'employee',
  accepted_at: null,
  organizations: {
    id: 'org-pending',
    name: 'Pending Co',
    abn: null,
    organization_type: 'standard',
    business_profile: null,
  },
};

const ACCEPTED_ACCOUNTANT = {
  role_enum: 'accountant',
  accepted_at: '2026-06-05T00:00:00Z',
  organizations: {
    id: 'org-client',
    name: 'Client Co',
    abn: null,
    organization_type: 'standard',
    business_profile: null,
  },
};

describe('OrgProvider — pending-membership access gate (P0-01)', () => {
  beforeEach(() => {
    sb.rows = [];
    sb.filterCalls = [];
    localStorage.clear();
  });

  it('excludes a pending org and includes the accepted org', async () => {
    // Server returns BOTH rows (simulating the server filter being bypassed) so
    // the client-side guard is what must drop the pending one.
    sb.rows = [ACCEPTED_OWNER, PENDING_INVITE];
    render(
      <OrgProvider>
        <OrgListProbe />
      </OrgProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('org-accepted')).toBeInTheDocument();
    });
    // Accepted org present; pending org absent.
    expect(screen.getByTestId('org-accepted')).toHaveTextContent('Accepted Co');
    expect(screen.queryByTestId('org-pending')).not.toBeInTheDocument();
    // Pending org is not auto-selected; the accepted org is the default.
    expect(screen.getByTestId('current-org')).toHaveTextContent('org-accepted');
  });

  it('does not auto-select or list a pending org even when it is the only row', async () => {
    sb.rows = [PENDING_INVITE];
    render(
      <OrgProvider>
        <OrgListProbe />
      </OrgProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('org-list')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('org-pending')).not.toBeInTheDocument();
    expect(screen.getByTestId('org-list').children.length).toBe(0);
    expect(screen.getByTestId('current-org')).toHaveTextContent('none');
  });

  it('preserves an ACCEPTED accountant membership (role is not the gate)', async () => {
    sb.rows = [ACCEPTED_ACCOUNTANT, PENDING_INVITE];
    render(
      <OrgProvider>
        <OrgListProbe />
      </OrgProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('org-client')).toBeInTheDocument();
    });
    expect(screen.getByTestId('org-client')).toHaveTextContent('Client Co');
    expect(screen.queryByTestId('org-pending')).not.toBeInTheDocument();
  });

  it('issues the accepted-only server filter on the membership query', async () => {
    sb.rows = [ACCEPTED_OWNER];
    render(
      <OrgProvider>
        <OrgListProbe />
      </OrgProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('org-accepted')).toBeInTheDocument();
    });
    // The query must scope to the caller AND to accepted memberships only.
    expect(sb.filterCalls).toContainEqual(['eq', 'user_id', 'user-1']);
    expect(sb.filterCalls).toContainEqual(['not', 'accepted_at', 'is', null]);
  });
});
