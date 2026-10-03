/**
 * LEGAL-01: a privacy policy, terms of service and collection notice are published (public routes),
 * linked from sign-in, sign-up and the app footer, describe what the code really does, and are
 * accepted at sign-up with the acceptance saved on the account.
 *
 * The documents are drafts: a qualified legal reviewer must approve them before reliance. Details
 * the repository does not contain must show as "To be confirmed by Looplet", never invented.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { AuthContext, type AuthContextValue } from '@/contexts/auth-context';
import { AuthProvider } from '@/contexts/AuthContext';
import { App } from '@/App';
import { LegalLinks } from '@/components/LegalLinks';
import { LoginPage } from '@/pages/Login';
import { SignupPage } from '@/pages/Signup';
import { LEGAL_VERSIONS, PENDING_GOOGLE_ACCEPTANCE_KEY } from '@/lib/legal';
import { supabase } from '@/test/mocks/supabase';

vi.mock('@/lib/supabase', () => import('@/test/mocks/supabase'));

function renderWithAuth(element: React.ReactElement, overrides: Partial<AuthContextValue> = {}) {
  const value: AuthContextValue = {
    user: null,
    session: null,
    loading: false,
    signIn: vi.fn().mockResolvedValue({ error: null }),
    signInWithGoogle: vi.fn().mockResolvedValue({ error: null }),
    signUp: vi.fn().mockResolvedValue({ error: null, needsEmailConfirmation: true }),
    resetPassword: vi.fn().mockResolvedValue({ error: null }),
    setPassword: vi.fn().mockResolvedValue({ error: null }),
    signOut: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  render(
    <AuthContext.Provider value={value}>
      <MemoryRouter>{element}</MemoryRouter>
    </AuthContext.Provider>,
  );
  return value;
}

async function renderAppAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  return screen.findByRole('heading', { level: 1 });
}

/** The AI and email providers the edge functions actually call. */
function providersCalledByCode(): string[] {
  const hosts: Record<string, string> = {
    'api.groq.com': 'Groq',
    'api.anthropic.com': 'Anthropic',
    'api.openai.com': 'OpenAI',
    'api.perplexity.ai': 'Perplexity',
    'api.minimax.io': 'MiniMax',
    'api.resend.com': 'Resend',
    'gmail.googleapis.com': 'Gmail',
    'api.xero.com': 'Xero',
  };
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) {
        const text = readFileSync(path, 'utf8');
        for (const [host, provider] of Object.entries(hosts))
          if (text.includes(host)) found.add(provider);
      }
    }
  };
  walk(join(process.cwd(), 'supabase/functions'));
  return [...found].sort();
}

