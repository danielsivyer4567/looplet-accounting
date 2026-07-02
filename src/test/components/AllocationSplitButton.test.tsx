import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AllocationSplitButton } from '@/components/AllocationSplitButton';

const h = vi.hoisted(() => ({
  currentOrg: { id: 'org-a', name: 'Host Org', organization_type: 'standard' },
  organizations: [
    { id: 'org-a', name: 'Host Org', organization_type: 'standard' },
    { id: 'org-b', name: 'Shared Org', organization_type: 'standard' },
  ],
}));

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    organizations: h.organizations,
    currentOrg: h.currentOrg,
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('@/lib/supabase', () => {
  const builder = () => {
    const chain: Record<string, unknown> = {};
    ['select', 'eq', 'delete', 'in', 'insert', 'update'].forEach((method) => {
      chain[method] = () => chain;
    });
    chain.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve);
    return chain;
  };

  return {
    supabase: {
      from: vi.fn(() => builder()),
    },
  };
});

describe('AllocationSplitButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens a responsive split popover for mobile-safe multi-org allocation', async () => {
    const { container } = render(
      <AllocationSplitButton resourceType="bill" resourceId="bill-1" hostOrgId="org-a" />,
    );

    expect(container.querySelector('.allocation-split-control')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /split/i }));

    await waitFor(() => {
      expect(container.querySelector('.allocation-split-popover')).toBeTruthy();
    });
    expect(screen.getByText(/Host Org/i)).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveTextContent('Shared Org');

    const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');
    expect(css).toMatch(
      /\.allocation-split-popover\s*{[\s\S]*width: min\(360px, calc\(100vw - 2rem\)\)/,
    );
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.allocation-split-popover\s*{[\s\S]*position: fixed/,
    );
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.allocation-split-actions button\s*{[\s\S]*width: 100%/,
    );
  });
});
