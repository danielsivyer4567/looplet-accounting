import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import {
  useAssurance,
  type AtoCorrespondenceDraftRow,
  type AtoCorrespondenceRow,
  type WorkingPapersResult,
} from '@/hooks/useAssurance';
import { downloadCsv } from '@/lib/csv';
import { orgTimeZone, startOfFinancialYear, todayLocal } from '@/lib/localDates';
import { SkeletonTable } from '@/components/Skeleton';
import {
  CheckCircle,
  ChevronLeft,
  Download,
  User,
  Calendar,
  Search,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  FileText,
  MessageSquare,
  Package,
  RefreshCw,
  Send,
  ShieldCheck,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';

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
          color: 'var(--text-body)',
        }}
      >
        <thead>
          <tr
            style={{ color: 'var(--text-muted)', borderBottom: '1px solid var(--border-subtle)' }}
          >
            <th style={{ textAlign: 'left', padding: '0.4rem 0.5rem' }}>Field</th>
            <th
              style={{ textAlign: 'left', padding: '0.4rem 0.5rem', color: 'var(--text-danger)' }}
            >
              Before
            </th>
            <th
              style={{ textAlign: 'left', padding: '0.4rem 0.5rem', color: 'var(--text-success)' }}
            >
              After
            </th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(changes).map(([col, [old, next]]) => (
            <tr key={col} style={{ borderBottom: '1px dashed var(--border-subtle)' }}>
              <td
                style={{
                  padding: '0.4rem 0.5rem',
                  color: 'var(--text-title)',
                  fontFamily: 'var(--font-mono, monospace)',
                }}
              >
                {col}
              </td>
              <td
                style={{
                  padding: '0.4rem 0.5rem',
                  color: 'var(--text-danger)',
                  fontFamily: 'var(--font-mono, monospace)',
                  wordBreak: 'break-all',
                }}
              >
                {old === null ? (
                  <span style={{ fontStyle: 'italic', opacity: 0.5 }}>null</span>
                ) : (
                  JSON.stringify(old)
                )}
              </td>
              <td
                style={{
                  padding: '0.4rem 0.5rem',
                  color: 'var(--text-success)',
                  fontFamily: 'var(--font-mono, monospace)',
                  wordBreak: 'break-all',
                }}
              >
                {next === null ? (
                  <span style={{ fontStyle: 'italic', opacity: 0.5 }}>null</span>
                ) : (
                  JSON.stringify(next)
                )}
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
        <span
          className={`badge ${operationBadgeClass(op)}`}
          style={{ minWidth: '70px', textAlign: 'center', justifyContent: 'center' }}
        >
          {op}
        </span>

        {/* Resource details */}
        <span
          style={{
            fontSize: '0.825rem',
            color: 'var(--text-title)',
            fontFamily: 'var(--font-mono, monospace)',
          }}
        >
          {resourceType}
          {resourceId ? (
            <span style={{ color: 'var(--text-muted)', marginLeft: '0.25rem' }}>
              #{resourceId.slice(0, 8)}
            </span>
          ) : null}
        </span>

        {/* Actor */}
        <span
          style={{
            fontSize: '0.825rem',
            color: 'var(--text-muted)',
            marginLeft: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.25rem',
          }}
        >
          <User size={12} />
          {row.actor_email ?? (row.actor_user_id ? row.actor_user_id.slice(0, 8) + '…' : 'system')}
        </span>

        {/* Timestamp */}
        <span
          style={{
            fontSize: '0.75rem',
            color: 'var(--text-muted)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.25rem',
          }}
        >
          <Calendar size={12} />
          {formatTimestamp(row.occurred_at)}
        </span>

        {/* Expand indicator */}
        {row.changes && (
          <span
            className="badge badge-neutral"
            style={{
              fontSize: '0.725rem',
              textTransform: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.25rem',
            }}
          >
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

/** 1 July of the current financial year, judged on today's date in the org's time zone. */
function defaultPeriodStart(timeZone: string): string {
  return startOfFinancialYear(todayLocal(timeZone));
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleDateString();
  } catch {
    return value;
  }
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'closed':
    case 'responded':
    case 'approved':
    case 'sent':
      return 'badge-success';
    case 'in_review':
    case 'ready_for_review':
      return 'badge-warning';
    case 'rejected':
      return 'badge-danger';
    case 'drafted':
    case 'draft':
    case 'received':
      return 'badge-info';
    default:
      return 'badge-neutral';
  }
}

function sourceDocLabel(row: AtoCorrespondenceRow): string {
  const source = row.source_doc_ref ?? {};
  const filename = source.filename ?? source.original_filename ?? source.storage_key;
  return typeof filename === 'string' && filename.trim() ? filename : 'No source file linked';
}

function evidenceCount(draft: AtoCorrespondenceDraftRow): number {
  return Array.isArray(draft.evidence) ? draft.evidence.length : 0;
}

function resolvedEvidenceCount(draft: AtoCorrespondenceDraftRow): number {
  return Array.isArray(draft.evidence) ? draft.evidence.filter((item) => item.resolved).length : 0;
}

function WorkingPapersPanel({
  periodStart,
  periodEnd,
  setPeriodStart,
  setPeriodEnd,
  workingPapers,
  actionBusy,
  onCompile,
  onDownload,
}: {
  periodStart: string;
  periodEnd: string;
  setPeriodStart: (value: string) => void;
  setPeriodEnd: (value: string) => void;
  workingPapers: WorkingPapersResult | null;
  actionBusy: string | null;
  onCompile: () => void;
  onDownload: () => void;
}) {
  const bundle = workingPapers?.bundle;
  const busy = actionBusy === 'working-papers';

  return (
    <div className="card" style={{ padding: '1rem' }}>
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
        <Package size={20} style={{ color: 'var(--text-link)', flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: '1rem' }}>Working papers</h2>
          <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.825rem' }}>
            Compile the closed-period bundle and index PDF for review.
          </p>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))',
          gap: '0.75rem',
          marginTop: '1rem',
        }}
      >
        <label
          style={{
            display: 'grid',
            gap: '0.35rem',
            fontSize: '0.75rem',
            color: 'var(--text-muted)',
          }}
        >
          Period start
          <input
            type="date"
            value={periodStart}
            onChange={(e) => setPeriodStart(e.target.value)}
            className="form-input"
          />
        </label>
        <label
          style={{
            display: 'grid',
            gap: '0.35rem',
            fontSize: '0.75rem',
            color: 'var(--text-muted)',
          }}
        >
          Period end
          <input
            type="date"
            value={periodEnd}
            onChange={(e) => setPeriodEnd(e.target.value)}
            className="form-input"
          />
        </label>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '1rem' }}>
        <button className="btn btn-primary" onClick={onCompile} disabled={busy}>
          <RefreshCw size={14} />
          <span>{busy ? 'Compiling…' : 'Compile bundle'}</span>
        </button>
        <button
          className="btn btn-secondary"
          onClick={onDownload}
          disabled={!workingPapers?.pdf_base64 || !bundle}
        >
          <Download size={14} />
          <span>Download index PDF</span>
        </button>
      </div>

      {bundle ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
            gap: '0.6rem',
            marginTop: '1rem',
            fontSize: '0.8rem',
          }}
        >
          <span className={`badge ${bundle.complete ? 'badge-success' : 'badge-warning'}`}>
            {bundle.complete ? 'Complete' : 'Needs review'}
          </span>
          <span style={{ color: 'var(--text-muted)' }}>
            {bundle.source_files.length} source files
          </span>
          <span style={{ color: 'var(--text-muted)' }}>
            {bundle.checks.unresolved_source_file_count} unresolved
          </span>
          <span style={{ color: 'var(--text-muted)' }}>{formatDate(bundle.generated_at)}</span>
        </div>
      ) : (
        <p style={{ margin: '1rem 0 0', color: 'var(--text-muted)', fontSize: '0.825rem' }}>
          No bundle compiled in this session.
        </p>
      )}
    </div>
  );
}

