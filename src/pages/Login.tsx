import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';

export function LoginPage() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await signIn(email, password);
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    navigate('/');
  };

  return (
    <div style={{ maxWidth: 400, margin: '4rem auto', padding: '2rem' }}>
      <h1>Looplet Accounting</h1>
      <h2>Sign in</h2>
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
        {error && <p style={{ color: 'salmon' }}>{error}</p>}
        <button type="submit" disabled={busy} style={{ padding: '0.5rem 1rem' }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p>
        New here? <Link to="/signup">Create an account</Link>
      </p>
    </div>
  );
}
