import { useEffect, useState, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { useAuth } from '@/hooks/useAuth';
import { formatMoney } from '@/lib/money';
import { DetailPageSkeleton } from '@/components/Skeleton';
import {
  ChevronLeft,
  Layers,
  Calendar,
  DollarSign,
  Wallet,
  CheckCircle,
  Download,
  XCircle,
  Info,
  FileText,
  UserMinus,
  X,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { Stat } from '@/components/ui/Stat';

interface PayRun {
  id: string;
  organization_id: string;
  period_start: string;
  period_end: string;
  pay_date: string;
  status: 'draft' | 'approved' | 'paid' | 'cancelled' | 'reversed';
  total_gross_cents: number;
  total_tax_cents: number;
  total_super_cents: number;
  total_net_cents: number;
  approved_at: string | null;
  paid_at: string | null;
  notes: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface PaySlip {
  id: string;
  employee_id: string;
  hours_ordinary: number;
  hours_overtime: number;
  hours_leave: number;
  gross_ordinary_cents: number;
  gross_overtime_cents: number;
  gross_leave_cents: number;
  gross_total_cents: number;
  payg_tax_cents: number;
  super_guarantee_cents: number;
  super_rate_pct: number;
  net_pay_cents: number;
  ytd_gross_cents: number;
  ytd_tax_cents: number;
  ytd_super_cents: number;
  payment_reference: string | null;
  employee?: { full_name: string; email: string | null } | null;
}

export function PayRunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { currentOrg } = useOrg();
  const { user } = useAuth();
  const [run, setRun] = useState<PayRun | null>(null);
  const [slips, setSlips] = useState<PaySlip[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [showTermination, setShowTermination] = useState(false);

  const refresh = useCallback(async () => {
    if (!currentOrg || !id || !user) return;
    setLoading(true);
    setError(null);
    const [runRes, slipsRes, memRes] = await Promise.all([
      supabase.from('pay_runs').select('*').eq('id', id).maybeSingle(),
      supabase
        .from('pay_slips')
        .select('*, employee:employees(full_name, email)')
        .eq('pay_run_id', id)
        .order('created_at'),
      supabase
        .from('organization_memberships')
        .select('role_enum')
        .eq('organization_id', currentOrg.id)
        .eq('user_id', user.id)
        .maybeSingle(),
    ]);
    if (runRes.error) {
      setError(runRes.error.message);
      setLoading(false);
      return;
    }
    setRun(runRes.data as PayRun | null);
    setSlips((slipsRes.data ?? []) as unknown as PaySlip[]);
    setRole((memRes.data?.role_enum as string | null) ?? null);
    setLoading(false);
  }, [currentOrg, id, user]);

  useEffect(() => void refresh(), [refresh]);

  const isAdmin = role === 'admin' || role === 'owner';
  const isOwner = role === 'owner';

  const approve = async () => {
    if (!run || !isAdmin) return;
    setBusy('approve');
    const { error: e } = await supabase
      .from('pay_runs')
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', run.id);
    setBusy(null);
    if (e) {
      setError(e.message);
      return;
    }
    void refresh();
  };

  const cancel = async () => {
    if (!run || !isAdmin) return;
    if (!confirm('Cancel this pay run? Payslips will remain but the run will be marked cancelled.'))
      return;
    setBusy('cancel');
    const { error: e } = await supabase
      .from('pay_runs')
      .update({ status: 'cancelled' })
      .eq('id', run.id);
    setBusy(null);
    if (e) {
      setError(e.message);
      return;
    }
    void refresh();
  };

  const finalise = async () => {
    if (!run || !isOwner) return;
    if (
      !confirm(
        `Finalise this pay run? This will mark it PAID and notify the org. Net to pay: ${formatMoney(Number(run.total_net_cents))}.`,
      )
    )
      return;
    setBusy('finalise');
    const { data, error: e } = await supabase.functions.invoke('payroll-finalise-pay-run', {
      body: { run_id: run.id },
    });
    setBusy(null);
    if (e) {
      setError(e.message);
      return;
    }
    if (!(data as { ok?: boolean })?.ok) {
      setError((data as { error?: string })?.error ?? 'finalisation failed');
      return;
    }
    void refresh();
  };

  const exportStp = async () => {
    if (!run) return;
    setBusy('stp');
    const { data, error: e } = await supabase.functions.invoke('payroll-export-stp', {
      body: { run_id: run.id },
    });
    setBusy(null);
    if (e) {
      setError(e.message);
      return;
    }
    const payload = data as { ok?: boolean; stp?: unknown; error?: string };
    if (!payload?.ok) {
      setError(payload?.error ?? 'STP export failed');
      return;
    }
    const blob = new Blob([JSON.stringify(payload.stp, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `stp_${run.period_start}_${run.period_end}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (!currentOrg) return null;
  if (loading) return <DetailPageSkeleton tableCols={6} />;
  if (!run) {
    return (
      <section className="animated-fade-in" style={{ padding: '2rem 0', textAlign: 'center' }}>
        <h2>Pay run not found</h2>
        <Link to="/payroll" className="btn btn-secondary" style={{ marginTop: '1rem' }}>
          <ChevronLeft size={16} /> All pay runs
        </Link>
      </section>
    );
  }

  const canApprove = isAdmin && run.status === 'draft';
  const canFinalise = isOwner && (run.status === 'draft' || run.status === 'approved');
  const canCancel = isAdmin && run.status !== 'paid' && run.status !== 'cancelled';
  const canTerminate = isAdmin && (run.status === 'draft' || run.status === 'approved');

  // Stepper steps configuration
  const steps = [
    { label: 'Draft', active: true },
    { label: 'Approved', active: run.status !== 'draft' && run.status !== 'cancelled' },
    { label: 'Paid', active: run.status === 'paid' },
  ];

  return (
    <section className="animated-fade-in">
      {/* Back button */}
      <Link
        to="/payroll"
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
        <span>All pay runs</span>
      </Link>

      {/* Stepper block */}
      {run.status !== 'cancelled' && run.status !== 'reversed' ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            marginBottom: '1.5rem',
            flexWrap: 'wrap',
          }}
        >
          {steps.map((step, idx) => (
            <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  padding: '0.4rem 0.8rem',
                  borderRadius: 'var(--radius-full)',
                  fontSize: '0.825rem',
                  fontWeight: 600,
                  background: step.active ? 'var(--bg-success-subtle)' : 'var(--bg-hover)',
                  color: step.active ? 'var(--text-success)' : 'var(--text-muted)',
                  border: step.active
                    ? '1px solid var(--border-success)'
                    : '1px solid var(--border-subtle)',
                }}
              >
                <CheckCircle size={14} />
                <span>{step.label}</span>
              </div>
              {idx < steps.length - 1 && (
                <span style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>&rarr;</span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div
          className="badge badge-danger"
          style={{
            display: 'inline-flex',
            gap: '0.35rem',
            padding: '0.5rem 1rem',
            marginBottom: '1.5rem',
            fontSize: '0.875rem',
            textTransform: 'uppercase',
          }}
        >
          <XCircle size={14} />
          <span>Pay Run {run.status}</span>
        </div>
      )}

      {/* Header Info */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1.5rem',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        <div>
          <PageHeader title={<><Layers size={24} style={{ color: 'var(--text-link)' }} /> Pay run · {run.period_start} → {run.period_end}</>} />
          <div
            style={{
              display: 'flex',
              gap: '0.5rem',
              fontSize: '0.825rem',
              color: 'var(--text-muted)',
              marginTop: '0.25rem',
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
              <Calendar size={12} />
              Pay Date: <strong style={{ color: 'var(--text-title)' }}>{run.pay_date}</strong>
            </span>
            <span>•</span>
            <span className="badge badge-neutral">{run.status}</span>
            {run.approved_at && (
              <>
                <span>•</span>
                <span>Approved: {new Date(run.approved_at).toLocaleDateString()}</span>
              </>
            )}
            {run.paid_at && (
              <>
                <span>•</span>
                <span>Paid: {new Date(run.paid_at).toLocaleDateString()}</span>
              </>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {canApprove && (
            <button onClick={approve} disabled={busy === 'approve'} className="btn btn-primary">
              <CheckCircle size={16} />
              <span>{busy === 'approve' ? 'Approving…' : 'Approve'}</span>
            </button>
          )}
          {canTerminate && (
            <button
              onClick={() => setShowTermination(true)}
              disabled={busy !== null}
              className="btn btn-secondary"
            >
              <UserMinus size={16} />
              <span>Record termination</span>
            </button>
          )}
          {canFinalise && (
            <button onClick={finalise} disabled={busy === 'finalise'} className="btn btn-success">
              <Wallet size={16} />
              <span>{busy === 'finalise' ? 'Finalising…' : 'Finalise & pay'}</span>
            </button>
          )}
          <button onClick={exportStp} disabled={busy === 'stp'} className="btn btn-secondary">
            <Download size={16} />
            <span>{busy === 'stp' ? 'Exporting…' : 'Export STP'}</span>
          </button>
          {canCancel && (
            <button
              onClick={cancel}
              disabled={busy === 'cancel'}
              className="btn btn-secondary"
              style={{ color: 'var(--text-danger)', borderColor: 'var(--text-danger)' }}
            >
              <XCircle size={16} />
              <span>{busy === 'cancel' ? 'Cancelling…' : 'Cancel'}</span>
            </button>
          )}
        </div>
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

      {showTermination && (
        <TerminationWizard
          run={run}
          slips={slips}
          organizationId={currentOrg.id}
          isOwner={isOwner}
          onClose={() => setShowTermination(false)}
          onSaved={() => {
            setShowTermination(false);
            void refresh();
          }}
          onFinalise={finalise}
        />
      )}

      {/* KPI Cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '1rem',
          marginBottom: '2rem',
        }}
      >
        <Stat
          label="Total Gross"
          value={formatMoney(Number(run.total_gross_cents))}
          tone="neutral"
          icon={DollarSign}
        />
        <Stat
          label="Total PAYG"
          value={formatMoney(Number(run.total_tax_cents))}
          tone="danger"
          icon={DollarSign}
        />
        <Stat
          label="Total Super"
          value={formatMoney(Number(run.total_super_cents))}
          tone="info"
          icon={Wallet}
        />
        <Stat
          label="Total Net"
          value={formatMoney(Number(run.total_net_cents))}
          tone="success"
          icon={Wallet}
        />
      </div>

      {/* Payslips table */}
      <h2
        style={{
          fontSize: '1.25rem',
          marginBottom: '0.75rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.35rem',
        }}
      >
        <FileText size={16} style={{ color: 'var(--text-muted)' }} />
        Payslips ({slips.length})
      </h2>
      {slips.length === 0 ? (
        <EmptyState>No payslips on this run.</EmptyState>
      ) : (
        <div className="table-premium-container">
          <table className="table-premium">
            <thead>
              <tr>
                <th>Employee</th>
                <th style={{ textAlign: 'right' }}>Ord h</th>
                <th style={{ textAlign: 'right' }}>OT h</th>
                <th style={{ textAlign: 'right' }}>Leave h</th>
                <th style={{ textAlign: 'right' }}>Gross</th>
                <th style={{ textAlign: 'right' }}>PAYG</th>
                <th style={{ textAlign: 'right' }}>Super</th>
                <th style={{ textAlign: 'right' }}>Net</th>
                <th style={{ textAlign: 'right' }}>YTD gross</th>
              </tr>
            </thead>
            <tbody>
              {slips.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link to={`/employees/${s.employee_id}`} style={{ fontWeight: 600 }}>
                      {s.employee?.full_name ?? s.employee_id}
                    </Link>
                  </td>
                  <td style={{ textAlign: 'right' }}>{Number(s.hours_ordinary).toFixed(1)}</td>
                  <td style={{ textAlign: 'right' }}>{Number(s.hours_overtime).toFixed(1)}</td>
                  <td style={{ textAlign: 'right' }}>{Number(s.hours_leave).toFixed(1)}</td>
                  <td style={{ textAlign: 'right' }}>{formatMoney(Number(s.gross_total_cents))}</td>
                  <td style={{ textAlign: 'right' }}>{formatMoney(Number(s.payg_tax_cents))}</td>
                  <td style={{ textAlign: 'right' }}>
                    {formatMoney(Number(s.super_guarantee_cents))}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>
                    {formatMoney(Number(s.net_pay_cents))}
                  </td>
                  <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>
                    {formatMoney(Number(s.ytd_gross_cents))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Single Touch Payroll Details Alert */}
      <div
        className="card"
        style={{
          marginTop: '2rem',
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
          style={{ flexShrink: 0, color: 'var(--text-link)', marginTop: '2px' }}
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
            ATO Single Touch Payroll (STP) Phase 2
          </span>
          The STP file is prepared in Phase 2 JSON format for your registered tax or BAS agent, and a
          draft record of it is kept in the lodgement ledger. Employee TFNs appear masked to the last
          four digits; the full numbers stay encrypted in Looplet. Nothing is lodged with the ATO from
          here.
        </div>
      </div>
    </section>
  );
}

interface TermResult {
  redundancy_tax_free_cents: number;
  etp_taxable_cents: number;
  etp_tax_cents: number;
  unused_leave_tax_cents: number;
  tax_free_cents: number;
  total_tax_cents: number;
  net_cents: number;
  gross_termination_cents: number;
}

const TERMINATION_REASONS: { value: string; label: string }[] = [
  { value: 'genuine_redundancy', label: 'Genuine redundancy' },
  { value: 'invalidity', label: 'Invalidity' },
  { value: 'early_retirement', label: 'Early retirement scheme' },
  { value: 'resignation', label: 'Resignation' },
  { value: 'retirement', label: 'Retirement' },
  { value: 'dismissal', label: 'Dismissal' },
  { value: 'contract_end', label: 'End of contract' },
];

const WIZARD_STEPS = ['Notice', 'Leave', 'ETP', 'Review'];

/**
 * Termination wizard (SC-3.L.03) — notice → leave → ETP → review. Calls the
 * payroll-termination calc (SC-3.L.01) for the breakdown, then on save writes
 * run.metadata.termination (which the STP export, SC-3.L.02, reads) and optionally
 * runs the existing Tier-2 finalise path. It does NOT recompute the pay slips' base
 * amounts — folding the ETP/leave into the slip totals is a documented follow-up.
 */
export function TerminationWizard({
  run,
  slips,
  organizationId,
  isOwner,
  onClose,
  onSaved,
  onFinalise,
}: {
  run: PayRun;
  slips: PaySlip[];
  organizationId: string;
  isOwner: boolean;
  onClose: () => void;
  onSaved: () => void;
  onFinalise: () => void | Promise<void>;
}) {
  const [step, setStep] = useState(0);
  const [employeeId, setEmployeeId] = useState(slips[0]?.employee_id ?? '');
  const [reason, setReason] = useState('genuine_redundancy');
  const [cessationDate, setCessationDate] = useState(run.pay_date);
  const [years, setYears] = useState('0');
  const [noticeDollars, setNoticeDollars] = useState('0');
  const [annualLeaveDollars, setAnnualLeaveDollars] = useState('0');
  const [lslDollars, setLslDollars] = useState('0');
  const [redundancyDollars, setRedundancyDollars] = useState('0');
  const [otherEtpDollars, setOtherEtpDollars] = useState('0');
  const [otherIncomeDollars, setOtherIncomeDollars] = useState('0');
  const [atPreservation, setAtPreservation] = useState(false);
  const [marginalPct, setMarginalPct] = useState('34.5');
  const [result, setResult] = useState<TermResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const c = (s: string) => Math.round((parseFloat(s) || 0) * 100);
  // Any input edit invalidates a stale breakdown — forces a re-calc on the review step.
  const resetResult = () => setResult(null);

  const calculate = async () => {
    setBusy(true);
    setErr(null);
    const input = {
      reason,
      years_of_service: parseFloat(years) || 0,
      at_or_above_preservation_age: atPreservation,
      unused_annual_leave_cents: c(annualLeaveDollars),
      unused_long_service_leave_cents: c(lslDollars),
      redundancy_or_severance_cents: c(redundancyDollars),
      etp_other_cents: c(noticeDollars) + c(otherEtpDollars),
      other_taxable_income_cents: c(otherIncomeDollars),
      leave_marginal_rate: (parseFloat(marginalPct) || 0) / 100,
    };
    const { data, error } = await supabase.functions.invoke('payroll-termination', {
      body: { organization_id: organizationId, employee_id: employeeId, input },
    });
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    const payload = data as { ok?: boolean; result?: TermResult; error?: string };
    if (!payload?.ok || !payload.result) {
      setErr(payload?.error ?? 'Calculation failed');
      return;
    }
    setResult(payload.result);
  };

  const save = async (alsoFinalise: boolean) => {
    if (!result) return;
    setBusy(true);
    setErr(null);
    const termination = {
      employee_id: employeeId,
      cessation_date: cessationDate,
      reason,
      etp: {
        taxable_cents: result.etp_taxable_cents,
        tax_free_cents: result.tax_free_cents,
        tax_withheld_cents: result.etp_tax_cents,
      },
    };
    const { error } = await supabase
      .from('pay_runs')
      .update({ metadata: { ...run.metadata, termination } })
      .eq('id', run.id);
    if (error) {
      setBusy(false);
      setErr(error.message);
      return;
    }
    if (alsoFinalise) await onFinalise();
    setBusy(false);
    onSaved();
  };

  const field = (label: string, node: React.ReactNode) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.8rem' }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      {node}
    </label>
  );
  const money = (val: string, set: (s: string) => void) => (
    <input
      type="number"
      step="0.01"
      value={val}
      onChange={(e) => {
        set(e.target.value);
        resetResult();
      }}
      className="form-input"
    />
  );

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--bg-scrim)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '3rem 1rem',
        zIndex: 50,
        overflowY: 'auto',
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ maxWidth: '640px', width: '100%', position: 'relative' }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute',
            right: '1rem',
            top: '1rem',
            background: 'none',
            border: 'none',
            color: 'var(--text-muted)',
            cursor: 'pointer',
          }}
        >
          <X size={20} />
        </button>
        <h2 style={{ margin: '0 0 0.25rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <UserMinus size={18} style={{ color: 'var(--text-link)' }} />
          Record termination
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: '0 0 1rem' }}>
          Step {step + 1} of {WIZARD_STEPS.length}: {WIZARD_STEPS[step]}. Estimates withholding for
          review — confirm the figures before finalising.
        </p>

        {step === 0 && (
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            {field(
              'Employee',
              <select
                value={employeeId}
                onChange={(e) => {
                  setEmployeeId(e.target.value);
                  resetResult();
                }}
                className="form-select"
              >
                {slips.length === 0 && <option value="">No employees on this run</option>}
                {slips.map((s) => (
                  <option key={s.employee_id} value={s.employee_id}>
                    {s.employee?.full_name ?? s.employee_id}
                  </option>
                ))}
              </select>,
            )}
            {field(
              'Reason',
              <select
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  resetResult();
                }}
                className="form-select"
              >
                {TERMINATION_REASONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>,
            )}
            {field(
              'Cessation date',
              <input
                type="date"
                value={cessationDate}
                onChange={(e) => {
                  setCessationDate(e.target.value);
                  resetResult();
                }}
                className="form-input"
              />,
            )}
            {field(
              'Completed years of service',
              <input
                type="number"
                step="1"
                value={years}
                onChange={(e) => {
                  setYears(e.target.value);
                  resetResult();
                }}
                className="form-input"
              />,
            )}
            {field('Payment in lieu of notice ($)', money(noticeDollars, setNoticeDollars))}
          </div>
        )}

        {step === 1 && (
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: 0 }}>
              Unused leave payable on termination (gross $). Enter from the employee&apos;s leave
              balances × their rate.
            </p>
            {field('Unused annual leave ($)', money(annualLeaveDollars, setAnnualLeaveDollars))}
            {field('Unused long service leave ($)', money(lslDollars, setLslDollars))}
          </div>
        )}

        {step === 2 && (
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            {field('Redundancy / severance ($)', money(redundancyDollars, setRedundancyDollars))}
            {field(
              'Other ETP — ex gratia / golden handshake ($)',
              money(otherEtpDollars, setOtherEtpDollars),
            )}
            {field(
              'Other taxable income this FY ($)',
              money(otherIncomeDollars, setOtherIncomeDollars),
            )}
            {field('Unused-leave marginal rate (%)', money(marginalPct, setMarginalPct))}
            <label
              style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem' }}
            >
              <input
                type="checkbox"
                checked={atPreservation}
                onChange={(e) => {
                  setAtPreservation(e.target.checked);
                  resetResult();
                }}
              />
              At or above preservation age
            </label>
          </div>
        )}

        {step === 3 && (
          <div style={{ display: 'grid', gap: '0.5rem' }}>
            {!result ? (
              <button
                onClick={calculate}
                disabled={busy || !employeeId}
                className="btn btn-primary"
              >
                {busy ? 'Calculating…' : 'Calculate breakdown'}
              </button>
            ) : (
              <div style={{ display: 'grid', gap: '0.35rem', fontSize: '0.85rem' }}>
                <Row label="Tax-free (redundancy)" value={result.tax_free_cents} />
                <Row label="Taxable ETP" value={result.etp_taxable_cents} />
                <Row label="ETP tax withheld" value={result.etp_tax_cents} />
                <Row label="Unused-leave tax" value={result.unused_leave_tax_cents} />
                <Row label="Total tax withheld" value={result.total_tax_cents} strong />
                <Row label="Gross termination" value={result.gross_termination_cents} />
                <Row label="Net to pay" value={result.net_cents} strong />
              </div>
            )}
          </div>
        )}

        {err && (
          <p style={{ color: 'var(--text-danger)', fontSize: '0.8rem', marginTop: '0.75rem' }}>
            {err}
          </p>
        )}

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: '0.5rem',
            marginTop: '1.25rem',
          }}
        >
          <button
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0 || busy}
            className="btn btn-secondary"
          >
            Back
          </button>
          {step < WIZARD_STEPS.length - 1 ? (
            <button onClick={() => setStep((s) => s + 1)} className="btn btn-primary">
              Next
            </button>
          ) : (
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={() => save(false)}
                disabled={busy || !result}
                className="btn btn-secondary"
              >
                Save details
              </button>
              {isOwner && (
                <button
                  onClick={() => save(true)}
                  disabled={busy || !result}
                  className="btn btn-success"
                >
                  {busy ? 'Saving…' : 'Save & finalise'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div
      style={{ display: 'flex', justifyContent: 'space-between', fontWeight: strong ? 700 : 400 }}
    >
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span>{formatMoney(value)}</span>
    </div>
  );
}
