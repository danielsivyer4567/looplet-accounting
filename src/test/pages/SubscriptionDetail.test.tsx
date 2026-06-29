import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const h = vi.hoisted(() => ({
  tables: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  updates: [] as { table: string; payload: unknown }[],
  currentOrg: { id: 'org-1', name: 'Test Org', organization_type: 'standard' },
}));

vi.mock('@/lib/supabase', () => {
  const builder = (table: string) => {
    let operation: 'select' | 'update' = 'select';
    const resolved = () => h.tables[table] ?? { data: [], error: null };
    const terminal = () =>
      Promise.resolve(operation === 'select' ? resolved() : { data: null, error: null });
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
    ].forEach((method) => {
      chain[method] = pass;
    });
    chain.update = (payload: unknown) => {
      operation = 'update';
      h.updates.push({ table, payload });
      return chain;
    };
    const single = () => {
      const result = resolved();
      return Promise.resolve({
        data: Array.isArray(result.data) ? (result.data[0] ?? null) : result.data,
        error: result.error,
      });
    };
    chain.single = single;
    chain.maybeSingle = single;
    chain.then = (resolve: (value: unknown) => unknown) => terminal().then(resolve);
    return chain;
  };

  return {
    supabase: {
      from: vi.fn((table: string) => builder(table)),
      auth: {
        getUser: vi.fn(() => Promise.resolve({ data: { user: null }, error: null })),
        getSession: vi.fn(() => Promise.resolve({ data: { session: null }, error: null })),
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

import { SubscriptionDetailPage } from '@/pages/SubscriptionDetail';

const SUBSCRIPTION = {
  id: 'sub-1',
  organization_id: 'org-1',
  merchant_canonical_key: 'adobe',
  merchant_name: 'Adobe Creative Cloud',
  cadence: 'monthly',
  amount_cents: 7_990,
  currency_code: 'AUD',
  status: 'detected',
  confidence: 0.91,
  first_seen_at: '2026-01-01',
  last_seen_at: '2026-06-01',
  next_expected_at: '2026-07-01',
  observed_count: 6,
  total_spent_cents: 47_940,
  detection_reason: 'Monthly merchant pattern',
  is_personal: false,
  is_business: true,
  notes: null,
};

beforeEach(() => {
  h.tables = {
    subscriptions: { data: [SUBSCRIPTION], error: null },
    bank_transactions: { data: [], error: null },
  };
  h.updates = [];
});

async function renderLoaded() {
  render(
    <MemoryRouter initialEntries={['/subscriptions/sub-1']}>
      <Routes>
        <Route path="/subscriptions/:id" element={<SubscriptionDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(await screen.findByText('Adobe Creative Cloud')).toBeInTheDocument();
}

describe('SubscriptionDetailPage', () => {
  it('saves subscription status, cadence, notes, and mutually exclusive personal classification', async () => {
    await renderLoaded();

    fireEvent.click(screen.getByRole('button', { name: /edit details/i }));
    fireEvent.change(screen.getByLabelText(/subscription status/i), {
      target: { value: 'paused' },
    });
    fireEvent.change(screen.getByLabelText(/cadence override/i), {
      target: { value: 'yearly' },
    });
    fireEvent.click(screen.getByRole('button', { name: /personal/i }));
    fireEvent.change(screen.getByLabelText(/^notes$/i), {
      target: { value: 'Moved to personal card' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(h.updates).toContainEqual({
        table: 'subscriptions',
        payload: {
          status: 'paused',
          cadence: 'yearly',
          is_personal: true,
          is_business: false,
          notes: 'Moved to personal card',
        },
      });
    });
  });
});
