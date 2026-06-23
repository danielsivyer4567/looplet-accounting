import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';

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
    <div style={{ maxWidth: 400, margin: '4rem auto', padding: '2rem' }}>
      <h1>Looplet Accounting</h1>
      <h2>{isReset ? 'Reset password' : 'Sign in'}</h2>
      <form onSubmit={onSubmit}>
        <label style={{ display: 'block', marginBottom: '1rem' }}>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={{ width: '100%', padding: '0.5rem' }}
          />
        </label>
        {!isReset && (
          <label style={{ display: 'block', marginBottom: '1rem' }}>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={{ width: '100%', padding: '0.5rem' }}
            />
          </label>
        )}
        {error && <p style={{ color: 'salmon' }}>{error}</p>}
        {notice && <p style={{ color: '#86c7a3' }}>{notice}</p>}
        <button type="submit" disabled={busy} style={{ padding: '0.5rem 1rem' }}>
          {busy
            ? isReset
              ? 'Sending…'
              : 'Signing in…'
            : isReset
              ? 'Send reset link'
              : 'Sign in'}
        </button>
      </form>
      <p>
        <button
          type="button"
          onClick={() => {
            setMode(isReset ? 'signin' : 'reset');
            setError(null);
            setNotice(null);
          }}
          style={{
            background: 'none',
            border: 'none',
            color: '#5096d8',
            padding: 0,
            cursor: 'pointer',
            textDecoration: 'underline',
            font: 'inherit',
          }}
        >
          {isReset ? '← Back to sign in' : 'Forgot password?'}
        </button>
      </p>
      <p>
        New here? <Link to="/signup">Create an account</Link>
      </p>
    </div>
  );
}
