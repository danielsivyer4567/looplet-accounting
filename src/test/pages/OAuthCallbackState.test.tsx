import { StrictMode, type ComponentType } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Xero and Gmail callback pages must only finish a connection this browser tab started: the state returned by the
// provider has to equal the one stored at the start. A callback link without a stored state (for example one sent by
// someone else) must never reach the server with its code.

const h = vi.hoisted(() => ({
  currentOrg: { id: 'org-1', name: 'Test Org', organization_type: 'standard' } as
    | { id: string; name: string; organization_type: string }
    | null,
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: 'user-jwt' } } })) },
  },
}));

vi.mock('@/hooks/useOrg', () => ({
  useOrg: () => ({
    organizations: h.currentOrg ? [h.currentOrg] : [],
    currentOrg: h.currentOrg,
    loading: false,
    setCurrentOrg: vi.fn(),
    createOrganization: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useGmailIntegrations', () => ({
  useGmailIntegrations: () => ({ integrations: [], loading: false, refresh: vi.fn() }),
}));

import { GmailConnect } from '@/components/settings/GmailConnect';
import { GmailCallbackPage } from '@/pages/GmailCallback';
import { XeroCallbackPage } from '@/pages/XeroCallback';

const PAGES: { name: string; Page: ComponentType; key: string; path: string; fn: string }[] = [
  { name: 'Xero', Page: XeroCallbackPage, key: 'xero_oauth_state', path: '/settings/xero-callback', fn: 'xero-oauth-callback' },
  { name: 'Gmail', Page: GmailCallbackPage, key: 'gmail_oauth_state', path: '/settings/gmail-callback', fn: 'gmail-oauth-callback' },
];

function renderAt(Page: ComponentType, path: string, query: string) {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[`${path}?${query}`]}>
        <Routes>
          <Route path={path} element={<Page />} />
          <Route path="*" element={<div>elsewhere</div>} />
        </Routes>
      </MemoryRouter>
    </StrictMode>,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sessionStorage.clear();
  h.currentOrg = { id: 'org-1', name: 'Test Org', organization_type: 'standard' };
  fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ ok: true, tenant: { name: 'Demo Co' }, gmail_address: 'bills@example.com' }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(PAGES)('$name callback page', ({ Page, key, path, fn }) => {
  it('refuses a callback this tab did not start and never sends the code', async () => {
    renderAt(Page, path, 'code=attacker-code&state=signed-state');
    expect(await screen.findByText(/not started in this browser tab/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a state that differs from the one this tab stored', async () => {
    sessionStorage.setItem(key, 'state-from-this-tab');
    renderAt(Page, path, 'code=attacker-code&state=state-from-elsewhere');
    expect(await screen.findByText(/does not match the connection started here/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it('finishes a matching connection exactly once and clears the stored state', async () => {
    sessionStorage.setItem(key, 'signed-state');
    renderAt(Page, path, 'code=good-code&state=signed-state');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/functions/v1/${fn}`);
    expect(JSON.parse(String(init.body))).toMatchObject({ organization_id: 'org-1', code: 'good-code', state: 'signed-state' });
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(await screen.findByText(/Redirecting/)).toBeInTheDocument();
    expect(screen.queryByText(/Connection failed|not started|does not match/i)).not.toBeInTheDocument();
  });

  it('waits for the organisation to load before using the state', async () => {
    h.currentOrg = null;
    sessionStorage.setItem(key, 'signed-state');
    renderAt(Page, path, 'code=good-code&state=signed-state');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(key)).toBe('signed-state');
    expect(screen.queryByText(/not started|does not match|Missing/i)).not.toBeInTheDocument();
  });

  it('reports a missing state from the provider without calling the server', async () => {
    sessionStorage.setItem(key, 'signed-state');
    renderAt(Page, path, 'code=good-code');
    expect(await screen.findByText(/Missing code or state/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Gmail connect button', () => {
  it('stores the issued state so the callback page can finish the connection', async () => {
    fetchMock.mockImplementationOnce(async () =>
      new Response(JSON.stringify({ ok: true, url: 'https://accounts.google.com/o/oauth2/v2/auth?state=issued', state: 'issued-state' }), {
        status: 200,
      }),
    );
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, origin: original.origin, set href(v: string) { assign(v); } } });
    try {
      render(<GmailConnect />);
      fireEvent.click(screen.getByRole('button', { name: /connect gmail/i }));
      await waitFor(() => expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?state=issued'));
      expect(sessionStorage.getItem('gmail_oauth_state')).toBe('issued-state');
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/functions/v1/gmail-oauth-start');
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });
});
