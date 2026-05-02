import { useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';
import { useGmailIntegrations } from '@/hooks/useGmailIntegrations';
import { useStagedEntities } from '@/hooks/onboarding/useStagedEntities';
import { DetectedInsights } from '@/components/onboarding/DetectedInsights';

/**
 * Auto Setup — landing page for the first-scrape onboarding.
 * Shows: connected mailbox, "Run Auto Setup" button, progress meter, and
 * a CTA to /onboarding/triage when entities have been mined.
 */
export function AutoSetupPage() {
  const { currentOrg } = useOrg();
  const { integrations, loading: gmailLoading } = useGmailIntegrations();
  const { progress, refresh: refreshProgress } = useStagedEntities();

  const [running, setRunning] = useState(false);
  const [aiRunning, setAiRunning] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  if (!currentOrg) {
    return (
      <section>
        <h1>Auto Setup</h1>
        <p style={{ color: '#888' }}>Pick an organisation first.</p>
      </section>
    );
  }

  const activeGmail = integrations.find((g) => g.is_active);

  const runMine = async () => {
    if (!activeGmail) return;
    setError(null);
    setRunning(true);
    setStatus('Starting…');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gmail-mine`;

      type Resp = {
        ok: boolean;
        error?: string;
        stats: { fetched: number; entities_upserted: number; attachments_seen: number; errors: number };
        next_page_token: string | null;
        folder: string;
      };

      const totals = { fetched: 0, entities_upserted: 0, attachments_seen: 0, errors: 0 };
      let pages = 0;

      for (const folder of ['inbox', 'sent'] as const) {
        let pageToken: string | null | undefined;
        do {
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              integration_id: activeGmail.id,
              days: 180,
              folder,
              page_token: pageToken,
              max: 100,
            }),
          });
          const body: Resp = await res.json();
          if (!res.ok || !body.ok) throw new Error(body.error ?? `${res.status}`);
          totals.fetched += body.stats.fetched;
          totals.entities_upserted += body.stats.entities_upserted;
          totals.attachments_seen += body.stats.attachments_seen;
          totals.errors += body.stats.errors;
          pages += 1;
          setStatus(
            `Mining ${folder.toUpperCase()} · page ${pages} · ${totals.fetched} msgs scanned · ${totals.entities_upserted} entities found`,
          );
          pageToken = body.next_page_token;
        } while (pageToken);
      }

      setStatus(
        `✓ Mining complete. ${totals.fetched} messages → ${totals.entities_upserted} unique senders. ${totals.attachments_seen} attachments noted.`,
      );
      await refreshProgress();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const runAiClassify = async () => {
    if (!activeGmail) return;
    setError(null);
    setAiRunning(true);
    setStatus('Classifying with AI…');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gmail-classify-ai`;

      let totals = { processed: 0, classified: 0, unchanged: 0, errors: 0 };
      let pass = 0;
      let remaining = -1;

      // Loop until remaining = 0 or we've done 5 passes
      while (remaining !== 0 && pass < 5) {
        pass += 1;
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ integration_id: activeGmail.id, batch_size: 25, max_batches: 20 }),
        });
        const body = await res.json();
        if (!res.ok || !body.ok) throw new Error(body.error ?? `${res.status}`);
        totals.processed += body.stats.processed;
        totals.classified += body.stats.classified;
        totals.unchanged += body.stats.unchanged;
        totals.errors += body.stats.errors;
        remaining = body.remaining ?? 0;
        setStatus(`AI pass ${pass}: ${totals.classified} classified · ${remaining} still unmatched`);
      }

      setStatus(`✓ AI classification done. ${totals.classified} entities pre-categorised. Open triage to review.`);
      await refreshProgress();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAiRunning(false);
    }
  };

  return (
    <section>
      <h1>Auto Setup</h1>
      <p style={{ color: '#aaa', maxWidth: 720, lineHeight: 1.6 }}>
        We'll scan the last 6 months of <strong>{activeGmail?.gmail_address ?? 'your inbox'}</strong> and pre-fill
        suppliers, contractors, customers, subscriptions, and personal items. Each is matched to a Xero
        account code so when you push to Xero later, the chart of accounts is already aligned.
      </p>
      <p style={{ color: '#666', fontSize: 13, maxWidth: 720, lineHeight: 1.5 }}>
        Mining is read-only — we look at headers, snippets, and basic body text. We do not download
        attachment bodies in this pass. Heavy OCR happens later, only on the entities you approve.
      </p>

      {!activeGmail ? (
        <div style={card}>
          <p style={{ color: '#e9a3a3' }}>
            Connect Gmail first. <Link to="/settings" style={{ color: '#86c7a3' }}>Go to Settings →</Link>
          </p>
        </div>
      ) : (
        <>
          <div style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <strong>{activeGmail.gmail_address}</strong>
              <span style={{ color: '#86c7a3', fontSize: 12 }}>● connected</span>
            </div>

            {progress && progress.total_entities > 0 && (
              <ProgressBar progress={progress} />
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
              <button
                onClick={runMine}
                disabled={running || aiRunning || gmailLoading}
                style={{
                  padding: '0.6rem 1rem',
                  background: running ? '#222' : '#1c5135',
                  color: '#fff',
                  border: '1px solid #2da565',
                  borderRadius: 4,
                  cursor: running ? 'wait' : 'pointer',
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                {running
                  ? 'Mining…'
                  : progress && progress.total_entities > 0
                  ? '↻ Re-run mining'
                  : '▶ 1. Run Auto Setup mining'}
              </button>

              {progress && progress.total_entities > 0 && (
                <button
                  onClick={runAiClassify}
                  disabled={running || aiRunning}
                  style={{
                    padding: '0.6rem 1rem',
                    background: aiRunning ? '#222' : '#3a2563',
                    color: '#fff',
                    border: '1px solid #6b4ba0',
                    borderRadius: 4,
                    cursor: aiRunning ? 'wait' : 'pointer',
                    fontSize: 13,
                    fontWeight: 600,
                  }}
                >
                  {aiRunning ? 'AI thinking…' : '✨ 2. AI-classify the unknowns'}
                </button>
              )}
            </div>
          </div>

          {progress && progress.total_entities > 0 && (
            <Link
              to="/onboarding/triage"
              style={{
                display: 'inline-block',
                marginTop: 12,
                padding: '0.5rem 1rem',
                background: '#1c4868',
                color: '#fff',
                border: '1px solid #5096d8',
                borderRadius: 4,
                textDecoration: 'none',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              Triage {progress.pending_count + progress.needs_review_count} unreviewed entities →
            </Link>
          )}

          {status && (
            <p style={{ color: '#86c7a3', fontSize: 13, marginTop: 12 }}>{status}</p>
          )}
          {error && (
            <p style={{ color: 'salmon', fontSize: 13, marginTop: 12 }}>{error}</p>
          )}

          <DetectedInsights />
        </>
      )}
    </section>
  );
}

function ProgressBar({ progress }: { progress: { pct_complete: number; pending_count: number; needs_review_count: number; approved_count: number; dismissed_count: number; total_entities: number; is_complete: boolean } }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>
        {progress.approved_count + progress.dismissed_count} of {progress.total_entities} reviewed
        ({progress.pct_complete}%)
        {progress.is_complete && <span style={{ color: '#86c7a3', marginLeft: 8 }}>✓ complete</span>}
      </div>
      <div style={{ height: 6, background: '#0a0a0a', borderRadius: 3, overflow: 'hidden' }}>
        <div
          style={{
            width: `${progress.pct_complete}%`,
            height: '100%',
            background: progress.is_complete ? '#2da565' : '#5096d8',
            transition: 'width 0.3s',
          }}
        />
      </div>
    </div>
  );
}

const card: React.CSSProperties = {
  marginTop: 16,
  padding: 16,
  background: '#1a1a1a',
  border: '1px solid #2a2a2a',
  borderRadius: 6,
};
