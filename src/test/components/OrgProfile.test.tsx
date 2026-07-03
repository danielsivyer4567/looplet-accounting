import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrgProfileForm } from '@/components/settings/OrgProfile';

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  updatePayload: null as Record<string, unknown> | null,
  eqCalls: [] as [string, unknown][],
  currentOrg: { id: 'org-1', name: 'Affordable Fencing', organization_type: 'standard' },
  saveError: null as string | null,
}));

const org = {
  id: 'org-1',
  name: 'Affordable Fencing',
  abn: null,
  settings: {
    tax_rate_percent: 25,
    gst_registered: true,
    default_invoice_terms_days: 14,
    default_invoice_notes: '',
  },
};

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    organizations: [mocks.currentOrg],
    currentOrg: mocks.currentOrg,
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: mocks.refresh,
  }),
}));

vi.mock('@/lib/supabase', () => {
  const buildChain = () => {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.update = vi.fn((payload: Record<string, unknown>) => {
      mocks.updatePayload = payload;
      return chain;
    });
    chain.eq = vi.fn((column: string, value: unknown) => {
      mocks.eqCalls.push([column, value]);
      return chain;
    });
    chain.maybeSingle = vi.fn(() => Promise.resolve({ data: org, error: null }));
    chain.then = (resolve: (value: unknown) => unknown) =>
      Promise.resolve(
        mocks.saveError
          ? { data: null, error: { message: mocks.saveError } }
          : { data: null, error: null },
      ).then(resolve);
    return chain;
  };

  return {
    supabase: {
      from: vi.fn(() => buildChain()),
    },
  };
});

describe('OrgProfileForm', () => {
  beforeEach(() => {
    mocks.refresh.mockClear();
    mocks.updatePayload = null;
    mocks.eqCalls = [];
    mocks.saveError = null;
  });

  it('surfaces a categorized save action error instead of the raw message', async () => {
    mocks.saveError = 'new row violates row-level security policy';
    render(<OrgProfileForm />);

    fireEvent.click(await screen.findByRole('button', { name: /save profile/i }));

    await waitFor(() =>
      expect(
        screen.getByText(
          /could not save the organisation profile\. access policy blocked this request/i,
        ),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument();
  });

  it('uses responsive grid classes with a 768px single-column breakpoint', async () => {
    const { container } = render(<OrgProfileForm />);
    await screen.findByLabelText(/trading name/i);

    expect(container.querySelectorAll('.org-profile-grid').length).toBeGreaterThan(0);

    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*\.org-profile-grid,[\s\S]*\.business-profile-grid\s*\{[\s\S]*grid-template-columns: 1fr/,
    );
  });

  it('writes ABN and tax settings back to organizations.settings', async () => {
    render(<OrgProfileForm />);

    const name = await screen.findByLabelText(/trading name/i);
    const abn = screen.getByLabelText(/abn/i);
    const gst = screen.getByLabelText(/gst registered/i);
    const taxRate = screen.getByLabelText(/income tax set-aside/i);
    const terms = screen.getByLabelText(/default payment terms/i);

    fireEvent.change(name, { target: { value: 'Looplet Test Org' } });
    fireEvent.change(abn, { target: { value: '12 345 678 901' } });
    fireEvent.change(gst, { target: { value: 'false' } });
    fireEvent.change(taxRate, { target: { value: '31' } });
    fireEvent.change(terms, { target: { value: '21' } });

    fireEvent.click(screen.getByRole('button', { name: /save profile/i }));

    await waitFor(() => {
      expect(mocks.updatePayload).toEqual({
        name: 'Looplet Test Org',
        abn: '12 345 678 901',
        settings: expect.objectContaining({
          gst_registered: false,
          tax_rate_percent: 31,
          default_invoice_terms_days: 21,
        }),
      });
    });

    expect(mocks.eqCalls).toContainEqual(['id', 'org-1']);
    expect(mocks.refresh).toHaveBeenCalled();
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('uses a skeleton while the organisation profile is loading', async () => {
    render(<OrgProfileForm />);

    expect(screen.getByLabelText(/loading organisation profile/i)).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(await screen.findByLabelText(/trading name/i)).toBeInTheDocument();
    expect(screen.queryByText(/loading org/i)).not.toBeInTheDocument();
  });
});
