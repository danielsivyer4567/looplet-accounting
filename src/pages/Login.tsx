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
      <div
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

        <form
          onSubmit={onSubmit}
          style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}
        >
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Email Address</label>
            <input
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
                <label className="form-label">Password</label>
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
      </div>
    </div>
  );
}
