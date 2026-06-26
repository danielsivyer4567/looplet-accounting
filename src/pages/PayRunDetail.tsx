import { useEffect, useState, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { useAuth } from '@/hooks/useAuth';
import { formatMoney } from '@/lib/money';
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
  type LucideIcon,
} from 'lucide-react';

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
  if (loading)
    return (
      <section>
        <p style={{ color: 'var(--text-muted)' }}>Loading pay run details…</p>
      </section>
    );
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
                    ? '1px solid rgba(16, 185, 129, 0.2)'
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
          <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Layers size={24} style={{ color: 'var(--accent-primary)' }} />
            Pay run · {run.period_start} → {run.period_end}
          </h1>
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

      {/* KPI Cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '1rem',
          marginBottom: '2rem',
        }}
      >
        <KpiCard
          label="Total Gross"
          value={formatMoney(Number(run.total_gross_cents))}
          type="neutral"
          icon={DollarSign}
        />
        <KpiCard
          label="Total PAYG"
          value={formatMoney(Number(run.total_tax_cents))}
          type="danger"
          icon={DollarSign}
        />
        <KpiCard
          label="Total Super"
          value={formatMoney(Number(run.total_super_cents))}
          type="info"
          icon={Wallet}
        />
        <KpiCard
          label="Total Net"
          value={formatMoney(Number(run.total_net_cents))}
          type="success"
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
        <div
          style={{
            padding: '2rem',
            background: 'var(--bg-card)',
            border: '1px dashed var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            textAlign: 'center',
            color: 'var(--text-muted)',
          }}
        >
          No payslips on this run.
        </div>
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
          style={{ flexShrink: 0, color: 'var(--accent-primary)', marginTop: '2px' }}
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
          STP file is generated in Phase 2 JSON format ready for secure handoff to your registered
          tax/BAS agent. Direct ATO lodgement requires SBR-gateway infrastructure configured on your
          organization profile.
        </div>
      </div>
    </section>
  );
}

function KpiCard({
  label,
  value,
  type,
  icon: Icon,
  sub,
}: {
  label: string;
  value: string;
  type: 'success' | 'danger' | 'warning' | 'info' | 'neutral';
  icon: LucideIcon;
  sub?: string;
}) {
  return (
    <div
      className="card"
      style={{
        padding: '1.25rem',
        borderLeft: `4px solid var(--accent-${type === 'neutral' ? 'primary' : type})`,
        position: 'relative',
      }}
    >
      <div
        style={{
          fontSize: '0.675rem',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          fontWeight: 700,
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: '0.35rem',
          fontSize: '1.5rem',
          color: 'var(--text-title)',
          fontWeight: 800,
          fontFamily: 'var(--font-title)',
        }}
      >
        {value}
      </div>
      {sub ? (
        <div style={{ marginTop: '0.25rem', fontSize: '0.725rem', color: 'var(--text-muted)' }}>
          {sub}
        </div>
      ) : (
        <div style={{ height: '0.725rem', marginTop: '0.25rem' }} />
      )}
      <div
        style={{
          position: 'absolute',
          right: '1rem',
          bottom: '1rem',
          color: `var(--accent-${type === 'neutral' ? 'primary' : type})`,
          opacity: 0.7,
        }}
      >
        <Icon size={18} />
      </div>
    </div>
  );
}
