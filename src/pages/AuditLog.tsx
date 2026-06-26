import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { downloadCsv } from '@/lib/csv';
import { ChevronLeft, Download, User, Calendar, Search, ChevronDown, ChevronUp, AlertCircle } from 'lucide-react';

interface AuditRow {
  id: string;
  organization_id: string;
  table_name: string;
  record_id: string | null;
  operation: string;
  actor_user_id: string | null;
  actor_email: string | null;
  action: string | null;
  resource_type: string | null;
  resource_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  changes: Record<string, [unknown, unknown]> | null;
  occurred_at: string;
}

function operationBadgeClass(op: string): string {
  switch (op?.toUpperCase()) {
    case 'INSERT':
      return 'badge-success';
    case 'UPDATE':
    case 'ROLE_CHANGE':
      return 'badge-warning';
    case 'DELETE':
    case 'VOID':
      return 'badge-danger';
    case 'INVITE':
    case 'ACCEPT':
      return 'badge-info';
    default:
      return 'badge-neutral';
  }
}

function formatTimestamp(ts: string): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

function JsonDiff({ changes }: { changes: Record<string, [unknown, unknown]> }) {
  return (
    <div style={{ overflowX: 'auto', width: '100%' }}>
      <table
        style={{
          fontSize: '0.75rem',
          borderCollapse: 'collapse',
          width: '100%',
          marginTop: '0.5rem',
          color: 'var(--text-body)'
        }}
      >
        <thead>
          <tr style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}>
            <th style={{ textAlign: 'left', padding: '0.4rem 0.5rem' }}>Field</th>
            <th style={{ textAlign: 'left', padding: '0.4rem 0.5rem', color: 'var(--text-danger)' }}>Before</th>
            <th style={{ textAlign: 'left', padding: '0.4rem 0.5rem', color: 'var(--text-success)' }}>After</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(changes).map(([col, [old, next]]) => (
            <tr key={col} style={{ borderBottom: '1px dashed var(--border-subtle)' }}>
              <td style={{ padding: '0.4rem 0.5rem', color: 'var(--text-title)', fontFamily: 'var(--font-mono, monospace)' }}>
                {col}
              </td>
              <td style={{ padding: '0.4rem 0.5rem', color: 'var(--text-danger)', fontFamily: 'var(--font-mono, monospace)', wordBreak: 'break-all' }}>
                {old === null ? <span style={{ fontStyle: 'italic', opacity: 0.5 }}>null</span> : JSON.stringify(old)}
              </td>
              <td style={{ padding: '0.4rem 0.5rem', color: 'var(--text-success)', fontFamily: 'var(--font-mono, monospace)', wordBreak: 'break-all' }}>
                {next === null ? <span style={{ fontStyle: 'italic', opacity: 0.5 }}>null</span> : JSON.stringify(next)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AuditRowItem({ row }: { row: AuditRow }) {
  const [expanded, setExpanded] = useState(false);
  const op = row.action ?? row.operation;
  const resourceType = row.resource_type ?? row.table_name;
  const resourceId = row.resource_id ?? row.record_id;

  return (
    <div
      style={{
        borderBottom: '1px solid var(--border-subtle)',
        padding: '0.875rem 0',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          flexWrap: 'wrap',
          cursor: row.changes ? 'pointer' : 'default',
        }}
        onClick={() => row.changes && setExpanded((x) => !x)}
      >
        {/* Operation badge */}
        <span className={`badge ${operationBadgeClass(op)}`} style={{ minWidth: '70px', textAlign: 'center', justifyContent: 'center' }}>
          {op}
        </span>

        {/* Resource details */}
        <span style={{ fontSize: '0.825rem', color: 'var(--text-title)', fontFamily: 'var(--font-mono, monospace)' }}>
          {resourceType}
          {resourceId ? (
            <span style={{ color: 'var(--text-muted)', marginLeft: '0.25rem' }}>#{resourceId.slice(0, 8)}</span>
          ) : null}
        </span>

        {/* Actor */}
        <span style={{ fontSize: '0.825rem', color: 'var(--text-muted)', marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
          <User size={12} />
          {row.actor_email ?? (row.actor_user_id ? row.actor_user_id.slice(0, 8) + '…' : 'system')}
        </span>

        {/* Timestamp */}
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
          <Calendar size={12} />
          {formatTimestamp(row.occurred_at)}
        </span>

        {/* Expand indicator */}
        {row.changes && (
          <span className="badge badge-neutral" style={{ fontSize: '0.725rem', textTransform: 'none', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
            <span>{Object.keys(row.changes).length} field(s)</span>
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </span>
        )}
      </div>

      {expanded && row.changes && (
        <div
          className="card"
          style={{
            marginTop: '0.75rem',
            background: 'var(--bg-hover)',
            borderColor: 'var(--border-subtle)',
            padding: '1rem',
          }}
        >
          <JsonDiff changes={row.changes as Record<string, [unknown, unknown]>} />
        </div>
      )}
    </div>
  );
}

const PAGE_SIZE = 50;

export function AuditLogPage() {
  const { currentOrg } = useOrg();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  const [filterActor, setFilterActor] = useState('');
  const [filterResource, setFilterResource] = useState('');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');

  const [actorOptions, setActorOptions] = useState<string[]>([]);
  const [resourceOptions, setResourceOptions] = useState<string[]>([]);

  const load = useCallback(
    async (reset = false) => {
      if (!currentOrg) return;
      setLoading(true);
      setError(null);

      const currentPage = reset ? 0 : page;
      if (reset) setPage(0);

      let query = supabase
        .from('audit_log')
        .select(
          'id, organization_id, table_name, record_id, operation, actor_user_id, actor_email, action, resource_type, resource_id, before, after, changes, occurred_at',
        )
        .eq('organization_id', currentOrg.id)
        .order('occurred_at', { ascending: false })
        .range(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);

      if (filterActor) {
        query = query.eq('actor_email', filterActor);
      }
      if (filterResource) {
        query = query.eq('resource_type', filterResource);
      }
      if (filterDateFrom) {
        query = query.gte('occurred_at', new Date(filterDateFrom).toISOString());
      }
      if (filterDateTo) {
        const to = new Date(filterDateTo);
        to.setDate(to.getDate() + 1);
        query = query.lt('occurred_at', to.toISOString());
      }

      const { data, error: fetchErr } = await query;

      if (fetchErr) {
        setError(fetchErr.message);
        setLoading(false);
        return;
      }

      const fetched = (data ?? []) as AuditRow[];
      setHasMore(fetched.length > PAGE_SIZE);
      const visible = fetched.slice(0, PAGE_SIZE);

      if (reset || currentPage === 0) {
        setRows(visible);
      } else {
        setRows((prev) => [...prev, ...visible]);
      }

      if (reset || currentPage === 0) {
        const actors = Array.from(
          new Set(
            visible.map((r) => r.actor_email).filter((e): e is string => !!e),
          ),
        ).sort();
        const resources = Array.from(
          new Set(
            visible.map((r) => r.resource_type).filter((r): r is string => !!r),
          ),
        ).sort();
        setActorOptions(actors);
        setResourceOptions(resources);
      }

      setLoading(false);
    },
    [currentOrg, page, filterActor, filterResource, filterDateFrom, filterDateTo],
  );

  useEffect(() => {
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOrg, filterActor, filterResource, filterDateFrom, filterDateTo]);

  function handleExport() {
    if (rows.length === 0) return;
    const exportRows = rows.map((r) => ({
      id: r.id,
      occurred_at: r.occurred_at,
      actor: r.actor_email ?? r.actor_user_id ?? '',
      action: r.action ?? r.operation,
      resource_type: r.resource_type ?? r.table_name,
      resource_id: r.resource_id ?? r.record_id ?? '',
      changes_count: r.changes ? Object.keys(r.changes).length : 0,
    }));
    downloadCsv(`audit-log-${currentOrg?.id ?? 'export'}.csv`, exportRows);
  }

  if (!currentOrg) {
    return (
      <section className="animated-fade-in">
        <h1>Audit Log</h1>
        <p style={{ color: 'var(--text-muted)' }}>Select an organisation first.</p>
      </section>
    );
  }

  return (
    <section className="animated-fade-in" style={{ maxWidth: '950px' }}>
      {/* Back button link */}
      <Link 
        to="/settings" 
        style={{ 
          color: 'var(--text-muted)', 
          fontSize: '0.825rem', 
          display: 'inline-flex', 
          alignItems: 'center', 
          gap: '0.25rem',
          marginBottom: '1rem'
        }}
      >
        <ChevronLeft size={14} />
        <span>Settings</span>
      </Link>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1.5rem',
          flexWrap: 'wrap',
          gap: '0.75rem',
        }}
      >
        <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Search size={24} style={{ color: 'var(--accent-primary)' }} />
          Audit Log
        </h1>
        <button
          onClick={handleExport}
          disabled={rows.length === 0}
          className="btn btn-secondary"
        >
          <Download size={14} />
          <span>Export CSV</span>
        </button>
      </div>

      {/* Filters Toolbar Card */}
      <div 
        className="card" 
        style={{ 
          display: 'flex', 
          gap: '0.75rem', 
          flexWrap: 'wrap', 
          marginBottom: '1.5rem',
          alignItems: 'center',
          padding: '1rem'
        }}
      >
        <select
          value={filterActor}
          onChange={(e) => setFilterActor(e.target.value)}
          className="form-select"
          style={{ width: 'auto', padding: '0.45rem 1.75rem 0.45rem 0.75rem', fontSize: '0.825rem' }}
        >
          <option value="">All actors</option>
          {actorOptions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>

        <select
          value={filterResource}
          onChange={(e) => setFilterResource(e.target.value)}
          className="form-select"
          style={{ width: 'auto', padding: '0.45rem 1.75rem 0.45rem 0.75rem', fontSize: '0.825rem' }}
        >
          <option value="">All resources</option>
          {resourceOptions.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>

        <input
          type="date"
          value={filterDateFrom}
          onChange={(e) => setFilterDateFrom(e.target.value)}
          className="form-input"
          style={{ width: '140px', padding: '0.45rem 0.75rem', fontSize: '0.825rem' }}
          title="From date"
        />
        
        <input
          type="date"
          value={filterDateTo}
          onChange={(e) => setFilterDateTo(e.target.value)}
          className="form-input"
          style={{ width: '140px', padding: '0.45rem 0.75rem', fontSize: '0.825rem' }}
          title="To date"
        />

        {(filterActor || filterResource || filterDateFrom || filterDateTo) && (
          <button
            onClick={() => {
              setFilterActor('');
              setFilterResource('');
              setFilterDateFrom('');
              setFilterDateTo('');
            }}
            className="btn btn-ghost"
            style={{ padding: '0.45rem 0.75rem', fontSize: '0.825rem' }}
          >
            Clear filters
          </button>
        )}
      </div>

      {error && (
        <div className="badge badge-danger" style={{ display: 'block', padding: '0.75rem', marginBottom: '1rem', textTransform: 'none' }}>
          {error}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading audit events…</p>
      ) : rows.length === 0 ? (
        <div style={{ padding: '3rem 1.5rem', background: 'var(--bg-card)', border: '1px dashed var(--border-subtle)', borderRadius: 'var(--radius-md)', textAlign: 'center', color: 'var(--text-muted)' }}>
          No audit events found for the current filters.
        </div>
      ) : (
        <>
          <div style={{ fontSize: '0.825rem', color: 'var(--text-muted)', marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <AlertCircle size={14} />
            <span>Showing {rows.length} events. Click any UPDATE row to expand field-level diff.</span>
          </div>

          <div className="card" style={{ padding: '0 1.25rem' }}>
            {rows.map((row) => (
              <AuditRowItem key={row.id} row={row} />
            ))}
          </div>

          {hasMore && (
            <div style={{ marginTop: '1.5rem', textAlign: 'center' }}>
              <button
                disabled={loading}
                onClick={() => {
                  setPage((p) => p + 1);
                  void load();
                }}
                className="btn btn-secondary"
                style={{ padding: '0.625rem 1.5rem' }}
              >
                {loading ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
