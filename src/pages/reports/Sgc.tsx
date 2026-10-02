import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Calculator,
  ChevronLeft,
  FileText,
  PiggyBank,
  ShieldCheck,
  Users,
} from 'lucide-react';
import {
  latestCompletedSgcPeriod,
  sgcFyLabel,
  sgcQuarterLabel,
  type SgcEmployeeRow,
  type SgcStatementPayload,
  useSgcStatement,
} from '@/hooks/useSgcStatement';
import { formatMoney } from '@/lib/money';

function formatDate(value: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-AU', { dateStyle: 'medium' });
}

function formatPct(value: number | null): string {
  return value == null ? '-' : `${Number(value).toFixed(2)}%`;
}

function currentYearOptions(base: number): number[] {
  return [0, 1, 2, 3, 4].map((offset) => base - offset);
}

export function SgcReportPage() {
  const latestPeriod = latestCompletedSgcPeriod();
  const [fyStartYear, setFyStartYear] = useState(latestPeriod.fyStartYear);
  const [quarter, setQuarter] = useState(latestPeriod.quarter);
  const { sgcStatement, loading, error } = useSgcStatement(fyStartYear, quarter);
  const fyOptions = useMemo(() => currentYearOptions(latestPeriod.fyStartYear), [latestPeriod]);

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
        <PiggyBank size={24} style={{ color: 'var(--text-link)' }} />
        SGC Statement
      </h1>
      <p
        style={{
          color: 'var(--text-muted)',
          fontSize: '0.875rem',
          marginTop: '0.25rem',
          marginBottom: '1.5rem',
          maxWidth: '840px',
          lineHeight: '1.5',
        }}
      >
        Quarterly Super Guarantee Charge review from approved and paid pay slips. Required SG is
        recalculated from ordinary time earnings, excludes overtime, and applies statutory SG rates.
      </p>

      <div className="card" style={{ padding: '1.25rem 1.5rem', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label className="form-label" htmlFor="sgc-fy">
              Financial year
            </label>
            <select
              id="sgc-fy"
              className="form-select"
              value={fyStartYear}
              onChange={(event) => setFyStartYear(Number(event.target.value))}
              disabled={loading}
              style={{ minWidth: '160px' }}
            >
              {fyOptions.map((fy) => (
                <option key={fy} value={fy}>
                  {sgcFyLabel(fy)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="form-label" htmlFor="sgc-quarter">
              Quarter
            </label>
            <select
              id="sgc-quarter"
              className="form-select"
              value={quarter}
              onChange={(event) => setQuarter(Number(event.target.value))}
              disabled={loading}
              style={{ minWidth: '150px' }}
            >
              {[1, 2, 3, 4].map((q) => (
                <option key={q} value={q}>
                  {sgcQuarterLabel(q)}
                </option>
              ))}
            </select>
          </div>
          {sgcStatement && (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.825rem' }}>
              {formatDate(sgcStatement.quarter_start)} - {formatDate(sgcStatement.quarter_end)} ·
              due {formatDate(sgcStatement.due_date)}
            </div>
          )}
        </div>
      </div>

      {error && (
        <Banner>
          <strong>SGC statement unavailable.</strong> {error}
        </Banner>
      )}

      {loading ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading SGC statement...</p>
      ) : sgcStatement ? (
        <>
          {sgcStatement.warnings.length > 0 && <Warnings warnings={sgcStatement.warnings} />}
          <Kpis sgcStatement={sgcStatement} />
          <ComponentsCard sgcStatement={sgcStatement} />
          <EmployeesCard employees={sgcStatement.employees} />
          <EvidenceCard sgcStatement={sgcStatement} />
        </>
      ) : (
        <Empty>No SGC statement is available for this quarter.</Empty>
      )}
    </section>
  );
}

function Kpis({ sgcStatement }: { sgcStatement: SgcStatementPayload }) {
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
        label="OTE"
        value={formatMoney(sgcStatement.summary.ordinary_time_earnings_cents)}
        icon={Calculator}
      />
      <Kpi
        label="Required SG"
        value={formatMoney(sgcStatement.summary.required_super_cents)}
        icon={ShieldCheck}
      />
      <Kpi
        label="Payroll SG"
        value={formatMoney(sgcStatement.summary.payroll_super_cents)}
        icon={PiggyBank}
      />
      <Kpi
        label="Shortfall"
        value={formatMoney(sgcStatement.summary.calculation_shortfall_cents)}
        icon={AlertTriangle}
      />
    </div>
  );
}

function ComponentsCard({ sgcStatement }: { sgcStatement: SgcStatementPayload }) {
  const components = sgcStatement.sgc_components;
  return (
    <Card title="Draft SGC components" icon={Calculator}>
      <Rows
        rows={[
          ['Super shortfall', formatMoney(components.super_shortfall_cents)],
          ['Admin fee per employee', formatMoney(components.admin_fee_cents_per_employee)],
          ['Admin fee', formatMoney(components.admin_fee_cents)],
          ['Nominal interest', components.nominal_interest_reason],
          ['Draft total excluding interest', formatMoney(components.draft_total_ex_interest_cents)],
          ['Lodgement', sgcStatement.lodgement.reason],
        ]}
      />
    </Card>
  );
}

function EmployeesCard({ employees }: { employees: SgcEmployeeRow[] }) {
  return (
    <Card title="Employee shortfall review" icon={Users}>
      {employees.length === 0 ? (
        <Empty>No approved or paid pay slips found for this quarter.</Empty>
      ) : (
        <div className="table-premium-container">
          <table className="table-premium">
            <thead>
              <tr>
                <th>Employee</th>
                <th style={{ textAlign: 'right' }}>OTE</th>
                <th style={{ textAlign: 'right' }}>Overtime excluded</th>
                <th style={{ textAlign: 'right' }}>Required SG</th>
                <th style={{ textAlign: 'right' }}>Payroll SG</th>
                <th style={{ textAlign: 'right' }}>Shortfall</th>
                <th>Rate</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((employee) => (
                <tr key={employee.employee_id}>
                  <td style={{ fontWeight: 700 }}>
                    {employee.employee_name}
                    <span style={{ color: 'var(--text-muted)', marginLeft: '0.35rem' }}>
                      {employee.slip_count} slip{employee.slip_count === 1 ? '' : 's'}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {formatMoney(employee.ordinary_time_earnings_cents)}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {formatMoney(employee.overtime_excluded_cents)}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {formatMoney(employee.required_super_cents)}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {formatMoney(employee.payroll_super_cents)}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {employee.calculation_shortfall_cents > 0 ? (
                      <span className="badge badge-warning">
                        {formatMoney(employee.calculation_shortfall_cents)}
                      </span>
                    ) : (
                      formatMoney(0)
                    )}
                  </td>
                  <td>
                    {formatPct(employee.recorded_rate_min_pct)}
                    {employee.recorded_rate_min_pct !== employee.recorded_rate_max_pct
                      ? ` - ${formatPct(employee.recorded_rate_max_pct)}`
                      : ''}
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

function EvidenceCard({ sgcStatement }: { sgcStatement: SgcStatementPayload }) {
  return (
    <Card title="Calculation evidence" icon={FileText}>
      <Rows
        rows={[
          ['Input hash', sgcStatement.evidence.input_hash],
          ['Source version', sgcStatement.evidence.source_version],
          ['Source tables', sgcStatement.evidence.source_tables.join(', ')],
          ['Calculation basis', sgcStatement.evidence.calculation_basis],
          ['Statutory rate', rateRange(sgcStatement)],
          ['ATO source', sgcStatement.evidence.source_label],
        ]}
        monoKeys={new Set(['Input hash'])}
      />
    </Card>
  );
}

function rateRange(sgcStatement: SgcStatementPayload): string {
  const min = sgcStatement.summary.statutory_rate_min_pct;
  const max = sgcStatement.summary.statutory_rate_max_pct;
  if (min == null && max == null) return '-';
  if (min === max) return formatPct(min);
  return `${formatPct(min)} - ${formatPct(max)}`;
}

function Warnings({ warnings }: { warnings: string[] }) {
  return (
    <Banner>
      <strong>Review before lodging externally.</strong>{' '}
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
  icon: typeof PiggyBank;
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
  icon: typeof PiggyBank;
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
