import { useEffect, useMemo, useState, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { formatMoney } from '@/lib/money';
import {
  ChevronLeft,
  User,
  Clock,
  Briefcase,
  Calendar,
  DollarSign,
  Wallet,
  Edit3,
  Save,
  X,
  Activity,
  FileText,
  Plus,
  Trash2,
  AlertTriangle,
  type LucideIcon,
} from 'lucide-react';

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
  modern_award: string | null;
  classification_level: string | null;
  created_at: string;
}

/** Row of v_award_rate_exceptions (SC-3.K.02) when this employee is flagged. */
interface AwardRateException {
  modern_award: string;
  classification_level: string;
  base_hourly_rate_cents: number;
  award_min_hourly_rate_cents: number;
  shortfall_cents: number;
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
  const [awardException, setAwardException] = useState<AwardRateException | null>(null);
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

    const [empRes, recentRes, yearRes, jobsRes, leaveRes, slipsRes, excRes] = await Promise.all([
      supabase
        .from('employees')
        .select('*')
        .eq('id', id)
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .maybeSingle(),
      supabase
        .from('timesheet_entries')
        .select('*, job:jobs(job_number, name)')
        .eq('employee_id', id)
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .gte('work_date', sixtyStr)
        .order('work_date', { ascending: false }),
      supabase
        .from('timesheet_entries')
        .select('id, work_date, hours, total_cost_cents, job_id')
        .eq('employee_id', id)
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .gte('work_date', yearStr),
      supabase
        .from('jobs')
        .select('id, job_number, name')
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .order('job_number'),
      supabase
        .from('leave_balances')
        .select('id, leave_type, hours_accrued, hours_taken, hours_balance')
        .eq('employee_id', id)
        .eq('organization_id', currentOrg.id),
      supabase
        .from('pay_slips')
        .select(
          'id, pay_run_id, hours_ordinary, hours_overtime, hours_leave, gross_total_cents, payg_tax_cents, super_guarantee_cents, net_pay_cents, ytd_gross_cents, ytd_tax_cents, ytd_super_cents, pay_run:pay_runs(period_start, period_end, pay_date, status)',
        )
        .eq('employee_id', id)
        .eq('organization_id', currentOrg.id)
        .order('created_at', { ascending: false })
        .limit(10),
      // Award underpayment flag (SC-3.K.02). Best-effort: the view may not be
      // deployed yet — an error degrades to "no flag", never breaks the page.
      supabase
        .from('v_award_rate_exceptions' as never)
        .select(
          'modern_award, classification_level, base_hourly_rate_cents, award_min_hourly_rate_cents, shortfall_cents',
        )
        .eq('employee_id', id)
        .maybeSingle(),
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
    setAwardException(excRes.error ? null : ((excRes.data ?? null) as unknown as AwardRateException | null));
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
      modern_award: employee.modern_award ?? '',
      classification_level: employee.classification_level ?? '',
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
      modern_award: draft.modern_award?.toString().trim() || null,
      classification_level: draft.classification_level?.toString().trim() || null,
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
    const { error: e } = await supabase
      .from('timesheet_entries')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', tid);
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
        return {
          job_id,
          job_number: job?.job_number ?? '—',
          job_name: job?.name ?? '(unknown)',
          ...v,
        };
      })
      .sort((a, b) => b.total_cost_cents - a.total_cost_cents);
  }, [allYearTs, jobs]);

  if (!currentOrg) return null;
  if (loading)
    return (
      <section>
        <p style={{ color: 'var(--text-muted)' }}>Loading employee details…</p>
      </section>
    );
  if (!employee) {
    return (
      <section className="animated-fade-in" style={{ padding: '2rem 0', textAlign: 'center' }}>
        <h2>Employee not found</h2>
        <Link to="/employees" className="btn btn-secondary" style={{ marginTop: '1rem' }}>
          <ChevronLeft size={16} /> Back to employees
        </Link>
      </section>
    );
  }

  const w = employee.wage_components ?? {};
  const loadedRate = w.loaded_hourly_rate_cents ?? computeLoadedRate(w);

  return (
    <section className="animated-fade-in">
      {/* Back button */}
      <Link
        to="/employees"
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
        <span>All employees</span>
      </Link>

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
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <User size={24} style={{ color: 'var(--accent-primary)' }} />
            {employee.full_name}
          </h1>
          {employee.role && (
            <span className="badge badge-neutral" style={{ fontSize: '0.825rem' }}>
              {employee.role}
            </span>
          )}
          <span className={`badge ${employee.is_active ? 'badge-success' : 'badge-neutral'}`}>
            {employee.is_active ? 'Active' : 'Inactive'}
          </span>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button onClick={() => setShowLogTime(true)} className="btn btn-primary">
            <Plus size={16} />
            <span>Log time</span>
          </button>

          {!editing && (
            <button onClick={startEdit} className="btn btn-secondary">
              <Edit3 size={14} />
              <span>Edit Info</span>
            </button>
          )}
        </div>
      </div>

      {/* KPI Cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '1rem',
          marginBottom: '1.5rem',
        }}
      >
        <KpiCard label="Hours (Month)" value={kpis.month.toFixed(1)} type="info" icon={Clock} />
        <KpiCard label="Hours (Quarter)" value={kpis.quarter.toFixed(1)} type="info" icon={Clock} />
        <KpiCard label="Hours (Year)" value={kpis.year.toFixed(1)} type="info" icon={Clock} />
        <KpiCard
          label="Loaded Rate"
          value={loadedRate > 0 ? formatMoney(loadedRate) : '—'}
          type="success"
          icon={DollarSign}
          sub="incl super, leave & workcover"
        />
      </div>

      <p
        style={{
          marginTop: '-0.5rem',
          marginBottom: '1.5rem',
          fontSize: '0.75rem',
          color: 'var(--text-muted)',
        }}
      >
        Employed since {new Date(employee.created_at).toLocaleDateString()}
      </p>

      {/* Award underpayment flag (SC-3.K.02) — ASSIST-ONLY: surfaces a possible
          underpayment for a human to confirm. No auto-correction. */}
      {awardException && (
        <div
          className="card"
          style={{
            marginBottom: '1.5rem',
            background: 'var(--bg-warning-subtle)',
            border: '1px solid var(--accent-warning)',
            display: 'flex',
            gap: '0.75rem',
            alignItems: 'flex-start',
          }}
        >
          <AlertTriangle
            size={20}
            style={{ color: 'var(--text-warning)', flexShrink: 0, marginTop: '0.1rem' }}
          />
          <div>
            <strong style={{ display: 'block', marginBottom: '0.25rem', color: 'var(--text-warning)' }}>
              Possible award underpayment — please review
            </strong>
            <p style={{ margin: 0, fontSize: '0.875rem' }}>
              Base rate {formatMoney(awardException.base_hourly_rate_cents)}/hr is{' '}
              {formatMoney(awardException.shortfall_cents)}/hr below the {awardException.modern_award}{' '}
              {awardException.classification_level} minimum of{' '}
              {formatMoney(awardException.award_min_hourly_rate_cents)}/hr.
            </p>
            <p style={{ margin: '0.4rem 0 0', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Automated assist using <em>illustrative</em> award data — confirm against the actual
              modern award and the employee&apos;s exact classification before acting. No pay change
              is made automatically.
            </p>
          </div>
        </div>
      )}

      {/* Edit Form / Detail Card */}
      {editing ? (
        <div className="card" style={{ marginBottom: '1.5rem', maxWidth: '850px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                gap: '1rem',
              }}
            >
              <Field label="Full name">
                <input
                  value={String(draft.full_name ?? '')}
                  onChange={(e) => setDraft({ ...draft, full_name: e.target.value })}
                  className="form-input"
                />
              </Field>
              <Field label="Role">
                <input
                  value={String(draft.role ?? '')}
                  onChange={(e) => setDraft({ ...draft, role: e.target.value })}
                  className="form-input"
                />
              </Field>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                gap: '1rem',
              }}
            >
              <Field label="Email">
                <input
                  value={String(draft.email ?? '')}
                  onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                  className="form-input"
                />
              </Field>
              <Field label="Status">
                <select
                  value={draft.is_active ? 'true' : 'false'}
                  onChange={(e) => setDraft({ ...draft, is_active: e.target.value === 'true' })}
                  className="form-select"
                >
                  <option value="true">Active</option>
                  <option value="false">Inactive</option>
                </select>
              </Field>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                gap: '1rem',
              }}
            >
              <Field label="Modern award">
                <input
                  value={String(draft.modern_award ?? '')}
                  onChange={(e) => setDraft({ ...draft, modern_award: e.target.value })}
                  placeholder="e.g. MA000004"
                  className="form-input"
                />
              </Field>
              <Field label="Classification level">
                <input
                  value={String(draft.classification_level ?? '')}
                  onChange={(e) => setDraft({ ...draft, classification_level: e.target.value })}
                  placeholder="e.g. Level 2"
                  className="form-input"
                />
              </Field>
            </div>

            <h4
              style={{
                fontSize: '0.825rem',
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                marginTop: '0.5rem',
                marginBottom: '0.25rem',
              }}
            >
              Wage components — loaded hourly rate
            </h4>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: '1rem',
              }}
            >
              <Field label="Base $/hr">
                <input
                  type="number"
                  step="0.01"
                  value={draft.wage_components?.base_hourly_rate ?? 0}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      wage_components: {
                        ...(draft.wage_components ?? {}),
                        base_hourly_rate: parseFloat(e.target.value) || 0,
                      },
                    })
                  }
                  className="form-input"
                />
              </Field>
              <Field label="Super %">
                <input
                  type="number"
                  step="0.1"
                  value={draft.wage_components?.super_pct ?? 11.5}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      wage_components: {
                        ...(draft.wage_components ?? {}),
                        super_pct: parseFloat(e.target.value) || 0,
                      },
                    })
                  }
                  className="form-input"
                />
              </Field>
              <Field label="Workcover %">
                <input
                  type="number"
                  step="0.1"
                  value={draft.wage_components?.workcover_pct ?? 1.5}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      wage_components: {
                        ...(draft.wage_components ?? {}),
                        workcover_pct: parseFloat(e.target.value) || 0,
                      },
                    })
                  }
                  className="form-input"
                />
              </Field>
              <Field label="Leave loading %">
                <input
                  type="number"
                  step="0.1"
                  value={draft.wage_components?.leave_loading_pct ?? 8}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      wage_components: {
                        ...(draft.wage_components ?? {}),
                        leave_loading_pct: parseFloat(e.target.value) || 0,
                      },
                    })
                  }
                  className="form-input"
                />
              </Field>
            </div>

            <p style={{ fontSize: '0.875rem', color: 'var(--text-success)', fontWeight: 600 }}>
              Loaded rate: {formatMoney(computeLoadedRate(draft.wage_components ?? {}))}/hr
              (recomputed on save)
            </p>

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
              <button
                onClick={save}
                disabled={saving}
                className="btn btn-primary"
                style={{ padding: '0.625rem 1.25rem' }}
              >
                <Save size={14} />
                <span>{saving ? 'Saving…' : 'Save'}</span>
              </button>
              <button
                onClick={() => setEditing(false)}
                disabled={saving}
                className="btn btn-secondary"
                style={{ padding: '0.625rem 1.25rem' }}
              >
                <span>Cancel</span>
              </button>
            </div>
            {error && (
              <div
                className="badge badge-danger"
                style={{ display: 'block', padding: '0.625rem', textTransform: 'none' }}
              >
                {error}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div
          className="card"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: '1.25rem',
            marginBottom: '2rem',
          }}
        >
          <Stat label="Email" value={employee.email ?? '—'} />
          <Stat label="Role" value={employee.role ?? '—'} />
          <Stat label="Status" value={employee.is_active ? 'Active' : 'Inactive'} />
          <Stat
            label="Base $/hr"
            value={w.base_hourly_rate != null ? `$${Number(w.base_hourly_rate).toFixed(2)}` : '—'}
          />
          <Stat label="Super %" value={w.super_pct != null ? `${w.super_pct}%` : '—'} />
          <Stat label="Workcover %" value={w.workcover_pct != null ? `${w.workcover_pct}%` : '—'} />
          <Stat
            label="Leave loading %"
            value={w.leave_loading_pct != null ? `${w.leave_loading_pct}%` : '—'}
          />
          <Stat label="Loaded $/hr" value={loadedRate > 0 ? formatMoney(loadedRate) : '—'} />
          <Stat label="Modern award" value={employee.modern_award ?? '—'} />
          <Stat label="Classification" value={employee.classification_level ?? '—'} />
          <Stat label="Created" value={new Date(employee.created_at).toLocaleDateString()} />
        </div>
      )}

      {/* Log Time Popup Form */}
      {showLogTime && (
        <div
          className="card"
          style={{
            marginBottom: '2rem',
            border: '1px solid var(--accent-primary)',
            position: 'relative',
          }}
        >
          <button
            onClick={() => setShowLogTime(false)}
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
          <LogTimeForm
            employee={employee}
            jobs={jobs}
            loadedRate={loadedRate}
            onClose={() => setShowLogTime(false)}
            onLogged={() => {
              setShowLogTime(false);
              void refresh();
            }}
          />
        </div>
      )}

      {/* Recent Timesheets */}
      <h2
        style={{
          fontSize: '1.25rem',
          marginTop: '2rem',
          marginBottom: '0.75rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.35rem',
        }}
      >
        <Clock size={16} style={{ color: 'var(--text-muted)' }} />
        Recent timesheets — last 60 days
      </h2>
      {recentTs.length === 0 ? (
        <div
          style={{
            padding: '2rem',
            background: 'var(--bg-card)',
            border: '1px dashed var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            textAlign: 'center',
            color: 'var(--text-muted)',
            fontSize: '0.875rem',
            marginBottom: '2rem',
          }}
        >
          No timesheet entries in the last 60 days.
        </div>
      ) : (
        <div className="table-premium-container" style={{ marginBottom: '2rem' }}>
          <table className="table-premium">
            <thead>
              <tr>
                <th>Date</th>
                <th>Job</th>
                <th style={{ textAlign: 'right' }}>Hours</th>
                <th style={{ textAlign: 'right' }}>Rate</th>
                <th style={{ textAlign: 'right' }}>Cost</th>
                <th>Notes</th>
                <th style={{ width: '120px' }}>Actions</th>
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
        </div>
      )}

      {/* Cost per Job */}
      <h2
        style={{
          fontSize: '1.25rem',
          marginTop: '2rem',
          marginBottom: '0.75rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.35rem',
        }}
      >
        <Briefcase size={16} style={{ color: 'var(--text-muted)' }} />
        Cost per job — last 90 days
      </h2>
      {jobCostBreakdown.length === 0 ? (
        <div
          style={{
            padding: '2rem',
            background: 'var(--bg-card)',
            border: '1px dashed var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            textAlign: 'center',
            color: 'var(--text-muted)',
            fontSize: '0.875rem',
            marginBottom: '2rem',
          }}
        >
          No job-attached time logged in the last 90 days.
        </div>
      ) : (
        <div className="table-premium-container" style={{ marginBottom: '2rem' }}>
          <table className="table-premium">
            <thead>
              <tr>
                <th>Job</th>
                <th style={{ textAlign: 'right' }}>Hours</th>
                <th style={{ textAlign: 'right' }}>Cost</th>
              </tr>
            </thead>
            <tbody>
              {jobCostBreakdown.map((row) => (
                <tr key={row.job_id}>
                  <td>
                    <Link to={`/jobs/${row.job_id}`} style={{ fontWeight: 600 }}>
                      <code>{row.job_number}</code>
                      <span style={{ marginLeft: 8, color: 'var(--text-body)' }}>
                        {row.job_name}
                      </span>
                    </Link>
                  </td>
                  <td style={{ textAlign: 'right' }}>{row.hours.toFixed(1)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>
                    {formatMoney(row.total_cost_cents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Leave Balances */}
      <h2
        style={{
          fontSize: '1.25rem',
          marginTop: '2rem',
          marginBottom: '0.75rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.35rem',
        }}
      >
        <Calendar size={16} style={{ color: 'var(--text-muted)' }} />
        Leave balances
      </h2>
      <div style={{ marginBottom: '2rem' }}>
        <LeaveBalancesPanel
          orgId={currentOrg.id}
          employeeId={employee.id}
          balances={leave}
          onChange={() => void refresh()}
        />
      </div>

      {/* Recent Payslips */}
      <h2
        style={{
          fontSize: '1.25rem',
          marginTop: '2rem',
          marginBottom: '0.75rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.35rem',
        }}
      >
        <FileText size={16} style={{ color: 'var(--text-muted)' }} />
        Recent payslips
      </h2>
      {paySlips.length === 0 ? (
        <div
          style={{
            padding: '2rem',
            background: 'var(--bg-card)',
            border: '1px dashed var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            textAlign: 'center',
            color: 'var(--text-muted)',
            fontSize: '0.875rem',
          }}
        >
          No payslips yet for this employee.
        </div>
      ) : (
        <>
          {(() => {
            const latest = paySlips[0];
            if (!latest) return null;
            return (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                  gap: '1rem',
                  marginBottom: '1rem',
                }}
              >
                <KpiCard
                  label="YTD Gross"
                  value={formatMoney(Number(latest.ytd_gross_cents))}
                  type="neutral"
                  icon={DollarSign}
                />
                <KpiCard
                  label="YTD PAYG"
                  value={formatMoney(Number(latest.ytd_tax_cents))}
                  type="danger"
                  icon={DollarSign}
                />
                <KpiCard
                  label="YTD Super"
                  value={formatMoney(Number(latest.ytd_super_cents))}
                  type="info"
                  icon={Wallet}
                />
              </div>
            );
          })()}
          <div className="table-premium-container">
            <table className="table-premium">
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Pay Date</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Hours</th>
                  <th style={{ textAlign: 'right' }}>Gross</th>
                  <th style={{ textAlign: 'right' }}>PAYG</th>
                  <th style={{ textAlign: 'right' }}>Super</th>
                  <th style={{ textAlign: 'right' }}>Net</th>
                </tr>
              </thead>
              <tbody>
                {paySlips.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link to={`/payroll/${s.pay_run_id}`} style={{ fontWeight: 600 }}>
                        {s.pay_run?.period_start} → {s.pay_run?.period_end}
                      </Link>
                    </td>
                    <td>{s.pay_run?.pay_date ?? '—'}</td>
                    <td>
                      <span
                        className={`badge ${s.pay_run?.status === 'paid' ? 'badge-success' : 'badge-neutral'}`}
                      >
                        {s.pay_run?.status ?? '—'}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {(
                        Number(s.hours_ordinary) +
                        Number(s.hours_overtime) +
                        Number(s.hours_leave)
                      ).toFixed(1)}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {formatMoney(Number(s.gross_total_cents))}
                    </td>
                    <td style={{ textAlign: 'right' }}>{formatMoney(Number(s.payg_tax_cents))}</td>
                    <td style={{ textAlign: 'right' }}>
                      {formatMoney(Number(s.super_guarantee_cents))}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>
                      {formatMoney(Number(s.net_pay_cents))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
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
          marginTop: '0.25rem',
          color: 'var(--text-title)',
          fontSize: '0.9rem',
          fontWeight: 600,
        }}
      >
        {value}
      </div>
    </div>
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

function LeaveBalancesPanel({
  orgId,
  employeeId,
  balances,
  onChange,
}: {
  orgId: string;
  employeeId: string;
  balances: LeaveBalance[];
  onChange: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const types: LeaveBalance['leave_type'][] = ['annual', 'sick', 'long_service'];

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
        hours_taken: field === 'hours_taken' ? value : 0,
      });
      if (e) setErr(e.message);
    }
    setBusy(null);
    onChange();
  };

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: '1rem',
      }}
    >
      {types.map((t) => {
        const b = balances.find((x) => x.leave_type === t);
        const name = t === 'long_service' ? 'Long Service' : t.charAt(0).toUpperCase() + t.slice(1);
        return (
          <div
            key={t}
            className="card"
            style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}
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
              {name} Leave
            </div>
            <div style={{ fontSize: '1.5rem', color: 'var(--text-success)', fontWeight: 800 }}>
              {(b?.hours_balance ?? 0).toFixed(1)} hrs
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '0.5rem',
                marginTop: '0.25rem',
              }}
            >
              <div className="form-group" style={{ marginBottom: 0 }}>
                <span className="form-label" style={{ fontSize: '0.65rem' }}>
                  Accrued
                </span>
                <input
                  type="number"
                  step="0.5"
                  defaultValue={Number(b?.hours_accrued ?? 0)}
                  onBlur={(e) => void upsert(t, 'hours_accrued', parseFloat(e.target.value) || 0)}
                  disabled={busy === `${t}:hours_accrued`}
                  className="form-input"
                  style={{ padding: '0.35rem 0.5rem', fontSize: '0.825rem' }}
                />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <span className="form-label" style={{ fontSize: '0.65rem' }}>
                  Taken
                </span>
                <input
                  type="number"
                  step="0.5"
                  defaultValue={Number(b?.hours_taken ?? 0)}
                  onBlur={(e) => void upsert(t, 'hours_taken', parseFloat(e.target.value) || 0)}
                  disabled={busy === `${t}:hours_taken`}
                  className="form-input"
                  style={{ padding: '0.35rem 0.5rem', fontSize: '0.825rem' }}
                />
              </div>
            </div>
          </div>
        );
      })}
      {err && (
        <div
          className="badge badge-danger"
          style={{ gridColumn: '1 / -1', padding: '0.5rem', textTransform: 'none' }}
        >
          {err}
        </div>
      )}
    </div>
  );
}

