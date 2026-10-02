import { useEffect, useRef, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Tag } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { useNotificationOrgScope } from '@/hooks/useNotificationOrgScope';
import { isTagMentionNotification } from '@/lib/notificationMeta';

interface NotificationRow {
  id: string;
  organization_id: string;
  category: string;
  severity: 'info' | 'warning' | 'error';
  title: string;
  body: string | null;
  link: string | null;
  resource_type: string | null;
  resource_id: string | null;
  read_at: string | null;
  created_at: string;
}

const SEVERITY_COLOURS: Record<string, string> = {
  info: 'var(--accent-info)',
  warning: 'var(--accent-warning)',
  error: 'var(--accent-danger)',
};

const ICON_MAP: Record<string, string> = {
  bill_overdue: '🧾',
  invoice_overdue: '📨',
  bas_due: '🏛️',
  connection_expiring: '🏦',
  low_confidence_review: '🔍',
  subscription_alert: '🔁',
  cron_failed: '⚠️',
};

const POLL_MS = 60_000;
const PANEL_LIMIT = 8;

export function NotificationBell() {
  const { currentOrg } = useOrg();
  const { crossOrg, orgNameById, enterOrg } = useNotificationOrgScope();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const fetchRecent = useCallback(async () => {
    if (!crossOrg && !currentOrg) {
      setRecent([]);
      setUnread(0);
      return;
    }
    let listQuery = supabase
      .from('notifications')
      .select(
        'id, organization_id, category, severity, title, body, link, resource_type, resource_id, read_at, created_at',
      )
      .is('dismissed_at', null);
    if (!crossOrg && currentOrg) listQuery = listQuery.eq('organization_id', currentOrg.id);
    const { data: list } = await listQuery
      .order('read_at', { ascending: true, nullsFirst: true })
      .order('created_at', { ascending: false })
      .limit(PANEL_LIMIT);
    setRecent((list ?? []) as NotificationRow[]);

    let countQuery = supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .is('dismissed_at', null)
      .is('read_at', null);
    if (!crossOrg && currentOrg) countQuery = countQuery.eq('organization_id', currentOrg.id);
    const { count } = await countQuery;
    setUnread(count ?? 0);
  }, [currentOrg, crossOrg]);

  // Initial + polling
  useEffect(() => {
    void fetchRecent();
    const t = setInterval(() => void fetchRecent(), POLL_MS);
    return () => clearInterval(t);
  }, [fetchRecent]);

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(ev.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const handleNotificationClick = async (n: NotificationRow) => {
    if (!n.read_at) {
      await supabase
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('id', n.id);
    }
    setOpen(false);
    enterOrg(n.organization_id);
    if (n.link) navigate(n.link);
    void fetchRecent();
  };

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ''}`}
        title="Notifications"
        style={{
          position: 'relative',
          background: 'transparent',
          border: '1px solid var(--border-subtle)',
          borderRadius: 4,
          color: 'var(--text-muted)',
          fontSize: 14,
          padding: '0.3rem 0.55rem',
          cursor: 'pointer',
          lineHeight: 1,
        }}
      >
        <span aria-hidden style={{ fontSize: 14 }}>
          🔔
        </span>
        {unread > 0 && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              top: -6,
              right: -6,
              background: 'var(--accent-danger)',
              color: 'var(--text-on-accent)',
              fontSize: 10,
              fontWeight: 700,
              minWidth: 16,
              height: 16,
              borderRadius: 8,
              padding: '0 4px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxSizing: 'border-box',
              border: '1px solid var(--border-subtle)',
            }}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications panel"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            width: 360,
            maxHeight: 480,
            background: 'var(--bg-panel)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
            zIndex: 200,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              padding: '0.6rem 0.85rem',
              borderBottom: '1px solid var(--border-subtle)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <strong style={{ fontSize: 13, color: 'var(--text-body)' }}>Notifications</strong>
            {unread > 0 && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{unread} unread</span>}
          </div>

          <div style={{ overflowY: 'auto', flex: 1 }}>
            {recent.length === 0 ? (
              <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 12, textAlign: 'center' }}>
                You're all caught up.
              </div>
            ) : (
              recent.map((n) => {
                const isUnread = n.read_at == null;
                const isTagMention = isTagMentionNotification(n);
                return (
                  <button
                    key={n.id}
                    onClick={() => void handleNotificationClick(n)}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: '0.6rem 0.85rem',
                      background: isUnread ? '#161616' : 'transparent',
                      border: 'none',
                      borderBottom: '1px solid var(--border-subtle)',
                      borderLeft: `3px solid ${SEVERITY_COLOURS[n.severity] ?? '#444'}`,
                      cursor: 'pointer',
                      color: 'var(--text-body)',
                      display: 'flex',
                      gap: 8,
                      alignItems: 'flex-start',
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        fontSize: 14,
                        lineHeight: 1.2,
                        color: isTagMention ? '#86c7a3' : undefined,
                        display: 'inline-flex',
                        alignItems: 'center',
                      }}
                    >
                      {isTagMention ? (
                        <Tag size={14} strokeWidth={2.25} />
                      ) : (
                        (ICON_MAP[n.category] ?? '🔔')
                      )}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span
                        style={{
                          display: 'block',
                          fontSize: 12,
                          fontWeight: isUnread ? 600 : 400,
                          color: isUnread ? '#fff' : '#bbb',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {n.title}
                      </span>
                      {n.body && (
                        <span
                          style={{
                            display: 'block',
                            fontSize: 11,
                            color: 'var(--text-muted)',
                            marginTop: 2,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {n.body}
                        </span>
                      )}
                      {crossOrg && orgNameById.get(n.organization_id) && (
                        <span
                          style={{
                            display: 'inline-block',
                            fontSize: 10,
                            color: 'var(--text-success)',
                            marginTop: 3,
                            fontWeight: 600,
                          }}
                        >
                          {orgNameById.get(n.organization_id)}
                        </span>
                      )}
                      {isTagMention && n.link && (
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            fontSize: 10,
                            color: 'var(--text-success)',
                            marginTop: 3,
                            fontWeight: 700,
                          }}
                        >
                          <Tag size={10} strokeWidth={2.4} />
                          View tag
                        </span>
                      )}
                      <span style={{ display: 'block', fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>
                        {new Date(n.created_at).toLocaleString()}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>

          <div
            style={{
              borderTop: '1px solid var(--border-subtle)',
              padding: '0.5rem 0.85rem',
              textAlign: 'center',
            }}
          >
            <Link
              to="/notifications"
              onClick={() => setOpen(false)}
              style={{ fontSize: 12, color: 'var(--text-success)', textDecoration: 'none' }}
            >
              View all
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
