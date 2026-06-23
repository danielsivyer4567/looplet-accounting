/**
 * PayRunDetail — single pay run with all payslips.
 *
 * Actions:
 *   - Approve (admin+):   draft -> approved
 *   - Finalise (owner):   approved/draft -> paid (via edge fn payroll-finalise-pay-run)
 *   - Export STP:         downloads the JSON returned by payroll-export-stp
 *   - Send payslips:      stubbed — future per-employee email
 */

import { useEffect, useState, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { useAuth } from '@/hooks/useAuth';
import { formatMoney } from '@/lib/money';

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
      supabase.from('pay_slips')
        .select('*, employee:employees(full_name, email)')
        .eq('pay_run_id', id)
        .order('created_at'),
      // Scope to THIS user's membership. Without the user_id filter, an org with
      // 2+ members matches multiple rows and .maybeSingle() errors, silently
      // dropping the caller's role and hiding every pay-run action org-wide.
      supabase.from('organization_memberships').select('role_enum')
        .eq('organization_id', currentOrg.id)
        .eq('user_id', user.id)
        .maybeSingle(),
    ]);
    if (runRes.error) { setError(runRes.error.message); setLoading(false); return; }
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
    if (e) { setError(e.message); return; }
    void refresh();
  };

  const cancel = async () => {
    if (!run || !isAdmin) return;
    if (!confirm('Cancel this pay run? Payslips will remain but the run will be marked cancelled.')) return;
    setBusy('cancel');
    const { error: e } = await supabase
      .from('pay_runs')
      .update({ status: 'cancelled' })
      .eq('id', run.id);
    setBusy(null);
    if (e) { setError(e.message); return; }
    void refresh();
  };

  const finalise = async () => {
    if (!run || !isOwner) return;
    if (!confirm(`Finalise this pay run? This will mark it PAID and notify the org. Net to pay: ${formatMoney(Number(run.total_net_cents))}.`)) return;
    setBusy('finalise');
    const { data, error: e } = await supabase.functions.invoke('payroll-finalise-pay-run', {
      body: { run_id: run.id },
    });
    setBusy(null);
    if (e) { setError(e.message); return; }
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
    if (e) { setError(e.message); return; }
    const payload = data as { ok?: boolean; stp?: unknown; error?: string };
    if (!payload?.ok) { setError(payload?.error ?? 'STP export failed'); return; }
    // Trigger download
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
  if (loading) return <section><h1>Pay run</h1><p style={{ color: '#888' }}>Loading…</p></section>;
  if (!run) return (
    <section>
      <h1>Pay run not found</h1>
      <Link to="/payroll" style={{ color: '#86c7a3' }}>&larr; All pay runs</Link>
    </section>
  );

  const canApprove = isAdmin && run.status === 'draft';
  const canFinalise = isOwner && (run.status === 'draft' || run.status === 'approved');
  const canCancel = isAdmin && run.status !== 'paid' && run.status !== 'cancelled';

  return (
    <section>
      <Link to="/payroll" style={{ color: '#86c7a3', fontSize: 13 }}>&larr; All pay runs</Link>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 8, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0 }}>Pay run · {run.period_start} → {run.period_end}</h1>
          <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
            Pay date <strong style={{ color: '#ddd' }}>{run.pay_date}</strong>
            {' · status '}<StatusPill status={run.status} />
            {run.approved_at && ` · approved ${new Date(run.approved_at).toLocaleDateString()}`}
            {run.paid_at && ` · paid ${new Date(run.paid_at).toLocaleDateString()}`}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {canApprove && <button onClick={approve} disabled={busy === 'approve'} style={btnPrim}>
            {busy === 'approve' ? 'Approving…' : 'Approve'}
          </button>}
          {canFinalise && <button onClick={finalise} disabled={busy === 'finalise'} style={btnAccent}>
            {busy === 'finalise' ? 'Finalising…' : 'Finalise & pay'}
          </button>}
          <button onClick={exportStp} disabled={busy === 'stp'} style={btnGhost}>
            {busy === 'stp' ? 'Exporting…' : 'Export STP'}
          </button>
          {canCancel && <button onClick={cancel} disabled={busy === 'cancel'} style={btnGhostRed}>
            {busy === 'cancel' ? 'Cancelling…' : 'Cancel'}
          </button>}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginTop: 16, maxWidth: 1100 }}>
        <Kpi label="Total gross" value={formatMoney(Number(run.total_gross_cents))} colour="#aaa" />
        <Kpi label="Total PAYG" value={formatMoney(Number(run.total_tax_cents))} colour="#e9a3a3" />
        <Kpi label="Total super" value={formatMoney(Number(run.total_super_cents))} colour="#5096d8" />
        <Kpi label="Total net" value={formatMoney(Number(run.total_net_cents))} colour="#86c7a3" />
      </div>

      <h2 style={h2}>Payslips ({slips.length})</h2>
      {slips.length === 0 ? (
        <p style={{ color: '#888', fontSize: 13 }}>No payslips on this run.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ borderBottom: '1px solid #2a2a2a' }}>
              <th style={th}>Employee</th>
              <th style={thRight}>Ord h</th>
              <th style={thRight}>OT h</th>
              <th style={thRight}>Leave h</th>
              <th style={thRight}>Gross</th>
              <th style={thRight}>PAYG</th>
              <th style={thRight}>Super</th>
              <th style={thRight}>Net</th>
              <th style={thRight}>YTD gross</th>
            </tr></thead>
            <tbody>
              {slips.map((s) => (
                <tr key={s.id} style={{ borderBottom: '1px solid #1a1a1a' }}>
                  <td style={td}>
                    <Link to={`/employees/${s.employee_id}`} style={{ color: '#86c7a3', textDecoration: 'none' }}>
                      {s.employee?.full_name ?? s.employee_id}
                    </Link>
                  </td>
                  <td style={tdRight}>{Number(s.hours_ordinary).toFixed(1)}</td>
                  <td style={tdRight}>{Number(s.hours_overtime).toFixed(1)}</td>
                  <td style={tdRight}>{Number(s.hours_leave).toFixed(1)}</td>
                  <td style={tdRight}>{formatMoney(Number(s.gross_total_cents))}</td>
                  <td style={tdRight}>{formatMoney(Number(s.payg_tax_cents))}</td>
                  <td style={tdRight}>{formatMoney(Number(s.super_guarantee_cents))}</td>
                  <td style={tdRight}><strong>{formatMoney(Number(s.net_pay_cents))}</strong></td>
                  <td style={tdRight}>{formatMoney(Number(s.ytd_gross_cents))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error && <p style={{ color: 'salmon', fontSize: 12, marginTop: 12 }}>{error}</p>}

      <p style={{ marginTop: 32, padding: 10, background: '#0e0e0e', border: '1px dashed #2a2a2a', borderRadius: 4, fontSize: 12, color: '#666' }}>
        STP file is in Phase 2 JSON format ready for handoff to your registered tax/BAS agent.
        Direct ATO lodgement requires SBR-gateway integration (out of scope).
      </p>
    </section>
  );
}

function StatusPill({ status }: { status: PayRun['status'] }) {
  const colour: Record<PayRun['status'], string> = {
    draft: '#888', approved: '#5096d8', paid: '#86c7a3', cancelled: '#666', reversed: '#e9a3a3',
  };
  return (
    <span style={{
      padding: '0.15rem 0.5rem', fontSize: 11, borderRadius: 3,
      background: '#222', color: colour[status], textTransform: 'uppercase',
    }}>{status}</span>
  );
}

function Kpi({ label, value, colour }: { label: string; value: string; colour: string }) {
  return (
    <div style={{ padding: 16, background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 6 }}>
      <div style={{ fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ marginTop: 6, fontSize: 22, color: colour, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

const h2: React.CSSProperties = { fontSize: 14, marginTop: 24, marginBottom: 8 };
const th: React.CSSProperties = { padding: '0.4rem 0.5rem', textAlign: 'left', fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 500 };
const thRight: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '0.5rem' };
const tdRight: React.CSSProperties = { ...td, textAlign: 'right' };
const btnPrim: React.CSSProperties = { padding: '0.4rem 1rem', background: '#1c4868', color: '#fff', border: '1px solid #5096d8', borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const btnAccent: React.CSSProperties = { padding: '0.4rem 1rem', background: '#1f5a3a', color: '#fff', border: '1px solid #86c7a3', borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const btnGhost: React.CSSProperties = { padding: '0.4rem 1rem', background: 'transparent', color: '#aaa', border: '1px solid #333', borderRadius: 4, fontSize: 12, cursor: 'pointer' };
const btnGhostRed: React.CSSProperties = { padding: '0.4rem 1rem', background: 'transparent', color: '#e9a3a3', border: '1px solid #5a2a2a', borderRadius: 4, fontSize: 12, cursor: 'pointer' };
