import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { BrandHeader } from '@/components/BrandHeader';

/**
 * Turn raw Supabase auth errors into something a signing-up user can act on.
 * The most common one in practice is the email-send rate limit (HTTP 429,
 * `over_email_send_rate_limit`) — the verbatim message reads like a system
 * fault, so soften it and tell them what to do.
 */
function friendlySignupError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('rate limit') || m.includes('too many') || m.includes('over_email')) {
    return "We're getting a lot of sign-ups right now. Please wait a minute and try again.";
  }
  if (
    m.includes('already registered') ||
    m.includes('already been') ||
    m.includes('user already')
  ) {
    return 'An account with this email already exists — try signing in instead.';
  }
  return message;
}

export function SignupPage() {
  const { signUp } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error, needsEmailConfirmation } = await signUp(email, password);
    setBusy(false);
    if (error) {
      setError(friendlySignupError(error.message));
      return;
    }
    if (needsEmailConfirmation) {
      setDone(true);
      return;
    }
    navigate('/');
  };

  const contentElement = done ? (
    <div className="auth-panel auth-panel--center glass-panel animated-fade-in">
      <div className="auth-confirm-icon" aria-hidden="true">
        ✓
      </div>
      <h2 className="auth-heading">Account created</h2>
      <p className="auth-copy">
        Check your email to confirm your address, then sign in.
      </p>
      <Link
        to="/login"
        className="btn btn-primary"
      >
        Back to sign in
      </Link>
    </div>
  ) : (
    <div className="auth-panel glass-panel animated-fade-in">
      <BrandHeader />

      <h2 className="auth-heading">Create your account</h2>

      <form className="auth-form" onSubmit={onSubmit}>
        <div className="form-group">
          <label className="form-label" htmlFor="signup-email">
            Email Address
          </label>
          <input
            id="signup-email"
            type="email"
            className="form-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            placeholder="name@company.com"
          />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="signup-password">
            Password
          </label>
          <input
            id="signup-password"
            type="password"
            className="form-input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            placeholder="Min. 8 characters"
          />
        </div>

        {error && (
          <div
            className="auth-alert badge badge-danger"
            role="alert"
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="btn btn-primary"
        >
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </form>

      <div className="auth-footer">
        Already have an account?{' '}
        <Link to="/login">
          Sign in
        </Link>
      </div>
    </div>
  );

  return (
    <div className="auth-shell">
      {contentElement}
    </div>
  );
}
