import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { useGmailIntegrations } from '@/hooks/useGmailIntegrations';
import { useStagedEntities } from '@/hooks/onboarding/useStagedEntities';
import { DetectedInsights } from '@/components/onboarding/DetectedInsights';
import { Sparkles, Mail, ShieldAlert, ArrowRight, Play, RefreshCw } from 'lucide-react';

export function AutoSetupPage() {
  const { currentOrg } = useOrg();
  const { integrations, loading: gmailLoading } = useGmailIntegrations();
  const { progress, refresh: refreshProgress } = useStagedEntities();
  const navigate = useNavigate();

  const [running, setRunning] = useState(false);
  const [aiRunning, setAiRunning] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  if (!currentOrg) {
    return (
      <section className="animated-fade-in">
        <h1>Auto Setup</h1>
        <p style={{ color: 'var(--text-muted)' }}>Pick an organisation first.</p>
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
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gmail-mine`;

      interface Resp {
        ok: boolean;
        error?: string;
        stats: {
          fetched: number;
          entities_upserted: number;
          attachments_seen: number;
          errors: number;
        };
        next_page_token: string | null;
        folder: string;
      }

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
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gmail-classify-ai`;

      const totals = { processed: 0, classified: 0, unchanged: 0, errors: 0 };
      let pass = 0;
      let remaining = -1;

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
        setStatus(
          `AI pass ${pass}: ${totals.classified} classified · ${remaining} still unmatched`,
        );
      }

      setStatus(
        `✓ AI classification done. ${totals.classified} entities pre-categorised. Open triage to review.`,
      );
      await refreshProgress();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAiRunning(false);
    }
  };

  return (
    <section className="animated-fade-in">
      {/* Header section */}
      <div style={{ marginBottom: '2rem' }}>
        <h1
          style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}
        >
          <Sparkles size={24} style={{ color: 'var(--accent-primary)' }} />
          Auto Setup
        </h1>
        <p
          style={{
            color: 'var(--text-muted)',
            fontSize: '0.9rem',
            margin: 0,
            maxWidth: '720px',
            lineHeight: '1.6',
          }}
        >
          Scans the last 6 months of your mailbox and automatically populates suppliers,
          contractors, customers, subscriptions, and personal expenses, pre-matching them to
          appropriate Xero account codes.
        </p>
      </div>

      <div
        style={{
          padding: '1rem 1.25rem',
          background: 'var(--bg-hover)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-md)',
          fontSize: '0.825rem',
          color: 'var(--text-muted)',
          marginBottom: '2rem',
          maxWidth: '720px',
          lineHeight: '1.5',
        }}
      >
        🔒 <strong>Read-Only Scan:</strong> We only evaluate headers, snippets, and basic email body
        contents. Attachment contents are ignored in this pass. Heavy OCR extraction will run later
        only on the files you upload.
      </div>

      {!activeGmail ? (
        <div
          className="card"
          style={{ maxWidth: '720px', borderLeft: '4px solid var(--accent-danger)' }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              color: 'var(--text-danger)',
              fontWeight: 'bold',
            }}
          >
            <ShieldAlert size={18} />
            <span>Connect Gmail First</span>
          </div>
          <p
            style={{
              color: 'var(--text-muted)',
              fontSize: '0.875rem',
              marginTop: '0.5rem',
              marginBottom: '1rem',
            }}
          >
            You need to link your email inbox in organization settings before Auto Setup can analyze
            historical trades transactions.
          </p>
          <Link to="/settings" className="btn btn-primary" style={{ display: 'inline-flex' }}>
            Go to Settings &rarr;
          </Link>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxWidth: '720px' }}>
          {/* Active mailbox status card */}
          <div className="card">
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '1.25rem',
                flexWrap: 'wrap',
                gap: '0.5rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Mail size={18} style={{ color: 'var(--accent-primary)' }} />
                <strong style={{ color: 'var(--text-title)' }}>{activeGmail.gmail_address}</strong>
              </div>
              <span className="badge badge-success">● Connected</span>
            </div>

            {progress && progress.total_entities > 0 && <ProgressBar progress={progress} />}

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1.5rem', flexWrap: 'wrap' }}>
              <button
                onClick={runMine}
                disabled={running || aiRunning || gmailLoading}
                className="btn btn-primary"
                style={{ padding: '0.625rem 1.25rem' }}
              >
                {running ? (
                  <RefreshCw size={14} className="spinning" />
                ) : (
                  <Play size={14} fill="currentColor" />
                )}
                <span>
                  {running
                    ? 'Mining Mailbox…'
                    : progress && progress.total_entities > 0
                      ? 'Re-run mining'
                      : '1. Run Auto Setup Mining'}
                </span>
              </button>

              {progress && progress.total_entities > 0 && (
                <button
                  onClick={runAiClassify}
                  disabled={running || aiRunning}
                  className="btn btn-secondary"
                  style={{
                    padding: '0.625rem 1.25rem',
                    border: '1px solid rgba(99, 102, 241, 0.4)',
                    color: 'var(--accent-primary)',
                  }}
                >
                  <Sparkles size={14} style={{ color: 'var(--accent-primary)' }} />
                  <span>{aiRunning ? 'AI Classifying…' : '2. AI-Classify Unknown Senders'}</span>
                </button>
              )}
            </div>
          </div>

          {/* Action route buttons */}
          {progress && progress.total_entities > 0 && (
            <button
              onClick={() => navigate('/onboarding/triage')}
              className="btn btn-primary"
              style={{
                padding: '0.75rem 1.5rem',
                alignSelf: 'flex-start',
                background: 'linear-gradient(135deg, var(--accent-primary) 0%, #4f46e5 100%)',
                fontSize: '0.9rem',
                borderRadius: 'var(--radius-md)',
                boxShadow: 'var(--shadow-md)',
              }}
            >
              <span>
                Triage {progress.pending_count + progress.needs_review_count} pending senders
              </span>
              <ArrowRight size={16} />
            </button>
          )}

          {/* Logs / Status alerts */}
          {status && (
            <div
              className="badge badge-info"
              style={{
                display: 'block',
                padding: '0.75rem',
                textTransform: 'none',
                textAlign: 'left',
                lineHeight: '1.4',
              }}
            >
              {status}
            </div>
          )}
          {error && (
            <div
              className="badge badge-danger"
              style={{
                display: 'block',
                padding: '0.75rem',
                textTransform: 'none',
                textAlign: 'left',
              }}
            >
              {error}
            </div>
          )}

          <div style={{ marginTop: '1rem' }}>
            <DetectedInsights />
          </div>
        </div>
      )}
    </section>
  );
}

