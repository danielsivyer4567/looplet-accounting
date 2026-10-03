import { type CSSProperties, type ReactNode } from 'react';
import { CheckCircle, ExternalLink, FileText, GitBranch, Lock, XCircle } from 'lucide-react';
import { TopDownMindMap, type MindMapBranch } from '@/components/InsightCharts';
import type { AdviceNote } from '@/hooks/useAdviceNotes';

interface AdviceNoteViewProps {
  note: AdviceNote;
  actionBusy?: boolean;
  onSignOff?: (id: string) => void | Promise<void>;
  onDismiss?: (id: string) => void | Promise<void>;
}

const moneyFormatter = new Intl.NumberFormat('en-AU', {
  style: 'currency',
  currency: 'AUD',
});

const integerFormatter = new Intl.NumberFormat('en-AU');

const shellStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
  width: '100%',
};

const panelStyle: CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-md)',
  padding: '1rem',
};

const sectionHeadingStyle: CSSProperties = {
  margin: 0,
  color: 'var(--text-title)',
  fontSize: '0.95rem',
  fontWeight: 700,
};

const mutedTextStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: '0.82rem',
  lineHeight: 1.5,
};

const tableStyle: CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: '0.85rem',
};

const cellStyle: CSSProperties = {
  padding: '0.55rem 0.6rem',
  borderTop: '1px solid var(--border-subtle)',
  verticalAlign: 'top',
};

export function AdviceNoteView({
  note,
  actionBusy = false,
  onSignOff,
  onDismiss,
}: AdviceNoteViewProps) {
  const branches = buildReasoningBranches(note);
  const signedOff = note.registered_agent_signoff_at != null;
  const canSignOff = note.status === 'draft' && !actionBusy && onSignOff != null;
  const canDismiss = note.status !== 'dismissed' && !actionBusy && onDismiss != null;

  return (
    <article style={shellStyle} aria-label={`Advice note: ${note.title}`}>
      <header style={panelStyle}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: '1rem',
            alignItems: 'flex-start',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ minWidth: 0, flex: '1 1 24rem' }}>
            <div
              style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.6rem' }}
            >
              <span className={`badge ${statusBadgeClass(note.status)}`}>
                {statusLabel(note.status)}
              </span>
              <span className="badge badge-info">{kindLabel(note.kind)}</span>
              {signedOff ? <span className="badge badge-success">Signed off</span> : null}
            </div>
            <h2
              style={{
                margin: 0,
                color: 'var(--text-title)',
                fontSize: '1.35rem',
                lineHeight: 1.2,
                letterSpacing: 0,
              }}
            >
              {note.title}
            </h2>
            <p style={{ ...mutedTextStyle, margin: '0.5rem 0 0' }}>
              Created {formatDate(note.created_at)}
              {note.updated_at !== note.created_at
                ? ` - updated ${formatDate(note.updated_at)}`
                : ''}
            </p>
          </div>

          <div
            style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}
          >
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canSignOff}
              onClick={() => void onSignOff?.(note.id)}
              title={
                note.status === 'draft'
                  ? 'Registered-agent sign-off for this advice note'
                  : 'Only draft advice notes can be signed off'
              }
            >
              <CheckCircle size={16} />
              Sign off
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!canDismiss}
              onClick={() => void onDismiss?.(note.id)}
              title="Dismiss this advice note"
            >
              <XCircle size={16} />
              Dismiss
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled
              title="Tier-2 approval actions are wired in a later slice"
            >
              <Lock size={16} />
              Act on this
            </button>
          </div>
        </div>
      </header>

      <section style={panelStyle} aria-labelledby={`summary-${note.id}`}>
        <SectionTitle id={`summary-${note.id}`} icon={<FileText size={16} />} title="Summary" />
        <p
          style={{
            margin: '0.75rem 0 0',
            color: 'var(--text-body)',
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
          }}
        >
          {note.summary}
        </p>
      </section>

      <section style={panelStyle} aria-labelledby={`numbers-${note.id}`}>
        <SectionTitle id={`numbers-${note.id}`} title="Numbers" />
        <RecordTable record={note.numbers} emptyLabel="No quantified numbers were attached." />
      </section>

      <section style={panelStyle} aria-labelledby={`assumptions-${note.id}`}>
        <SectionTitle id={`assumptions-${note.id}`} title="Assumptions" />
        <RecordTable record={note.assumptions} emptyLabel="No assumptions were attached." />
      </section>

      <section style={panelStyle} aria-labelledby={`citations-${note.id}`}>
        <SectionTitle id={`citations-${note.id}`} title="Citations" />
        <CitationList citations={note.citations} />
      </section>

      <section style={panelStyle} aria-labelledby={`reasoning-${note.id}`}>
        <SectionTitle
          id={`reasoning-${note.id}`}
          icon={<GitBranch size={16} />}
          title="Reasoning View"
        />
        <TopDownMindMap root={note.title} branches={branches} />
      </section>

      <section
        style={{
          ...panelStyle,
          background: 'var(--bg-warning-subtle)',
          borderColor: 'var(--border-warning)',
        }}
        aria-labelledby={`disclaimer-${note.id}`}
      >
        <SectionTitle id={`disclaimer-${note.id}`} title="Disclaimer" />
        <p style={{ ...mutedTextStyle, margin: '0.5rem 0 0', color: 'var(--text-warning)' }}>
          {note.disclaimer}
        </p>
      </section>
    </article>
  );
}

