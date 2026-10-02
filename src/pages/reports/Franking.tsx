import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ChevronLeft,
  FileText,
  Landmark,
  Scale,
  ShieldCheck,
  Users,
} from 'lucide-react';
import {
  frankingFyLabel,
  latestCompletedFrankingFyStartYear,
  type DividendStatementRow,
  type FrankingAccountEntry,
  type FrankingRegisterPayload,
  useFrankingRegister,
} from '@/hooks/useFrankingRegister';
import { formatMoney } from '@/lib/money';

function formatDate(value: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-AU', { dateStyle: 'medium' });
}

function pctFromBps(value: number | null): string {
  if (value == null) return '-';
  return `${(value / 100).toFixed(2)}%`;
}

function currentYearOptions(base = latestCompletedFrankingFyStartYear()): number[] {
  return [0, 1, 2, 3, 4].map((offset) => base - offset);
}

export function FrankingReportPage() {
  const latestFy = latestCompletedFrankingFyStartYear();
  const [fyStartYear, setFyStartYear] = useState(latestFy);
  const { frankingRegister, loading, error } = useFrankingRegister(fyStartYear);
  const fyOptions = useMemo(() => currentYearOptions(latestFy), [latestFy]);

  return (
    <section className="animated-fade-in">
      <Link
        to="/reports"
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
        <span>Reports</span>
      </Link>

      <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Landmark size={24} style={{ color: 'var(--text-link)' }} />
        Franking Register
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
        Company franking account movements, member dividend statements, benchmark percentage, and
        reconciliation against posted dividend/distribution equity lines.
      </p>

      <div className="card" style={{ padding: '1.25rem 1.5rem', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label className="form-label" htmlFor="franking-fy">
              Financial year
            </label>
            <select
              id="franking-fy"
              className="form-select"
              value={fyStartYear}
              onChange={(e) => setFyStartYear(Number(e.target.value))}
              disabled={loading}
              style={{ minWidth: '160px' }}
            >
              {fyOptions.map((fy) => (
                <option key={fy} value={fy}>
                  {frankingFyLabel(fy)}
                </option>
              ))}
            </select>
          </div>
          {frankingRegister && (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.825rem' }}>
              {formatDate(frankingRegister.period_start)} -{' '}
              {formatDate(frankingRegister.period_end)}
            </div>
          )}
        </div>
      </div>

      {error && (
        <Banner>
          <strong>Franking register unavailable.</strong> {error}
        </Banner>
      )}

      {loading ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading franking register...</p>
      ) : frankingRegister ? (
        <>
          {frankingRegister.warnings.length > 0 && (
            <Warnings warnings={frankingRegister.warnings} />
          )}
          <Kpis frankingRegister={frankingRegister} />
          <ReconciliationCard frankingRegister={frankingRegister} />
          <EntriesCard entries={frankingRegister.entries} />
          <StatementsCard statements={frankingRegister.dividend_statements} />
          <EvidenceCard frankingRegister={frankingRegister} />
        </>
      ) : (
        <Empty>No franking register is available for this financial year.</Empty>
      )}
    </section>
  );
}

function Kpis({ frankingRegister }: { frankingRegister: FrankingRegisterPayload }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
        gap: '1rem',
        marginBottom: '1.5rem',
      }}
    >
      <Kpi
        label="Opening balance"
        value={formatMoney(frankingRegister.summary.opening_balance_cents)}
        icon={Landmark}
      />
      <Kpi
        label="Credits"
        value={formatMoney(frankingRegister.summary.credit_cents)}
        icon={ShieldCheck}
      />
      <Kpi
        label="Debits"
        value={formatMoney(frankingRegister.summary.debit_cents)}
        icon={FileText}
      />
      <Kpi
        label="Closing balance"
        value={formatMoney(frankingRegister.summary.closing_balance_cents)}
        icon={Scale}
      />
    </div>
  );
}