function ProgressBar({
  progress,
}: {
  progress: {
    pct_complete: number;
    pending_count: number;
    needs_review_count: number;
    approved_count: number;
    dismissed_count: number;
    total_entities: number;
    is_complete: boolean;
  };
}) {
  return (
    <div style={{ marginBottom: '1.25rem' }}>
      <style>{`
        @keyframes progressPulse {
          0% { opacity: 0.8; }
          50% { opacity: 1; }
          100% { opacity: 0.8; }
        }
        .progress-bar-fill {
          height: 100%;
          border-radius: var(--radius-full);
          transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .progress-bar-active {
          animation: progressPulse 2s infinite ease-in-out;
        }
      `}</style>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: '0.8rem',
          color: 'var(--text-muted)',
          marginBottom: '0.5rem',
          fontWeight: 600,
        }}
      >
        <span>
          {progress.approved_count + progress.dismissed_count} of {progress.total_entities} Senders
          Reviewed ({progress.pct_complete}%)
        </span>
        {progress.is_complete && <span style={{ color: 'var(--text-success)' }}>✓ Complete</span>}
      </div>

      <div
        style={{
          height: '8px',
          background: 'var(--bg-app)',
          borderRadius: 'var(--radius-full)',
          overflow: 'hidden',
          border: '1px solid var(--border-subtle)',
        }}
      >
        <div
          className={`progress-bar-fill ${!progress.is_complete ? 'progress-bar-active' : ''}`}
          style={{
            width: `${progress.pct_complete}%`,
            background: progress.is_complete ? 'var(--accent-success)' : 'var(--accent-primary)',
          }}
        />
      </div>
    </div>
  );
}
