import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '@/contexts/auth-context';
import { LoginPage } from '@/pages/Login';
import { SignupPage } from '@/pages/Signup';

function renderAuthPage(element: React.ReactElement, overrides: Partial<AuthContextValue> = {}) {
  const authValue: AuthContextValue = {
    user: null,
    session: null,
    loading: false,
    signIn: vi.fn().mockResolvedValue({ error: null }),
    signInWithGoogle: vi.fn().mockResolvedValue({ error: null }),
    signUp: vi.fn().mockResolvedValue({ error: null, needsEmailConfirmation: false }),
    resetPassword: vi.fn().mockResolvedValue({ error: null }),
    setPassword: vi.fn().mockResolvedValue({ error: null }),
    signOut: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };

  return {
    authValue,
    ...render(
      <AuthContext.Provider value={authValue}>
        <MemoryRouter>{element}</MemoryRouter>
      </AuthContext.Provider>,
    ),
  };
}

describe('Auth mobile layout', () => {
  it('renders login in the responsive auth shell without fixed inline viewport styles', () => {
    renderAuthPage(<LoginPage />);

    const heading = screen.getByRole('heading', { name: /welcome back/i });
    const shell = heading.closest('.auth-shell');
    const panel = heading.closest('.auth-panel');

    expect(shell).toBeInTheDocument();
    expect(shell).not.toHaveAttribute('style');
    expect(panel).toBeInTheDocument();
    expect(panel).not.toHaveAttribute('style');
    expect(screen.getByRole('img', { name: /looplet logo/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toHaveClass('btn', 'btn-primary');
  });

  it('keeps reset-password mode inside the same mobile-safe auth shell', () => {
    renderAuthPage(<LoginPage />);

    fireEvent.click(screen.getByRole('button', { name: /forgot password/i }));

    const heading = screen.getByRole('heading', { name: /reset password/i });
    expect(heading.closest('.auth-shell')).toBeInTheDocument();
    expect(heading.closest('.auth-panel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send reset link/i })).toHaveClass(
      'btn',
      'btn-primary',
    );
    expect(screen.getByRole('button', { name: /back to sign in/i })).toHaveClass(
      'auth-inline-button',
    );
  });

  it('renders signup and confirmation states in the responsive auth panel', async () => {
    const signUp = vi.fn().mockResolvedValue({ error: null, needsEmailConfirmation: true });
    renderAuthPage(<SignupPage />, { signUp });

    const createHeading = screen.getByRole('heading', { name: /create your account/i });
    expect(createHeading.closest('.auth-shell')).toBeInTheDocument();
    expect(createHeading.closest('.auth-panel')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/email address/i), {
      target: { value: 'owner@example.com' },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'long-enough-password' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /i agree to the terms of service/i }));
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() =>
      expect(signUp).toHaveBeenCalledWith(
        'owner@example.com',
        'long-enough-password',
        expect.objectContaining({ legal_acceptance: expect.any(Object) }),
      ),
    );

    const doneHeading = screen.getByRole('heading', { name: /account created/i });
    expect(doneHeading.closest('.auth-panel')).toHaveClass('auth-panel--center');
    expect(screen.getByRole('link', { name: /back to sign in/i })).toHaveClass(
      'btn',
      'btn-primary',
    );
  });

  it('keeps auth-specific small-screen rules in the global CSS contract', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
    const mobileBlock = css.slice(css.indexOf('@media (max-width: 768px)'));

    expect(css).toMatch(/\.auth-shell\s*\{[\s\S]*min-height:\s*100dvh/);
    expect(css).toMatch(/\.auth-panel\s*\{[\s\S]*width:\s*min\(100%, 480px\)/);
    expect(mobileBlock).toMatch(/\.auth-shell\s*\{[\s\S]*align-items:\s*flex-start/);
    expect(mobileBlock).toMatch(/\.auth-panel\s*\{[\s\S]*padding:\s*1\.5rem 1rem/);
    expect(mobileBlock).toMatch(/\.auth-row-between\s*\{[\s\S]*flex-direction:\s*column/);
  });
});