function CorrespondencePanel({
  correspondence,
  loading,
  requestedOutcome,
  setRequestedOutcome,
  actionBusy,
  onDraft,
}: {
  correspondence: AtoCorrespondenceRow[];
  loading: boolean;
  requestedOutcome: string;
  setRequestedOutcome: (value: string) => void;
  actionBusy: string | null;
  onDraft: (id: string) => void;
}) {
  return (
    <div className="card" style={{ padding: '1rem' }}>
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
        <FileText size={20} style={{ color: 'var(--text-link)', flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: '1rem' }}>ATO correspondence</h2>
          <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.825rem' }}>
            Review notices, source files, due dates, and draftable response work.
          </p>
        </div>
      </div>

      <label
        style={{
          display: 'grid',
          gap: '0.35rem',
          marginTop: '1rem',
          fontSize: '0.75rem',
          color: 'var(--text-muted)',
        }}
      >
        Requested outcome for new drafts
        <textarea
          className="form-input"
          value={requestedOutcome}
          onChange={(e) => setRequestedOutcome(e.target.value)}
          rows={3}
          style={{ resize: 'vertical', minHeight: '76px' }}
        />
      </label>

      {loading ? (
        <div aria-busy="true" aria-label="Loading correspondence">
          <SkeletonTable rows={3} cols={4} />
        </div>
      ) : correspondence.length === 0 ? (
        <EmptyState>No ATO correspondence is recorded for this organisation.</EmptyState>
      ) : (
        <div style={{ overflowX: 'auto', marginTop: '1rem' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.825rem' }}>
            <thead>
              <tr
                style={{
                  color: 'var(--text-muted)',
                  borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                <th style={{ textAlign: 'left', padding: '0.5rem' }}>Notice</th>
                <th style={{ textAlign: 'left', padding: '0.5rem' }}>Status</th>
                <th style={{ textAlign: 'left', padding: '0.5rem' }}>Due</th>
                <th style={{ textAlign: 'left', padding: '0.5rem' }}>Source</th>
                <th style={{ textAlign: 'right', padding: '0.5rem' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {correspondence.map((row) => {
                const busy = actionBusy === `draft:${row.id}`;
                return (
                  <tr key={row.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <td style={{ padding: '0.65rem 0.5rem', minWidth: '220px' }}>
                      <div style={{ color: 'var(--text-title)', fontWeight: 600 }}>
                        {row.subject ?? row.notice_type}
                      </div>
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                        {row.notice_type}
                        {row.ato_reference ? ` · ${row.ato_reference}` : ''}
                      </div>
                    </td>
                    <td style={{ padding: '0.65rem 0.5rem' }}>
                      <span className={`badge ${statusBadgeClass(row.status)}`}>{row.status}</span>
                    </td>
                    <td style={{ padding: '0.65rem 0.5rem', color: 'var(--text-muted)' }}>
                      {formatDate(row.due_date)}
                    </td>
                    <td
                      style={{
                        padding: '0.65rem 0.5rem',
                        color: 'var(--text-muted)',
                        maxWidth: '180px',
                        wordBreak: 'break-word',
                      }}
                    >
                      {sourceDocLabel(row)}
                    </td>
                    <td style={{ padding: '0.65rem 0.5rem', textAlign: 'right' }}>
                      <button
                        className="btn btn-secondary"
                        onClick={() => onDraft(row.id)}
                        disabled={busy}
                        style={{ padding: '0.45rem 0.65rem', whiteSpace: 'nowrap' }}
                      >
                        <MessageSquare size={14} />
                        <span>{busy ? 'Drafting…' : 'Draft response'}</span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DraftsPanel({
  drafts,
  correspondence,
  loading,
  actionBusy,
  onRequestApproval,
}: {
  drafts: AtoCorrespondenceDraftRow[];
  correspondence: AtoCorrespondenceRow[];
  loading: boolean;
  actionBusy: string | null;
  onRequestApproval: (id: string) => void;
}) {
  const noticeById = new Map(correspondence.map((row) => [row.id, row]));

  return (
    <div className="card" style={{ padding: '1rem' }}>
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
        <ShieldCheck size={20} style={{ color: 'var(--text-link)', flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: '1rem' }}>Draft responses</h2>
          <p style={{ margin: '0.25rem 0 0', color: 'var(--text-muted)', fontSize: '0.825rem' }}>
            Review draft status, evidence coverage, and approval requests.
          </p>
        </div>
        <Link className="btn btn-ghost" to="/approvals" style={{ padding: '0.45rem 0.65rem' }}>
          <CheckCircle size={14} />
          <span>Approvals</span>
        </Link>
      </div>

      {loading ? (
        <div aria-busy="true" aria-label="Loading correspondence drafts">
          <SkeletonTable rows={3} cols={5} />
        </div>
      ) : drafts.length === 0 ? (
        <EmptyState>No draft ATO responses have been created yet.</EmptyState>
      ) : (
        <div style={{ display: 'grid', gap: '0.75rem', marginTop: '1rem' }}>
          {drafts.map((draft) => {
            const notice = noticeById.get(draft.correspondence_id);
            const busy = actionBusy === `send:${draft.id}`;
            return (
              <div
                key={draft.id}
                style={{
                  borderTop: '1px solid var(--border-subtle)',
                  paddingTop: '0.75rem',
                  minWidth: 0,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    gap: '0.6rem',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        color: 'var(--text-title)',
                        fontWeight: 600,
                        overflowWrap: 'anywhere',
                      }}
                    >
                      {draft.subject}
                    </div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                      {notice?.ato_reference ?? notice?.notice_type ?? 'Unlinked notice'} ·{' '}
                      {formatTimestamp(draft.created_at)}
                    </div>
                  </div>
                  <span className={`badge ${statusBadgeClass(draft.status)}`}>{draft.status}</span>
                </div>

                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '0.6rem',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginTop: '0.75rem',
                    color: 'var(--text-muted)',
                    fontSize: '0.8rem',
                  }}
                >
                  <span>
                    Evidence: {resolvedEvidenceCount(draft)} / {evidenceCount(draft)} resolved
                  </span>
                  <span
                    style={{
                      fontFamily: draft.approval_id ? 'var(--font-mono, monospace)' : undefined,
                    }}
                  >
                    Approval: {draft.approval_id ? draft.approval_id.slice(0, 8) : 'not requested'}
                  </span>
                  <button
                    className="btn btn-secondary"
                    onClick={() => onRequestApproval(draft.id)}
                    disabled={busy || draft.status === 'sent'}
                    style={{ padding: '0.45rem 0.65rem' }}
                  >
                    <Send size={14} />
                    <span>{busy ? 'Checking…' : 'Request send approval'}</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const PAGE_SIZE = 50;

export function AuditLogPage() {
  const { currentOrg } = useOrg();
  const {
    correspondence,
    drafts,
    workingPapers,
    loading: assuranceLoading,
    error: assuranceError,
    actionBusy,
    actionMessage,
    refresh: refreshAssurance,
    compileWorkingPapers,
    draftCorrespondence,
    requestSendApproval,
    downloadWorkingPapersPdf,
  } = useAssurance();
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
  const [periodStart, setPeriodStart] = useState(() => defaultPeriodStart(orgTimeZone(currentOrg)));
  const [periodEnd, setPeriodEnd] = useState(() => todayLocal(orgTimeZone(currentOrg)));
  const [requestedOutcome, setRequestedOutcome] = useState(
    'Prepare a concise draft response for registered-agent review, grounded in the notice, source documents, working papers, and current ATO guidance.',
  );

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
          new Set(visible.map((r) => r.actor_email).filter((e): e is string => !!e)),
        ).sort();
        const resources = Array.from(
          new Set(visible.map((r) => r.resource_type).filter((r): r is string => !!r)),
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

  function handleCompileWorkingPapers() {
    void compileWorkingPapers(periodStart, periodEnd);
  }

  function handleDraftCorrespondence(correspondenceId: string) {
    void draftCorrespondence(correspondenceId, requestedOutcome, periodStart, periodEnd);
  }

  function handleRequestSendApproval(draftId: string) {
    void requestSendApproval(draftId);
  }

  if (!currentOrg) {
    return (
      <section className="animated-fade-in">
        <h1>Assurance</h1>
        <p style={{ color: 'var(--text-muted)' }}>Select an organisation first.</p>
      </section>
    );
  }

  return (
    <section className="animated-fade-in" style={{ maxWidth: '1180px' }}>
      {/* Back button link */}
      <Link
        to="/settings"
        style={{
          color: 'var(--text-muted)',
          fontSize: '0.825rem',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.25rem',
          marginBottom: '1rem',
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
        <PageHeader title={<><ShieldCheck size={24} style={{ color: 'var(--text-link)' }} /> Assurance</>} />
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            onClick={() => {
              void refreshAssurance();
              void load(true);
            }}
            disabled={assuranceLoading || loading}
            className="btn btn-secondary"
          >
            <RefreshCw size={14} />
            <span>Refresh</span>
          </button>
          <button onClick={handleExport} disabled={rows.length === 0} className="btn btn-secondary">
            <Download size={14} />
            <span>Export audit CSV</span>
          </button>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: '1rem',
          marginBottom: '1rem',
        }}
      >
        <WorkingPapersPanel
          periodStart={periodStart}
          periodEnd={periodEnd}
          setPeriodStart={setPeriodStart}
          setPeriodEnd={setPeriodEnd}
          workingPapers={workingPapers}
          actionBusy={actionBusy}
          onCompile={handleCompileWorkingPapers}
          onDownload={downloadWorkingPapersPdf}
        />
        <DraftsPanel
          drafts={drafts}
          correspondence={correspondence}
          loading={assuranceLoading}
          actionBusy={actionBusy}
          onRequestApproval={handleRequestSendApproval}
        />
      </div>

      <div style={{ marginBottom: '1.5rem' }}>
        <CorrespondencePanel
          correspondence={correspondence}
          loading={assuranceLoading}
          requestedOutcome={requestedOutcome}
          setRequestedOutcome={setRequestedOutcome}
          actionBusy={actionBusy}
          onDraft={handleDraftCorrespondence}
        />
      </div>

      {(assuranceError || actionMessage) && (
        <div
          className={`badge ${assuranceError ? 'badge-danger' : 'badge-info'}`}
          style={{
            display: 'block',
            padding: '0.75rem',
            marginBottom: '1.5rem',
            textTransform: 'none',
            whiteSpace: 'normal',
          }}
        >
          {assuranceError ?? actionMessage}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.75rem',
          flexWrap: 'wrap',
          marginBottom: '0.75rem',
        }}
      >
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Search size={20} style={{ color: 'var(--text-link)' }} />
          Audit trail
        </h2>
        <span style={{ color: 'var(--text-muted)', fontSize: '0.825rem' }}>
          Org-scoped event history for assurance review.
        </span>
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
          padding: '1rem',
        }}
      >
        <select
          value={filterActor}
          onChange={(e) => setFilterActor(e.target.value)}
          className="form-select"
          style={{
            width: 'auto',
            padding: '0.45rem 1.75rem 0.45rem 0.75rem',
            fontSize: '0.825rem',
          }}
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
          style={{
            width: 'auto',
            padding: '0.45rem 1.75rem 0.45rem 0.75rem',
            fontSize: '0.825rem',
          }}
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
        <div
          className="badge badge-danger"
          style={{
            display: 'block',
            padding: '0.75rem',
            marginBottom: '1rem',
            textTransform: 'none',
          }}
        >
          {error}
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div aria-busy="true" aria-label="Loading audit events">
          <SkeletonTable rows={6} cols={6} />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState>No audit events found for the current filters.</EmptyState>
      ) : (
        <>
          <div
            style={{
              fontSize: '0.825rem',
              color: 'var(--text-muted)',
              marginBottom: '0.75rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
            }}
          >
            <AlertCircle size={14} />
            <span>
              Showing {rows.length} events. Click any UPDATE row to expand field-level diff.
            </span>
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
