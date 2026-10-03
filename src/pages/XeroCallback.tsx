import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { consumeOAuthState } from '@/lib/oauthState';
import { useOrg } from '@/hooks/useOrg';

/**
 * XeroCallbackPage — handles the OAuth redirect from Xero's authorization server.
 *
 * Xero redirects to /settings/xero-callback?code=...&state=...
 * This page:
 *   1. Requires the state to match the one this tab stored when it started
 *      the connection (a missing stored state is refused, not skipped)
 *   2. POSTs code + redirect_uri to xero-oauth-callback edge fn
 *   3. On success, navigates to /settings#xero-connected (triggers flash in XeroConnect)
 */
export function XeroCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { currentOrg } = useOrg();
  const [status, setStatus] = useState('Connecting to Xero…');
  const [error, setError] = useState<string | null>(null);
  // The code and state are single-use: handle the redirect once, even when the effect re-runs (StrictMode, org reload).
  const handled = useRef(false);

  useEffect(() => {
    const code = params.get('code');
    const state = params.get('state');
    const errParam = params.get('error');
    const errDescription = params.get('error_description');

    if (errParam) {
      setError(`Xero returned error: ${errParam}${errDescription ? ` — ${errDescription}` : ''}`);
      return;
    }

    if (!code || !state) {
      setError('Missing code or state parameter from Xero redirect.');
      return;
    }

    if (!currentOrg) {
      // OrgContext may not have loaded yet; the effect will re-run when it does
      return;
    }

    if (handled.current) return;
    handled.current = true;

    // CSRF guard: only finish a connection this tab started.
    const stateCheck = consumeOAuthState('xero_oauth_state', state);
    if (!stateCheck.ok) {
      setError(stateCheck.error);
      return;
    }

    (async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) throw new Error('Not signed in');

        const redirect_uri =
          import.meta.env.VITE_XERO_REDIRECT_URI ||
          `${window.location.origin}/settings/xero-callback`;
        const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/xero-oauth-callback`;
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({
            organization_id: currentOrg.id,
            code,
            redirect_uri,
            state,
          }),
        });

        const body = await res.json();
        if (!res.ok || !body.ok) throw new Error(body.error ?? `${res.status}`);

        setStatus(`Connected ${body.tenant?.name ?? 'Xero'}. Redirecting…`);
        setTimeout(() => navigate('/settings#xero-connected'), 1200);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [params, currentOrg, navigate]);

  return (
    <section>
      <h1>Xero connection</h1>
      {error ? (
        <div
          style={{
            padding: '1rem',
            background: 'var(--bg-danger-subtle)',
            color: 'var(--text-danger)',
            borderRadius: 4,
            fontSize: 13,
            maxWidth: 600,
          }}
        >
          <strong>Connection failed</strong>
          <div style={{ marginTop: 8 }}>{error}</div>
          <div style={{ marginTop: 12 }}>
            <a href="/settings" style={{ color: 'var(--text-success)', fontSize: 12 }}>
              &larr; Back to Settings
            </a>
          </div>
        </div>
      ) : (
        <p style={{ color: 'var(--text-muted)' }}>{status}</p>
      )}
    </section>
  );
}
