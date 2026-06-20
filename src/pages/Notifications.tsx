import { useEffect, useState, useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { SkeletonTable } from '@/components/Skeleton';

interface NotificationRow {
  id: string;
  organization_id: string;
  user_id: string | null;
  category: string;
  severity: 'info' | 'warning' | 'error';
  title: string;
  body: string | null;
  link: string | null;
  resource_type: string | null;
  resource_id: string | null;
  read_at: string | null;
  dismissed_at: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
}

const CATEGORY_LABELS: Record<string, string> = {
  bill_overdue: 'Bills overdue',
  invoice_overdue: 'Invoices overdue',
  bas_due: 'BAS due',
  connection_expiring: 'Bank connection',
  low_confidence_review: 'Quality',
  subscription_alert: 'Subscriptions',
  cron_failed: 'System',
};

const CATEGORY_ICONS: Record<string, string> = {
  bill_overdue: '🧾',
  invoice_overdue: '📨',
  bas_due: '🏛️',
  connection_expiring: '🏦',
  low_confidence_review: '🔍',
  subscription_alert: '🔁',
  cron_failed: '⚠️',
};

const SEVERITY_COLOURS: Record<string, string> = {
  info: '#86c7a3',
  warning: '#e9c97a',
  error: '#e9a3a3',
};

export function NotificationsPage() {
  const { currentOrg } = useOrg();
  const navigate = useNavigate();
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [filterSeverity, setFilterSeverity] = useState<string>('all');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    const { data, error: e } = await supabase
      .from('notifications')
      .select('*')
      .eq('organization_id', currentOrg.id)
      .is('dismissed_at', null)
      .order('read_at', { ascending: true, nullsFirst: true })
      .order('created_at', { ascending: false })
      .limit(200);
    if (e) setError(e.message);
    setRows((data ?? []) as NotificationRow[]);
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => void refresh(), [refresh]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (filterCategory !== 'all' && r.category !== filterCategory) return false;
      if (filterSeverity !== 'all' && r.severity !== filterSeverity) return false;
      return true;
    });
  }, [rows, filterCategory, filterSeverity]);

  const unreadCount = filtered.filter((r) => r.read_at == null).length;

  const handleClick = async (n: NotificationRow) => {
    // Mark read
    if (!n.read_at) {
      await supabase
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('id', n.id);
    }
    if (n.link) {
      navigate(n.link);
    } else {
      void refresh();
    }
  };

  const handleMarkAllRead = async () => {
    if (!currentOrg || unreadCount === 0) return;
    setBusy(true);
    const ids = filtered.filter((r) => r.read_at == null).map((r) => r.id);
    if (ids.length > 0) {
      await supabase
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .in('id', ids);
    }
    await refresh();
    setBusy(false);
  };

  const handleDismiss = async (id: string) => {
    await supabase
      .from('notifications')
      .update({ dismissed_at: new Date().toISOString() })
      .eq('id', id);
    void refresh();
  };

  if (!currentOrg) return null;

  const distinctCategories = Array.from(new Set(rows.map((r) => r.category)));

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0 }}>Notifications</h1>
          <p style={{ color: '#888', fontSize: 13, marginTop: 4 }}>
            {unreadCount > 0 ? `${unreadCount} unread` : 'All caught up.'}
          </p>
        </div>
        <button
          onClick={handleMarkAllRead}
          disabled={busy || unreadCount === 0}
          style={{
            ...btn,
            opacity: unreadCount === 0 ? 0.4 : 1,
            cursor: unreadCount === 0 ? 'default' : 'pointer',
          }}
        >
          Mark all read
        </button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
        <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)} style={selectStyle}>
          <option value="all">All categories</option>
          {distinctCategories.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c] ?? c}
            </option>
          ))}
        </select>
        <select value={filterSeverity} onChange={(e) => setFilterSeverity(e.target.value)} style={selectStyle}>
          <option value="all">All severities</option>
          <option value="info">Info</option>
          <option value="warning">Warning</option>
          <option value="error">Error</option>
        </select>
      </div>

      {loading ? (
        <div style={{ marginTop: 16 }}>
          <SkeletonTable rows={5} cols={3} />
        </div>
      ) : error ? (
        <p style={{ color: 'salmon', marginTop: 16 }}>{error}</p>
      ) : filtered.length === 0 ? (
        <div style={emptyBox}>
          {rows.length === 0 ? "You're all caught up — no notifications." : 'No notifications match the current filters.'}
        </div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, marginTop: 16 }}>
          {filtered.map((n) => {
            const unread = n.read_at == null;
            return (
              <li
                key={n.id}
                style={{
                  padding: 12,
                  background: unread ? '#1a1a1a' : '#141414',
                  border: '1px solid #2a2a2a',
                  borderLeft: `3px solid ${SEVERITY_COLOURS[n.severity] ?? '#444'}`,
                  borderRadius: 6,
                  marginBottom: 8,
                  display: 'flex',
                  gap: 12,
                  alignItems: 'flex-start',
                }}
              >
                <div style={{ fontSize: 18, lineHeight: 1, flexShrink: 0 }}>{CATEGORY_ICONS[n.category] ?? '🔔'}</div>
                <div
                  onClick={() => handleClick(n)}
                  style={{ flex: 1, cursor: n.link ? 'pointer' : 'default', minWidth: 0 }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 14, fontWeight: unread ? 600 : 400, color: unread ? '#fff' : '#bbb' }}>
                      {n.title}
                    </span>
                    <span style={{ fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      {CATEGORY_LABELS[n.category] ?? n.category}
                    </span>
                  </div>
                  {n.body && (
                    <div style={{ marginTop: 4, fontSize: 12, color: '#888' }}>{n.body}</div>
                  )}
                  <div style={{ marginTop: 6, fontSize: 11, color: '#555' }}>
                    {new Date(n.created_at).toLocaleString()}
                    {n.link && (
                      <span style={{ marginLeft: 8, color: '#86c7a3' }}>→ {n.link}</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDismiss(n.id);
                  }}
                  aria-label="Dismiss"
                  title="Dismiss"
                  style={dismissBtn}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <p style={{ marginTop: 24, fontSize: 12, color: '#666' }}>
        Notifications are generated nightly. <Link to="/settings" style={{ color: '#86c7a3' }}>Settings</Link> to manage email digests (coming soon).
      </p>
    </section>
  );
}

const btn: React.CSSProperties = {
  padding: '0.4rem 0.85rem',
  background: 'transparent',
  color: '#86c7a3',
  border: '1px solid #2da565',
  borderRadius: 4,
  fontSize: 12,
  cursor: 'pointer',
};
const selectStyle: React.CSSProperties = {
  padding: '0.35rem 0.5rem',
  background: '#1a1a1a',
  color: '#ddd',
  border: '1px solid #2a2a2a',
  borderRadius: 4,
  fontSize: 12,
};
const emptyBox: React.CSSProperties = {
  marginTop: 24,
  padding: 16,
  background: '#0e0e0e',
  border: '1px dashed #2a2a2a',
  borderRadius: 4,
  color: '#888',
  fontSize: 13,
};
const dismissBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#666',
  fontSize: 18,
  lineHeight: 1,
  cursor: 'pointer',
  padding: '0 6px',
  flexShrink: 0,
};
