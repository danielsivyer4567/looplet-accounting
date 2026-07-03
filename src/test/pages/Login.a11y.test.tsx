/**
 * Accessibility tests for src/pages/Login.tsx
 *
 * Strategy:
 * - Mock @/hooks/useAuth so signIn/resetPassword are controllable without a
 *   real Supabase client — these tests are about a11y wiring, not auth.
 * - Render inside a MemoryRouter because the page uses <Link>/useNavigate.
 *
 * Covers the slice's a11y requirements: labels are programmatically associated
 * with their inputs (getByLabelText resolves), a skip-link points at the main
 * content landmark, and an aria-live region announces login errors/status.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as ReactRouterDom from 'react-router-dom';
import { LoginPage } from '@/pages/Login';

const signInMock = vi.fn();
const signInWithGoogleMock = vi.fn();
const resetPasswordMock = vi.fn();

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: null,
    signIn: signInMock,
    signInWithGoogle: signInWithGoogleMock,
    resetPassword: resetPasswordMock,
  }),
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig<typeof ReactRouterDom>();
  return { ...actual, useNavigate: () => navigateMock };
});

function renderPage() {
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
}

describe('LoginPage accessibility', () => {
  beforeEach(() => {
    signInMock.mockReset();
    signInWithGoogleMock.mockReset();
    resetPasswordMock.mockReset();
    navigateMock.mockReset();
  });

  it('associates the email label with its input', () => {
    renderPage();
    const email = screen.getByLabelText(/email address/i);
    expect(email).toBeInstanceOf(HTMLInputElement);
    expect(email).toHaveAttribute('type', 'email');
    expect(email).toHaveAttribute('id', 'login-email');
  });

  it('associates the password label with its input', () => {
    renderPage();
    const password = screen.getByLabelText(/^password$/i);
    expect(password).toBeInstanceOf(HTMLInputElement);
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('id', 'login-password');
  });

  it('renders a skip-link that targets the main content landmark', () => {
    renderPage();
    const skip = screen.getByRole('link', { name: /skip to sign-in form/i });
    expect(skip).toHaveAttribute('href', '#login-main');

    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'login-main');
  });

  it('exposes an aria-live region for status/error announcements', () => {
    renderPage();
    const live = screen.getByRole('status');
    expect(live).toHaveAttribute('aria-live', 'polite');
  });

  it('offers Google sign-in as an OAuth action', async () => {
    signInWithGoogleMock.mockResolvedValue({ error: null });
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: /continue with google/i }));

    await waitFor(() => expect(signInWithGoogleMock).toHaveBeenCalledTimes(1));
  });

  it('announces sign-in errors via the live region', async () => {
    signInMock.mockResolvedValue({ error: { message: 'Invalid login credentials' } });
    renderPage();

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: 'user@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/^password$/i), {
      target: { value: 'wrong-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^sign in$/i }));

    const live = screen.getByRole('status');
    await waitFor(() => expect(live).toHaveTextContent(/invalid login credentials/i));
  });
});
