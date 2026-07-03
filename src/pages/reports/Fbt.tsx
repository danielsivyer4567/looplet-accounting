import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Calculator,
  ChevronLeft,
  Clock,
  FileText,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { useApprovals } from '@/hooks/useApprovals';
import {
  fbtYearLabel,
  latestCompletedFbtYearEndYear,
  type FbtBenefitRow,
  type FbtReturnPayload,
  useFbtReturn,
} from '@/hooks/useFbtReturn';
import { useOrg } from '@/hooks/useOrg';
import { formatMoney } from '@/lib/money';

const RESOURCE_TYPE = 'fbt_return';

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-AU', { dateStyle: 'medium' });
}

function pctFromBps(value: number): string {
  return `${(value / 100).toFixed(2)}%`;
}

function currentYearOptions(base = latestCompletedFbtYearEndYear()): number[] {
  return [0, 1, 2, 3, 4].map((offset) => base - offset);
}

export function FbtReportPage() {
  const { currentOrg } = useOrg();
  const latestYear = latestCompletedFbtYearEndYear();
  const [yearEndYear, setYearEndYear] = useState(latestYear);
  const { fbtReturn, approvalPayload, loading, error, refresh } = useFbtReturn(yearEndYear);
  const { pending, requestApproval, isApproved, refresh: refreshApprovals } = useApprovals();
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState<null | 'approve' | 'refresh'>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const orgId = currentOrg?.id ?? null;
  const approvalResourceId = fbtReturn?.approval?.resource_id ?? orgId;
  const pendingForReturn = pending.some(
    (a) => a.resource_type === RESOURCE_TYPE && a.resource_id === approvalResourceId,
  );
  const canApprove = Boolean(fbtReturn && approvalPayload);
  const yearOptions = useMemo(() => currentYearOptions(latestYear), [latestYear]);

  useEffect(() => {
    let live = true;
    if (!orgId || !approvalResourceId || !approvalPayload) {
      setApproved(false);
      return;
    }
    isApproved(RESOURCE_TYPE, approvalResourceId, approvalPayload)
      .then((ok) => live && setApproved(ok))
      .catch(() => live && setApproved(false));
    return () => {
      live = false;
    };
  }, [orgId, approvalResourceId, approvalPayload, pendingForReturn, isApproved]);

  if (!currentOrg) return null;

  const handleApprove = async () => {
    if (!approvalResourceId || !approvalPayload) return;
    setBusy('approve');
    setActionError(null);
    try {
      await requestApproval(RESOURCE_TYPE, approvalResourceId, approvalPayload);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleRefreshStatus = async () => {
    setBusy('refresh');
    setActionError(null);
    try {
      await Promise.all([refresh(), refreshApprovals()]);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

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
        <Calculator size={24} style={{ color: 'var(--accent-primary)' }} />
        FBT Return
      </h1>
      <p
        style={{
          color: 'var(--text-muted)',
          fontSize: '0.875rem',
          marginTop: '0.25rem',
          marginBottom: '1.5rem',
          maxWidth: '760px',
          lineHeight: '1.5',
        }}
      >
        Draft FBT return for the selected FBT year, built from curated benefit inputs and pinned ATO
        rate rows. Approval binds to the input hash and headline totals.
      </p>

      <div className="card" style={{ padding: '1.25rem 1.5rem', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label className="form-label" htmlFor="fbt-year">
              FBT year
            </label>
            <select
              id="fbt-year"
              className="form-select"
              value={yearEndYear}
              onChange={(e) => setYearEndYear(Number(e.target.value))}
              disabled={loading}
              style={{ minWidth: '150px' }}
            >
              {yearOptions.map((year) => (
                <option key={year} value={year}>
                  {fbtYearLabel(year)}
                </option>
              ))}
            </select>
          </div>
          {fbtReturn && (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.825rem' }}>
              {formatDate(fbtReturn.period_start)} - {formatDate(fbtReturn.period_end)} · due{' '}
              {formatDate(fbtReturn.due_date)}
            </div>
          )}
        </div>
      </div>

      <ApprovalCard
        approved={approved}
        pending={pendingForReturn}
        canApprove={canApprove}
        busy={busy}
        actionError={actionError}
        onApprove={handleApprove}
        onRefreshStatus={handleRefreshStatus}
      />

      {error && (
        <Banner>
          <strong>FBT return unavailable.</strong> {error}
        </Banner>
      )}

      {loading ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading FBT return...</p>
      ) : fbtReturn ? (
        <>
          <Kpis fbtReturn={fbtReturn} />
          <SummaryCard fbtReturn={fbtReturn} />
          <BenefitsCard benefits={fbtReturn.benefits} />
          <EvidenceCard fbtReturn={fbtReturn} />
        </>
      ) : (
        <Empty>No FBT return is available for this year.</Empty>
      )}
    </section>
  );
}

function Kpis({ fbtReturn }: { fbtReturn: FbtReturnPayload }) {
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
        label="Taxable value"
        value={formatMoney(fbtReturn.summary.aggregate_taxable_value_cents)}
      />
      <Kpi
        label="Grossed-up amount"
        value={formatMoney(fbtReturn.summary.grossed_up_taxable_amount_cents)}
      />
      <Kpi label="FBT payable" value={formatMoney(fbtReturn.summary.fbt_payable_cents)} />
      <Kpi label="Benefit rows" value={String(fbtReturn.benefits.length)} />
    </div>
  );
}

function SummaryCard({ fbtReturn }: { fbtReturn: FbtReturnPayload }) {
  return (
    <Card title="Return summary" icon={Calculator}>
      <Rows
        rows={[
          ['Type 1 taxable value', formatMoney(fbtReturn.summary.type_1_taxable_value_cents)],
          ['Type 2 taxable value', formatMoney(fbtReturn.summary.type_2_taxable_value_cents)],
          ['Employee contributions', formatMoney(fbtReturn.summary.employee_contributions_cents)],
          ['Exempt taxable value', formatMoney(fbtReturn.summary.exempt_taxable_value_cents)],
          [
            'Rates',
            `${pctFromBps(fbtReturn.rates.fbt_rate_bps)} FBT · ${pctFromBps(
              fbtReturn.rates.type_1_gross_up_rate_bps,
            )} Type 1 · ${pctFromBps(fbtReturn.rates.type_2_gross_up_rate_bps)} Type 2`,
          ],
          ['Rate source', fbtReturn.rates.source_label],
          ['FBT registered', fbtReturn.registration.is_fbt_registered ? 'Yes' : 'No'],
        ]}
      />
      {fbtReturn.warnings.length > 0 && (
        <ul
          style={{
            margin: '1rem 0 0',
            paddingLeft: '1rem',
            color: 'var(--text-muted)',
            fontSize: '0.8rem',
            lineHeight: '1.55',
          }}
        >
          {fbtReturn.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function BenefitsCard({ benefits }: { benefits: FbtBenefitRow[] }) {
  return (
    <Card title="Benefit inputs" icon={FileText}>
      {benefits.length === 0 ? (
        <Empty>No curated FBT benefit rows for this year.</Empty>
      ) : (
        <div className="table-premium-container">
          <table className="table-premium">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Description</th>
                <th>Gross-up</th>
                <th>Taxable value</th>
                <th>Contribution</th>
                <th>Net taxable</th>
              </tr>
            </thead>
            <tbody>
              {benefits.map((benefit) => (
                <tr key={benefit.id}>
                  <td style={{ fontWeight: 700 }}>{benefit.benefit_kind.replace(/_/g, ' ')}</td>
                  <td>
                    {benefit.description}
                    {benefit.employee_reference && (
                      <span style={{ color: 'var(--text-muted)', marginLeft: '0.35rem' }}>
                        {benefit.employee_reference}
                      </span>
                    )}
                    {benefit.is_exempt && (
                      <span className="badge badge-success" style={{ marginLeft: '0.5rem' }}>
                        Exempt
                      </span>
                    )}
                  </td>
                  <td>{benefit.gross_up_type === 'type_1' ? 'Type 1' : 'Type 2'}</td>
                  <td>{formatMoney(benefit.taxable_value_cents)}</td>
                  <td>{formatMoney(benefit.employee_contribution_cents)}</td>
                  <td>{formatMoney(benefit.net_taxable_value_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function EvidenceCard({ fbtReturn }: { fbtReturn: FbtReturnPayload }) {
  return (
    <Card title="Approval evidence" icon={ShieldCheck}>
      <Rows
        rows={[
          ['Input hash', fbtReturn.evidence.input_hash],
          ['Source version', fbtReturn.evidence.source_version],
          ['Source tables', fbtReturn.evidence.source_tables.join(', ')],
          ['Lodgement', fbtReturn.lodgement.reason],
        ]}
        monoKeys={new Set(['Input hash'])}
      />
    </Card>
  );
}

function ApprovalCard({
  approved,
  pending,
  canApprove,
  busy,
  actionError,
  onApprove,
  onRefreshStatus,
}: {
  approved: boolean;
  pending: boolean;
  canApprove: boolean;
  busy: null | 'approve' | 'refresh';
  actionError: string | null;
  onApprove: () => void;
  onRefreshStatus: () => void;
}) {
  const status = approved ? 'Approved' : pending ? 'Pending approval' : 'Draft';
  const badge = approved ? 'badge-success' : pending ? 'badge-warning' : 'badge-neutral';

  return (
    <div className="card" style={{ padding: '1.25rem 1.5rem', marginBottom: '1.5rem' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '0.75rem',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <ShieldCheck size={18} style={{ color: 'var(--accent-primary)' }} />
          <h2 style={{ margin: 0, fontSize: '1.05rem' }}>Return approval</h2>
        </div>
        <span className={`badge ${badge}`}>{status}</span>
      </div>

      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '1rem' }}>
        <button
          className="btn btn-secondary"
          type="button"
          onClick={onApprove}
          disabled={!canApprove || pending || approved || busy !== null}
        >
          {busy === 'approve' ? <Loader2 size={14} /> : <ShieldCheck size={14} />}
          <span>{pending ? 'Approval requested' : approved ? 'Approved' : 'Request approval'}</span>
        </button>
        {pending && !approved && (
          <button
            className="btn btn-ghost"
            type="button"
            onClick={onRefreshStatus}
            disabled={busy !== null}
          >
            {busy === 'refresh' ? <Loader2 size={14} /> : <Clock size={14} />}
            <span>Check status</span>
          </button>
        )}
        <Link className="btn btn-ghost" to="/approvals">
          <span>Approvals queue</span>
        </Link>
      </div>

      {actionError && (
        <p style={{ color: 'var(--text-danger)', fontSize: '0.8rem', margin: '0.75rem 0 0' }}>
          {actionError}
        </p>
      )}
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="card" style={{ padding: '1rem 1.1rem' }}>
      <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem', fontWeight: 700 }}>
        {label}
      </div>
      <div style={{ marginTop: '0.35rem', fontSize: '1.35rem', fontWeight: 800 }}>{value}</div>
    </div>
  );
}

function Card({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: typeof Calculator;
  children: React.ReactNode;
}) {
  return (
    <div className="card" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
        <Icon size={18} style={{ color: 'var(--accent-primary)' }} />
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
