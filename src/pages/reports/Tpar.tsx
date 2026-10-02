import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ChevronLeft,
  ClipboardList,
  Download,
  FileText,
  Hash,
  Users,
} from 'lucide-react';
import {
  latestCompletedTparFyStartYear,
  tparFyLabel,
  type TparReportPayload,
  type TparSupplierRow,
  useTparReport,
} from '@/hooks/useTparReport';
import { downloadCsv } from '@/lib/csv';
import { formatMoney } from '@/lib/money';

function formatDate(value: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-AU', { dateStyle: 'medium' });
}

function currentYearOptions(base = latestCompletedTparFyStartYear()): number[] {
  return [0, 1, 2, 3, 4].map((offset) => base - offset);
}

export function TparReportPage() {
  const latestFy = latestCompletedTparFyStartYear();
  const [fyStartYear, setFyStartYear] = useState(latestFy);
  const { tparReport, loading, error } = useTparReport(fyStartYear);
  const fyOptions = useMemo(() => currentYearOptions(latestFy), [latestFy]);

  const handleExport = () => {
    if (!tparReport || tparReport.suppliers.length === 0) return;
    const today = new Date().toISOString().slice(0, 10);
    const filename = `${tparReport.export.filename.replace(/\.csv$/i, '')}-export-${today}.csv`;
    downloadCsv(
      filename,
      tparReport.suppliers.map((supplier) => ({
        'Supplier name': supplier.supplier_name,
        ABN: supplier.supplier_abn ?? '',
        'Gross payments': (supplier.gross_paid_cents / 100).toFixed(2),
        'GST component': (supplier.gst_component_cents / 100).toFixed(2),
        'Net payments': (supplier.net_paid_cents / 100).toFixed(2),
        'Payment count': supplier.payment_count,
        'Bill count': supplier.bill_count,
        'First payment': supplier.first_payment_date ?? '',
        'Last payment': supplier.last_payment_date ?? '',
        'Missing ABN': supplier.missing_abn ? 'Yes' : 'No',
        'Missing GST rows': supplier.missing_gst_count,
      })),
    );
  };

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
        <Link
          to="/reports"
          style={{
            color: 'var(--text-muted)',
            fontSize: '0.825rem',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.25rem',
          }}
        >
          <ChevronLeft size={14} />
          <span>Reports</span>
        </Link>

        {tparReport && tparReport.suppliers.length > 0 && (
          <button className="btn btn-secondary" type="button" onClick={handleExport}>
            <Download size={14} />
            <span>Export CSV</span>
          </button>
        )}
      </div>

      <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <ClipboardList size={24} style={{ color: 'var(--text-link)' }} />
        TPAR
      </h1>
      <p
        style={{
          color: 'var(--text-muted)',
          fontSize: '0.875rem',
          marginTop: '0.25rem',
          marginBottom: '1.5rem',
          maxWidth: '820px',
          lineHeight: '1.5',
        }}
      >
        Taxable Payments Annual Report export for paid subcontractor bills and paid payment-run
        items. Reportable rows come from subcontractor coding or supplier intake rules.
      </p>

      <div className="card" style={{ padding: '1.25rem 1.5rem', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label className="form-label" htmlFor="tpar-fy">
              Financial year
            </label>
            <select
              id="tpar-fy"
              className="form-select"
              value={fyStartYear}
              onChange={(e) => setFyStartYear(Number(e.target.value))}
              disabled={loading}
              style={{ minWidth: '160px' }}
            >
              {fyOptions.map((fy) => (
                <option key={fy} value={fy}>
                  {tparFyLabel(fy)}
                </option>
              ))}
            </select>
          </div>
          {tparReport && (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.825rem' }}>
              {formatDate(tparReport.period_start)} - {formatDate(tparReport.period_end)} · due{' '}
              {formatDate(tparReport.due_date)}
            </div>
          )}
        </div>
      </div>

      {error && (
        <Banner>
          <strong>TPAR report unavailable.</strong> {error}
        </Banner>
      )}

      {loading ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading TPAR report...</p>
      ) : tparReport ? (
        <>
          {tparReport.warnings.length > 0 && <Warnings warnings={tparReport.warnings} />}
          <Kpis tparReport={tparReport} />
          <SuppliersCard suppliers={tparReport.suppliers} />
          <EvidenceCard tparReport={tparReport} />
        </>
      ) : (
        <Empty>No TPAR report is available for this financial year.</Empty>
      )}
    </section>
  );
}

function Kpis({ tparReport }: { tparReport: TparReportPayload }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
        gap: '1rem',
        marginBottom: '1.5rem',
      }}
    >
      <Kpi label="Payees" value={String(tparReport.summary.supplier_count)} icon={Users} />
      <Kpi
        label="Gross payments"
        value={formatMoney(tparReport.summary.gross_paid_cents)}
        icon={ClipboardList}
      />
      <Kpi
        label="GST component"
        value={formatMoney(tparReport.summary.gst_component_cents)}
        icon={FileText}
      />
      <Kpi label="Missing ABNs" value={String(tparReport.summary.missing_abn_count)} icon={Hash} />
    </div>
  );
}