function SectionTitle({ id, title, icon }: { id: string; title: string; icon?: ReactNode }) {
  return (
    <h3
      id={id}
      style={{ ...sectionHeadingStyle, display: 'flex', alignItems: 'center', gap: '0.45rem' }}
    >
      {icon}
      {title}
    </h3>
  );
}

function RecordTable({
  record,
  emptyLabel,
}: {
  record: Record<string, unknown>;
  emptyLabel: string;
}) {
  const entries = Object.entries(record);
  if (entries.length === 0)
    return <p style={{ ...mutedTextStyle, margin: '0.75rem 0 0' }}>{emptyLabel}</p>;

  return (
    <div className="table-premium-container" style={{ marginTop: '0.75rem' }}>
      <table style={tableStyle}>
        <tbody>
          {entries.map(([key, value]) => (
            <tr key={key}>
              <th
                scope="row"
                style={{
                  ...cellStyle,
                  width: '32%',
                  textAlign: 'left',
                  color: 'var(--text-muted)',
                  fontWeight: 700,
                }}
              >
                {labelFromKey(key)}
              </th>
              <td style={{ ...cellStyle, color: 'var(--text-body)' }}>
                <ValueCell value={value} fieldName={key} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ValueCell({ value, fieldName }: { value: unknown; fieldName: string }): ReactNode {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span style={mutedTextStyle}>None recorded</span>;
    if (value.every(isRecord)) return <NestedRows rows={value} />;
    return <span>{value.map((item) => formatScalar(item, fieldName)).join(', ')}</span>;
  }

  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return <span style={mutedTextStyle}>Empty object</span>;
    // A map of uniform objects (e.g. structuring options keyed by company /
    // sole_trader / …) reads far better as one row per entry than as a tall
    // stack of label/value pairs.
    if (entries.every(([, item]) => isRecord(item))) {
      return <ObjectMapTable map={value as Record<string, Record<string, unknown>>} />;
    }
    return (
      <dl style={{ display: 'grid', gap: '0.35rem', margin: 0 }}>
        {entries.map(([key, item]) => (
          <div key={key} style={{ display: 'grid', gap: '0.15rem' }}>
            <dt style={{ color: 'var(--text-muted)', fontSize: '0.75rem', fontWeight: 700 }}>
              {labelFromKey(key)}
            </dt>
            <dd style={{ margin: 0 }}>
              <ValueCell value={item} fieldName={key} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }

  return <span>{formatScalar(value, fieldName)}</span>;
}

function NestedRows({ rows }: { rows: Record<string, unknown>[] }) {
  const visibleRows = rows.slice(0, 5);
  const columns = Array.from(new Set(visibleRows.flatMap((row) => Object.keys(row)))).slice(0, 5);

  return (
    <div style={{ display: 'grid', gap: '0.45rem' }}>
      <span style={mutedTextStyle}>
        {rows.length} item{rows.length === 1 ? '' : 's'}
        {rows.length > visibleRows.length ? `, showing first ${visibleRows.length}` : ''}
      </span>
      <div className="table-premium-container">
        <table style={tableStyle}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column}
                  scope="col"
                  style={{
                    ...cellStyle,
                    textAlign: 'left',
                    color: 'var(--text-muted)',
                    fontSize: '0.75rem',
                    fontWeight: 700,
                  }}
                >
                  {labelFromKey(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, index) => (
              <tr key={index}>
                {columns.map((column) => (
                  <td key={column} style={{ ...cellStyle, color: 'var(--text-body)' }}>
                    {formatScalar(row[column], column)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ObjectMapTable({ map }: { map: Record<string, Record<string, unknown>> }) {
  const entries = Object.entries(map);
  // The entry key + its `label` field become the row name, so don't repeat them
  // as their own columns.
  const hidden = new Set(['key', 'label', 'name']);
  const columns = Array.from(new Set(entries.flatMap(([, row]) => Object.keys(row)))).filter(
    (column) => !hidden.has(column.toLowerCase()),
  );

  const isNumericColumn = (column: string) =>
    entries.every(([, row]) => row[column] == null || typeof row[column] === 'number');

  const headStyle: CSSProperties = {
    ...cellStyle,
    borderTop: 0,
    color: 'var(--text-muted)',
    fontSize: '0.75rem',
    fontWeight: 700,
  };

  return (
    <div className="table-premium-container">
      <table style={tableStyle}>
        <thead>
          <tr>
            <th scope="col" style={{ ...headStyle, textAlign: 'left' }} />
            {columns.map((column) => (
              <th
                key={column}
                scope="col"
                style={{ ...headStyle, textAlign: isNumericColumn(column) ? 'right' : 'left' }}
              >
                {labelFromKey(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map(([key, row]) => (
            <tr key={key}>
              <th
                scope="row"
                style={{
                  ...cellStyle,
                  textAlign: 'left',
                  color: 'var(--text-title)',
                  fontWeight: 700,
                  whiteSpace: 'nowrap',
                }}
              >
                {stringFrom(row.label) ?? labelFromKey(key)}
              </th>
              {columns.map((column) => (
                <td
                  key={column}
                  style={{
                    ...cellStyle,
                    textAlign: isNumericColumn(column) ? 'right' : 'left',
                    color: 'var(--text-body)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {formatScalar(row[column], column)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CitationList({ citations }: { citations: unknown[] }) {
  if (citations.length === 0) {
    return <p style={{ ...mutedTextStyle, margin: '0.75rem 0 0' }}>No citations were attached.</p>;
  }

  return (
    <ol style={{ margin: '0.75rem 0 0', paddingLeft: '1.25rem', color: 'var(--text-body)' }}>
      {citations.map((citation, index) => {
        const label = citationLabel(citation, index);
        const url = citationUrl(citation);
        const detail = citationDetail(citation);
        return (
          <li key={`${label}-${index}`} style={{ marginBottom: '0.65rem', lineHeight: 1.45 }}>
            {url ? (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.3rem',
                  color: 'var(--text-link)',
                  textDecoration: 'none',
                  fontWeight: 700,
                }}
              >
                {label}
                <ExternalLink size={13} />
              </a>
            ) : (
              <strong style={{ color: 'var(--text-title)' }}>{label}</strong>
            )}
            {detail ? <div style={mutedTextStyle}>{detail}</div> : null}
          </li>
        );
      })}
    </ol>
  );
}

function buildReasoningBranches(note: AdviceNote): MindMapBranch[] {
  return [
    {
      title: 'Inputs checked',
      detail: keysSummary(note.inputs, 'No structured inputs attached'),
      tone: 'info',
    },
    {
      title: 'Numbers modelled',
      detail: keysSummary(note.numbers, 'No quantified numbers attached'),
      tone: 'primary',
    },
    {
      title: 'Assumptions',
      detail: keysSummary(note.assumptions, 'No assumptions attached'),
      tone: 'warning',
    },
    {
      title: 'Citations',
      detail:
        note.citations.length > 0
          ? `${note.citations.length} source${note.citations.length === 1 ? '' : 's'} attached`
          : 'No citations attached',
      tone: note.citations.length > 0 ? 'success' : 'neutral',
    },
    {
      title: 'Decision state',
      detail: `${statusLabel(note.status)} - ${truncate(note.summary, 120)}`,
      tone: note.status === 'issued' || note.status === 'acted' ? 'success' : 'neutral',
    },
  ];
}

function keysSummary(record: Record<string, unknown>, emptyLabel: string) {
  const keys = Object.keys(record);
  if (keys.length === 0) return emptyLabel;
  return (
    keys.slice(0, 6).map(labelFromKey).join(', ') +
    (keys.length > 6 ? `, +${keys.length - 6} more` : '')
  );
}

function formatScalar(value: unknown, fieldName: string): string {
  if (value == null) return '-';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') {
    const lowerField = fieldName.toLowerCase();
    if (lowerField.includes('cents')) return moneyFormatter.format(value / 100);
    // Basis points → percentage (e.g. effective_tax_rate_bps: 2500 → "25.00%").
    if (lowerField.includes('bps')) return `${(value / 100).toFixed(2)}%`;
    return integerFormatter.format(value);
  }
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function citationLabel(citation: unknown, index: number): string {
  if (typeof citation === 'string') return citation;
  if (!isRecord(citation)) return `Citation ${index + 1}`;

  const title =
    stringFrom(citation.title) ?? stringFrom(citation.doc_ref) ?? stringFrom(citation.source);
  const section = stringFrom(citation.section_ref) ?? stringFrom(citation.section);
  if (title && section) return `${title} ${section}`;
  return title ?? section ?? `Citation ${index + 1}`;
}

function citationDetail(citation: unknown): string | null {
  if (!isRecord(citation)) return null;
  return (
    stringFrom(citation.quoted_text) ??
    stringFrom(citation.text) ??
    stringFrom(citation.summary) ??
    stringFrom(citation.description)
  );
}

function citationUrl(citation: unknown): string | null {
  if (typeof citation === 'string' && /^https?:\/\//i.test(citation)) return citation;
  if (!isRecord(citation)) return null;
  return stringFrom(citation.citation_url) ?? stringFrom(citation.url) ?? stringFrom(citation.href);
}

function stringFrom(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function labelFromKey(key: string): string {
  return key
    .replace(/_cents$/i, '')
    .replace(/_bps$/i, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\bFy\b/g, 'FY')
    .replace(/\bCgt\b/g, 'CGT')
    .replace(/\bFbt\b/g, 'FBT');
}

function kindLabel(kind: AdviceNote['kind']): string {
  return labelFromKey(kind);
}

function statusLabel(status: AdviceNote['status']): string {
  return labelFromKey(status);
}

function statusBadgeClass(status: AdviceNote['status']) {
  switch (status) {
    case 'issued':
    case 'acted':
      return 'badge-success';
    case 'dismissed':
      return 'badge-neutral';
    case 'draft':
    default:
      return 'badge-warning';
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-AU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
