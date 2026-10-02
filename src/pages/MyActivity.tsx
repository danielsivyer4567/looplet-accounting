import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { useAuth } from '@/hooks/useAuth';
import { SkeletonTable } from '@/components/Skeleton';
import { Clock, Mail, Activity as ActivityIcon, Layers, Info } from 'lucide-react';

interface Session {
  id: string;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
  pageview_count: number;
  action_count: number;
  total_seconds: number | null;
  digest_sent_at: string | null;
  digest_recipient_email: string | null;
}

interface Activity {
  id: string;
  occurred_at: string;
  event_type: string;
  path: string | null;
  description: string | null;
  duration_ms: number | null;
}

export function MyActivityPage() {
  const { currentOrg } = useOrg();
  const { user } = useAuth();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [recent, setRecent] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg || !user) return;
    setLoading(true);
    const [sRes, aRes] = await Promise.all([
      supabase
        .from('accountant_sessions')
        .select('*')
        .eq('organization_id', currentOrg.id)
        .eq('user_id', user.id)
        .order('started_at', { ascending: false })
        .limit(20),
      supabase
        .from('accountant_activity_log')
        .select('*')
        .eq('organization_id', currentOrg.id)
        .eq('user_id', user.id)
        .order('occurred_at', { ascending: false })
        .limit(50),
    ]);
    if (sRes.error) setErr(sRes.error.message);
    setSessions((sRes.data ?? []) as Session[]);
    setRecent((aRes.data ?? []) as Activity[]);
    setLoading(false);
  }, [currentOrg, user]);

  useEffect(() => void refresh(), [refresh]);

  if (!currentOrg || !user) return null;

  const sendMyLog = async (sinceDays: number) => {
    setSending(true);
    setMsg(null);
    setErr(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/accountant-session-digest`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ organization_id: currentOrg.id, since }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error ?? `${res.status}`);
      setMsg(`Emailed your activity log to ${body.recipient} (${body.rows} entries).`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="animated-fade-in" style={{ maxWidth: '950px' }}>
      <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <ActivityIcon size={24} style={{ color: 'var(--text-link)' }} />
        My Activity
      </h1>
      <p
        style={{
          color: 'var(--text-muted)',
          fontSize: '0.875rem',
          marginTop: '0.25rem',
          marginBottom: '1.5rem',
          lineHeight: '1.5',
        }}
      >
        Auto-tracked accountant activity. Digest emails are sent to your registered address on
        session closure (after 30 minutes of idle time). You can also send a digest email on demand
        below.
      </p>

      {/* Button panel */}
      <div
        style={{
          display: 'flex',
          gap: '0.5rem',
          marginBottom: '1.5rem',
          flexWrap: 'wrap',
        }}
      >
        <button onClick={() => void sendMyLog(1)} disabled={sending} className="btn btn-primary">
          <Mail size={14} />
          <span>Email last 24h</span>
        </button>
        <button onClick={() => void sendMyLog(7)} disabled={sending} className="btn btn-secondary">
          <span>Last 7 days</span>
        </button>
        <button onClick={() => void sendMyLog(30)} disabled={sending} className="btn btn-secondary">
          <span>Last 30 days</span>
        </button>
      </div>

      {msg && (
        <div
          className="badge badge-success"
          style={{
            display: 'block',
            padding: '0.75rem',
            marginBottom: '1.5rem',
            textTransform: 'none',
          }}
        >
          {msg}
        </div>
      )}
      {err && (
        <div
          className="badge badge-danger"
          style={{
            display: 'block',
            padding: '0.75rem',
            marginBottom: '1.5rem',
            textTransform: 'none',
          }}
        >
          {err}
        </div>
      )}

      {/* Recent Sessions */}
      <h2
        style={{
          fontSize: '1.25rem',
          marginTop: '2rem',
          marginBottom: '0.75rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.35rem',
        }}
      >
        <Clock size={16} style={{ color: 'var(--text-muted)' }} />
        Recent Sessions
      </h2>

      {loading ? (
        <div aria-busy="true" aria-label="Loading activity sessions">
          <SkeletonTable rows={5} cols={6} />
        </div>
      ) : sessions.length === 0 ? (
        <div
          style={{
            padding: '2rem 1.5rem',
            background: 'var(--bg-card)',
            border: '1px dashed var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            textAlign: 'center',
            color: 'var(--text-muted)',
          }}
        >
          No sessions yet. Sessions auto-create on your first pageview while logged in as an
          accountant.
        </div>
      ) : (
        <div className="table-premium-container" style={{ marginBottom: '2rem' }}>
          <table className="table-premium">
            <thead>
              <tr>
                <th>Started</th>
                <th>Ended</th>
                <th style={{ textAlign: 'right' }}>Duration</th>
                <th style={{ textAlign: 'right' }}>Pages</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
                <th>Reason</th>
                <th>Digest Status</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const dur = s.total_seconds
                  ? `${Math.floor(s.total_seconds / 3600)}h ${Math.floor((s.total_seconds % 3600) / 60)}m`
                  : s.ended_at
                    ? '—'
                    : 'open';
                return (
                  <tr key={s.id}>
                    <td style={{ fontWeight: 600 }}>
                      {new Date(s.started_at).toLocaleString('en-AU')}
                    </td>
                    <td>
                      {s.ended_at ? (
                        new Date(s.ended_at).toLocaleString('en-AU')
                      ) : (
                        <span className="badge badge-success">open</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>{dur}</td>
                    <td style={{ textAlign: 'right' }}>{s.pageview_count}</td>
                    <td style={{ textAlign: 'right' }}>{s.action_count}</td>
                    <td>{s.end_reason ?? '—'}</td>
                    <td>
                      <span
                        className={`badge ${s.digest_sent_at ? 'badge-success' : s.ended_at ? 'badge-warning' : 'badge-neutral'}`}
                      >
                        {s.digest_sent_at ? 'sent' : s.ended_at ? 'pending' : '—'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Recent Activity Log */}
      <h2
        style={{
          fontSize: '1.25rem',
          marginTop: '2rem',
          marginBottom: '0.75rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.35rem',
        }}
      >
        <Layers size={16} style={{ color: 'var(--text-muted)' }} />
        Recent Activity (last 50)
      </h2>

      {recent.length === 0 ? (
        <div
          style={{
            padding: '2rem 1.5rem',
            background: 'var(--bg-card)',
            border: '1px dashed var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            textAlign: 'center',
            color: 'var(--text-muted)',
          }}
        >
          None yet.
        </div>
      ) : (
        <div className="table-premium-container">
          <table className="table-premium">
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th>Path / Description</th>
                <th style={{ textAlign: 'right' }}>Duration</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((a) => (
                <tr key={a.id}>
                  <td>{new Date(a.occurred_at).toLocaleTimeString('en-AU')}</td>
                  <td>
                    <code style={{ fontSize: '0.75rem' }}>{a.event_type}</code>
                  </td>
                  <td>{a.description ?? a.path ?? '—'}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>
                    {a.duration_ms ? `${(a.duration_ms / 1000).toFixed(1)}s` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Info callout */}
      <div
        className="card"
        style={{
          marginTop: '2.5rem',
          background: 'var(--bg-hover)',
          border: '1px dashed var(--border-subtle)',
          padding: '1.25rem',
          display: 'flex',
          gap: '0.75rem',
          alignItems: 'flex-start',
        }}
      >
        <Info
          size={16}
          style={{ flexShrink: 0, color: 'var(--text-link)', marginTop: '2px' }}
        />
        <div style={{ fontSize: '0.825rem', color: 'var(--text-muted)', lineHeight: '1.5' }}>
          <span
            style={{
              fontWeight: 600,
              color: 'var(--text-title)',
              display: 'block',
              marginBottom: '0.25rem',
            }}
          >
            Activity Logging
          </span>
          Activity is tracked locally to enable audits and reviews of actions performed by external
          advisors. Logs are encrypted and accessible only by org administrators.
        </div>
      </div>
    </section>
  );
}
