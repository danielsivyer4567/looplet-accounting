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
  if (m.includes('already registered') || m.includes('already been') || m.includes('user already')) {
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
    <div className="glass-panel animated-fade-in" style={{ maxWidth: '420px', width: '100%', padding: '2.5rem 2rem', boxSizing: 'border-box', textAlign: 'center' }}>
      <div 
        style={{ 
          width: '48px', 
          height: '48px', 
          borderRadius: '50%', 
          background: 'var(--bg-success-subtle)',
          color: 'var(--text-success)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '24px',
          marginBottom: '1rem'
        }}
      >
        ✓
      </div>
      <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>Account created</h2>
      <p style={{ color: 'var(--text-body)', fontSize: '0.9rem', lineHeight: '1.5', marginBottom: '1.5rem' }}>
        Check your email to confirm your address, then sign in.
      </p>
      <Link to="/login" className="btn btn-primary" style={{ width: '100%', textDecoration: 'none' }}>
        Back to sign in
      </Link>
    </div>
  ) : (
    <div 
      className="glass-panel animated-fade-in" 
      style={{ 
        maxWidth: '420px', 
        width: '100%', 
        padding: '2.5rem 2rem',
        boxSizing: 'border-box'
      }}
    >
      <BrandHeader />

      <h2 style={{ fontSize: '1.25rem', marginBottom: '1.5rem', textAlign: 'center' }}>
        Create your account
      </h2>

      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
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

        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Password</label>
          <input
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
          <div className="badge badge-danger" style={{ width: '100%', padding: '0.625rem', textAlign: 'center', justifyContent: 'center' }}>
            {error}
          </div>
        )}

        <button 
          type="submit" 
          disabled={busy} 
          className="btn btn-primary"
          style={{ width: '100%', padding: '0.625rem', marginTop: '0.5rem' }}
        >
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </form>

      <div style={{ marginTop: '1.75rem', textAlign: 'center', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
        Already have an account?{' '}
        <Link to="/login" style={{ fontWeight: 600 }}>
          Sign in
        </Link>
      </div>
    </div>
  );

  return (
    <div 
      style={{ 
        minHeight: '100vh', 
        width: '100vw', 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        background: 'radial-gradient(circle at 10% 20%, rgba(99, 102, 241, 0.15) 0%, rgba(0,0,0,0) 90%), var(--bg-app)',
        padding: '1.5rem',
        boxSizing: 'border-box',
        position: 'fixed',
        top: 0,
        left: 0,
        overflowY: 'auto'
      }}
    >
      {contentElement}
    </div>
  );
}