function ReconciliationCard({ frankingRegister }: { frankingRegister: FrankingRegisterPayload }) {
  const s = frankingRegister.summary;
  return (
    <Card title="Reconciliation" icon={Scale}>
      <Rows
        rows={[
          ['Statement cash dividends', formatMoney(s.statement_cash_dividend_cents)],
          ['Posted dividend/distribution GL', formatMoney(s.gl_dividend_cents)],
          ['Statement vs GL variance', formatMoney(s.statement_vs_gl_variance_cents)],
          ['Statement franking credits', formatMoney(s.statement_franking_credit_cents)],
          ['Register distribution debits', formatMoney(s.register_distribution_debit_cents)],
          ['Statement vs register variance', formatMoney(s.statement_vs_register_variance_cents)],
          ['Benchmark franking percentage', pctFromBps(s.benchmark_franking_percentage_bps)],
        ]}
      />
    </Card>
  );
}

function EntriesCard({ entries }: { entries: FrankingAccountEntry[] }) {
  return (
    <Card title="Franking account entries" icon={Landmark}>
      {entries.length === 0 ? (
        <Empty>No franking account entries for this year.</Empty>
      ) : (
        <div className="table-premium-container">
          <table className="table-premium">
            <thead>
              <tr>
                <th>Date</th>
                <th>Kind</th>
                <th>Description</th>
                <th style={{ textAlign: 'right' }}>Credit</th>
                <th style={{ textAlign: 'right' }}>Debit</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{formatDate(entry.entry_date)}</td>
                  <td>{entry.entry_kind.replace(/_/g, ' ')}</td>
                  <td>
                    {entry.description}
                    {entry.source_reference && (
                      <span style={{ color: 'var(--text-muted)', marginLeft: '0.35rem' }}>
                        {entry.source_reference}
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>{formatMoney(entry.credit_cents)}</td>
                  <td style={{ textAlign: 'right' }}>{formatMoney(entry.debit_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function StatementsCard({ statements }: { statements: DividendStatementRow[] }) {
  return (
    <Card title="Dividend statements" icon={Users}>
      {statements.length === 0 ? (
        <Empty>No member dividend statements for this year.</Empty>
      ) : (
        <div className="table-premium-container">
          <table className="table-premium">
            <thead>
              <tr>
                <th>Member</th>
                <th>Dividend date</th>
                <th>Class</th>
                <th style={{ textAlign: 'right' }}>Cash dividend</th>
                <th style={{ textAlign: 'right' }}>Franking credit</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {statements.map((statement) => (
                <tr key={statement.id}>
                  <td style={{ fontWeight: 700 }}>{statement.member_name}</td>
                  <td>{formatDate(statement.dividend_date)}</td>
                  <td>{statement.share_class}</td>
                  <td style={{ textAlign: 'right' }}>
                    {formatMoney(statement.cash_dividend_cents)}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {formatMoney(statement.franking_credit_cents)}
                  </td>
                  <td>
                    <span className="badge badge-neutral">{statement.statement_status}</span>
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

function EvidenceCard({ frankingRegister }: { frankingRegister: FrankingRegisterPayload }) {
  return (
    <Card title="Register evidence" icon={FileText}>
      <Rows
        rows={[
          ['Input hash', frankingRegister.evidence.input_hash],
          ['Source version', frankingRegister.evidence.source_version],
          ['Source tables', frankingRegister.evidence.source_tables.join(', ')],
          ['ATO source', frankingRegister.evidence.source_label],
          ['Lodgement', frankingRegister.lodgement.reason],
        ]}
        monoKeys={new Set(['Input hash'])}
      />
    </Card>
  );
}

function Warnings({ warnings }: { warnings: string[] }) {
  return (
    <Banner>
      <strong>Review before issuing statements.</strong>{' '}
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
  icon: typeof Landmark;
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
  icon: typeof Landmark;
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
        gridTemplateColumns: 'minmax(190px, max-content) 1fr',
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
