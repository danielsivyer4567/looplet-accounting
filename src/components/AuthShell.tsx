import { useContext, type ReactNode } from 'react';
import { BrandLogo } from './BrandLogo';
import { ThemeContext } from '@/contexts/theme-context';

/**
 * Page frame for the sign-in, sign-up and invitation screens, matching the Looplet sign-in theme: a top bar with the
 * "L" mark and a light/dark switch, a short introduction beside the form card, and a quiet footer. The card itself
 * (`.auth-panel`) is passed as children so each screen keeps its own form logic.
 */
export function AuthShell({ children }: { children: ReactNode }) {
  // Optional: screens rendered without a ThemeProvider (for example in tests) simply omit the switch.
  const themeContext = useContext(ThemeContext);
  return (
    <div className="auth-shell">
      <header className="auth-topbar">
        <div className="auth-topbar__brand">
          <BrandLogo size={36} glow={false} />
          <span className="auth-topbar__wordmark">looplet</span>
          <span className="auth-topbar__product">Accounting</span>
        </div>
        {themeContext && (
          <div className="auth-theme-switch" role="group" aria-label="Colour theme">
            {(['light', 'dark'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={themeContext.theme === mode}
                onClick={() => themeContext.setTheme(mode)}
              >
                {mode === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
        )}
      </header>
      <div className="auth-layout">
        <section className="auth-intro" aria-label="About Looplet Accounting">
          <p className="auth-eyebrow">Your business, in focus</p>
          <h1 className="auth-intro__title">
            A clearer picture.
            <br />A trusted way in.
          </h1>
          <p className="auth-intro__lead">
            Job-costed AP/AR for trades businesses. One place to see the money, understand the work
            and decide what comes next.
          </p>
          <div className="auth-intro__note">
            <span aria-hidden="true">✓</span>
            <div>
              <strong>Your books stay exactly as they are.</strong>
              <p>Sign in to pick up your organisations, jobs and records where you left them.</p>
            </div>
          </div>
        </section>
        <div className="auth-card-column">{children}</div>
      </div>
      <footer className="auth-bottombar">
        <span>Looplet Accounting</span>
        <span>Secure sign-in · Your data stays yours</span>
      </footer>
    </div>
  );
}
