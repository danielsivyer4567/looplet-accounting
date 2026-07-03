import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoSetupPage } from '@/pages/onboarding/AutoSetup';

interface MockGmailIntegration {
  id: string;
  gmail_address: string;
  is_active: boolean;
}

const mocks = vi.hoisted(() => ({
  integrations: [] as MockGmailIntegration[],
  progress: null as unknown,
}));

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    organizations: [{ id: 'org-1', name: 'Test Org', organization_type: 'standard' }],
    currentOrg: { id: 'org-1', name: 'Test Org', organization_type: 'standard' },
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useGmailIntegrations', () => ({
  useGmailIntegrations: () => ({
    integrations: mocks.integrations,
    loading: false,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/onboarding/useStagedEntities', () => ({
  useStagedEntities: () => ({
    entities: [],
    progress: mocks.progress,
    loading: false,
    error: null,
    refresh: vi.fn(),
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

describe('Onboarding Auto Setup mobile layout', () => {
  beforeEach(() => {
    mocks.integrations = [
      { id: 'gmail-1', gmail_address: 'owner@business.example', is_active: true },
    ];
    mocks.progress = {
      total_entities: 12,
      pending_count: 8,
      needs_review_count: 0,
      approved_count: 4,
      dismissed_count: 0,
      pct_complete: 33,
      is_complete: false,
    };
  });

  it('tags the panel, action row, and triage CTA with responsive classes', () => {
    const { container } = renderAutoSetup();

    // Fluid panel that must collapse to full width on mobile.
    expect(container.querySelector('.autosetup-panel')).toBeInTheDocument();
    // Mining/AI-classify button row that must stack full-width on mobile.
    expect(container.querySelector('.autosetup-actions')).toBeInTheDocument();
    // Triage CTA that must go full-width on mobile.
    expect(screen.getByRole('button', { name: /triage .* pending senders/i })).toHaveClass(
      'autosetup-triage-cta',
    );
  });

  it('has a max-width: 768px breakpoint that stacks the Auto Setup actions full width', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.autosetup-panel\s*\{[\s\S]*max-width: 100%/,
    );
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.autosetup-actions button\s*\{[\s\S]*width: 100%/,
    );
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.autosetup-triage-cta\s*\{[\s\S]*width: 100%/,
    );
  });
});
