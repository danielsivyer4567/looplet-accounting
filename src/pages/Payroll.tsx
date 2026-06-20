/**
 * Payroll — list of pay runs with totals + "+ New pay run" creator.
 *
 * Reads pay_runs (RLS-scoped). Creates new runs via the
 * payroll-create-pay-run edge function.
 */

import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { formatMoney } from '@/lib/money';
import { SkeletonTable } from '@/components/Skeleton';

interface PayRun {
  id: string;
  period_start: string;
  period_end: string;
  pay_date: string;
  status: 'draft' | 'approved' | 'paid' | 'cancelled' | 'reversed';
  total_gross_cents: number;
  total_tax_cents: number;
  total_super_cents: number;
  total_net_cents: number;
  created_at: string;
}

interface Employee {
  id: string;
  full_name: string;
  is_active: boolean;
}

const STATUS_COLOUR: Record<PayRun['status'], string> = {
  draft: '#888',
  approved: '#5096d8',
  paid: '#86c7a3',
  cancelled: '#666',
  reversed: '#e9a3a3',
};

export function PayrollPage() {
  const { currentOrg } = useOrg();
  const [runs, setRuns] = useState<PayRun[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    const [runsRes, empRes] = await Promise.all([
      supabase.from('pay_runs').select('*')
        .eq('organization_id', currentOrg.id)
        .order('period_start', { ascending: false }),
      supabase.from('employees').select('id, full_name, is_active')
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .order('full_name'),
    ]);
    setRuns((runsRes.data ?? []) as PayRun[]);
    setEmployees((empRes.data ?? []) as Employee[]);
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => void refresh(), [refresh]);

  if (!currentOrg) return null;

  const ytdTotals = runs
    .filter((r) => r.status === 'paid' && r.pay_date >= fyStart())
    .reduce((acc, r) => ({
      gross: acc.gross + Number(r.total_gross_cents),
      tax:   acc.tax + Number(r.total_tax_cents),
      sup:   acc.sup + Number(r.total_super_cents),
      net:   acc.net + Number(r.total_net_cents),
    }), { gross: 0, tax: 0, sup: 0, net: 0 });

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Payroll</h1>
        <button onClick={() => setShowCreate(true)} disabled={employees.filter((e) => e.is_active).length === 0} style={btnPrim}>
          + New pay run
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, maxWidth: 1100 }}>
        <Kpi label="YTD gross" value={formatMoney(ytdTotals.gross)} colour="#aaa" />
        <Kpi label="YTD PAYG" value={formatMoney(ytdTotals.tax)} colour="#e9a3a3" />
        <Kpi label="YTD super" value={formatMoney(ytdTotals.sup)} colour="#5096d8" />
        <Kpi label="YTD net paid" value={formatMoney(ytdTotals.net)} colour="#86c7a3" />
      </div>

      {showCreate && (
        <CreatePayRunForm
          employees={employees.filter((e) => e.is_active)}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); void refresh(); }}
        />
      )}

      <h2 style={h2}>Pay runs</h2>
      {loading ? (
        <SkeletonTable rows={3} cols={6} />
      ) : runs.length === 0 ? (
        <p style={{ color: '#888', fontSize: 13 }}>
          No pay runs yet. Approve some timesheets and click <strong>+ New pay run</strong> to start.
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ borderBottom: '1px solid #2a2a2a' }}>
              <th style={th}>Period</th>
              <th style={th}>Pay date</th>
              <th style={th}>Status</th>
              <th style={thRight}>Gross</th>
              <th style={thRight}>PAYG</th>
              <th style={thRight}>Super</th>
              <th style={thRight}>Net</th>
            </tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} style={{ borderBottom: '1px solid #1a1a1a' }}>
                  <td style={td}>
                    <Link to={`/payroll/${r.id}`} style={{ color: '#86c7a3', textDecoration: 'none' }}>
                      {r.period_start} → {r.period_end}
                    </Link>
                  </td>
                  <td style={td}>{r.pay_date}</td>
                  <td style={td}><Pill colour={STATUS_COLOUR[r.status]}>{r.status}</Pill></td>
                  <td style={tdRight}>{formatMoney(Number(r.total_gross_cents))}</td>
                  <td style={tdRight}>{formatMoney(Number(r.total_tax_cents))}</td>
                  <td style={tdRight}>{formatMoney(Number(r.total_super_cents))}</td>
                  <td style={tdRight}><strong>{formatMoney(Number(r.total_net_cents))}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// New pay run form
// ---------------------------------------------------------------------------

