import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { downloadCsv } from '@/lib/csv';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const inputStyle: React.CSSProperties = {
  background: '#1a1a1a',
  border: '1px solid #333',
  borderRadius: 4,
  color: '#eee',
  padding: '0.35rem 0.6rem',
  fontSize: 12,
};

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: 'pointer',
};

function operationColor(op: string): string {
  switch (op?.toUpperCase()) {
    case 'INSERT':
      return '#86c7a3';
    case 'UPDATE':
    case 'ROLE_CHANGE':
      return '#d2c886';
    case 'DELETE':
    case 'VOID':
      return '#c88';
    case 'INVITE':
    case 'ACCEPT':
      return '#7799d6';
    default:
      return '#888';
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
    <table
      style={{
        fontSize: 11,
        borderCollapse: 'collapse',
        width: '100%',
        marginTop: '0.5rem',
      }}
    >
      <thead>
        <tr style={{ color: '#555' }}>
          <th style={{ textAlign: 'left', padding: '0.2rem 0.4rem' }}>Field</th>
          <th style={{ textAlign: 'left', padding: '0.2rem 0.4rem', color: '#c88' }}>Before</th>
          <th style={{ textAlign: 'left', padding: '0.2rem 0.4rem', color: '#86c7a3' }}>After</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(changes).map(([col, [old, next]]) => (
          <tr key={col} style={{ borderTop: '1px solid #222' }}>
            <td style={{ padding: '0.2rem 0.4rem', color: '#888', fontFamily: 'monospace' }}>
              {col}
            </td>
            <td style={{ padding: '0.2rem 0.4rem', color: '#c88', fontFamily: 'monospace', wordBreak: 'break-all' }}>
              {JSON.stringify(old)}
            </td>
            <td style={{ padding: '0.2rem 0.4rem', color: '#86c7a3', fontFamily: 'monospace', wordBreak: 'break-all' }}>
              {JSON.stringify(next)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Row component
// ---------------------------------------------------------------------------

function AuditRowItem({ row }: { row: AuditRow }) {
  const [expanded, setExpanded] = useState(false);
  const op = row.action ?? row.operation;
  const resourceType = row.resource_type ?? row.table_name;
  const resourceId = row.resource_id ?? row.record_id;

  return (
    <div
      style={{
        borderBottom: '1px solid #1e1e1e',
        padding: '0.75rem 0',
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
        <span
          style={{
            fontFamily: 'monospace',
            fontSize: 11,
            color: operationColor(op),
            background: '#1e1e1e',
            padding: '0.15rem 0.4rem',
            borderRadius: 3,
            minWidth: 60,
            textAlign: 'center',
          }}
        >
          {op}
        </span>

        {/* Resource */}
        <span style={{ fontSize: 12, color: '#aaa', fontFamily: 'monospace' }}>
          {resourceType}
          {resourceId ? (
            <span style={{ color: '#555' }}>#{resourceId.slice(0, 8)}</span>
          ) : null}
        </span>

        {/* Actor */}
        <span style={{ fontSize: 12, color: '#666', marginLeft: 'auto' }}>
          {row.actor_email ?? (row.actor_user_id ? row.actor_user_id.slice(0, 8) + '…' : 'system')}
        </span>

        {/* Timestamp */}
        <span style={{ fontSize: 11, color: '#555' }}>
          {formatTimestamp(row.occurred_at)}
        </span>

        {/* Expand indicator */}
        {row.changes && (
          <span style={{ color: '#555', fontSize: 11 }}>
            {expanded ? '▲' : '▼'} {Object.keys(row.changes).length} field(s) changed
          </span>
        )}
      </div>

      {expanded && row.changes && (
        <div
          style={{
            marginTop: '0.5rem',
            background: '#111',
            border: '1px solid #222',
            borderRadius: 4,
            padding: '0.5rem',
          }}
        >
          <JsonDiff changes={row.changes as Record<string, [unknown, unknown]>} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

const PAGE_SIZE = 50;

export function AuditLogPage() {
  const { currentOrg } = useOrg();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  // Filters
  const [filterActor, setFilterActor] = useState('');
  const [filterResource, setFilterResource] = useState('');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');

  // Available filter values derived from loaded rows
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
        // Include the whole "to" day
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

      // Build filter option sets from all loaded rows
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

  // Initial load + re-load when org changes
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
      <section>
        <h1>Audit Log</h1>
        <p style={{ color: '#888' }}>Select an organisation first.</p>
      </section>
    );
  }

  return (
    <section>
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
        <h1 style={{ margin: 0 }}>Audit Log</h1>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <Link to="/settings/team" style={{ color: '#86c7a3', fontSize: 13 }}>
            &larr; Team
          </Link>
          <button
            onClick={handleExport}
            disabled={rows.length === 0}
            style={{
              padding: '0.35rem 0.9rem',
              borderRadius: 4,
              fontSize: 13,
              cursor: rows.length > 0 ? 'pointer' : 'not-allowed',
              border: '1px solid #444',
              background: 'transparent',
              color: rows.length > 0 ? '#aaa' : '#555',
            }}
          >
            Export CSV
          </button>
        </div>
      </div>

      {/* Filters */}
      <div
        style={{
          display: 'flex',
          gap: '0.75rem',
          flexWrap: 'wrap',
          marginBottom: '1.25rem',
          alignItems: 'center',
        }}
      >
        <select
          value={filterActor}
          onChange={(e) => setFilterActor(e.target.value)}
          style={selectStyle}
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
          style={selectStyle}
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
          style={inputStyle}
          title="From date"
        />
        <input
          type="date"
          value={filterDateTo}
          onChange={(e) => setFilterDateTo(e.target.value)}
          style={inputStyle}
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
            style={{
              fontSize: 12,
              color: '#888',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: '0.35rem 0.4rem',
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {error && (
        <p style={{ color: '#c88', fontSize: 13, marginBottom: '1rem' }}>{error}</p>
      )}

      {loading && rows.length === 0 ? (
        <p style={{ color: '#888', fontSize: 13 }}>Loading audit events…</p>
      ) : rows.length === 0 ? (
        <p style={{ color: '#555', fontSize: 13 }}>
          No audit events found for the current filters.
        </p>
      ) : (
        <>
          <div style={{ fontSize: 12, color: '#555', marginBottom: '0.75rem' }}>
            Showing {rows.length} events. Click any UPDATE row to expand field-level diff.
          </div>

          <div>
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
                style={{
                  padding: '0.5rem 1.5rem',
                  borderRadius: 4,
                  fontSize: 13,
                  cursor: 'pointer',
                  border: '1px solid #444',
                  background: 'transparent',
                  color: '#aaa',
                }}
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
