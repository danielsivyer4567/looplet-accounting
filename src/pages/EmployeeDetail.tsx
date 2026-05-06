import { useEffect, useMemo, useState, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';
import { formatMoney } from '@/lib/money';

interface WageComponents {
  base_hourly_rate?: number;
  super_pct?: number;
  workcover_pct?: number;
  leave_loading_pct?: number;
  loaded_hourly_rate_cents?: number;
}

interface Employee {
  id: string;
  organization_id: string;
  full_name: string;
  email: string | null;
  role: string | null;
  is_active: boolean;
  wage_components: WageComponents | null;
  created_at: string;
}

interface JobLite {
  id: string;
  job_number: string;
  name: string;
}

interface Timesheet {
  id: string;
  employee_id: string;
  job_id: string | null;
  work_date: string;
  hours: number;
  loaded_hourly_rate_cents: number;
  total_cost_cents: number;
  is_billable: boolean;
  notes: string | null;
  entry_type?: 'ordinary' | 'overtime' | 'annual_leave' | 'sick_leave' | 'public_holiday' | null;
  job?: { job_number: string; name: string } | null;
}

interface LeaveBalance {
  id: string;
  leave_type: 'annual' | 'sick' | 'long_service';
  hours_accrued: number;
  hours_taken: number;
  hours_balance: number;
}

interface PaySlipLite {
  id: string;
  pay_run_id: string;
  hours_ordinary: number;
  hours_overtime: number;
  hours_leave: number;
  gross_total_cents: number;
  payg_tax_cents: number;
  super_guarantee_cents: number;
  net_pay_cents: number;
  ytd_gross_cents: number;
  ytd_tax_cents: number;
  ytd_super_cents: number;
  pay_run?: { period_start: string; period_end: string; pay_date: string; status: string } | null;
}

// Mirrors Employees.tsx computeLoadedRate.
function computeLoadedRate(w: WageComponents): number {
  const base = (w.base_hourly_rate ?? 0) * 100;
  const sup = (w.super_pct ?? 11.5) / 100;
  const wc = (w.workcover_pct ?? 1.5) / 100;
  const leave = (w.leave_loading_pct ?? 8) / 100;
  return Math.round(base * (1 + sup + wc + leave));
}

export function EmployeeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { currentOrg } = useOrg();
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [recentTs, setRecentTs] = useState<Timesheet[]>([]);
  const [allYearTs, setAllYearTs] = useState<Timesheet[]>([]);
  const [jobs, setJobs] = useState<JobLite[]>([]);
  const [leave, setLeave] = useState<LeaveBalance[]>([]);
  const [paySlips, setPaySlips] = useState<PaySlipLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<Employee> & { wage_components?: WageComponents }>({});
  const [saving, setSaving] = useState(false);
  const [showLogTime, setShowLogTime] = useState(false);

  const refresh = useCallback(async () => {
    if (!currentOrg || !id) return;
    setLoading(true);
    setError(null);
    const sixtyAgo = new Date();
    sixtyAgo.setDate(sixtyAgo.getDate() - 60);
    const sixtyStr = sixtyAgo.toISOString().slice(0, 10);
    const yearAgo = new Date();
    yearAgo.setFullYear(yearAgo.getFullYear() - 1);
    const yearStr = yearAgo.toISOString().slice(0, 10);

    const [empRes, recentRes, yearRes, jobsRes, leaveRes, slipsRes] = await Promise.all([
      supabase.from('employees').select('*').eq('id', id).eq('organization_id', currentOrg.id).is('deleted_at', null).maybeSingle(),
      supabase.from('timesheet_entries')
        .select('*, job:jobs(job_number, name)')
        .eq('employee_id', id).eq('organization_id', currentOrg.id).is('deleted_at', null)
        .gte('work_date', sixtyStr)
        .order('work_date', { ascending: false }),
      supabase.from('timesheet_entries')
        .select('id, work_date, hours, total_cost_cents, job_id')
        .eq('employee_id', id).eq('organization_id', currentOrg.id).is('deleted_at', null)
        .gte('work_date', yearStr),
      supabase.from('jobs').select('id, job_number, name').eq('organization_id', currentOrg.id).is('deleted_at', null).order('job_number'),
      supabase.from('leave_balances')
        .select('id, leave_type, hours_accrued, hours_taken, hours_balance')
        .eq('employee_id', id).eq('organization_id', currentOrg.id),
      supabase.from('pay_slips')
        .select('id, pay_run_id, hours_ordinary, hours_overtime, hours_leave, gross_total_cents, payg_tax_cents, super_guarantee_cents, net_pay_cents, ytd_gross_cents, ytd_tax_cents, ytd_super_cents, pay_run:pay_runs(period_start, period_end, pay_date, status)')
        .eq('employee_id', id).eq('organization_id', currentOrg.id)
        .order('created_at', { ascending: false })
        .limit(10),
    ]);
    if (empRes.error) {
      setError(empRes.error.message);
      setLoading(false);
      return;
    }
    setEmployee((empRes.data ?? null) as Employee | null);
    setRecentTs((recentRes.data ?? []) as unknown as Timesheet[]);
    setAllYearTs((yearRes.data ?? []) as unknown as Timesheet[]);
    setJobs((jobsRes.data ?? []) as JobLite[]);
    setLeave((leaveRes.data ?? []) as LeaveBalance[]);
    setPaySlips((slipsRes.data ?? []) as unknown as PaySlipLite[]);
    setLoading(false);
  }, [currentOrg, id]);

  useEffect(() => void refresh(), [refresh]);

  const startEdit = () => {
    if (!employee) return;
    setDraft({
      full_name: employee.full_name,
      email: employee.email ?? '',
      role: employee.role ?? '',
      is_active: employee.is_active,
      wage_components: { ...(employee.wage_components ?? {}) },
    });
    setEditing(true);
  };

  const save = async () => {
    if (!employee) return;
    setSaving(true);
    setError(null);
    const wage: WageComponents = { ...(draft.wage_components ?? {}) };
    const loaded = computeLoadedRate(wage);
    wage.loaded_hourly_rate_cents = loaded;
    const payload: Partial<Employee> = {
      full_name: (draft.full_name ?? employee.full_name).toString().trim(),
      email: draft.email?.toString().trim() || null,
      role: draft.role?.toString().trim() || null,
      is_active: draft.is_active ?? employee.is_active,
      wage_components: wage,
    };
    const { error: e } = await supabase.from('employees').update(payload).eq('id', employee.id);
    setSaving(false);
    if (e) {
      setError(e.message);
      return;
    }
    setEditing(false);
    void refresh();
  };

  const updateTimesheet = async (tid: string, patch: { hours?: number; notes?: string | null }) => {
    const ts = recentTs.find((t) => t.id === tid);
    if (!ts) return;
    const newPatch: Record<string, unknown> = { ...patch };
    if (patch.hours != null) {
      // Recompute total cost from existing loaded rate.
      newPatch.total_cost_cents = Math.round(patch.hours * ts.loaded_hourly_rate_cents);
    }
    const { error: e } = await supabase.from('timesheet_entries').update(newPatch).eq('id', tid);
    if (e) {
      setError(e.message);
      return;
    }
    void refresh();
  };

  const deleteTimesheet = async (tid: string) => {
    if (!confirm('Delete this timesheet entry?')) return;
    const { error: e } = await supabase.from('timesheet_entries').update({ deleted_at: new Date().toISOString() }).eq('id', tid);
    if (e) {
      setError(e.message);
      return;
    }
    void refresh();
  };

  const kpis = useMemo(() => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const quarterMonth = Math.floor(now.getMonth() / 3) * 3;
    const quarterStart = new Date(now.getFullYear(), quarterMonth, 1).toISOString().slice(0, 10);
    const yearStart = new Date(now.getFullYear(), 0, 1).toISOString().slice(0, 10);
    const sum = (since: string) =>
      allYearTs.filter((t) => t.work_date >= since).reduce((a, t) => a + Number(t.hours), 0);
    return {
      month: sum(monthStart),
      quarter: sum(quarterStart),
      year: sum(yearStart),
    };
  }, [allYearTs]);

  // Cost per job (last 90 days).
  const jobCostBreakdown = useMemo(() => {
    const ninetyAgo = new Date();
    ninetyAgo.setDate(ninetyAgo.getDate() - 90);
    const cutoff = ninetyAgo.toISOString().slice(0, 10);
    const map = new Map<string, { total_cost_cents: number; hours: number }>();
    for (const t of allYearTs) {
      if (t.work_date < cutoff) continue;
      if (!t.job_id) continue;
      const cur = map.get(t.job_id) ?? { total_cost_cents: 0, hours: 0 };
      cur.total_cost_cents += t.total_cost_cents;
      cur.hours += Number(t.hours);
      map.set(t.job_id, cur);
    }
    return Array.from(map.entries())
      .map(([job_id, v]) => {
        const job = jobs.find((j) => j.id === job_id);
        return { job_id, job_number: job?.job_number ?? '—', job_name: job?.name ?? '(unknown)', ...v };
      })
      .sort((a, b) => b.total_cost_cents - a.total_cost_cents);
  }, [allYearTs, jobs]);

  if (!currentOrg) return null;
  if (loading) return <section><h1>Employee</h1><p style={{ color: '#888' }}>Loading…</p></section>;
  if (!employee)
    return (
      <section>
        <h1>Employee not found</h1>
        <Link to="/employees" style={{ color: '#86c7a3' }}>&larr; Back to employees</Link>
      </section>
    );

  const w = employee.wage_components ?? {};
  const loadedRate = w.loaded_hourly_rate_cents ?? computeLoadedRate(w);

  return (
    <section>
      <Link to="/employees" style={{ color: '#86c7a3', fontSize: 13 }}>&larr; All employees</Link>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: '0.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <h1 style={{ margin: 0 }}>{employee.full_name}</h1>
          {employee.role && <span style={{ color: '#aaa', fontSize: 13 }}>{employee.role}</span>}
          <StatusPill active={employee.is_active} />
        </div>
        {!editing && (
          <span style={{ display: 'inline-flex', gap: 8 }}>
            <button onClick={() => setShowLogTime(true)} style={btnPrim}>+ Log time</button>
            <button onClick={startEdit} style={btnGhost}>✎ Edit</button>
          </span>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginTop: 16, maxWidth: 1100 }}>
        <KpiCard label="Hours this month" value={kpis.month.toFixed(1)} colour="#5096d8" />
        <KpiCard label="Hours this quarter" value={kpis.quarter.toFixed(1)} colour="#5096d8" />
        <KpiCard label="Hours this year" value={kpis.year.toFixed(1)} colour="#5096d8" />
        <KpiCard label="Loaded $/hr" value={loadedRate > 0 ? formatMoney(loadedRate) : '—'} colour="#86c7a3" sub="incl super/leave/workcover" />
      </div>
      <p style={{ marginTop: 8, fontSize: 12, color: '#888' }}>
        Employed since {new Date(employee.created_at).toLocaleDateString()}
      </p>

      {editing ? (
        <div style={card}>
          <div style={grid2}>
            <Field label="Full name">
              <input value={String(draft.full_name ?? '')} onChange={(e) => setDraft({ ...draft, full_name: e.target.value })} style={inp} />
            </Field>
            <Field label="Role">
              <input value={String(draft.role ?? '')} onChange={(e) => setDraft({ ...draft, role: e.target.value })} style={inp} />
            </Field>
          </div>
          <div style={grid2}>
            <Field label="Email">
              <input value={String(draft.email ?? '')} onChange={(e) => setDraft({ ...draft, email: e.target.value })} style={inp} />
            </Field>
            <Field label="Active">
              <select value={draft.is_active ? 'true' : 'false'} onChange={(e) => setDraft({ ...draft, is_active: e.target.value === 'true' })} style={inp}>
                <option value="true">Active</option>
                <option value="false">Inactive</option>
              </select>
            </Field>
          </div>
          <h4 style={{ fontSize: 12, color: '#888', marginTop: 12 }}>Wage components — loaded hourly rate</h4>
          <div style={grid4}>
            <Field label="Base $/hr">
              <input type="number" step="0.01"
                value={draft.wage_components?.base_hourly_rate ?? 0}
                onChange={(e) => setDraft({ ...draft, wage_components: { ...(draft.wage_components ?? {}), base_hourly_rate: parseFloat(e.target.value) || 0 } })}
                style={inp} />
            </Field>
            <Field label="Super %">
              <input type="number" step="0.1"
                value={draft.wage_components?.super_pct ?? 11.5}
                onChange={(e) => setDraft({ ...draft, wage_components: { ...(draft.wage_components ?? {}), super_pct: parseFloat(e.target.value) || 0 } })}
                style={inp} />
            </Field>
            <Field label="Workcover %">
              <input type="number" step="0.1"
                value={draft.wage_components?.workcover_pct ?? 1.5}
                onChange={(e) => setDraft({ ...draft, wage_components: { ...(draft.wage_components ?? {}), workcover_pct: parseFloat(e.target.value) || 0 } })}
                style={inp} />
            </Field>
            <Field label="Leave loading %">
              <input type="number" step="0.1"
                value={draft.wage_components?.leave_loading_pct ?? 8}
                onChange={(e) => setDraft({ ...draft, wage_components: { ...(draft.wage_components ?? {}), leave_loading_pct: parseFloat(e.target.value) || 0 } })}
                style={inp} />
            </Field>
          </div>
          <p style={{ marginTop: 8, fontSize: 12, color: '#86c7a3' }}>
            Loaded rate: <strong>{formatMoney(computeLoadedRate(draft.wage_components ?? {}))}</strong>/hr (recomputed on save)
          </p>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button onClick={save} disabled={saving} style={btnPrim}>{saving ? 'Saving…' : 'Save'}</button>
            <button onClick={() => setEditing(false)} disabled={saving} style={btnGhost}>Cancel</button>
          </div>
          {error && <p style={{ color: 'salmon', fontSize: 12, marginTop: 8 }}>{error}</p>}
        </div>
      ) : (
        <div style={{ ...card, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          <Stat label="Email" value={employee.email ?? '—'} />
          <Stat label="Role" value={employee.role ?? '—'} />
          <Stat label="Status" value={employee.is_active ? 'Active' : 'Inactive'} />
          <Stat label="Base $/hr" value={w.base_hourly_rate != null ? `$${Number(w.base_hourly_rate).toFixed(2)}` : '—'} />
          <Stat label="Super %" value={w.super_pct != null ? `${w.super_pct}%` : '—'} />
          <Stat label="Workcover %" value={w.workcover_pct != null ? `${w.workcover_pct}%` : '—'} />
          <Stat label="Leave loading %" value={w.leave_loading_pct != null ? `${w.leave_loading_pct}%` : '—'} />
          <Stat label="Loaded $/hr" value={loadedRate > 0 ? formatMoney(loadedRate) : '—'} />
          <Stat label="Created" value={new Date(employee.created_at).toLocaleDateString()} />
        </div>
      )}

      {showLogTime && (
        <LogTimeForm
          employee={employee}
          jobs={jobs}
          loadedRate={loadedRate}
          onClose={() => setShowLogTime(false)}
          onLogged={() => { setShowLogTime(false); void refresh(); }}
        />
      )}

      <h2 style={h2}>Recent timesheets — last 60 days</h2>
      {recentTs.length === 0 ? (
        <p style={{ color: '#888', fontSize: 13 }}>No timesheet entries in the last 60 days.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
              <th style={th}>Date</th>
              <th style={th}>Job</th>
              <th style={thRight}>Hours</th>
              <th style={thRight}>Rate</th>
              <th style={thRight}>Cost</th>
              <th style={th}>Notes</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {recentTs.map((t) => (
              <TimesheetRow
                key={t.id}
                ts={t}
                onUpdate={(patch) => void updateTimesheet(t.id, patch)}
                onDelete={() => void deleteTimesheet(t.id)}
              />
            ))}
          </tbody>
        </table>
      )}

      <h2 style={h2}>Cost per job — last 90 days</h2>
      {jobCostBreakdown.length === 0 ? (
        <p style={{ color: '#888', fontSize: 13 }}>No job-attached time logged in the last 90 days.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
              <th style={th}>Job</th>
              <th style={thRight}>Hours</th>
              <th style={thRight}>Cost</th>
            </tr>
          </thead>
          <tbody>
            {jobCostBreakdown.map((row) => (
              <tr key={row.job_id} style={{ borderBottom: '1px solid #1a1a1a' }}>
                <td style={td}>
                  <Link to={`/jobs/${row.job_id}`} style={{ color: '#86c7a3', textDecoration: 'none' }}>
                    <code style={{ color: '#aaa', fontSize: 12 }}>{row.job_number}</code>
                    <span style={{ color: '#ddd', marginLeft: 8 }}>{row.job_name}</span>
                  </Link>
                </td>
                <td style={tdRight}>{row.hours.toFixed(1)}</td>
                <td style={tdRight}><strong>{formatMoney(row.total_cost_cents)}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={h2}>Leave balances</h2>
      <LeaveBalancesPanel orgId={currentOrg.id} employeeId={employee.id} balances={leave} onChange={() => void refresh()} />

      <h2 style={h2}>Recent payslips</h2>
      {paySlips.length === 0 ? (
        <p style={{ color: '#888', fontSize: 13 }}>No payslips yet for this employee.</p>
      ) : (
        <>
          {(() => {
            const latest = paySlips[0];
            if (!latest) return null;
            return (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, maxWidth: 720, marginBottom: 12 }}>
                <KpiCard label="YTD gross" value={formatMoney(Number(latest.ytd_gross_cents))} colour="#aaa" />
                <KpiCard label="YTD PAYG" value={formatMoney(Number(latest.ytd_tax_cents))} colour="#e9a3a3" />
                <KpiCard label="YTD super" value={formatMoney(Number(latest.ytd_super_cents))} colour="#5096d8" />
              </div>
            );
          })()}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ borderBottom: '1px solid #2a2a2a' }}>
              <th style={th}>Period</th>
              <th style={th}>Pay date</th>
              <th style={th}>Status</th>
              <th style={thRight}>Hours</th>
              <th style={thRight}>Gross</th>
              <th style={thRight}>PAYG</th>
              <th style={thRight}>Super</th>
              <th style={thRight}>Net</th>
            </tr></thead>
            <tbody>
              {paySlips.map((s) => (
                <tr key={s.id} style={{ borderBottom: '1px solid #1a1a1a' }}>
                  <td style={td}>
                    <Link to={`/payroll/${s.pay_run_id}`} style={{ color: '#86c7a3', textDecoration: 'none' }}>
                      {s.pay_run?.period_start} → {s.pay_run?.period_end}
                    </Link>
                  </td>
                  <td style={td}>{s.pay_run?.pay_date ?? '—'}</td>
                  <td style={td}><span style={{ color: s.pay_run?.status === 'paid' ? '#86c7a3' : '#888', fontSize: 11, textTransform: 'uppercase' }}>{s.pay_run?.status ?? '—'}</span></td>
                  <td style={tdRight}>{(Number(s.hours_ordinary) + Number(s.hours_overtime) + Number(s.hours_leave)).toFixed(1)}</td>
                  <td style={tdRight}>{formatMoney(Number(s.gross_total_cents))}</td>
                  <td style={tdRight}>{formatMoney(Number(s.payg_tax_cents))}</td>
                  <td style={tdRight}>{formatMoney(Number(s.super_guarantee_cents))}</td>
                  <td style={tdRight}><strong>{formatMoney(Number(s.net_pay_cents))}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Leave balances panel — three rows (annual / sick / long_service) with
// admin-editable accrued + taken hours. Initial rows auto-created on demand.
// ---------------------------------------------------------------------------
function LeaveBalancesPanel({ orgId, employeeId, balances, onChange }: {
  orgId: string;
  employeeId: string;
  balances: LeaveBalance[];
  onChange: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const types: Array<LeaveBalance['leave_type']> = ['annual', 'sick', 'long_service'];

  const upsert = async (
    leave_type: LeaveBalance['leave_type'],
    field: 'hours_accrued' | 'hours_taken',
    value: number,
  ) => {
    setBusy(`${leave_type}:${field}`);
    setErr(null);
    const existing = balances.find((b) => b.leave_type === leave_type);
    if (existing) {
      const { error: e } = await supabase
        .from('leave_balances')
        .update({ [field]: value })
        .eq('id', existing.id);
      if (e) setErr(e.message);
    } else {
      const { error: e } = await supabase.from('leave_balances').insert({
        organization_id: orgId,
        employee_id: employeeId,
        leave_type,
        hours_accrued: field === 'hours_accrued' ? value : 0,
        hours_taken:   field === 'hours_taken'   ? value : 0,
      });
      if (e) setErr(e.message);
    }
    setBusy(null);
    onChange();
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, maxWidth: 720 }}>
      {types.map((t) => {
        const b = balances.find((x) => x.leave_type === t);
        return (
          <div key={t} style={{ padding: 12, background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 6 }}>
            <div style={{ fontSize: 11, color: '#aaa', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              {t === 'long_service' ? 'Long service' : t} leave
            </div>
            <div style={{ marginTop: 6, fontSize: 22, color: '#86c7a3', fontWeight: 600 }}>
              {(b?.hours_balance ?? 0).toFixed(1)} h
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: '#888', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <label>Accrued
                <input type="number" step="0.5" defaultValue={Number(b?.hours_accrued ?? 0)}
                  onBlur={(e) => void upsert(t, 'hours_accrued', parseFloat(e.target.value) || 0)}
                  disabled={busy === `${t}:hours_accrued`}
                  style={{ ...inp, marginTop: 2 }} />
              </label>
              <label>Taken
                <input type="number" step="0.5" defaultValue={Number(b?.hours_taken ?? 0)}
                  onBlur={(e) => void upsert(t, 'hours_taken', parseFloat(e.target.value) || 0)}
                  disabled={busy === `${t}:hours_taken`}
                  style={{ ...inp, marginTop: 2 }} />
              </label>
            </div>
          </div>
        );
      })}
      {err && <p style={{ gridColumn: '1 / -1', color: 'salmon', fontSize: 12 }}>{err}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline-edit row for timesheets.
// ---------------------------------------------------------------------------
function TimesheetRow({ ts, onUpdate, onDelete }: { ts: Timesheet; onUpdate: (patch: { hours?: number; notes?: string | null }) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [hours, setHours] = useState(Number(ts.hours));
  const [notes, setNotes] = useState(ts.notes ?? '');

  const save = () => {
    onUpdate({ hours, notes: notes.trim() || null });
    setEditing(false);
  };

  return (
    <tr style={{ borderBottom: '1px solid #1a1a1a' }}>
      <td style={td}>{ts.work_date}</td>
      <td style={td}>{ts.job ? <span><code style={{ color: '#aaa', fontSize: 12 }}>{ts.job.job_number}</code> · {ts.job.name}</span> : <span style={{ color: '#666' }}>(unassigned)</span>}</td>
      <td style={tdRight}>
        {editing ? (
          <input type="number" step="0.25" value={hours} onChange={(e) => setHours(parseFloat(e.target.value) || 0)} style={{ ...inp, width: 70, textAlign: 'right' }} />
        ) : (
          Number(ts.hours).toFixed(2)
        )}
      </td>
      <td style={tdRight}>{formatMoney(ts.loaded_hourly_rate_cents)}</td>
      <td style={tdRight}>{formatMoney(Math.round((editing ? hours : Number(ts.hours)) * ts.loaded_hourly_rate_cents))}</td>
      <td style={td}>
        {editing ? (
          <input value={notes} onChange={(e) => setNotes(e.target.value)} style={{ ...inp, width: '100%' }} />
        ) : (
          <span style={{ color: '#888', fontSize: 12 }}>{ts.notes ?? ''}</span>
        )}
      </td>
      <td style={td}>
        {editing ? (
          <span style={{ display: 'inline-flex', gap: 4 }}>
            <button onClick={save} style={btnTinyPrim}>Save</button>
            <button onClick={() => { setEditing(false); setHours(Number(ts.hours)); setNotes(ts.notes ?? ''); }} style={btnTiny}>Cancel</button>
          </span>
        ) : (
          <span style={{ display: 'inline-flex', gap: 4 }}>
            <button onClick={() => setEditing(true)} style={btnTiny}>Edit</button>
            <button onClick={onDelete} style={btnTinyRed}>Del</button>
          </span>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Log-time form, prefilled with this employee.
// ---------------------------------------------------------------------------
function LogTimeForm({ employee, jobs, loadedRate, onClose, onLogged }: { employee: Employee; jobs: JobLite[]; loadedRate: number; onClose: () => void; onLogged: () => void }) {
  const { currentOrg } = useOrg();
  const [jobId, setJobId] = useState('');
  const [workDate, setWorkDate] = useState(new Date().toISOString().slice(0, 10));
  const [hours, setHours] = useState(8);
  const [notes, setNotes] = useState('');
  const [entryType, setEntryType] = useState<'ordinary' | 'overtime' | 'annual_leave' | 'sick_leave' | 'public_holiday'>('ordinary');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const totalCost = Math.round(hours * loadedRate);

  const submit = async () => {
    if (!currentOrg) return;
    setBusy(true);
    setErr(null);
    const { error } = await supabase.from('timesheet_entries').insert({
      organization_id: currentOrg.id,
      employee_id: employee.id,
      job_id: jobId || null,
      work_date: workDate,
      hours,
      loaded_hourly_rate_cents: loadedRate,
      notes: notes.trim() || null,
      is_billable: true,
      entry_type: entryType,
    });
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    onLogged();
  };

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ fontSize: 14, margin: 0 }}>Log time — {employee.full_name}</h3>
        <button onClick={onClose} style={closeBtn}>×</button>
      </div>
      <div style={grid2}>
        <Field label="Date"><input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} style={inp} /></Field>
        <Field label="Hours"><input type="number" step="0.25" value={hours} onChange={(e) => setHours(parseFloat(e.target.value) || 0)} style={inp} /></Field>
      </div>
      <div style={grid2}>
        <Field label="Entry type">
          <select value={entryType} onChange={(e) => setEntryType(e.target.value as typeof entryType)} style={inp}>
            <option value="ordinary">Ordinary</option>
            <option value="overtime">Overtime</option>
            <option value="annual_leave">Annual leave</option>
            <option value="sick_leave">Sick leave</option>
            <option value="public_holiday">Public holiday</option>
          </select>
        </Field>
        <Field label="Job (optional)">
          <select value={jobId} onChange={(e) => setJobId(e.target.value)} style={inp}>
            <option value="">— unassigned —</option>
            {jobs.map((j) => <option key={j.id} value={j.id}>{j.job_number} · {j.name}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Notes"><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was worked on" style={inp} /></Field>
      <p style={{ marginTop: 8, fontSize: 12, color: '#86c7a3' }}>
        Cost: <strong>{formatMoney(totalCost)}</strong> ({hours}h × {formatMoney(loadedRate)}/hr loaded)
      </p>
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button onClick={submit} disabled={busy || hours <= 0} style={btnPrim}>{busy ? 'Logging…' : 'Log entry'}</button>
        <button onClick={onClose} disabled={busy} style={btnGhost}>Cancel</button>
      </div>
      {err && <p style={{ color: 'salmon', fontSize: 12, marginTop: 8 }}>{err}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared chrome.
// ---------------------------------------------------------------------------
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', fontSize: 11, color: '#888', marginTop: 6 }}>
      <div style={{ marginBottom: 3 }}>{label}</div>
      {children}
    </label>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ marginTop: 3, color: '#ddd', fontSize: 13, fontFamily: mono ? 'monospace' : 'inherit' }}>{value}</div>
    </div>
  );
}

function KpiCard({ label, value, colour, sub }: { label: string; value: string; colour: string; sub?: string }) {
  return (
    <div style={{ padding: 16, background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 6 }}>
      <div style={{ fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ marginTop: 6, fontSize: 22, color: colour, fontWeight: 600 }}>{value}</div>
      {sub && <div style={{ marginTop: 4, fontSize: 11, color: '#888' }}>{sub}</div>}
    </div>
  );
}

function StatusPill({ active }: { active: boolean }) {
  return (
    <span style={{
      padding: '0.15rem 0.5rem', fontSize: 11, borderRadius: 3,
      background: '#222', color: active ? '#86c7a3' : '#666', textTransform: 'uppercase',
    }}>{active ? 'Active' : 'Inactive'}</span>
  );
}

const card: React.CSSProperties = { marginTop: 16, padding: 16, background: '#0e0e0e', border: '1px solid #2a2a2a', borderRadius: 6, maxWidth: 920 };
const grid2: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 };
const grid4: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 };
const inp: React.CSSProperties = { width: '100%', padding: '6px 8px', background: '#000', color: '#ddd', border: '1px solid #333', borderRadius: 3, fontSize: 12 };
const h2: React.CSSProperties = { fontSize: 14, marginTop: 24, marginBottom: 8 };
const th: React.CSSProperties = { padding: '0.4rem 0.5rem', textAlign: 'left', fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 500 };
const thRight: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '0.5rem' };
const tdRight: React.CSSProperties = { ...td, textAlign: 'right' };
const btnPrim: React.CSSProperties = { padding: '0.4rem 1rem', background: '#1c4868', color: '#fff', border: '1px solid #5096d8', borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const btnGhost: React.CSSProperties = { padding: '0.4rem 1rem', background: 'transparent', color: '#aaa', border: '1px solid #333', borderRadius: 4, fontSize: 12, cursor: 'pointer' };
const btnTiny: React.CSSProperties = { padding: '0.2rem 0.6rem', background: 'transparent', color: '#aaa', border: '1px solid #333', borderRadius: 3, fontSize: 11, cursor: 'pointer' };
const btnTinyPrim: React.CSSProperties = { padding: '0.2rem 0.6rem', background: '#1c4868', color: '#fff', border: '1px solid #5096d8', borderRadius: 3, fontSize: 11, cursor: 'pointer' };
const btnTinyRed: React.CSSProperties = { padding: '0.2rem 0.6rem', background: 'transparent', color: '#e9a3a3', border: '1px solid #333', borderRadius: 3, fontSize: 11, cursor: 'pointer' };
const closeBtn: React.CSSProperties = { background: 'transparent', color: '#888', border: 'none', fontSize: 18, cursor: 'pointer', padding: 0 };
