import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';

/**
 * Basiq Connect redirects here with a `jobId` param after the user completes
 * the bank-link flow. The job results in zero-or-more new connection_ids on
 * the user's Basiq profile. We resolve them and call bank-exchange for each.
 */
export function BankCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { currentOrg } = useOrg();
  const [status, setStatus] = useState('Reading Basiq response…');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const jobId = params.get('jobId');
    const errParam = params.get('error');

    if (errParam) {
      setError(`Basiq returned error: ${errParam}`);
      return;
    }
    if (!currentOrg) {
      setError('No organisation selected');
      return;
    }
    // Basiq sometimes returns connectionId directly; if not we'll prompt user
    // to retry from the connections list once webhook fires.
    const connectionId = params.get('connectionId');

    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error('Not signed in');

        if (connectionId) {
          setStatus(`Finalising connection ${connectionId.slice(0, 8)}…`);
          const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/bank-exchange`;
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              organization_id: currentOrg.id,
              connection_id: connectionId,
            }),
          });
          const body = await res.json();
          if (!res.ok || !body.ok) throw new Error(body.error ?? `${res.status}`);
          setStatus(`✓ Connected. ${body.accounts?.length ?? 0} accounts. Syncing transactions…`);
        } else {
          setStatus(
            `Job ${jobId ? jobId.slice(0, 8) : ''} is still running on Basiq. Your accounts will appear in Settings within a minute.`,
          );
        }
        setTimeout(() => navigate('/settings'), 2000);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [params, currentOrg, navigate]);

  return (
    <section>
      <h1>Bank connection</h1>
      {error ? (
        <div style={{ padding: '1rem', background: '#3d1818', color: '#e9a3a3', borderRadius: 4, fontSize: 13 }}>
          {error}
        </div>
      ) : (
        <p style={{ color: '#888' }}>{status}</p>
      )}
    </section>
  );
}
