import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TriagePage } from '@/pages/onboarding/Triage';

const mocks = vi.hoisted(() => ({
  currentOrg: { id: 'org-1', name: 'Test Org', organization_type: 'standard' } as {
    id: string;
    name: string;
    organization_type: string;
  } | null,
  entities: [] as unknown[],
  progress: null as unknown,
  loading: false,
  error: null as string | null,
}));

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    organizations: mocks.currentOrg ? [mocks.currentOrg] : [],
    currentOrg: mocks.currentOrg,
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/onboarding/useStagedEntities', () => ({
  useStagedEntities: () => ({
    entities: mocks.entities,
    progress: mocks.progress,
    loading: mocks.loading,
    error: mocks.error,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useIntakeCategories', () => ({
  useIntakeCategories: () => ({ categories: [], loading: false }),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    },
    from: vi.fn(),
  },
}));

function renderTriage() {
  return render(
    <MemoryRouter>
      <TriagePage />
    </MemoryRouter>,
  );
}

describe('Onboarding Triage load-error state', () => {
  beforeEach(() => {
    mocks.currentOrg = { id: 'org-1', name: 'Test Org', organization_type: 'standard' };
    mocks.entities = [];
    mocks.progress = null;
    mocks.loading = false;
    mocks.error = null;
  });

  it('renders a categorized load error instead of the false "empty" state when the query fails', () => {
    mocks.error = 'new row violates row-level security policy for table "staged_entities"';
    renderTriage();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/could not load staged senders/i);
    expect(alert).toHaveTextContent(/access policy blocked this request/i);

    // The misleading "no senders yet — run mining" empty copy must NOT show on failure.
    expect(
      screen.queryByText(/no staged senders found yet\. run mailbox mining first\./i),
    ).not.toBeInTheDocument();
  });

  it('classifies an auth failure as an authentication/permission issue', () => {
    mocks.error = 'JWT expired';
    renderTriage();

    expect(screen.getByRole('alert')).toHaveTextContent(/authentication or permission issue/i);
  });

  it('still shows the plain empty state when there is genuinely no data and no error', () => {
    mocks.error = null;
    renderTriage();

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(
      screen.getByText(/no staged senders found yet\. run mailbox mining first\./i),
    ).toBeInTheDocument();
  });
});
