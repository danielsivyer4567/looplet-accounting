import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';

/**
 * XeroCallbackPage — handles the OAuth redirect from Xero's authorization server.
 *
 * Xero redirects to /settings/xero-callback?code=...&state=...
 * This page:
 *   1. Validates the state matches what we stored in sessionStorage
 *   2. POSTs code + redirect_uri to xero-oauth-callback edge fn
 *   3. On success, navigates to /settings#xero-connected (triggers flash in XeroConnect)
 */
export function XeroCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { currentOrg } = useOrg();
  const [status, setStatus] = useState('Connecting to Xero…');
  const [error, setError] = useState<string | null>(null);

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

    // Validate state against sessionStorage to prevent CSRF
    const storedState = sessionStorage.getItem('xero_oauth_state');
    if (storedState && state !== storedState) {
      setError('State mismatch — possible CSRF attempt. Please try connecting again.');
      return;
    }
    sessionStorage.removeItem('xero_oauth_state');

    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error('Not signed in');

        const redirect_uri = `${window.location.origin}/settings/xero-callback`;
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
            background: '#3d1818',
            color: '#e9a3a3',
            borderRadius: 4,
            fontSize: 13,
            maxWidth: 600,
          }}
        >
          <strong>Connection failed</strong>
          <div style={{ marginTop: 8 }}>{error}</div>
          <div style={{ marginTop: 12 }}>
            <a href="/settings" style={{ color: '#86c7a3', fontSize: 12 }}>
              &larr; Back to Settings
            </a>
          </div>
        </div>
      ) : (
        <p style={{ color: '#888' }}>{status}</p>
      )}
    </section>
  );
}