function TimesheetRow({
  ts,
  onUpdate,
  onDelete,
}: {
  ts: Timesheet;
  onUpdate: (patch: { hours?: number; notes?: string | null }) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [hours, setHours] = useState(Number(ts.hours));
  const [notes, setNotes] = useState(ts.notes ?? '');

  const save = () => {
    onUpdate({ hours, notes: notes.trim() || null });
    setEditing(false);
  };

  return (
    <tr>
      <td>{ts.work_date}</td>
      <td style={{ fontWeight: 600 }}>
        {ts.job ? (
          <span>
            <code>{ts.job.job_number}</code> · {ts.job.name}
          </span>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>(unassigned)</span>
        )}
      </td>
      <td style={{ textAlign: 'right' }}>
        {editing ? (
          <input
            type="number"
            step="0.25"
            value={hours}
            onChange={(e) => setHours(parseFloat(e.target.value) || 0)}
            className="form-input"
            style={{
              width: 80,
              textAlign: 'right',
              padding: '0.35rem 0.5rem',
              display: 'inline-block',
            }}
          />
        ) : (
          Number(ts.hours).toFixed(2)
        )}
      </td>
      <td style={{ textAlign: 'right' }}>{formatMoney(ts.loaded_hourly_rate_cents)}</td>
      <td style={{ textAlign: 'right', fontWeight: 600 }}>
        {formatMoney(
          Math.round((editing ? hours : Number(ts.hours)) * ts.loaded_hourly_rate_cents),
        )}
      </td>
      <td>
        {editing ? (
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="form-input"
            style={{ padding: '0.35rem 0.5rem' }}
          />
        ) : (
          <span style={{ color: 'var(--text-muted)', fontSize: '0.825rem' }}>{ts.notes ?? ''}</span>
        )}
      </td>
      <td>
        {editing ? (
          <div style={{ display: 'inline-flex', gap: '0.25rem' }}>
            <button
              onClick={save}
              className="btn btn-primary"
              style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
            >
              <Save size={12} />
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setHours(Number(ts.hours));
                setNotes(ts.notes ?? '');
              }}
              className="btn btn-secondary"
              style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
            >
              <X size={12} />
            </button>
          </div>
        ) : (
          <div style={{ display: 'inline-flex', gap: '0.25rem' }}>
            <button
              onClick={() => setEditing(true)}
              className="btn btn-secondary"
              style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
            >
              <Edit3 size={12} />
            </button>
            <button
              onClick={onDelete}
              className="btn btn-secondary"
              style={{
                padding: '0.25rem 0.5rem',
                fontSize: '0.75rem',
                color: 'var(--text-danger)',
              }}
            >
              <Trash2 size={12} />
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

function LogTimeForm({
  employee,
  jobs,
  loadedRate,
  onClose,
  onLogged,
}: {
  employee: Employee;
  jobs: JobLite[];
  loadedRate: number;
  onClose: () => void;
  onLogged: () => void;
}) {
  const { currentOrg } = useOrg();
  const [jobId, setJobId] = useState('');
  const [workDate, setWorkDate] = useState(new Date().toISOString().slice(0, 10));
  const [hours, setHours] = useState(8);
  const [notes, setNotes] = useState('');
  const [entryType, setEntryType] = useState<
    'ordinary' | 'overtime' | 'annual_leave' | 'sick_leave' | 'public_holiday'
  >('ordinary');
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '0.5rem' }}>
      <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Clock size={18} style={{ color: 'var(--accent-primary)' }} />
        Log time — {employee.full_name}
      </h3>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '1rem',
        }}
      >
        <Field label="Date">
          <input
            type="date"
            value={workDate}
            onChange={(e) => setWorkDate(e.target.value)}
            className="form-input"
          />
        </Field>
        <Field label="Hours">
          <input
            type="number"
            step="0.25"
            value={hours}
            onChange={(e) => setHours(parseFloat(e.target.value) || 0)}
            className="form-input"
          />
        </Field>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '1rem',
        }}
      >
        <Field label="Entry type">
          <select
            value={entryType}
            onChange={(e) => setEntryType(e.target.value as typeof entryType)}
            className="form-select"
          >
            <option value="ordinary">Ordinary</option>
            <option value="overtime">Overtime</option>
            <option value="annual_leave">Annual leave</option>
            <option value="sick_leave">Sick leave</option>
            <option value="public_holiday">Public holiday</option>
          </select>
        </Field>
        <Field label="Job (optional)">
          <select value={jobId} onChange={(e) => setJobId(e.target.value)} className="form-select">
            <option value="">— unassigned —</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.job_number} · {j.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Notes">
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What was worked on"
          className="form-input"
        />
      </Field>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1rem',
          marginTop: '0.5rem',
        }}
      >
        <span style={{ fontSize: '0.9rem', color: 'var(--text-success)', fontWeight: 600 }}>
          Cost: {formatMoney(totalCost)} ({hours}h × {formatMoney(loadedRate)}/hr loaded)
        </span>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            onClick={submit}
            disabled={busy || hours <= 0}
            className="btn btn-primary"
            style={{ padding: '0.625rem 1.25rem' }}
          >
            <Activity size={14} />
            <span>{busy ? 'Logging…' : 'Log entry'}</span>
          </button>
          <button
            onClick={onClose}
            disabled={busy}
            className="btn btn-secondary"
            style={{ padding: '0.625rem 1.25rem' }}
          >
            <span>Cancel</span>
          </button>
        </div>
      </div>
      {err && (
        <div
          className="badge badge-danger"
          style={{ display: 'block', padding: '0.625rem', textTransform: 'none' }}
        >
          {err}
        </div>
      )}
    </div>
  );
}
