/**
 * Tests for src/pages/AcceptInvite.tsx
 *
 * Strategy:
 * - Mock @/lib/supabase so auth.getSession()/updateUser()/rpc() are controllable.
 * - Mock @/hooks/useOrg for refresh().
 * - Spy on react-router's useNavigate to assert the post-accept redirect.
 *
 * Covers the three states from the slice spec: new user (set password +
 * accept), existing user (accept without changing password), and expired
 * invite (no session, and accept returning no org ids).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as ReactRouterDom from 'react-router-dom';
import { AcceptInvitePage } from '@/pages/AcceptInvite';
import { AuthProvider } from '@/contexts/AuthContext';
import { mockSupabaseResponse } from '@/test/mocks/supabase';

vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));

const navigateMock = vi.fn();
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig<typeof ReactRouterDom>();
  return { ...actual, useNavigate: () => navigateMock };
});

const refreshMock = vi.fn();
vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    currentOrg: null,
    organizations: [],
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: refreshMock,
  }),
}));

async function setSession(session: unknown) {
  const { supabase } = await import('@/test/mocks/supabase');
  supabase.auth.getSession = vi.fn().mockResolvedValue({ data: { session }, error: null });
}

function renderPage(initialPath = '/accept-invite') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AuthProvider>
        <AcceptInvitePage />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('AcceptInvitePage', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    refreshMock.mockReset();
    mockSupabaseResponse({ data: [], error: null });
  });

  it('new user: sets a password then redeems the invite and redirects to /clients', async () => {
    await setSession({ access_token: 'tok-new' });
    const { supabase } = await import('@/test/mocks/supabase');
    supabase.auth.updateUser = vi.fn().mockResolvedValue({ data: { user: {} }, error: null });
    mockSupabaseResponse({ data: ['client-org-1'], error: null });

    renderPage();

    await screen.findByRole('button', { name: /set password & accept/i });
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: 'hunter2hunter2' },
    });
    fireEvent.click(screen.getByRole('button', { name: /set password & accept/i }));

    await waitFor(() =>
      expect(supabase.auth.updateUser).toHaveBeenCalledWith({ password: 'hunter2hunter2' }),
    );
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    expect(navigateMock).toHaveBeenCalledWith('/clients', { replace: true });
  });

  it('existing user: accepts without changing password', async () => {
    await setSession({ access_token: 'tok-existing' });
    const { supabase } = await import('@/test/mocks/supabase');
    supabase.auth.updateUser = vi.fn();
    mockSupabaseResponse({ data: ['client-org-2'], error: null });

    renderPage();

    const skip = await screen.findByRole('button', { name: /accept without changing it/i });
    fireEvent.click(skip);

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/clients', { replace: true }));
    expect(supabase.auth.updateUser).not.toHaveBeenCalled();
  });

  it('expired invite (no session): shows the expired message with a sign-in link', async () => {
    await setSession(null);

    renderPage();

    expect(await screen.findByText(/invitation link expired/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /go to sign in/i })).toHaveAttribute('href', '/login');
  });

  it('lapsed invite: a valid session but no pending invites shows the no-invitation state', async () => {
    await setSession({ access_token: 'tok-lapsed' });
    const { supabase } = await import('@/test/mocks/supabase');
    supabase.auth.updateUser = vi.fn().mockResolvedValue({ data: { user: {} }, error: null });
    mockSupabaseResponse({ data: [], error: null });

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /accept without changing it/i }));

    expect(await screen.findByText(/no pending invitation/i)).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
