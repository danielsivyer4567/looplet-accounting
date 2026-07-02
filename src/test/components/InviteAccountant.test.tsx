/**
 * Tests for src/components/settings/InviteAccountant.tsx
 *
 * Strategy:
 * - Mock @/lib/supabase so auth.getSession() resolves a token.
 * - Mock @/hooks/useOrg to supply a current org.
 * - Stub global fetch and assert the team-invite payload carries role:'accountant'.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { InviteAccountant } from '@/components/settings/InviteAccountant';

vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));

let _mockCurrentOrg: { id: string; name: string } | null = {
  id: 'org-a',
  name: 'Alpha Plumbing',
};

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    currentOrg: _mockCurrentOrg,
    organizations: _mockCurrentOrg ? [_mockCurrentOrg] : [],
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
  }),
}));

function typeEmail(value: string) {
  fireEvent.change(screen.getByLabelText(/accountant email/i), { target: { value } });
}

describe('InviteAccountant', () => {
  beforeEach(async () => {
    _mockCurrentOrg = { id: 'org-a', name: 'Alpha Plumbing' };
    const { supabase } = await import('@/test/mocks/supabase');
    supabase.auth.getSession = vi
      .fn()
      .mockResolvedValue({ data: { session: { access_token: 'tok-123' } }, error: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the invite form', () => {
    render(<InviteAccountant />);
    expect(screen.getByRole('heading', { name: /invite your accountant/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send invite/i })).toBeInTheDocument();
  });

  it('renders nothing when there is no current org', () => {
    _mockCurrentOrg = null;
    const { container } = render(<InviteAccountant />);
    expect(container.firstChild).toBeNull();
  });

  it('POSTs to team-invite with role:accountant and the current org id', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ json: () => Promise.resolve({ ok: true, message: 'Invitation sent' }) });
    vi.stubGlobal('fetch', fetchMock);

    render(<InviteAccountant />);
    typeEmail('accountant@firm.com.au');
    fireEvent.click(screen.getByRole('button', { name: /send invite/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error('fetch was not called');
    const [url, init] = call;
    expect(String(url)).toContain('/functions/v1/team-invite');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok-123');
    expect(JSON.parse(init.body)).toEqual({
      email: 'accountant@firm.com.au',
      role: 'accountant',
      organization_id: 'org-a',
    });

    await waitFor(() => expect(screen.getByText('Invitation sent')).toBeInTheDocument());
  });

  it('surfaces the error message when the invite fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: false, error: 'A pending invitation already exists' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<InviteAccountant />);
    typeEmail('dupe@firm.com.au');
    fireEvent.click(screen.getByRole('button', { name: /send invite/i }));

    await waitFor(() =>
      expect(screen.getByText('A pending invitation already exists')).toBeInTheDocument(),
    );
  });
});
