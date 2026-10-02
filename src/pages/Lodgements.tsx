import { useMemo, useState } from 'react';
import { Download, FileCheck2, RefreshCw } from 'lucide-react';
import { SkeletonTable } from '@/components/Skeleton';
import { LodgeReadinessChecklist } from '@/components/lodge/LodgeReadinessChecklist';
import { useBasLodgementPack } from '@/hooks/useBasLodgementPack';
import { useLodgements, type LodgementRow, type LodgementStatus } from '@/hooks/useLodgements';

const MUTED = 'var(--text-muted)';
const TYPE_LABELS: Record<LodgementRow['lodgement_type'], string> = {
  bas: 'BAS',
  stp: 'STP',
  tpar: 'TPAR',
  return: 'Tax return',
  fbt: 'FBT',
  tbar: 'TBAR',
};

function humanize(value: string): string {
  return value.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function formatDateTime(value: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' });
}

function shortHash(value: string): string {
  return value.length > 16 ? `${value.slice(0, 16)}...` : value;
}

function prettyJson(value: unknown): string {
  if (value == null) return '{}';
  try {
    return JSON.stringify(value, null, 2) ?? '{}';
  } catch {
    return String(value);
  }
}

function statusTone(status: LodgementStatus): string {
  if (status === 'accepted') return 'badge-success';
  if (status === 'rejected' || status === 'error') return 'badge-danger';
  if (status === 'submitted' || status === 'queued') return 'badge-info';
  return 'badge-warning';
}

function StatusPill({ status }: { status: LodgementStatus }) {
  return <span className={`badge ${statusTone(status)}`}>{humanize(status)}</span>;
}

function JsonBlock({ value, maxHeight }: { value: unknown; maxHeight: string }) {
  return (
    <pre
      style={{
        maxHeight,
        overflow: 'auto',
        background: 'var(--bg-app)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        padding: '0.75rem',
        fontSize: '0.75rem',
        whiteSpace: 'pre-wrap',
      }}
    >
      {prettyJson(value)}
    </pre>
  );
}

function DetailPanel({
  lodgement,
  packBusy,
  packError,
  onDownloadPack,
}: {
  lodgement: LodgementRow;
  packBusy: boolean;
  packError: string | null;
  onDownloadPack: (lodgement: LodgementRow) => void;
}) {
  const canDownloadPack = lodgement.lodgement_type === 'bas';

  return (
    <aside className="card" style={{ padding: '1rem', alignSelf: 'start' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
        <div>
          <div style={{ fontSize: '0.75rem', color: MUTED, fontWeight: 700 }}>
            {TYPE_LABELS[lodgement.lodgement_type]}
          </div>
          <h2 style={{ margin: '0.2rem 0 0', fontSize: '1.15rem' }}>{lodgement.period_label}</h2>
        </div>
        <StatusPill status={lodgement.status} />
      </div>

      {canDownloadPack && (
        <button
          className="btn btn-secondary"
          type="button"
          onClick={() => onDownloadPack(lodgement)}
          disabled={packBusy}
          style={{ marginTop: '1rem' }}
        >
          <Download size={16} />
          {packBusy ? 'Preparing pack...' : 'Download BAS pack'}
        </button>
      )}

      {packError && (
        <div
          className="badge badge-danger"
          style={{
            display: 'block',
            padding: '0.75rem',
            marginTop: '0.75rem',
            textTransform: 'none',
          }}
        >
          BAS pack unavailable: {packError}
        </div>
      )}

      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'max-content 1fr',
          gap: '0.45rem 0.75rem',
          margin: '1rem 0',
          fontSize: '0.85rem',
        }}
      >
        <dt style={{ color: MUTED }}>Receipt</dt>
        <dd style={{ margin: 0 }}>{lodgement.ato_receipt_id ?? '-'}</dd>
        <dt style={{ color: MUTED }}>Submitted</dt>
        <dd style={{ margin: 0 }}>{formatDateTime(lodgement.submitted_at)}</dd>
        <dt style={{ color: MUTED }}>Payload hash</dt>
        <dd style={{ margin: 0, fontFamily: 'monospace', wordBreak: 'break-all' }}>
          {lodgement.payload_hash}
        </dd>
      </dl>

      {lodgement.error_message && (
        <div
          className="badge badge-danger"
          style={{ display: 'block', padding: '0.75rem', textTransform: 'none' }}
        >
          {lodgement.error_message}
        </div>
      )}

      <h3 style={{ fontSize: '0.9rem', margin: '1rem 0 0.4rem' }}>Submitted payload</h3>
      <JsonBlock value={lodgement.payload} maxHeight="18rem" />

      <h3 style={{ fontSize: '0.9rem', margin: '1rem 0 0.4rem' }}>ATO response</h3>
      <JsonBlock value={lodgement.response} maxHeight="14rem" />
    </aside>
  );
}

export function LodgementsPage() {
  const { lodgements, loading, error, refresh } = useLodgements();
  const { busyId: packBusyId, error: packError, downloadPack } = useBasLodgementPack();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(
    () => lodgements.find((item) => item.id === selectedId) ?? null,
    [lodgements, selectedId],
  );

  const acceptedCount = lodgements.filter((item) => item.status === 'accepted').length;
  const problemCount = lodgements.filter(
    (item) => item.status === 'rejected' || item.status === 'error',
  ).length;

  return (
    <section className="animated-fade-in">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '1rem',
          flexWrap: 'wrap',
          marginBottom: '1rem',
        }}
      >
        <div>
          <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <FileCheck2 size={24} style={{ color: 'var(--text-link)' }} />
            Lodgements
          </h1>
          <p style={{ color: MUTED, margin: '0.35rem 0 0', maxWidth: '48rem' }}>
            Read-only history of ATO/SBR lodgement ledger rows, including receipts, status and the
            submitted payload used for audit review.
          </p>
        </div>
        <button className="btn btn-secondary" type="button" onClick={() => void refresh()}>
          <RefreshCw size={16} />
          Refresh
        </button>
      </div>

      <LodgeReadinessChecklist />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: '0.75rem',
          marginBottom: '1rem',
        }}
      >
        <Kpi label="Total" value={lodgements.length} />
        <Kpi label="Accepted" value={acceptedCount} tone="success" />
        <Kpi
          label="Needs attention"
          value={problemCount}
          tone={problemCount > 0 ? 'danger' : 'neutral'}
        />
      </div>

      {loading ? (
        <SkeletonTable rows={5} cols={6} />
      ) : error ? (
        <div
          className="badge badge-danger"
          style={{ display: 'block', padding: '1rem', textTransform: 'none' }}
        >
          Lodgement history unavailable: {error}
        </div>
      ) : lodgements.length === 0 ? (
        <div
          style={{
            padding: '2.5rem 1.5rem',
            background: 'var(--bg-card)',
            border: '1px dashed var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            textAlign: 'center',
            color: MUTED,
          }}
        >
          No lodgement records yet. Rows will appear here after the lodgement ledger is populated.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '1rem' }}>
          <div className="table-premium-container">
            <table className="table-premium">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Period</th>
                  <th>Status</th>
                  <th>Receipt</th>
                  <th>Submitted</th>
                  <th>Payload hash</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lodgements.map((item) => (
                  <tr key={item.id}>
                    <td style={{ fontWeight: 600 }}>{TYPE_LABELS[item.lodgement_type]}</td>
                    <td>{item.period_label}</td>
                    <td>
                      <StatusPill status={item.status} />
                    </td>
                    <td>{item.ato_receipt_id ?? <span style={{ color: MUTED }}>-</span>}</td>
                    <td style={{ fontSize: '0.825rem' }}>{formatDateTime(item.submitted_at)}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}>
                      {shortHash(item.payload_hash)}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        className="btn btn-ghost btn-sm"
                        type="button"
                        onClick={() => setSelectedId(item.id)}
                      >
                        View payload
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {selected && (
            <DetailPanel
              lodgement={selected}
              packBusy={packBusyId === selected.id}
              packError={packError}
              onDownloadPack={(lodgement) => {
                void downloadPack(lodgement);
              }}
            />
          )}
        </div>
      )}
    </section>
  );
}

function Kpi({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  tone?: 'neutral' | 'success' | 'danger';
}) {
  const color =
    tone === 'success'
      ? 'var(--accent-success)'
      : tone === 'danger'
        ? 'var(--accent-danger)'
        : 'var(--text-title)';

  return (
    <div className="card" style={{ padding: '0.85rem 1rem' }}>
      <div style={{ color: MUTED, fontSize: '0.75rem', fontWeight: 700 }}>{label}</div>
      <div style={{ color, fontSize: '1.45rem', fontWeight: 800, marginTop: '0.2rem' }}>
        {value}
      </div>
    </div>
  );
}
