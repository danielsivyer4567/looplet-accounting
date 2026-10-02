import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

export function GmailCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { currentOrg } = useOrg();
  const [status, setStatus] = useState('Connecting…');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = params.get('code');
    const state = params.get('state');
    const errParam = params.get('error');

    if (errParam) {
      setError(`Google returned error: ${errParam}`);
      return;
    }
    if (!code || !state || !currentOrg) {
      setError('Missing code/state or organisation');
      return;
    }

    (async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session) throw new Error('Not signed in');

        const redirect_uri = `${window.location.origin}/settings/gmail-callback`;
        const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gmail-oauth-callback`;
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

        setStatus(`Connected ${body.gmail_address}. Redirecting…`);
        setTimeout(() => navigate('/settings'), 1500);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [params, currentOrg, navigate]);

  return (
    <section>
      <h1>Gmail connection</h1>
      {error ? (
        <div
          style={{
            padding: '1rem',
            background: 'var(--bg-danger-subtle)',
            color: 'var(--text-danger)',
            borderRadius: 4,
            fontSize: 13,
          }}
        >
          {error}
        </div>
      ) : (
        <p style={{ color: 'var(--text-muted)' }}>{status}</p>
      )}
    </section>
  );
}
