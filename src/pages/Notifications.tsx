import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { useNotificationOrgScope } from '@/hooks/useNotificationOrgScope';
import { SkeletonTable } from '@/components/Skeleton';
import { InsightAreaChart, InsightBarList, InsightPanel } from '@/components/InsightCharts';
import {
  Bell,
  FileText,
  Send,
  Calendar,
  Link as LinkIcon,
  Search,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  Info,
  X,
  type LucideIcon,
} from 'lucide-react';

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

// Lucide icon mapping instead of raw emojis
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  bill_overdue: FileText,
  invoice_overdue: Send,
  bas_due: Calendar,
  connection_expiring: LinkIcon,
  low_confidence_review: Search,
  subscription_alert: RefreshCw,
  cron_failed: AlertTriangle,
};

const SEVERITY_COLOURS: Record<string, string> = {
  info: 'var(--accent-info)',
  warning: 'var(--accent-warning)',
  error: 'var(--accent-danger)',
};

export function NotificationsPage() {
  const { currentOrg } = useOrg();
  const { crossOrg, orgNameById, enterOrg } = useNotificationOrgScope();
  const navigate = useNavigate();
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [filterSeverity, setFilterSeverity] = useState<string>('all');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!crossOrg && !currentOrg) return;
    setLoading(true);
    let query = supabase.from('notifications').select('*').is('dismissed_at', null);
    if (!crossOrg && currentOrg) query = query.eq('organization_id', currentOrg.id);
    const { data, error: e } = await query
      .order('read_at', { ascending: true, nullsFirst: true })
      .order('created_at', { ascending: false })
      .limit(200);
    if (e) setError(e.message);
    setRows((data ?? []) as NotificationRow[]);
    setLoading(false);
  }, [currentOrg, crossOrg]);

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
    if (!n.read_at) {
      await supabase
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('id', n.id);
    }
    enterOrg(n.organization_id);
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

  if (!crossOrg && !currentOrg) return null;

  const distinctCategories = Array.from(new Set(rows.map((r) => r.category)));
  const severityItems = [
    {
      label: 'Error',
      value: filtered.filter((r) => r.severity === 'error').length,
      tone: 'danger' as const,
    },
    {
      label: 'Warning',
      value: filtered.filter((r) => r.severity === 'warning').length,
      tone: 'warning' as const,
    },
    {
      label: 'Info',
      value: filtered.filter((r) => r.severity === 'info').length,
      tone: 'info' as const,
    },
  ];
  const categoryItems = distinctCategories.slice(0, 5).map((category) => ({
    label: CATEGORY_LABELS[category] ?? category,
    value: rows.filter((r) => r.category === category).length,
    tone:
      category === 'cron_failed'
        ? ('danger' as const)
        : category === 'bas_due'
          ? ('warning' as const)
          : ('primary' as const),
  }));
  let runningAlertLoad = 0;
  let runningUnreadLoad = 0;
  const alertTrendSource = filtered
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const alertTrendItems = filtered.length
    ? alertTrendSource.map((row) => {
        runningAlertLoad += row.severity === 'error' ? 3 : row.severity === 'warning' ? 2 : 1;
        return {
          label: new Date(row.created_at).toLocaleDateString('en-AU', {
            day: '2-digit',
            month: 'short',
          }),
          value: runningAlertLoad,
        };
      })
    : [{ label: 'Clear', value: 0 }];
  const unreadTrendItems = alertTrendSource.map((row) => {
    if (row.read_at == null)
      runningUnreadLoad += row.severity === 'error' ? 3 : row.severity === 'warning' ? 2 : 1;
    return {
      label: new Date(row.created_at).toLocaleDateString('en-AU', {
        day: '2-digit',
        month: 'short',
      }),
      value: runningUnreadLoad,
    };
  });
  const errorAlertCount = severityItems.find((item) => item.label === 'Error')?.value ?? 0;
  const warningAlertCount = severityItems.find((item) => item.label === 'Warning')?.value ?? 0;

  return (
    <section className="animated-fade-in" style={{ maxWidth: '850px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '1rem',
          marginBottom: '1.5rem',
        }}
      >
        <div>
          <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Bell size={24} style={{ color: 'var(--accent-primary)' }} />
            Notifications
          </h1>
          <p
            style={{
              color: 'var(--text-muted)',
              fontSize: '0.875rem',
              marginTop: '0.25rem',
              marginBottom: 0,
            }}
          >
            {unreadCount > 0 ? (
              <span style={{ fontWeight: 600, color: 'var(--accent-primary)' }}>
                {unreadCount} unread notifications
              </span>
            ) : (
              'All caught up.'
            )}
          </p>
        </div>

        <button
          onClick={handleMarkAllRead}
          disabled={busy || unreadCount === 0}
          className="btn btn-secondary"
        >
          <CheckCircle size={16} />
          <span>Mark all read</span>
        </button>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: '1rem',
          marginBottom: '1.5rem',
        }}
      >
        <InsightPanel title="Alert pulse" eyebrow="Filtered view">
          <InsightAreaChart
            title="Attention load"
            items={alertTrendItems}
            tone={errorAlertCount > 0 ? 'danger' : warningAlertCount > 0 ? 'warning' : 'info'}
            series={[{ label: 'Unread', items: unreadTrendItems, tone: 'primary' }]}
            markerLabel={`${unreadCount} unread`}
            formatValue={(value) => value.toLocaleString('en-AU')}
          />
        </InsightPanel>
        <InsightPanel title="Alert sources" eyebrow="Category pattern">
          <InsightBarList
            items={categoryItems}
            formatValue={(value) => value.toLocaleString('en-AU')}
          />
        </InsightPanel>
      </div>

      {/* Filters Toolbar Card */}
      <div
        className="card"
        style={{
          display: 'flex',
          gap: '0.75rem',
          flexWrap: 'wrap',
          marginBottom: '1.5rem',
          padding: '1rem',
        }}
      >
        <select
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          className="form-select"
          style={{
            width: 'auto',
            padding: '0.45rem 1.75rem 0.45rem 0.75rem',
            fontSize: '0.825rem',
          }}
        >
          <option value="all">All categories</option>
          {distinctCategories.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c] ?? c}
            </option>
          ))}
        </select>

        <select
          value={filterSeverity}
          onChange={(e) => setFilterSeverity(e.target.value)}
          className="form-select"
          style={{
            width: 'auto',
            padding: '0.45rem 1.75rem 0.45rem 0.75rem',
            fontSize: '0.825rem',
          }}
        >
          <option value="all">All severities</option>
          <option value="info">Info</option>
          <option value="warning">Warning</option>
          <option value="error">Error</option>
        </select>
      </div>

      {loading ? (
        <SkeletonTable rows={5} cols={3} />
      ) : error ? (
        <div
          className="badge badge-danger"
          style={{ display: 'block', padding: '1rem', textTransform: 'none' }}
        >
          {error}
        </div>
      ) : filtered.length === 0 ? (
        <div
          style={{
            padding: '3rem 1.5rem',
            background: 'var(--bg-card)',
            border: '1px dashed var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            textAlign: 'center',
            color: 'var(--text-muted)',
          }}
        >
          {rows.length === 0
            ? "You're all caught up — no notifications."
            : 'No notifications match the current filters.'}
        </div>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
          }}
        >
          {filtered.map((n) => {
            const unread = n.read_at == null;
            const CategoryIcon = CATEGORY_ICONS[n.category] ?? Bell;

            return (
              <li
                key={n.id}
                style={{
                  padding: '1rem 1.25rem',
                  background: unread ? 'var(--bg-card)' : 'var(--bg-hover)',
                  border: '1px solid var(--border-subtle)',
                  borderLeft: `4px solid ${SEVERITY_COLOURS[n.severity] ?? 'var(--border-subtle)'}`,
                  borderRadius: 'var(--radius-sm)',
                  display: 'flex',
                  gap: '1rem',
                  alignItems: 'flex-start',
                  boxShadow: unread ? 'var(--shadow-sm)' : 'none',
                  transition: 'var(--transition-smooth)',
                  position: 'relative',
                }}
              >
                <div
                  style={{
                    color: SEVERITY_COLOURS[n.severity],
                    background: 'var(--bg-hover)',
                    padding: '0.5rem',
                    borderRadius: 'var(--radius-full)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <CategoryIcon size={18} />
                </div>

                <div
                  onClick={() => handleClick(n)}
                  style={{ flex: 1, cursor: n.link ? 'pointer' : 'default', minWidth: 0 }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: '0.5rem',
                      flexWrap: 'wrap',
                    }}
                  >
                    <span
                      style={{
                        fontSize: '0.9rem',
                        fontWeight: unread ? 700 : 500,
                        color: unread ? 'var(--text-title)' : 'var(--text-body)',
                      }}
                    >
                      {n.title}
                    </span>
                    <span
                      className="badge badge-neutral"
                      style={{ fontSize: '0.625rem', padding: '0.1rem 0.35rem' }}
                    >
                      {CATEGORY_LABELS[n.category] ?? n.category}
                    </span>
                    {crossOrg && orgNameById.get(n.organization_id) && (
                      <span
                        className="badge badge-primary"
                        style={{ fontSize: '0.625rem', padding: '0.1rem 0.35rem' }}
                      >
                        {orgNameById.get(n.organization_id)}
                      </span>
                    )}
                  </div>
                  {n.body && (
                    <div
                      style={{
                        marginTop: '0.25rem',
                        fontSize: '0.825rem',
                        color: 'var(--text-muted)',
                        lineHeight: '1.4',
                      }}
                    >
                      {n.body}
                    </div>
                  )}
                  <div
                    style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}
                  >
                    {new Date(n.created_at).toLocaleString()}
                    {n.link && (
                      <span
                        style={{
                          marginLeft: '0.5rem',
                          color: 'var(--accent-primary)',
                          fontWeight: 600,
                        }}
                      >
                        → View details
                      </span>
                    )}
                  </div>
                </div>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDismiss(n.id);
                  }}
                  aria-label="Dismiss notification"
                  title="Dismiss notification"
                  className="btn btn-ghost"
                  style={{
                    padding: '0.25rem',
                    color: 'var(--text-muted)',
                    borderRadius: 'var(--radius-full)',
                    marginTop: '-0.25rem',
                    marginRight: '-0.25rem',
                  }}
                >
                  <X size={16} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Info Callout */}
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
          style={{ flexShrink: 0, color: 'var(--accent-primary)', marginTop: '2px' }}
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
            Automated Alerts
          </span>
          Notifications are generated nightly from your active bills, invoices, and bank
          integrations. System alerts can also flag sync conflicts and connection expiries.
        </div>
      </div>
    </section>
  );
}
