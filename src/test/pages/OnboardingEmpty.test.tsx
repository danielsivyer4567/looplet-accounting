import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoSetupPage } from '@/pages/onboarding/AutoSetup';
import { TriagePage } from '@/pages/onboarding/Triage';

interface MockOrg {
  id: string;
  name: string;
  organization_type: string;
}

interface MockGmailIntegration {
  id: string;
  gmail_address: string;
  is_active: boolean;
}

const emptyProgress = {
  total_entities: 0,
  pending_count: 0,
  needs_review_count: 0,
  approved_count: 0,
  dismissed_count: 0,
  pct_complete: 0,
  is_complete: false,
};

const mocks = vi.hoisted(() => ({
  currentOrg: {
    id: 'org-1',
    name: 'Test Org',
    organization_type: 'standard',
  } as MockOrg | null,
  integrations: [] as MockGmailIntegration[],
  gmailLoading: false,
  entities: [] as unknown[],
  progress: null as unknown,
  stagedLoading: false,
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

vi.mock('@/hooks/useGmailIntegrations', () => ({
  useGmailIntegrations: () => ({
    integrations: mocks.integrations,
    loading: mocks.gmailLoading,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/onboarding/useStagedEntities', () => ({
  useStagedEntities: () => ({
    entities: mocks.entities,
    progress: mocks.progress,
    loading: mocks.stagedLoading,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useIntakeCategories', () => ({
  useIntakeCategories: () => ({
    categories: [],
    loading: false,
  }),
}));

vi.mock('@/components/onboarding/DetectedInsights', () => ({
  DetectedInsights: () => <div data-testid="detected-insights" />,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    },
    from: vi.fn(),
  },
}));

function renderAutoSetup() {
  return render(
    <MemoryRouter>
      <AutoSetupPage />
    </MemoryRouter>,
  );
}

function renderTriage() {
  return render(
    <MemoryRouter>
      <TriagePage />
    </MemoryRouter>,
  );
}

describe('Onboarding empty states', () => {
  beforeEach(() => {
    mocks.currentOrg = { id: 'org-1', name: 'Test Org', organization_type: 'standard' };
    mocks.integrations = [];
    mocks.gmailLoading = false;
    mocks.entities = [];
    mocks.progress = null;
    mocks.stagedLoading = false;
  });

  it('Auto Setup without an organisation asks the user to pick one', () => {
    mocks.currentOrg = null;
    renderAutoSetup();

    expect(screen.getByText(/pick an organisation first/i)).toBeInTheDocument();
  });

  it('Auto Setup without a connected Gmail shows the connect-first card with a Settings link', () => {
    renderAutoSetup();

    expect(screen.getByText(/connect gmail first/i)).toBeInTheDocument();
    const settingsLink = screen.getByRole('link', { name: /go to settings/i });
    expect(settingsLink).toHaveAttribute('href', '/settings');
    expect(screen.queryByRole('button', { name: /run auto setup mining/i })).not.toBeInTheDocument();
  });

  it('Auto Setup with Gmail but zero staged entities offers the initial mining action only', () => {
    mocks.integrations = [
      { id: 'gmail-1', gmail_address: 'owner@business.example', is_active: true },
    ];
    mocks.progress = emptyProgress;
    renderAutoSetup();

    expect(screen.getByText('owner@business.example')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /1\. run auto setup mining/i })).toBeEnabled();
    expect(
      screen.queryByRole('button', { name: /ai-classify unknown senders/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /triage .* pending senders/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/senders reviewed/i)).not.toBeInTheDocument();
  });

  it('Triage without an organisation asks the user to pick one', () => {
    mocks.currentOrg = null;
    renderTriage();

    expect(screen.getByText(/pick an organisation first/i)).toBeInTheDocument();
  });

  it('Triage with zero staged senders explains the empty state and routes back to Auto Setup', () => {
    mocks.progress = emptyProgress;
    renderTriage();

    expect(
      screen.getByText(/no staged senders found yet\. run mailbox mining first\./i),
    ).toBeInTheDocument();
    const backLink = screen.getByRole('link', { name: /back to auto setup/i });
    expect(backLink).toHaveAttribute('href', '/onboarding');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