function CreatePayRunForm({ employees, onClose, onCreated }: {
  employees: Employee[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { currentOrg } = useOrg();
  const [frequency, setFrequency] = useState<'weekly' | 'fortnightly' | 'monthly'>('weekly');
  const today = new Date();
  const monday = new Date(today);
  const day = monday.getDay();
  const diffToMon = (day === 0 ? -6 : 1 - day);
  monday.setDate(today.getDate() + diffToMon - 7); // last week's Monday
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const payDate = new Date(sunday);
  payDate.setDate(sunday.getDate() + 3); // pay 3 days after period end

  const [periodStart, setPeriodStart] = useState(monday.toISOString().slice(0, 10));
  const [periodEnd, setPeriodEnd] = useState(sunday.toISOString().slice(0, 10));
  const [payDateStr, setPayDateStr] = useState(payDate.toISOString().slice(0, 10));
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    new Set(employees.map((e) => e.id)),
  );
  const [claimsThreshold, setClaimsThreshold] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const submit = async () => {
    if (!currentOrg) return;
    setBusy(true);
    setErr(null);
    const { data, error } = await supabase.functions.invoke('payroll-create-pay-run', {
      body: {
        organization_id: currentOrg.id,
        period_start: periodStart,
        period_end: periodEnd,
        pay_date: payDateStr,
        employee_ids: Array.from(selectedIds),
        frequency,
        claims_threshold: claimsThreshold,
      },
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    if (!(data as { ok?: boolean })?.ok) {
      setErr((data as { error?: string })?.error ?? 'Failed to create pay run');
      return;
    }
    onCreated();
  };

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ fontSize: 14, margin: 0 }}>New pay run</h3>
        <button onClick={onClose} style={closeBtn}>×</button>
      </div>

      <div style={grid3}>
        <Field label="Frequency">
          <select value={frequency} onChange={(e) => setFrequency(e.target.value as typeof frequency)} style={inp}>
            <option value="weekly">Weekly</option>
            <option value="fortnightly">Fortnightly</option>
            <option value="monthly">Monthly</option>
          </select>
        </Field>
        <Field label="Period start">
          <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} style={inp} />
        </Field>
        <Field label="Period end">
          <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} style={inp} />
        </Field>
      </div>
      <div style={grid2}>
        <Field label="Pay date">
          <input type="date" value={payDateStr} onChange={(e) => setPayDateStr(e.target.value)} style={inp} />
        </Field>
        <Field label="Tax-free threshold">
          <select value={claimsThreshold ? 'yes' : 'no'} onChange={(e) => setClaimsThreshold(e.target.value === 'yes')} style={inp}>
            <option value="yes">Claimed (Scale 2 — most employees)</option>
            <option value="no">Not claimed (Scale 1 — second job / non-resident)</option>
          </select>
        </Field>
      </div>

      <h4 style={{ fontSize: 12, color: '#888', marginTop: 16 }}>Employees ({selectedIds.size}/{employees.length})</h4>
      <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid #2a2a2a', borderRadius: 4, padding: 6 }}>
        {employees.length === 0 ? (
          <p style={{ color: '#888', fontSize: 12, margin: 8 }}>No active employees.</p>
        ) : employees.map((e) => (
          <label key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 4, fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={selectedIds.has(e.id)} onChange={() => toggle(e.id)} />
            {e.full_name}
          </label>
        ))}
      </div>

      <p style={{ marginTop: 8, fontSize: 12, color: '#888' }}>
        The run will pull <strong>approved</strong> timesheets in [{periodStart} → {periodEnd}], split into ordinary / overtime / leave hours by <code>entry_type</code>, and compute PAYG + super.
      </p>

      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button onClick={submit} disabled={busy || selectedIds.size === 0} style={btnPrim}>
          {busy ? 'Creating…' : 'Create draft pay run'}
        </button>
        <button onClick={onClose} disabled={busy} style={btnGhost}>Cancel</button>
      </div>
      {err && <p style={{ color: 'salmon', fontSize: 12, marginTop: 8 }}>{err}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fyStart(): string {
  const now = new Date();
  const y = now.getMonth() + 1 >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  return `${y}-07-01`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', fontSize: 11, color: '#888', marginTop: 6 }}>
      <div style={{ marginBottom: 3 }}>{label}</div>
      {children}
    </label>
  );
}

function Kpi({ label, value, colour }: { label: string; value: string; colour: string }) {
  return (
    <div style={{ padding: 12, background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 6 }}>
      <div style={{ fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ marginTop: 4, fontSize: 18, color: colour, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

function Pill({ children, colour }: { children: React.ReactNode; colour: string }) {
  return (
    <span style={{
      padding: '0.15rem 0.5rem', fontSize: 11, borderRadius: 3,
      background: '#222', color: colour, textTransform: 'uppercase',
    }}>{children}</span>
  );
}

const card: React.CSSProperties = { marginTop: 16, padding: 16, background: '#0e0e0e', border: '1px solid #2a2a2a', borderRadius: 6, maxWidth: 720 };
const grid2: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 };
const grid3: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 };
const inp: React.CSSProperties = { width: '100%', padding: '6px 8px', background: '#000', color: '#ddd', border: '1px solid #333', borderRadius: 3, fontSize: 12 };
const h2: React.CSSProperties = { fontSize: 14, marginTop: 24, marginBottom: 8 };
const th: React.CSSProperties = { padding: '0.4rem 0.5rem', textAlign: 'left', fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 500 };
const thRight: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '0.5rem' };
const tdRight: React.CSSProperties = { ...td, textAlign: 'right' };
const btnPrim: React.CSSProperties = { padding: '0.4rem 1rem', background: '#1c4868', color: '#fff', border: '1px solid #5096d8', borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const btnGhost: React.CSSProperties = { padding: '0.4rem 1rem', background: 'transparent', color: '#aaa', border: '1px solid #333', borderRadius: 4, fontSize: 12, cursor: 'pointer' };
const closeBtn: React.CSSProperties = { background: 'transparent', color: '#888', border: 'none', fontSize: 18, cursor: 'pointer', padding: 0 };
