import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';

const h = vi.hoisted(() => ({
  currentOrg: { id: 'org-1', name: 'Test Org', organization_type: 'standard' },
  subscriptions: [
    {
      id: 'sub-1',
      organization_id: 'org-1',
      merchant_name: 'Adobe Creative Cloud',
      merchant_canonical_key: 'domain:adobe.com',
      cadence: 'monthly',
      amount_cents: 7999,
      status: 'candidate',
      confidence: 0.92,
      first_seen_at: '2026-04-01',
      last_seen_at: '2026-06-01',
      next_expected_at: '2026-07-01',
      observed_count: 3,
      total_spent_cents: 23997,
      detection_reason: 'monthly recurring card debit',
      is_personal: false,
      is_business: true,
      notes: null,
    },
  ],
  loadError: null as string | null,
}));

vi.mock('@/lib/supabase', () => {
  const builder = () => {
    const chain: Record<string, unknown> = {};
    const pass = () => chain;
    chain.select = pass;
    chain.eq = pass;
    chain.order = pass;
    chain.update = pass;
    chain.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve(
        h.loadError
          ? { data: null, error: { message: h.loadError } }
          : { data: h.subscriptions, error: null },
      ).then(resolve);
    return chain;
  };

  return {
    supabase: {
      from: vi.fn(() => builder()),
      auth: {
        getSession: vi.fn(() => Promise.resolve({ data: { session: null } })),
      },
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

vi.mock('@/components/AllocationSplitButton', () => ({
  AllocationSplitButton: ({ label = 'Split' }: { label?: string }) => (
    <button type="button">{label}</button>
  ),
}));

vi.mock('@/components/MoveToOrgButton', () => ({
  MoveToOrgButton: ({ label = 'Move' }: { label?: string }) => (
    <button type="button">{label}</button>
  ),
}));

import { SubscriptionsPage } from '@/pages/Subscriptions';

function renderPage() {
  return render(
    <MemoryRouter>
      <SubscriptionsPage />
    </MemoryRouter>,
  );
}

describe('SubscriptionsPage responsive layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.loadError = null;
  });

  it('classifies subscription load errors instead of showing the raw message', async () => {
    h.loadError = 'new row violates row-level security policy';
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByText(/could not load subscriptions\. access policy blocked this request/i),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/^new row violates/i)).not.toBeInTheDocument();
  });

  it('renders mobile subscription cards with core fields and row actions', async () => {
    const { container } = renderPage();

    await waitFor(() => {
      expect(screen.getAllByText('Adobe Creative Cloud').length).toBeGreaterThan(0);
    });

    const cardDeck = await waitFor(() => {
      expect(container.querySelector('.subscriptions-table-view')).toBeTruthy();
      const deck = container.querySelector('.subscriptions-card-view');
      if (!(deck instanceof HTMLElement)) throw new Error('Subscription card view not rendered');
      return deck;
    });

    const card = within(cardDeck).getByRole('article', {
      name: /subscription adobe creative cloud/i,
    });
    expect(within(card).getByText('@adobe.com')).toBeInTheDocument();
    expect(within(card).getByText('Monthly Eq.')).toBeInTheDocument();
    expect(within(card).getByText('Annual Eq.')).toBeInTheDocument();
    expect(within(card).getByText('92%')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /biz/i })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /personal/i })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /split/i })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /move/i })).toBeInTheDocument();
  });

  it('defines the mobile breakpoint that swaps the table for cards', () => {
    const css = readFileSync('src/index.css', 'utf8');

    expect(css).toMatch(/\.subscriptions-card-view\s*{\s*display:\s*none;/);
    expect(css).toMatch(
      /@media\s*\(max-width:\s*768px\)\s*{[\s\S]*\.subscriptions-table-view\s*{[\s\S]*display:\s*none;/,
    );
    expect(css).toMatch(
      /@media\s*\(max-width:\s*768px\)\s*{[\s\S]*\.subscriptions-card-view\s*{[\s\S]*display:\s*grid;/,
    );
  });
});
