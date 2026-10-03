import { useEffect, useState, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { formatMoney } from '@/lib/money';
import { currentStatutorySuperRatePct } from '@/lib/superGuarantee';
import { addDays, orgTimeZone, todayLocal } from '@/lib/localDates';
import { formatLoadError, formatActionError } from '@/lib/errorMessages';
import { SkeletonTable } from '@/components/Skeleton';
import { Contact, Plus, Wallet, Clock, X, Users, Calculator, type LucideIcon } from 'lucide-react';

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

interface Job {
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
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    const sinceStr = addDays(todayLocal(orgTimeZone(currentOrg)), -30);

    const [empRes, jobsRes, tsRes] = await Promise.all([
      supabase
        .from('employees')
        .select('*')
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .order('full_name'),
      supabase
        .from('jobs')
        .select('id, job_number, name')
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .order('job_number'),
      supabase
        .from('timesheet_entries')
        .select('*, employee:employees(full_name), job:jobs(job_number, name)')
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .gte('work_date', sinceStr)
        .order('work_date', { ascending: false }),
    ]);
    const loadErr = empRes.error ?? jobsRes.error ?? tsRes.error;
    if (loadErr) {
      // A failed load must not masquerade as "no employees added yet".
      setLoadError(formatLoadError('employees', loadErr.message));
      setEmployees([]);
      setJobs([]);
      setTimesheets([]);
      setLoading(false);
      return;
    }
    setLoadError(null);
    setEmployees((empRes.data ?? []) as Employee[]);
    setJobs((jobsRes.data ?? []) as Job[]);
    setTimesheets((tsRes.data ?? []) as unknown as Timesheet[]);
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => void refresh(), [refresh]);

  if (!currentOrg) return null;

  const computeLoadedRate = (w: WageComponents): number => {
    const base = (w.base_hourly_rate ?? 0) * 100;
    const sup = (w.super_pct ?? currentStatutorySuperRatePct()) / 100;
    const wc = (w.workcover_pct ?? 1.5) / 100;
    const leave = (w.leave_loading_pct ?? 8) / 100;
    return Math.round(base * (1 + sup + wc + leave));
  };

  const totalLast30 = timesheets.reduce((a, t) => a + t.total_cost_cents, 0);
  const hoursLast30 = timesheets.reduce((a, t) => a + Number(t.hours), 0);

  return (
    <section className="animated-fade-in">
      {/* Header section */}
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
        <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Contact size={24} style={{ color: 'var(--text-link)' }} />
          Employees
        </h1>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            onClick={() => setShowLogTime(true)}
            disabled={employees.length === 0}
            className="btn btn-primary"
          >
            <Clock size={16} />
            <span>Log hours</span>
          </button>
          <button onClick={() => setShowAddEmployee(true)} className="btn btn-secondary">
            <Plus size={16} />
            <span>Add employee</span>
          </button>
        </div>
      </div>

      {/* Wage cost / Hours KPIs */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: '1rem',
          marginBottom: '2rem',
        }}
      >
        <Kpi
          label="Active employees"
          value={String(employees.filter((e) => e.is_active).length)}
          type="info"
          icon={Users}
        />
        <Kpi
          label="Hours logged (30d)"
          value={hoursLast30.toFixed(1)}
          type="neutral"
          icon={Clock}
        />
        <Kpi
          label="Loaded wage cost (30d)"
          value={formatMoney(totalLast30)}
          type="danger"
          icon={Wallet}
          sub="Loaded — incl. super/leave/workcover"
        />
      </div>

      {showAddEmployee && (
        <AddEmployeeForm
          onClose={() => setShowAddEmployee(false)}
          onAdded={() => {
            setShowAddEmployee(false);
            void refresh();
          }}
          computeLoadedRate={computeLoadedRate}
        />
      )}
      {showLogTime && (
        <LogTimeForm
          employees={employees}
          jobs={jobs}
          computeLoadedRate={computeLoadedRate}
          onClose={() => setShowLogTime(false)}
          onLogged={() => {
            setShowLogTime(false);
            void refresh();
          }}
        />
      )}

      {/* Employees Directory List */}
      <h2 style={{ fontSize: '1.25rem', marginBottom: '0.75rem' }}>Staff Roster</h2>
      {loading ? (
        <SkeletonTable rows={4} cols={6} />
      ) : loadError ? (
        <div
          role="alert"
          className="badge badge-danger"
          style={{
            display: 'block',
            padding: '0.75rem',
            textTransform: 'none',
            marginBottom: '2rem',
          }}
        >
          {loadError}
        </div>
      ) : employees.length === 0 ? (
        <div
          style={{
            padding: '2.5rem',
            background: 'var(--bg-card)',
            border: '1px dashed var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--text-muted)',
            textAlign: 'center',
            fontSize: '0.9rem',
            marginBottom: '2rem',
          }}
        >
          No employees added yet. Add staff to start tracking timesheets and job costs.
        </div>
      ) : (
        <>
          <div
            className="employees-table-view table-premium-container"
            style={{ marginBottom: '2.5rem' }}
          >
            <table className="table-premium">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Email</th>
                  <th style={{ textAlign: 'right' }}>Base Rate</th>
                  <th style={{ textAlign: 'right' }}>Loaded Rate</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {employees.map((e) => {
                  const w = e.wage_components ?? {};
                  const loaded = w.loaded_hourly_rate_cents ?? computeLoadedRate(w);
                  return (
                    <tr
                      key={e.id}
                      style={{ cursor: 'pointer' }}
                      onClick={() => navigate(`/employees/${e.id}`)}
                    >
                      <td style={{ fontWeight: 600, color: 'var(--text-title)' }}>{e.full_name}</td>
                      <td>{e.role ?? <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                      <td>{e.email ?? <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'ui-monospace, monospace' }}>
                        {w.base_hourly_rate != null ? `$${w.base_hourly_rate.toFixed(2)}/hr` : '—'}
                      </td>
                      <td
                        style={{
                          textAlign: 'right',
                          fontWeight: 600,
                          fontFamily: 'ui-monospace, monospace',
                        }}
                      >
                        {loaded > 0 ? `${formatMoney(loaded)}/hr` : '—'}
                      </td>
                      <td>
                        <span
                          className={`badge ${e.is_active ? 'badge-success' : 'badge-neutral'}`}
                        >
                          {e.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div
            className="employees-card-view"
            aria-label="Employee cards"
            style={{ marginBottom: '2.5rem' }}
          >
            {employees.map((e) => {
              const w = e.wage_components ?? {};
              const loaded = w.loaded_hourly_rate_cents ?? computeLoadedRate(w);
              return (
                <article
                  key={`card-${e.id}`}
                  className="employee-mobile-card card"
                  aria-label={`Employee ${e.full_name}`}
                >
                  <div className="employee-mobile-card__header">
                    <div>
                      <a
                        href={`/employees/${e.id}`}
                        onClick={(ev) => {
                          ev.preventDefault();
                          navigate(`/employees/${e.id}`);
                        }}
                        style={{
                          fontWeight: 700,
                          color: 'var(--text-link)',
                          textDecoration: 'none',
                        }}
                      >
                        {e.full_name}
                      </a>
                      <div
                        style={{
                          color: 'var(--text-muted)',
                          fontSize: '0.75rem',
                          marginTop: '0.15rem',
                        }}
                      >
                        {e.role ?? 'No role'}
                        {e.email ? ` · ${e.email}` : ''}
                      </div>
                    </div>
                    <span className={`badge ${e.is_active ? 'badge-success' : 'badge-neutral'}`}>
                      {e.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                  <div className="employee-mobile-card__metrics">
                    <div>
                      <span>Base rate</span>
                      <strong>
                        {w.base_hourly_rate != null ? `$${w.base_hourly_rate.toFixed(2)}/hr` : '—'}
                      </strong>
                    </div>
                    <div>
                      <span>Loaded rate</span>
                      <strong>{loaded > 0 ? `${formatMoney(loaded)}/hr` : '—'}</strong>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </>
      )}

      {/* Recent Timesheets List */}
      <h2 style={{ fontSize: '1.25rem', marginBottom: '0.75rem' }}>
        Recent timesheets (last 30 days)
      </h2>
      {timesheets.length === 0 ? (
        <div
          style={{
            padding: '2.5rem',
            background: 'var(--bg-card)',
            border: '1px dashed var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--text-muted)',
            textAlign: 'center',
            fontSize: '0.9rem',
            marginBottom: '2rem',
          }}
        >
          No timesheet entries recorded in the last 30 days.
        </div>
      ) : (
        <div className="table-premium-container" style={{ marginBottom: '2.5rem' }}>
          <table className="table-premium">
            <thead>
              <tr>
                <th>Date</th>
                <th>Employee</th>
                <th>Job Assignment</th>
                <th style={{ textAlign: 'right' }}>Hours</th>
                <th style={{ textAlign: 'right' }}>Loaded Rate</th>
                <th style={{ textAlign: 'right' }}>Loaded Cost</th>
              </tr>
            </thead>
            <tbody>
              {timesheets.map((t) => (
                <tr key={t.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{t.work_date}</td>
                  <td style={{ fontWeight: 600, color: 'var(--text-title)' }}>
                    {t.employee?.full_name ?? '—'}
                  </td>
                  <td>
                    {t.job ? (
                      <Link to={`/jobs/${t.job_id}`} style={{ fontWeight: 600 }}>
                        <code>{t.job.job_number}</code> ·{' '}
                        <span style={{ color: 'var(--text-muted)' }}>{t.job.name}</span>
                      </Link>
                    ) : (
                      <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
                        (unassigned)
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'ui-monospace, monospace' }}>
                    {Number(t.hours).toFixed(2)}
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'ui-monospace, monospace' }}>
                    {formatMoney(t.loaded_hourly_rate_cents)}/hr
                  </td>
                  <td
                    style={{
                      textAlign: 'right',
                      fontWeight: 600,
                      color: 'var(--text-link)',
                      fontFamily: 'ui-monospace, monospace',
                    }}
                  >
                    {formatMoney(t.total_cost_cents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Info Footnote block */}
      <div
        style={{
          padding: '1rem 1.25rem',
          background: 'var(--bg-card)',
          border: '1px dashed var(--border-subtle)',
          borderRadius: 'var(--radius-md)',
          fontSize: '0.75rem',
          color: 'var(--text-muted)',
        }}
      >
        💡 <strong>Payroll lives in its own module:</strong> pay runs, gross-to-net with super, and
        STP export are under{' '}
        <Link to="/payroll" style={{ color: 'var(--text-link)', fontWeight: 600 }}>
          Payroll
        </Link>
        .
      </div>
    </section>
  );
}

function AddEmployeeForm({
  onClose,
  onAdded,
  computeLoadedRate,
}: {
  onClose: () => void;
  onAdded: () => void;
  computeLoadedRate: (w: WageComponents) => number;
}) {
  const { currentOrg } = useOrg();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('Tradie');
  const [baseRate, setBaseRate] = useState(45);
  // New employees default to the statutory super guarantee rate for today.
  const sgPct = currentStatutorySuperRatePct();
  const [superPct, setSuperPct] = useState(sgPct);
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
    if (error) {
      setErr(formatActionError('add the employee', error.message));
      return;
    }
    onAdded();
  };

  return (
    <div
      className="card"
      style={{ marginBottom: '1.5rem', maxWidth: '720px', animation: 'fadeIn 0.25s ease' }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1.25rem',
        }}
      >
        <h3 style={{ margin: 0, fontSize: '1.15rem' }}>Add Employee</h3>
        <button onClick={onClose} className="btn btn-ghost" style={{ padding: '0.2rem 0.4rem' }}>
          <X size={16} />
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '1rem',
          }}
        >
          <Field label="Full name *">
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="John Doe"
              className="form-input"
            />
          </Field>
          <Field label="Role">
            <input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="Tradie / Apprentice / Foreman"
              className="form-input"
            />
          </Field>
        </div>

        <Field label="Email address">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="john@company.com"
            className="form-input"
          />
        </Field>

        <div
          style={{
            borderTop: '1px solid var(--border-subtle)',
            paddingTop: '1rem',
            marginTop: '0.5rem',
          }}
        >
          <span
            style={{
              fontSize: '0.725rem',
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: '0.25rem',
            }}
          >
            <Calculator size={12} />
            Wage settings & loaded multipliers
          </span>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
              gap: '0.75rem',
              marginTop: '0.75rem',
            }}
          >
            <Field label="Base Rate ($/hr)">
              <input
                type="number"
                step="0.01"
                value={baseRate}
                onChange={(e) => setBaseRate(parseFloat(e.target.value) || 0)}
                className="form-input"
                style={{ textAlign: 'right' }}
              />
            </Field>
            <Field label="Super (%)">
              <input
                type="number"
                step="0.1"
                value={superPct}
                onChange={(e) => setSuperPct(parseFloat(e.target.value) || 0)}
                className="form-input"
                style={{ textAlign: 'right' }}
                aria-label="Super (%)"
              />
              {superPct < sgPct && (
                <div style={{ marginTop: '0.25rem', fontSize: '0.7rem', color: 'var(--text-warning)' }}>
                  Below the {sgPct}% super guarantee. Pay runs use at least {sgPct}%.
                </div>
              )}
            </Field>
            <Field label="Workcover (%)">
              <input
                type="number"
                step="0.1"
                value={workcoverPct}
                onChange={(e) => setWorkcoverPct(parseFloat(e.target.value) || 0)}
                className="form-input"
                style={{ textAlign: 'right' }}
              />
            </Field>
            <Field label="Leave Loading (%)">
              <input
                type="number"
                step="0.1"
                value={leavePct}
                onChange={(e) => setLeavePct(parseFloat(e.target.value) || 0)}
                className="form-input"
                style={{ textAlign: 'right' }}
              />
            </Field>
          </div>
        </div>

        <div
          style={{
            background: 'var(--bg-success-subtle)',
            padding: '0.75rem 1rem',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border-success)',
            fontSize: '0.85rem',
            color: 'var(--text-success)',
            marginTop: '0.5rem',
            fontWeight: 500,
          }}
        >
          Loaded rate estimate: <strong>{formatMoney(loadedRate)}/hr</strong> (calculated loaded
          labor cost).
        </div>

        {err && (
          <div
            className="badge badge-danger"
            style={{ display: 'block', padding: '0.625rem', textTransform: 'none' }}
          >
            {err}
          </div>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
          <button
            onClick={submit}
            disabled={busy || !fullName.trim()}
            className="btn btn-primary"
            style={{ padding: '0.625rem 1.25rem' }}
          >
            {busy ? 'Saving employee…' : 'Add employee'}
          </button>
          <button
            onClick={onClose}
            disabled={busy}
            className="btn btn-secondary"
            style={{ padding: '0.625rem 1.25rem' }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function LogTimeForm({
  employees,
  jobs,
  computeLoadedRate,
  onClose,
  onLogged,
}: {
  employees: Employee[];
  jobs: Job[];
  computeLoadedRate: (w: WageComponents) => number;
  onClose: () => void;
  onLogged: () => void;
}) {
  const { currentOrg } = useOrg();
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? '');
  const [jobId, setJobId] = useState('');
  const [workDate, setWorkDate] = useState(() => todayLocal(orgTimeZone(currentOrg)));
  const [hours, setHours] = useState(8);
  const [notes, setNotes] = useState('');
  const [entryType, setEntryType] = useState<
    'ordinary' | 'overtime' | 'annual_leave' | 'sick_leave' | 'public_holiday'
  >('ordinary');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const employee = employees.find((e) => e.id === employeeId);
  const loadedRate =
    employee?.wage_components?.loaded_hourly_rate_cents ??
    (employee?.wage_components ? computeLoadedRate(employee.wage_components) : 0);
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
      entry_type: entryType,
    });
    setBusy(false);
    if (error) {
      setErr(formatActionError('log this time entry', error.message));
      return;
    }
    onLogged();
  };

  return (
    <div
      className="card"
      style={{ marginBottom: '1.5rem', maxWidth: '720px', animation: 'fadeIn 0.25s ease' }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1.25rem',
        }}
      >
        <h3 style={{ margin: 0, fontSize: '1.15rem' }}>Log Hours Work</h3>
        <button onClick={onClose} className="btn btn-ghost" style={{ padding: '0.2rem 0.4rem' }}>
          <X size={16} />
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '1rem',
          }}
        >
          <Field label="Employee *">
            <select
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              className="form-select"
            >
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.full_name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Work Date">
            <input
              type="date"
              value={workDate}
              onChange={(e) => setWorkDate(e.target.value)}
              className="form-input"
            />
          </Field>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '1rem',
          }}
        >
          <Field label="Job Assignment (optional)">
            <select
              value={jobId}
              onChange={(e) => setJobId(e.target.value)}
              className="form-select"
            >
              <option value="">— unassigned —</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.job_number} · {j.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Hours Worked">
            <input
              type="number"
              step="0.25"
              value={hours}
              onChange={(e) => setHours(parseFloat(e.target.value) || 0)}
              className="form-input"
              style={{ textAlign: 'right' }}
            />
          </Field>
        </div>

        <Field label="Hourly multiplier type">
          <select
            value={entryType}
            onChange={(e) => setEntryType(e.target.value as typeof entryType)}
            className="form-select"
          >
            <option value="ordinary">Ordinary hours</option>
            <option value="overtime">Overtime hours</option>
            <option value="annual_leave">Annual leave</option>
            <option value="sick_leave">Sick leave</option>
            <option value="public_holiday">Public holiday</option>
          </select>
        </Field>

        <Field label="Work Description / Notes">
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Description of task worked on…"
            className="form-input"
          />
        </Field>

        <div
          style={{
            background: 'var(--bg-success-subtle)',
            padding: '0.75rem 1rem',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border-success)',
            fontSize: '0.85rem',
            color: 'var(--text-success)',
            marginTop: '0.5rem',
            fontWeight: 500,
          }}
        >
          Loaded labor cost: <strong>{formatMoney(totalCost)}</strong> ({hours}h ×{' '}
          {formatMoney(loadedRate)}/hr loaded rate)
        </div>

        {err && (
          <div
            className="badge badge-danger"
            style={{ display: 'block', padding: '0.625rem', textTransform: 'none' }}
          >
            {err}
          </div>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
          <button
            onClick={submit}
            disabled={busy || !employeeId || hours <= 0}
            className="btn btn-primary"
            style={{ padding: '0.625rem 1.25rem' }}
          >
            {busy ? 'Logging entry…' : 'Log entry'}
          </button>
          <button
            onClick={onClose}
            disabled={busy}
            className="btn btn-secondary"
            style={{ padding: '0.625rem 1.25rem' }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <span className="form-label" style={{ fontSize: '0.725rem' }}>
        {label}
      </span>
      <div style={{ marginTop: '0.25rem' }}>{children}</div>
    </div>
  );
}

function Kpi({
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
