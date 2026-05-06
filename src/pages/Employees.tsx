import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';
import { formatMoney } from '@/lib/money';
import { SkeletonTable } from '@/components/Skeleton';

interface Employee {
  id: string;
  full_name: string;
  email: string | null;
  role: string | null;
  is_active: boolean;
  wage_components: WageComponents | null;
}

interface WageComponents {
  base_hourly_rate?: number;
  super_pct?: number;
  workcover_pct?: number;
  leave_loading_pct?: number;
  loaded_hourly_rate_cents?: number;
}

interface Job { id: string; job_number: string; name: string }

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
  employee?: { full_name: string };
  job?: { job_number: string; name: string };
}

export function EmployeesPage() {
  const { currentOrg } = useOrg();
  const navigate = useNavigate();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [timesheets, setTimesheets] = useState<Timesheet[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddEmployee, setShowAddEmployee] = useState(false);
  const [showLogTime, setShowLogTime] = useState(false);

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const sinceStr = since.toISOString().slice(0, 10);

    const [empRes, jobsRes, tsRes] = await Promise.all([
      supabase.from('employees').select('*').eq('organization_id', currentOrg.id).is('deleted_at', null).order('full_name'),
      supabase.from('jobs').select('id, job_number, name').eq('organization_id', currentOrg.id).is('deleted_at', null).order('job_number'),
      supabase.from('timesheet_entries')
        .select('*, employee:employees(full_name), job:jobs(job_number, name)')
        .eq('organization_id', currentOrg.id).is('deleted_at', null)
        .gte('work_date', sinceStr)
        .order('work_date', { ascending: false }),
    ]);
    setEmployees((empRes.data ?? []) as Employee[]);
    setJobs((jobsRes.data ?? []) as Job[]);
    setTimesheets((tsRes.data ?? []) as unknown as Timesheet[]);
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => void refresh(), [refresh]);

  if (!currentOrg) return null;

  const computeLoadedRate = (w: WageComponents): number => {
    const base = (w.base_hourly_rate ?? 0) * 100;
    const sup = (w.super_pct ?? 11.5) / 100;
    const wc = (w.workcover_pct ?? 1.5) / 100;
    const leave = (w.leave_loading_pct ?? 8) / 100;
    return Math.round(base * (1 + sup + wc + leave));
  };

  const totalLast30 = timesheets.reduce((a, t) => a + t.total_cost_cents, 0);
  const hoursLast30 = timesheets.reduce((a, t) => a + Number(t.hours), 0);

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Employees</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setShowLogTime(true)} disabled={employees.length === 0} style={btnPrim}>+ Log time</button>
          <button onClick={() => setShowAddEmployee(true)} style={btnGhost}>+ Add employee</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, maxWidth: 900 }}>
        <Kpi label="Active employees" value={String(employees.filter((e) => e.is_active).length)} colour="#aaa" />
        <Kpi label="Hours logged (30d)" value={hoursLast30.toFixed(1)} colour="#5096d8" />
        <Kpi label="Wage cost (30d)" value={formatMoney(totalLast30)} colour="#e9a3a3" sub="loaded — incl super/leave/workcover" />
      </div>

      {showAddEmployee && (
        <AddEmployeeForm onClose={() => setShowAddEmployee(false)} onAdded={() => { setShowAddEmployee(false); void refresh(); }} computeLoadedRate={computeLoadedRate} />
      )}
      {showLogTime && (
        <LogTimeForm employees={employees} jobs={jobs} computeLoadedRate={computeLoadedRate} onClose={() => setShowLogTime(false)} onLogged={() => { setShowLogTime(false); void refresh(); }} />
      )}

      <h2 style={h2}>Employees</h2>
      {loading ? <SkeletonTable rows={4} cols={6} /> : employees.length === 0 ? (
        <p style={{ color: '#888', fontSize: 13 }}>No employees yet. Add one to start logging time against jobs.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ borderBottom: '1px solid #2a2a2a' }}>
              <th style={th}>Name</th><th style={th}>Role</th><th style={th}>Email</th>
              <th style={thRight}>Base $/hr</th><th style={thRight}>Loaded $/hr</th><th style={th}>Status</th>
            </tr></thead>
            <tbody>
              {employees.map((e) => {
                const w = e.wage_components ?? {};
                const loaded = w.loaded_hourly_rate_cents ?? computeLoadedRate(w);
                return (
                  <tr
                    key={e.id}
                    style={{ borderBottom: '1px solid #1a1a1a', cursor: 'pointer' }}
                    onClick={() => navigate(`/employees/${e.id}`)}
                    onMouseEnter={(ev) => { (ev.currentTarget as HTMLTableRowElement).style.background = '#202020'; }}
                    onMouseLeave={(ev) => { (ev.currentTarget as HTMLTableRowElement).style.background = ''; }}
                  >
                    <td style={td}><strong>{e.full_name}</strong></td>
                    <td style={td}>{e.role ?? '—'}</td>
                    <td style={td}>{e.email ?? '—'}</td>
                    <td style={tdRight}>{w.base_hourly_rate != null ? `$${w.base_hourly_rate.toFixed(2)}` : '—'}</td>
                    <td style={tdRight}>{loaded > 0 ? formatMoney(loaded) : '—'}</td>
                    <td style={td}>{e.is_active ? <Pill on>Active</Pill> : <Pill>Inactive</Pill>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={h2}>Recent timesheets (last 30 days)</h2>
      {timesheets.length === 0 ? (
        <p style={{ color: '#888', fontSize: 13 }}>No timesheet entries yet. Log time against a job to start cost-tracking.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr style={{ borderBottom: '1px solid #2a2a2a' }}>
              <th style={th}>Date</th><th style={th}>Employee</th><th style={th}>Job</th>
              <th style={thRight}>Hours</th><th style={thRight}>Rate</th><th style={thRight}>Cost</th>
            </tr></thead>
            <tbody>
              {timesheets.map((t) => (
                <tr key={t.id} style={{ borderBottom: '1px solid #1a1a1a' }}>
                  <td style={td}>{t.work_date}</td>
                  <td style={td}>{t.employee?.full_name ?? '—'}</td>
                  <td style={td}>{t.job ? `${t.job.job_number} · ${t.job.name}` : <span style={{ color: '#666' }}>(unassigned)</span>}</td>
                  <td style={tdRight}>{Number(t.hours).toFixed(2)}</td>
                  <td style={tdRight}>{formatMoney(t.loaded_hourly_rate_cents)}</td>
                  <td style={tdRight}>{formatMoney(t.total_cost_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ marginTop: 32, padding: 10, background: '#0e0e0e', border: '1px dashed #2a2a2a', borderRadius: 4, fontSize: 12, color: '#666' }}>
        Future: full payroll run (gross → tax → super → net), STP file export, geofenced timesheet starts (per ADR 0001), leave balances, employee self-service portal.
      </p>
    </section>
  );
}

function AddEmployeeForm({ onClose, onAdded, computeLoadedRate }: { onClose: () => void; onAdded: () => void; computeLoadedRate: (w: WageComponents) => number }) {
  const { currentOrg } = useOrg();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('Tradie');
  const [baseRate, setBaseRate] = useState(45);
  const [superPct, setSuperPct] = useState(11.5);
  const [workcoverPct, setWorkcoverPct] = useState(1.5);
  const [leavePct, setLeavePct] = useState(8);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const wageComponents: WageComponents = {
    base_hourly_rate: baseRate,
    super_pct: superPct,
    workcover_pct: workcoverPct,
    leave_loading_pct: leavePct,
  };
  const loadedRate = computeLoadedRate(wageComponents);

  const submit = async () => {
    if (!currentOrg) return;
    setBusy(true);
    const { error } = await supabase.from('employees').insert({
      organization_id: currentOrg.id,
      full_name: fullName.trim(),
      email: email.trim() || null,
      role: role.trim() || null,
      is_active: true,
      wage_components: { ...wageComponents, loaded_hourly_rate_cents: loadedRate },
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    onAdded();
  };

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ fontSize: 14, margin: 0 }}>Add employee</h3>
        <button onClick={onClose} style={closeBtn}>×</button>
      </div>
      <div style={grid2}>
        <Field label="Full name"><input value={fullName} onChange={(e) => setFullName(e.target.value)} style={inp} /></Field>
        <Field label="Role"><input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Tradie / Apprentice / Foreman" style={inp} /></Field>
      </div>
      <Field label="Email"><input value={email} onChange={(e) => setEmail(e.target.value)} style={inp} /></Field>
      <h4 style={{ fontSize: 12, color: '#888', marginTop: 12 }}>Wage components — loaded hourly rate</h4>
      <div style={grid4}>
        <Field label="Base $/hr"><input type="number" step="0.01" value={baseRate} onChange={(e) => setBaseRate(parseFloat(e.target.value) || 0)} style={inp} /></Field>
        <Field label="Super %"><input type="number" step="0.1" value={superPct} onChange={(e) => setSuperPct(parseFloat(e.target.value) || 0)} style={inp} /></Field>
        <Field label="Workcover %"><input type="number" step="0.1" value={workcoverPct} onChange={(e) => setWorkcoverPct(parseFloat(e.target.value) || 0)} style={inp} /></Field>
        <Field label="Leave loading %"><input type="number" step="0.1" value={leavePct} onChange={(e) => setLeavePct(parseFloat(e.target.value) || 0)} style={inp} /></Field>
      </div>
      <p style={{ marginTop: 8, fontSize: 12, color: '#86c7a3' }}>
        Loaded rate: <strong>{formatMoney(loadedRate)}</strong> per hour (per ADR 0001).
      </p>
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button onClick={submit} disabled={busy || !fullName.trim()} style={btnPrim}>{busy ? 'Adding…' : 'Add employee'}</button>
        <button onClick={onClose} disabled={busy} style={btnGhost}>Cancel</button>
      </div>
      {err && <p style={{ color: 'salmon', fontSize: 12, marginTop: 8 }}>{err}</p>}
    </div>
  );
}

function LogTimeForm({ employees, jobs, computeLoadedRate, onClose, onLogged }: { employees: Employee[]; jobs: Job[]; computeLoadedRate: (w: WageComponents) => number; onClose: () => void; onLogged: () => void }) {
  const { currentOrg } = useOrg();
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? '');
  const [jobId, setJobId] = useState('');
  const [workDate, setWorkDate] = useState(new Date().toISOString().slice(0, 10));
  const [hours, setHours] = useState(8);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const employee = employees.find((e) => e.id === employeeId);
  const loadedRate = employee?.wage_components?.loaded_hourly_rate_cents ?? (employee?.wage_components ? computeLoadedRate(employee.wage_components) : 0);
  const totalCost = Math.round(hours * loadedRate);

  const submit = async () => {
    if (!currentOrg || !employeeId) return;
    setBusy(true);
    const { error } = await supabase.from('timesheet_entries').insert({
      organization_id: currentOrg.id,
      employee_id: employeeId,
      job_id: jobId || null,
      work_date: workDate,
      hours,
      loaded_hourly_rate_cents: loadedRate,
      notes: notes.trim() || null,
      is_billable: true,
    });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    onLogged();
  };

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ fontSize: 14, margin: 0 }}>Log time</h3>
        <button onClick={onClose} style={closeBtn}>×</button>
      </div>
      <div style={grid2}>
        <Field label="Employee">
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} style={inp}>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.full_name}</option>)}
          </select>
        </Field>
        <Field label="Date"><input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} style={inp} /></Field>
      </div>
      <div style={grid2}>
        <Field label="Job (optional)">
          <select value={jobId} onChange={(e) => setJobId(e.target.value)} style={inp}>
            <option value="">— unassigned —</option>
            {jobs.map((j) => <option key={j.id} value={j.id}>{j.job_number} · {j.name}</option>)}
          </select>
        </Field>
        <Field label="Hours"><input type="number" step="0.25" value={hours} onChange={(e) => setHours(parseFloat(e.target.value) || 0)} style={inp} /></Field>
      </div>
      <Field label="Notes"><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was worked on" style={inp} /></Field>
      <p style={{ marginTop: 8, fontSize: 12, color: '#86c7a3' }}>
        Cost: <strong>{formatMoney(totalCost)}</strong> ({hours}h × {formatMoney(loadedRate)}/hr loaded)
      </p>
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button onClick={submit} disabled={busy || !employeeId || hours <= 0} style={btnPrim}>{busy ? 'Logging…' : 'Log entry'}</button>
        <button onClick={onClose} disabled={busy} style={btnGhost}>Cancel</button>
      </div>
      {err && <p style={{ color: 'salmon', fontSize: 12, marginTop: 8 }}>{err}</p>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: 'block', fontSize: 11, color: '#888', marginTop: 6 }}><div style={{ marginBottom: 3 }}>{label}</div>{children}</label>;
}
function Kpi({ label, value, colour, sub }: { label: string; value: string; colour: string; sub?: string }) {
  return (
    <div style={{ padding: 12, background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 6 }}>
      <div style={{ fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ marginTop: 4, fontSize: 18, color: colour, fontWeight: 600 }}>{value}</div>
      {sub && <div style={{ marginTop: 3, fontSize: 11, color: '#888' }}>{sub}</div>}
    </div>
  );
}
function Pill({ children, on }: { children: React.ReactNode; on?: boolean }) {
  return <span style={{ padding: '0.15rem 0.5rem', fontSize: 11, borderRadius: 3, background: '#222', color: on ? '#86c7a3' : '#666', textTransform: 'uppercase' }}>{children}</span>;
}

const card: React.CSSProperties = { marginTop: 16, padding: 16, background: '#0e0e0e', border: '1px solid #2a2a2a', borderRadius: 6, maxWidth: 720 };
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
const closeBtn: React.CSSProperties = { background: 'transparent', color: '#888', border: 'none', fontSize: 18, cursor: 'pointer', padding: 0 };