describe('legal pages (LEGAL-01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  it('serves the three documents publicly, without signing in', async () => {
    expect(await renderAppAt('/privacy')).toHaveTextContent('Privacy policy');
  });

  it.each([
    ['/terms', 'Terms of service'],
    ['/collection-notice', 'Collection notice'],
  ])('serves %s publicly', async (path, title) => {
    expect(await renderAppAt(path)).toHaveTextContent(title);
  });

  it('the privacy policy describes the services and data flows in the code', async () => {
    await renderAppAt('/privacy');
    const text = document.body.textContent ?? '';
    for (const provider of providersCalledByCode()) expect(text, provider).toContain(provider);
    for (const fact of [
      'Supabase',
      'Cloudflare',
      'gmail.readonly',
      'Limited Use',
      'Australian Privacy Principles',
      'Privacy (Tax File Number) Rule 2015',
      'How long we keep it',
      'oaic.gov.au',
      '1300 363 992',
      'does not lodge anything with the ATO',
    ]) {
      expect(text, fact).toContain(fact);
    }
  });

  it('marks missing business details visibly and shows the documents are drafts', async () => {
    await renderAppAt('/terms');
    expect(screen.getByRole('note', { name: /draft notice/i })).toHaveTextContent(
      /draft awaiting legal review/i,
    );
    const markers = Array.from(document.querySelectorAll('mark.legal-tbc')).map(
      (m) => m.textContent ?? '',
    );
    expect(markers.some((m) => /legal entity name/.test(m))).toBe(true);
    expect(markers.some((m) => /\bABN\b/.test(m))).toBe(true);
    expect(markers.every((m) => m.startsWith('[To be confirmed by Looplet:'))).toBe(true);
    // No invented ABN or ACN anywhere in the documents' source.
    const source = readFileSync('src/pages/Legal.tsx', 'utf8');
    expect(source).not.toMatch(/\b\d{2} ?\d{3} ?\d{3} ?\d{3}\b/);
  });

  it('sign-in and sign-up link to all three documents', () => {
    for (const page of [<LoginPage key="login" />, <SignupPage key="signup" />]) {
      const { unmount } = render(
        <AuthContext.Provider
          value={{
            user: null,
            session: null,
            loading: false,
            signIn: vi.fn(),
            signInWithGoogle: vi.fn(),
            signUp: vi.fn(),
            resetPassword: vi.fn(),
            setPassword: vi.fn(),
            signOut: vi.fn(),
          }}
        >
          <MemoryRouter>{page}</MemoryRouter>
        </AuthContext.Provider>,
      );
      const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
      expect(hrefs).toEqual(expect.arrayContaining(['/privacy', '/terms', '/collection-notice']));
      unmount();
    }
  });

  it('sign-up needs the box ticked, and saves the acceptance on the new account', async () => {
    const value = renderWithAuth(<SignupPage />);
    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: 'owner@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/^password/i), {
      target: { value: 'long-enough-password' },
    });

    const form = screen.getByRole('button', { name: /create account/i }).closest('form');
    if (!form) throw new Error('sign-up form not found');
    fireEvent.submit(form);
    expect(await screen.findByRole('alert')).toHaveTextContent(/agree to the terms of service/i);
    expect(value.signUp).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox', { name: /i agree to the terms of service/i }));
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => expect(value.signUp).toHaveBeenCalledTimes(1));
    const [email, password, metadata] = (value.signUp as Mock).mock.calls[0] as [
      string,
      string,
      { legal_acceptance: Record<string, string> },
    ];
    expect([email, password]).toEqual(['owner@example.com', 'long-enough-password']);
    expect(metadata.legal_acceptance).toMatchObject({
      terms_version: LEGAL_VERSIONS.terms,
      privacy_version: LEGAL_VERSIONS.privacy,
      collection_notice_version: LEGAL_VERSIONS.collectionNotice,
      method: 'signup_checkbox',
    });
    expect(Number.isNaN(Date.parse(metadata.legal_acceptance.accepted_at ?? ''))).toBe(false);
  });

  it('the email sign-up passes the acceptance to Supabase as user metadata', async () => {
    const signUp = vi.fn().mockResolvedValue({ data: { session: null }, error: null });
    (supabase.auth as unknown as { signUp: Mock }).signUp = signUp;
    let captured: AuthContextValue | undefined;
    function Capture() {
      return (
        <AuthContext.Consumer>
          {(ctx) => {
            captured = ctx;
            return null;
          }}
        </AuthContext.Consumer>
      );
    }
    render(
      <AuthProvider>
        <Capture />
      </AuthProvider>,
    );
    await waitFor(() => expect(captured).toBeDefined());
    if (!captured) throw new Error('auth context not captured');
    await captured.signUp('owner@example.com', 'long-enough-password', {
      legal_acceptance: { terms_version: LEGAL_VERSIONS.terms },
    });
    expect(signUp).toHaveBeenCalledWith({
      email: 'owner@example.com',
      password: 'long-enough-password',
      options: { data: { legal_acceptance: { terms_version: LEGAL_VERSIONS.terms } } },
    });
  });

  it('continuing with Google records the acceptance when Google sends the user back', async () => {
    renderWithAuth(<LoginPage />);
    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));
    expect(sessionStorage.getItem(PENDING_GOOGLE_ACCEPTANCE_KEY)).toBe('google_continue');

    (supabase.auth.getSession as Mock).mockResolvedValueOnce({
      data: { session: { user: { id: 'user-1', email: 'owner@example.com', user_metadata: {} } } },
      error: null,
    });
    render(
      <AuthProvider>
        <div />
      </AuthProvider>,
    );
    await waitFor(() => expect(supabase.auth.updateUser).toHaveBeenCalledTimes(1));
    const [{ data }] = (supabase.auth.updateUser as Mock).mock.calls[0] as [
      { data: { legal_acceptance: Record<string, string> } },
    ];
    expect(data.legal_acceptance).toMatchObject({
      terms_version: LEGAL_VERSIONS.terms,
      method: 'google_continue',
    });
    expect(sessionStorage.getItem(PENDING_GOOGLE_ACCEPTANCE_KEY)).toBeNull();
  });

  it('the app footer links to the documents', () => {
    const source = readFileSync('src/components/Layout.tsx', 'utf8');
    expect(source).toMatch(/<LegalLinks compact \/>/);
    render(
      <MemoryRouter>
        <Routes>
          <Route path="*" element={<FooterProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    const nav = screen.getByRole('navigation', { name: /legal/i });
    expect(within(nav).getByRole('link', { name: /privacy/i })).toHaveAttribute('href', '/privacy');
    expect(within(nav).getByRole('link', { name: /terms/i })).toHaveAttribute('href', '/terms');
    expect(within(nav).getByRole('link', { name: /collection/i })).toHaveAttribute(
      'href',
      '/collection-notice',
    );
  });
});

function FooterProbe() {
  return <LegalLinks compact />;
}
