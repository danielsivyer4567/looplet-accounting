import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CgtEventsPanel } from '@/components/CgtEventsPanel';

const mocks = vi.hoisted(() => ({
  error: null as string | null,
}));

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    currentOrg: { id: 'org-1', name: 'Test Org', organization_type: 'standard' },
  }),
}));

vi.mock('@/hooks/useCgtEvents', () => ({
  useCgtEvents: () => ({
    events: [],
    loading: false,
    error: mocks.error,
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  }),
  costBaseCents: () => 0,
}));

describe('CgtEventsPanel', () => {
  beforeEach(() => {
    mocks.error = null;
  });

  it('classifies CGT-event load errors instead of showing generic failed-to-load copy', () => {
    mocks.error = 'permission denied for table cgt_events';

    render(<CgtEventsPanel />);

    expect(
      screen.getByText(
        /could not load cgt events\. authentication or permission issue: permission denied for table cgt_events/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^failed to load:/i)).not.toBeInTheDocument();
  });
});
