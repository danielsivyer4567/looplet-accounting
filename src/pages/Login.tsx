import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Globe } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { BrandHeader } from '@/components/BrandHeader';

export function LoginPage() {
  const { user, signIn, signInWithGoogle, resetPassword } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'signin' | 'reset'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);

  useEffect(() => {
    if (user) navigate('/');
  }, [navigate, user]);

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

  const onGoogleSignIn = async () => {
    setGoogleBusy(true);
    setError(null);
    setNotice(null);
    const { error } = await signInWithGoogle();
    if (error) {
      setError(error.message);
      setGoogleBusy(false);
    }
  };

  const isReset = mode === 'reset';

  return (
    <div
      style={{
        minHeight: '100vh',
        width: '100vw',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background:
          'radial-gradient(circle at 10% 20%, rgba(99, 102, 241, 0.15) 0%, rgba(0,0,0,0) 90%), var(--bg-app)',
        padding: '1.5rem',
        boxSizing: 'border-box',
        position: 'fixed',
        top: 0,
        left: 0,
        overflowY: 'auto',
      }}
    >
      <a href="#login-main" className="skip-link">
        Skip to sign-in form
      </a>
      <main
        id="login-main"
        className="glass-panel animated-fade-in"
        style={{
          maxWidth: '420px',
          width: '100%',
          padding: '2.5rem 2rem',
          boxSizing: 'border-box',
        }}
      >
        <BrandHeader />

        <h2 style={{ fontSize: '1.25rem', marginBottom: '1.5rem', textAlign: 'center' }}>
          {isReset ? 'Reset password' : 'Sign in to your account'}
        </h2>

        {!isReset && (
          <>
            <button
              type="button"
              onClick={onGoogleSignIn}
              disabled={busy || googleBusy}
              className="btn"
              style={{
                width: '100%',
                padding: '0.625rem',
                marginBottom: '1rem',
                border: '1px solid var(--border-subtle)',
                background: 'var(--bg-card)',
                color: 'var(--text-title)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
              }}
            >
              <Globe size={16} aria-hidden="true" />
              {googleBusy ? 'Opening Google…' : 'Continue with Google'}
            </button>
            <div
              aria-hidden="true"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.75rem',
                marginBottom: '1rem',
                color: 'var(--text-muted)',
                fontSize: '0.75rem',
              }}
            >
              <span style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
              <span>Email</span>
              <span style={{ flex: 1, height: 1, background: 'var(--border-subtle)' }} />
            </div>
          </>
        )}

        <form
          onSubmit={onSubmit}
          style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}
        >
          <div className="form-group" style={{ marginBottom: 0 }}>
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
            <div className="form-group" style={{ marginBottom: 0 }}>
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
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
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--accent-primary)',
                    cursor: 'pointer',
                    fontSize: '0.775rem',
                    fontWeight: 600,
                    padding: 0,
                  }}
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

          <div role="status" aria-live="polite">
            {error && (
              <div
                className="badge badge-danger"
                style={{
                  width: '100%',
                  padding: '0.625rem',
                  textAlign: 'center',
                  justifyContent: 'center',
                }}
              >
                {error}
              </div>
            )}
            {notice && (
              <div
                className="badge badge-success"
                style={{
                  width: '100%',
                  padding: '0.625rem',
                  textAlign: 'center',
                  justifyContent: 'center',
                  textTransform: 'none',
                }}
              >
                {notice}
              </div>
            )}
          </div>

          <button
            type="submit"
            disabled={busy}
            className="btn btn-primary"
            style={{ width: '100%', padding: '0.625rem', marginTop: '0.5rem' }}
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

        <div
          style={{
            marginTop: '1.75rem',
            textAlign: 'center',
            fontSize: '0.875rem',
            color: 'var(--text-muted)',
          }}
        >
          {isReset ? (
            <button
              type="button"
              onClick={() => {
                setMode('signin');
                setError(null);
                setNotice(null);
              }}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--accent-primary)',
                cursor: 'pointer',
                fontWeight: 600,
                padding: 0,
              }}
            >
              ← Back to sign in
            </button>
          ) : (
            <>
              New here?{' '}
              <Link to="/signup" style={{ fontWeight: 600 }}>
                Create an account
              </Link>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
