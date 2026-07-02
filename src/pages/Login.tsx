import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { BrandHeader } from '@/components/BrandHeader';

export function LoginPage() {
  const { signIn, resetPassword } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'signin' | 'reset'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);

    if (mode === 'reset') {
      const { error } = await resetPassword(email);
      setBusy(false);
      if (error) {
        setError(error.message);
        return;
      }
      setNotice('If an account exists for that email, a reset link is on its way.');
      return;
    }

    const { error } = await signIn(email, password);
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    navigate('/');
  };

  const isReset = mode === 'reset';

  return (
    <div className="auth-shell">
      <div className="auth-panel glass-panel animated-fade-in">
        <BrandHeader />

        <h2 className="auth-heading">
          {isReset ? 'Reset password' : 'Sign in to your account'}
        </h2>

        <form className="auth-form" onSubmit={onSubmit}>
          <div className="form-group">
            <label className="form-label" htmlFor="login-email">
              Email Address
            </label>
            <input
              id="login-email"
              type="email"
              className="form-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="name@company.com"
            />
          </div>

          {!isReset && (
            <div className="form-group">
              <div className="auth-row-between">
                <label className="form-label" htmlFor="login-password">
                  Password
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setMode('reset');
                    setError(null);
                    setNotice(null);
                  }}
                  className="auth-inline-button"
                >
                  Forgot password?
                </button>
              </div>
              <input
                id="login-password"
                type="password"
                className="form-input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                placeholder="••••••••"
              />
            </div>
          )}

          {error && (
            <div
              className="auth-alert badge badge-danger"
              role="alert"
            >
              {error}
            </div>
          )}
          {notice && (
            <div
              className="auth-alert auth-alert--plain badge badge-success"
              role="status"
            >
              {notice}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="btn btn-primary"
          >
            {busy
              ? isReset
                ? 'Sending…'
                : 'Signing in…'
              : isReset
                ? 'Send reset link'
                : 'Sign in'}
          </button>
        </form>

        <div className="auth-footer">
          {isReset ? (
            <button
              type="button"
              onClick={() => {
                setMode('signin');
                setError(null);
                setNotice(null);
              }}
              className="auth-inline-button"
            >
              ← Back to sign in
            </button>
          ) : (
            <>
              New here?{' '}
              <Link to="/signup">
                Create an account
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
