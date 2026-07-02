/**
 * Tests for SLICE P0-03 — invite fallback token redemption.
 *
 * The team-invite edge fn used to hand back a `?token=<uuid>` copy-paste link
 * when the Supabase invite email failed to send. That link was a dead end:
 * redemption (accept_pending_invites, migration 0199) is gated on the caller's
 * *verified* JWT email, never on the URL token, so the token granted nothing
 * and only leaked a live invite token. P0-03 removes that fallback and fails
 * closed in the edge fn; here we assert AcceptInvite redeems exclusively through
 * the intended verified-session path and treats a stray ?token as inert.
 *
 * Strategy mirrors AcceptInvite.test.tsx:
 * - Mock @/lib/supabase so auth.getSession()/updateUser()/rpc() are controllable.
 * - Mock @/hooks/useOrg for refresh().
 * - Spy on react-router's useNavigate to assert (or assert the absence of) the
 *   post-accept redirect — access only ever appears AFTER acceptance (P0-01).
 *
 * Required scenarios: existing-user invite, new-user invite, invalid/expired
 * token, reuse-after-acceptance.
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

// A realistic stray fallback link: the format the old edge fn used to emit.
const STRAY_TOKEN_PATH = '/accept-invite?token=11111111-2222-3333-4444-555555555555';

describe('AcceptInvite — P0-03 fallback removal & verified redemption', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    refreshMock.mockReset();
    mockSupabaseResponse({ data: [], error: null });
  });

  it('existing-user invite: a verified session redeems via accept_pending_invites and access appears only at acceptance', async () => {
    await setSession({ access_token: 'tok-existing' });
    const { supabase } = await import('@/test/mocks/supabase');
    supabase.auth.updateUser = vi.fn();
    const rpcMock = vi.fn().mockResolvedValue({ data: ['client-org-existing'], error: null });
    supabase.rpc = rpcMock;

    renderPage();

    // Before acceptance: no navigation has occurred (no early access).
    const skip = await screen.findByRole('button', { name: /accept without changing it/i });
    expect(navigateMock).not.toHaveBeenCalled();

    fireEvent.click(skip);

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/clients', { replace: true }));
    expect(rpcMock).toHaveBeenCalledWith('accept_pending_invites');
    // Existing user keeps their password — no updateUser call.
    expect(supabase.auth.updateUser).not.toHaveBeenCalled();
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('new-user invite: sets a password first, then redeems and is granted access', async () => {
    await setSession({ access_token: 'tok-new' });
    const { supabase } = await import('@/test/mocks/supabase');
    supabase.auth.updateUser = vi.fn().mockResolvedValue({ data: { user: {} }, error: null });
    const rpcMock = vi.fn().mockResolvedValue({ data: ['client-org-new'], error: null });
    supabase.rpc = rpcMock;

    renderPage();

    await screen.findByRole('button', { name: /set password & accept/i });
    // Access is not granted just by landing on the page.
    expect(navigateMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: 'hunter2hunter2' },
    });
    fireEvent.click(screen.getByRole('button', { name: /set password & accept/i }));

    await waitFor(() =>
      expect(supabase.auth.updateUser).toHaveBeenCalledWith({ password: 'hunter2hunter2' }),
    );
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/clients', { replace: true }));
    expect(rpcMock).toHaveBeenCalledWith('accept_pending_invites');
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('invalid/expired token: a stray ?token link with no session is inert — no token redemption, generic expired message, no access', async () => {
    await setSession(null);
    const { supabase } = await import('@/test/mocks/supabase');
    const rpcMock = vi.fn().mockResolvedValue({ data: [], error: null });
    supabase.rpc = rpcMock;

    renderPage(STRAY_TOKEN_PATH);

    expect(await screen.findByText(/invitation link expired/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /go to sign in/i })).toHaveAttribute('href', '/login');
    // The token must never drive a redemption attempt — the only safe path is a
    // verified session, which we don't have here.
    expect(rpcMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('invalid/expired token: a verified session whose invite has lapsed yields no access', async () => {
    await setSession({ access_token: 'tok-lapsed' });
    const { supabase } = await import('@/test/mocks/supabase');
    supabase.auth.updateUser = vi.fn();
    // accept_pending_invites returns no org ids — nothing pending/unexpired.
    const rpcMock = vi.fn().mockResolvedValue({ data: [], error: null });
    supabase.rpc = rpcMock;

    renderPage(STRAY_TOKEN_PATH);

    fireEvent.click(await screen.findByRole('button', { name: /accept without changing it/i }));

    expect(await screen.findByText(/no pending invitation/i)).toBeInTheDocument();
    expect(rpcMock).toHaveBeenCalledWith('accept_pending_invites');
    expect(navigateMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('reuse-after-acceptance: a second visit after the invite was already accepted grants no further access', async () => {
    // The invite row is now status=accepted, so accept_pending_invites (which
    // only matches status=pending) returns an empty set on the repeat visit.
    await setSession({ access_token: 'tok-already-accepted' });
    const { supabase } = await import('@/test/mocks/supabase');
    supabase.auth.updateUser = vi.fn();
    const rpcMock = vi.fn().mockResolvedValue({ data: [], error: null });
    supabase.rpc = rpcMock;

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /accept without changing it/i }));

    expect(await screen.findByText(/no pending invitation/i)).toBeInTheDocument();
    expect(rpcMock).toHaveBeenCalledWith('accept_pending_invites');
    expect(navigateMock).not.toHaveBeenCalled();
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