function SuppliersCard({ suppliers }: { suppliers: TparSupplierRow[] }) {
  return (
    <Card title="Reportable payees" icon={Users}>
      {suppliers.length === 0 ? (
        <Empty>No paid subcontractor bills or supplier intake rules found for this year.</Empty>
      ) : (
        <div className="table-premium-container">
          <table className="table-premium">
            <thead>
              <tr>
                <th>Payee</th>
                <th>ABN</th>
                <th>Period paid</th>
                <th style={{ textAlign: 'right' }}>Gross</th>
                <th style={{ textAlign: 'right' }}>GST</th>
                <th style={{ textAlign: 'right' }}>Bills</th>
              </tr>
            </thead>
            <tbody>
              {suppliers.map((supplier) => (
                <tr key={supplier.supplier_key}>
                  <td style={{ fontWeight: 700 }}>{supplier.supplier_name}</td>
                  <td>
                    {supplier.supplier_abn ?? (
                      <span className="badge badge-warning">Missing ABN</span>
                    )}
                  </td>
                  <td>
                    {formatDate(supplier.first_payment_date)} -{' '}
                    {formatDate(supplier.last_payment_date)}
                  </td>
                  <td style={{ textAlign: 'right' }}>{formatMoney(supplier.gross_paid_cents)}</td>
                  <td style={{ textAlign: 'right' }}>
                    {formatMoney(supplier.gst_component_cents)}
                    {supplier.missing_gst_count > 0 && (
                      <span className="badge badge-warning" style={{ marginLeft: '0.35rem' }}>
                        {supplier.missing_gst_count} missing
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {supplier.bill_count} bill{supplier.bill_count === 1 ? '' : 's'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function EvidenceCard({ tparReport }: { tparReport: TparReportPayload }) {
  return (
    <Card title="Export evidence" icon={FileText}>
      <Rows
        rows={[
          ['Input hash', tparReport.evidence.input_hash],
          ['Source version', tparReport.evidence.source_version],
          ['Source tables', tparReport.evidence.source_tables.join(', ')],
          ['Reportable basis', tparReport.evidence.reportable_basis],
          ['ATO source', tparReport.obligation.source_label],
          ['Lodgement', tparReport.lodgement.reason],
        ]}
        monoKeys={new Set(['Input hash'])}
      />
    </Card>
  );
}

function Warnings({ warnings }: { warnings: string[] }) {
  return (
    <Banner>
      <strong>Review before export.</strong>{' '}
      {warnings.map((warning, index) => (
        <span key={warning}>
          {index > 0 ? ' ' : ''}
          {warning}
          {index < warnings.length - 1 ? ';' : '.'}
        </span>
      ))}
    </Banner>
  );
}

function Kpi({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: typeof ClipboardList;
}) {
  return (
    <div className="card" style={{ padding: '1rem 1.1rem', position: 'relative' }}>
      <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem', fontWeight: 700 }}>
        {label}
      </div>
      <div style={{ marginTop: '0.35rem', fontSize: '1.35rem', fontWeight: 800 }}>{value}</div>
      <Icon
        size={18}
        style={{
          color: 'var(--text-link)',
          opacity: 0.65,
          position: 'absolute',
          right: '1rem',
          bottom: '1rem',
        }}
      />
    </div>
  );
}

function Card({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof ClipboardList;
  children: React.ReactNode;
}) {
  return (
    <div className="card" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
        <Icon size={18} style={{ color: 'var(--text-link)' }} />
        <h2 style={{ margin: 0, fontSize: '1.1rem' }}>{title}</h2>
      </div>
      {children}
    </div>
  );
}

function Rows({ rows, monoKeys }: { rows: [string, string][]; monoKeys?: Set<string> }) {
  return (
    <dl
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(150px, max-content) 1fr',
        gap: '0.55rem 1rem',
        margin: 0,
        fontSize: '0.85rem',
      }}
    >
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'contents' }}>
          <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
          <dd
            style={{
              margin: 0,
              wordBreak: 'break-word',
              fontFamily: monoKeys?.has(label) ? 'monospace' : undefined,
            }}
          >
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="badge badge-warning"
      style={{
        display: 'flex',
        gap: '0.5rem',
        alignItems: 'flex-start',
        justifyContent: 'flex-start',
        padding: '0.875rem 1rem',
        marginBottom: '1.5rem',
        textTransform: 'none',
        width: '100%',
        lineHeight: 1.45,
      }}
    >
      <AlertTriangle size={16} style={{ marginTop: '2px', flexShrink: 0 }} />
      <span>{children}</span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: '1.5rem',
        border: '1px dashed var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        color: 'var(--text-muted)',
        fontSize: '0.85rem',
      }}
    >
      {children}
    </div>
  );
}
