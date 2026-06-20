import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { useAuth } from '@/hooks/useAuth';

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
    setSending(true); setMsg(null); setErr(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/accountant-session-digest`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
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
    <section>
      <h1>My activity</h1>
      <p style={{ color: '#888', fontSize: 13 }}>
        Auto-tracked when you're logged in as an accountant. Digest emails go to your address on session close (idle 30+ min). Use the buttons below to send a digest on demand.
      </p>

      <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
        <button onClick={() => void sendMyLog(1)} disabled={sending} style={btnPrimary}>
          {sending ? 'Sending…' : '✉ Email me last 24h'}
        </button>
        <button onClick={() => void sendMyLog(7)} disabled={sending} style={btnSecondary}>
          ✉ Last 7 days
        </button>
        <button onClick={() => void sendMyLog(30)} disabled={sending} style={btnSecondary}>
          ✉ Last 30 days
        </button>
      </div>
      {msg && <p style={{ color: '#86c7a3', fontSize: 12, marginTop: 8 }}>{msg}</p>}
      {err && <p style={{ color: 'salmon', fontSize: 12, marginTop: 8 }}>{err}</p>}

      <h2 style={{ fontSize: 14, color: '#aaa', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 32 }}>
        Recent sessions
      </h2>
      {loading ? <p style={{ color: '#888' }}>Loading…</p> :
        sessions.length === 0 ? (
          <p style={{ color: '#888', fontSize: 13 }}>
            No sessions yet. Sessions auto-create on your first pageview while logged in as an accountant.
          </p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
                <th style={th}>Started</th>
                <th style={th}>Ended</th>
                <th style={thRight}>Duration</th>
                <th style={thRight}>Pages</th>
                <th style={thRight}>Actions</th>
                <th style={th}>Reason</th>
                <th style={th}>Digest</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const dur = s.total_seconds
                  ? `${Math.floor(s.total_seconds / 3600)}h ${Math.floor((s.total_seconds % 3600) / 60)}m`
                  : s.ended_at ? '—' : 'open';
                return (
                  <tr key={s.id} style={{ borderBottom: '1px solid #1a1a1a' }}>
                    <td style={td}>{new Date(s.started_at).toLocaleString('en-AU')}</td>
                    <td style={td}>{s.ended_at ? new Date(s.ended_at).toLocaleString('en-AU') : <span style={{ color: '#86c7a3' }}>open</span>}</td>
                    <td style={tdRight}>{dur}</td>
                    <td style={tdRight}>{s.pageview_count}</td>
                    <td style={tdRight}>{s.action_count}</td>
                    <td style={td}>{s.end_reason ?? '—'}</td>
                    <td style={td}>{s.digest_sent_at ? '✓ sent' : (s.ended_at ? 'pending' : '—')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )
      }

      <h2 style={{ fontSize: 14, color: '#aaa', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 32 }}>
        Recent activity (last 50)
      </h2>
      {recent.length === 0 ? (
        <p style={{ color: '#888', fontSize: 13 }}>None yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 8 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
              <th style={th}>When</th>
              <th style={th}>Type</th>
              <th style={th}>Path / Description</th>
              <th style={thRight}>Duration</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((a) => (
              <tr key={a.id} style={{ borderBottom: '1px solid #1a1a1a' }}>
                <td style={td}>{new Date(a.occurred_at).toLocaleTimeString('en-AU')}</td>
                <td style={td}>{a.event_type}</td>
                <td style={td}>{a.description ?? a.path ?? '—'}</td>
                <td style={tdRight}>{a.duration_ms ? `${(a.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const btnPrimary: React.CSSProperties = {
  padding: '0.5rem 1rem', background: '#1c4868', color: '#fff',
  border: '1px solid #5096d8', borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: 'pointer',
};
const btnSecondary: React.CSSProperties = {
  padding: '0.5rem 1rem', background: 'transparent', color: '#9ab0c0',
  border: '1px solid #1f3a52', borderRadius: 4, fontSize: 13, cursor: 'pointer',
};
const th: React.CSSProperties = { padding: '0.4rem 0.5rem', textAlign: 'left', fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 500 };
const thRight: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '0.5rem' };
const tdRight: React.CSSProperties = { ...td, textAlign: 'right' };
