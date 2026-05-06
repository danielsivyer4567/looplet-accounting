import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;

// Poll every 2 s, up to 30 attempts = 60 s total.
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 30;

/**
 * Basiq Connect redirects here after the user completes the bank-link flow.
 *
 * Three cases:
 *   A. connectionId in params — the rarest but fastest path; call bank-exchange directly.
 *   B. jobId only — the common async path; poll bank-job-poll until the job
 *      resolves a connectionId (or timeout after 60 s), then call bank-exchange.
 *   C. error param — surface the error with a retry button.
 *
 * Once bank-exchange returns, bank-sync is already kicked inside that function,
 * and bank-sync fires subscriptions-detect when it finishes.
 */
export function BankCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { currentOrg } = useOrg();
  const [status, setStatus] = useState('Reading Basiq response…');
  const [error, setError] = useState<string | null>(null);
  const didRun = useRef(false);

  useEffect(() => {
    // Strict-mode safe: only run once per mount.
    if (didRun.current) return;
    didRun.current = true;

    const connectionId = params.get('connectionId');
    const jobId = params.get('jobId');
    const errParam = params.get('error');

    if (errParam) {
      setError(`Basiq returned an error: ${errParam}`);
      return;
    }

    if (!currentOrg) {
      setError('No organisation selected — please go back and try again.');
      return;
    }

    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error('Not signed in');

        let resolvedConnectionId = connectionId ?? null;

        // ── Path B: jobId only — poll bank-job-poll until we get a connectionId ──
        if (!resolvedConnectionId && jobId) {
          setStatus(`Job ${jobId.slice(0, 8)}… received. Waiting for bank connection to activate…`);

          resolvedConnectionId = await pollForConnection(
            jobId,
            currentOrg.id,
            session.access_token,
            (attempt) => {
              const elapsed = Math.round((attempt * POLL_INTERVAL_MS) / 1000);
              setStatus(`Waiting for bank to connect… (${elapsed}s)`);
            },
          );

          if (!resolvedConnectionId) {
            // Timeout or job failed — the bank connection may still complete via
            // Basiq's webhook. Tell the user to check Settings in a moment.
            setStatus(
              'Connection is still activating on Basiq — this can take up to 2 minutes. ' +
              'Your accounts will appear in Settings once ready.',
            );
            setTimeout(() => navigate('/settings'), 4000);
            return;
          }
        }

        // ── Path A / B resolved: call bank-exchange with the connectionId ──
        if (resolvedConnectionId) {
          setStatus(`Finalising connection ${resolvedConnectionId.slice(0, 8)}…`);

          const res = await fetch(`${SUPABASE_URL}/functions/v1/bank-exchange`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              organization_id: currentOrg.id,
              connection_id: resolvedConnectionId,
            }),
          });
          const body = await res.json();
          if (!res.ok || !body.ok) throw new Error(body.error ?? `bank-exchange ${res.status}`);

          const accountCount = body.accounts?.length ?? 0;
          setStatus(
            `Connected. ${accountCount} account${accountCount === 1 ? '' : 's'} linked. ` +
            'Syncing transactions in the background…',
          );
          setTimeout(() => navigate('/settings'), 2500);
          return;
        }

        // No connectionId and no jobId — Basiq returned neither; shouldn't happen.
        setError('Basiq did not return a connection ID or job ID. Please try again from Settings.');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [params, currentOrg, navigate]);

  return (
    <section style={{ padding: '2rem', maxWidth: 480 }}>
      <h1 style={{ marginBottom: '1rem' }}>Bank connection</h1>
      {error ? (
        <>
          <div
            style={{
              padding: '1rem',
              background: '#3d1818',
              color: '#e9a3a3',
              borderRadius: 4,
              fontSize: 13,
              marginBottom: '1rem',
            }}
          >
            {error}
          </div>
          <button
            onClick={() => navigate('/settings')}
            style={{
              padding: '0.5rem 1.25rem',
              background: '#1a4d8c',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            Back to Settings
          </button>
        </>
      ) : (
        <p style={{ color: '#888', fontSize: 14 }}>{status}</p>
      )}
    </section>
  );
}

/**
 * Poll bank-job-poll every POLL_INTERVAL_MS ms for up to POLL_MAX_ATTEMPTS
 * attempts. Returns the connectionId string on success, or null on timeout
 * or job failure.
 */
async function pollForConnection(
  jobId: string,
  organizationId: string,
  accessToken: string,
  onProgress: (attempt: number) => void,
): Promise<string | null> {
  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    // Wait before polling (except on the very first attempt, give Basiq ~1s).
    await delay(attempt === 1 ? 1000 : POLL_INTERVAL_MS);
    onProgress(attempt);

    let data: { ok: boolean; status?: string; connection_id?: string | null; error?: string };
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/bank-job-poll`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ organization_id: organizationId, job_id: jobId }),
      });
      data = await res.json();
    } catch {
      // Network blip — keep trying.
      continue;
    }

    if (!data.ok) {
      // Server-side error (e.g. Basiq 5xx) — keep trying unless it looks permanent.
      console.warn('bank-job-poll error:', data.error);
      continue;
    }

    if (data.status === 'failed') {
      console.error('Basiq job failed for jobId', jobId);
      return null;
    }

    if (data.status === 'active' && data.connection_id) {
      return data.connection_id;
    }

    // status === 'pending' — continue polling.
  }

  // Exhausted all attempts.
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
