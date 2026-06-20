import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';

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
    const { error } = await signUp(email, password);
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    // After email confirmation flow, user lands back via callback.
    // For dev with confirm-email off, navigate straight to dashboard.
    setDone(true);
    setTimeout(() => navigate('/'), 1500);
  };

  if (done) {
    return (
      <div style={{ maxWidth: 400, margin: '4rem auto', padding: '2rem' }}>
        <h2>Account created</h2>
        <p>Check your email to confirm. Then sign in.</p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 400, margin: '4rem auto', padding: '2rem' }}>
      <h1>Looplet Accounting</h1>
      <h2>Create account</h2>
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
            minLength={8}
            style={{ width: '100%', padding: '0.5rem' }}
          />
        </label>
        {error && <p style={{ color: 'salmon' }}>{error}</p>}
        <button type="submit" disabled={busy} style={{ padding: '0.5rem 1rem' }}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </form>
      <p>
        Already have an account? <Link to="/login">Sign in</Link>
      </p>
    </div>
  );
}
