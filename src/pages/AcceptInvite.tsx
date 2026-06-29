import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { useOrg } from '@/hooks/useOrg';
import { BrandHeader } from '@/components/BrandHeader';

/**
 * Public landing page for team/accountant invitations.
 *
 * A Supabase invite email (`inviteUserByEmail` with redirectTo=/accept-invite)
 * signs the invitee in passwordless via the link's access token, so by the time
 * this page mounts the user usually already has a session. We then let a NEW
 * user choose a password before redeeming their pending invites, while an
 * EXISTING user (already has a password) can skip straight to accepting.
 *
 * Redemption itself is the `accept_pending_invites()` RPC (migration 0199),
 * which matches pending, unexpired invitations to the caller's verified email
 * and creates/accepts the membership rows. An empty result means there was
 * nothing to accept — i.e. the invite already lapsed or was already used.
 */
type Phase = 'checking' | 'form' | 'no-session' | 'working' | 'no-invites';

export function AcceptInvitePage() {
  const { setPassword } = useAuth();
  const { refresh } = useOrg();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const hasToken = Boolean(params.get('token'));

  const [phase, setPhase] = useState<Phase>('checking');
  const [password, setPwd] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The invite link's tokens are parsed asynchronously by supabase-js
  // (detectSessionInUrl), so the session may not be present on the very first
  // getSession() — also listen for the SIGNED_IN event to catch it arriving.
  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(({ data: { session } }) => {
      if (!active) return;
      setPhase((p) => (p === 'checking' ? (session ? 'form' : 'no-session') : p));
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      if (session) setPhase((p) => (p === 'checking' || p === 'no-session' ? 'form' : p));
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const acceptInvites = useCallback(async () => {
    const { data, error: rpcError } = await supabase.rpc('accept_pending_invites');
    if (rpcError) {
      setError(rpcError.message);
      setPhase('form');
      return;
    }
    const orgIds = (data as string[] | null) ?? [];
    if (orgIds.length === 0) {
      setPhase('no-invites');
      return;
    }
    await refresh();
    navigate('/clients', { replace: true });
  }, [refresh, navigate]);

  // Redeem the invite. A new user passes a password to set first; an existing
  // user (who already has one) skips that step and accepts as-is.
  const accept = async (newPassword?: string) => {
    setBusy(true);
    setError(null);
    if (newPassword !== undefined) {
      const { error: pwError } = await setPassword(newPassword);
      if (pwError) {
        setBusy(false);
        setError(pwError.message);
        return;
      }
    }
    setPhase('working');
    await acceptInvites();
    setBusy(false);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void accept(password);
  };

  const renderMessage = (
    title: string,
    body: React.ReactNode,
    link: { to: string; label: string },
  ) => (
    <div style={{ textAlign: 'center' }}>
      <h2 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>{title}</h2>
      <p
        style={{
          color: 'var(--text-body)',
          fontSize: '0.9rem',
          lineHeight: 1.5,
          marginBottom: '1.5rem',
        }}
      >
        {body}
      </p>
      <Link
        to={link.to}
        className="btn btn-primary"
        style={{ width: '100%', textDecoration: 'none' }}
      >
        {link.label}
      </Link>
    </div>
  );

  let content: React.ReactNode;
  if (phase === 'checking' || phase === 'working') {
    content = (
      <p style={{ color: 'var(--text-body)', textAlign: 'center' }}>
        {phase === 'checking' ? 'Checking your invitation…' : 'Accepting your invitation…'}
      </p>
    );
  } else if (phase === 'no-session') {
    content = renderMessage(
      'Invitation link expired',
      hasToken
        ? 'Your invitation link could not sign you in. If you already have an account, sign in and your invitation will be applied automatically.'
        : 'This invitation link is invalid or has expired. Ask your client to send a new invitation, or sign in if you already have an account.',
      { to: '/login', label: 'Go to sign in' },
    );
  } else if (phase === 'no-invites') {
    content = renderMessage(
      'No pending invitation',
      <>
        We couldn&apos;t find a pending invitation for your account — it may have already been
        accepted or expired.
      </>,
      { to: '/', label: 'Continue' },
    );
  } else {
    content = (
      <>
        <BrandHeader />
        <h2 style={{ fontSize: '1.25rem', marginBottom: '0.5rem', textAlign: 'center' }}>
          Accept your invitation
        </h2>
        <p
          style={{
            color: 'var(--text-muted)',
            fontSize: '0.875rem',
            textAlign: 'center',
            marginBottom: '1.5rem',
          }}
        >
          Choose a password to finish setting up your account.
        </p>

        <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label" htmlFor="accept-password">
              Password
            </label>
            <input
              id="accept-password"
              type="password"
              className="form-input"
              value={password}
              onChange={(e) => setPwd(e.target.value)}
              required
              minLength={8}
              placeholder="Min. 8 characters"
            />
          </div>

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

          <button
            type="submit"
            disabled={busy}
            className="btn btn-primary"
            style={{ width: '100%', padding: '0.625rem', marginTop: '0.5rem' }}
          >
            {busy ? 'Setting up…' : 'Set password & accept'}
          </button>
        </form>

        <div
          style={{
            marginTop: '1.5rem',
            textAlign: 'center',
            fontSize: '0.875rem',
            color: 'var(--text-muted)',
          }}
        >
          Already have a password?{' '}
          <button
            type="button"
            onClick={() => void accept()}
            disabled={busy}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--accent-primary)',
              cursor: 'pointer',
              fontWeight: 600,
              padding: 0,
            }}
          >
            Accept without changing it
          </button>
        </div>
      </>
    );
  }

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
        {content}
      </div>
    </div>
  );
}
