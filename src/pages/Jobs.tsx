import { cloneElement, isValidElement, useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOrg } from '@/hooks/useOrg';
import { useJobs } from '@/hooks/useJobs';
import type { JobStatus, JobListRow } from '@/hooks/useJobs';
import { supabase } from '@/lib/supabase';
import { formatLoadError, formatActionError } from '@/lib/errorMessages';
import { SkeletonTable } from '@/components/Skeleton';
import { formatMoney, formatMoneyCompact } from '@/lib/money';
import { orgTimeZone, todayLocal } from '@/lib/localDates';
import { InsightAreaChart, InsightBarList, InsightPanel } from '@/components/InsightCharts';
import { AnimatedNumber } from '@/components/AnimatedNumber';
import { Briefcase, Plus, FileSpreadsheet, X, Activity, type LucideIcon } from 'lucide-react';

function getBillCount(val: [{ count: number }] | []): number {
  if (val.length === 0) return 0;
  const row = val[0];
  if (!row) return 0;
  return row.count;
}

export function JobsPage() {
  const { currentOrg } = useOrg();
  const { jobs, loading, error, pnlError, refresh } = useJobs();
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);

  if (!currentOrg) {
    return (
      <section className="animated-fade-in">
        <h1>Jobs</h1>
        <p style={{ color: 'var(--text-muted)' }}>Pick an organisation to see jobs.</p>
      </section>
    );
  }

  const activeCount = jobs.filter((j) => j.status === 'active').length;

  // Job financial aggregates
  const totalRevenue = jobs.reduce((sum, j) => sum + (j.revenue_inc_gst_cents ?? 0), 0);
  const totalCost = jobs.reduce((sum, j) => sum + (j.total_cost_cents ?? 0), 0);
  const totalProfit = jobs.reduce((sum, j) => sum + (j.gross_profit_cents ?? 0), 0);

  // Job Profitability Mix
  const profitMixItems = jobs
    .filter((j) => j.revenue_inc_gst_cents || j.total_cost_cents)
    .map((j) => {
      const profit = j.gross_profit_cents ?? 0;
      return {
        label: `${j.job_number} — ${j.name}`,
        value: profit,
        displayValue: formatMoneyCompact(profit),
        tone: profit >= 0 ? ('success' as const) : ('danger' as const),
      };
    })
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);

  // Chronological trends for Jobs
  let runningRevenueCents = 0;
  let runningCostCents = 0;
  let runningProfitCents = 0;

  const jobsChronological = jobs.slice().sort((a, b) => a.created_at.localeCompare(b.created_at));

  const cumulativeProfitTrend = jobsChronological.length
    ? jobsChronological.map((j) => {
        runningProfitCents += j.gross_profit_cents ?? 0;
        return {
          label: new Date(j.created_at).toLocaleDateString('en-AU', {
            day: '2-digit',
            month: 'short',
          }),
          value: runningProfitCents,
        };
      })
    : [{ label: 'No jobs', value: 0 }];

  const cumulativeRevenueTrend = jobsChronological.map((j) => {
    runningRevenueCents += j.revenue_inc_gst_cents ?? 0;
    return {
      label: new Date(j.created_at).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' }),
      value: runningRevenueCents,
    };
  });

  const cumulativeCostTrend = jobsChronological.map((j) => {
    runningCostCents += j.total_cost_cents ?? 0;
    return {
      label: new Date(j.created_at).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' }),
      value: runningCostCents,
    };
  });

  return (
    <section className="animated-fade-in">
      {/* Header */}
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
          <Briefcase size={24} style={{ color: 'var(--text-link)' }} />
          Jobs
        </h1>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          {!loading && (
            <span style={{ color: 'var(--text-muted)', fontSize: '0.825rem' }}>
              {jobs.length} job{jobs.length !== 1 ? 's' : ''}
            </span>
          )}
          <button onClick={() => setShowCreate(true)} className="btn btn-primary">
            <Plus size={16} />
            <span>New job</span>
          </button>
        </div>
      </div>

      {showCreate && (
        <div
          className="card"
          style={{
            marginBottom: '1.5rem',
            border: '1px solid var(--accent-primary)',
            position: 'relative',
          }}
        >
          <button
            onClick={() => setShowCreate(false)}
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
          <CreateJobForm
            onClose={() => setShowCreate(false)}
            onCreated={(id) => {
              setShowCreate(false);
              void refresh();
              navigate(`/jobs/${id}`);
            }}
          />
        </div>
      )}

      {/* Non-blocking P&L pipeline warning — list still renders, but costs/margins
          may be missing if v_job_pnl failed to load. */}
      {!loading && !error && pnlError && (
        <div
          role="alert"
          className="badge badge-warning"
          style={{
            display: 'block',
            padding: '0.75rem',
            marginBottom: '1.5rem',
            textTransform: 'none',
          }}
        >
          {formatLoadError('live job P&L', pnlError)} Job costs and margins below may show as zero
          until this resolves.
        </div>
      )}

      {/* Stat cards */}
      {!loading && !error && (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: '1rem',
              marginBottom: '1.5rem',
            }}
          >
            <KpiCard label="Active Jobs" value={activeCount} type="success" icon={Briefcase} />
            <KpiCard
              label="Total Revenue (all-time)"
              value={totalRevenue}
              formatter={formatMoney}
              type="info"
              icon={FileSpreadsheet}
            />
            <KpiCard
              label="Total Job Cost (all-time)"
              value={totalCost}
              formatter={formatMoney}
              type="neutral"
              icon={FileSpreadsheet}
            />
            <KpiCard
              label="Gross Margin (all-time)"
              value={totalProfit}
              formatter={formatMoney}
              type={totalProfit >= 0 ? 'success' : 'danger'}
              icon={FileSpreadsheet}
            />
          </div>

          {/* Charts Section */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: '1rem',
              marginBottom: '2rem',
            }}
          >
            <InsightPanel title="Margin pulse" eyebrow="Cumulative job margins">
              <InsightAreaChart
                title="Total Profit"
                items={cumulativeProfitTrend}
                tone={totalProfit >= 0 ? 'success' : 'danger'}
                series={[
                  { label: 'Revenue', items: cumulativeRevenueTrend, tone: 'info' },
                  { label: 'Costs', items: cumulativeCostTrend, tone: 'neutral' },
                ]}
                markerLabel="Gross margin"
                formatValue={formatMoneyCompact}
              />
            </InsightPanel>
            <InsightPanel title="Profitability mix" eyebrow="Top performing jobs">
              {profitMixItems.length === 0 ? (
                <div
                  style={{ color: 'var(--text-muted)', fontSize: '0.875rem', padding: '1rem 0' }}
                >
                  No job profitability mix to display.
                </div>
              ) : (
                <InsightBarList items={profitMixItems} formatValue={formatMoneyCompact} />
              )}
            </InsightPanel>
          </div>
        </>
      )}

      {loading ? (
        <SkeletonTable rows={5} cols={6} />
      ) : error ? (
        <div
          className="badge badge-danger"
          style={{ display: 'block', padding: '1rem', textTransform: 'none' }}
        >
          {formatLoadError('jobs', error)}
        </div>
      ) : jobs.length === 0 ? (
        <div
          style={{
            padding: '3rem 1.5rem',
            background: 'var(--bg-card)',
            border: '1px dashed var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            textAlign: 'center',
            color: 'var(--text-muted)',
          }}
        >
          No jobs yet for {currentOrg.name}.
        </div>
      ) : (
        <>
          <div className="jobs-table-view table-premium-container">
            <table className="table-premium">
              <thead>
                <tr>
                  <th>Job #</th>
                  <th>Name</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Bills attached</th>
                  <th style={{ textAlign: 'right' }}>Bills suggested</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => {
                  const attached = getBillCount(j.attached_bills);
                  const suggested = getBillCount(j.suggested_bills);
                  const created = new Date(j.created_at).toLocaleDateString('en-AU', {
                    day: '2-digit',
                    month: 'short',
                    year: 'numeric',
                  });
                  return (
                    <tr
                      key={j.id}
                      style={{ cursor: 'pointer' }}
                      onClick={() => void navigate(`/jobs/${j.id}`)}
                    >
                      <td>
                        <code>{j.job_number}</code>
                      </td>
                      <td style={{ fontWeight: 600, color: 'var(--text-title)' }}>{j.name}</td>
                      <td>
                        <Pill status={j.status} />
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>
                        {attached > 0 ? (
                          <span style={{ color: 'var(--text-success)' }}>{attached}</span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>0</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {suggested > 0 ? (
                          <span style={{ color: 'var(--text-warning)' }}>{suggested}</span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>0</span>
                        )}
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: '0.825rem' }}>
                        {created}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="jobs-card-view" aria-label="Job cards">
            {jobs.map((j) => (
              <JobCard key={j.id} job={j} onOpen={() => void navigate(`/jobs/${j.id}`)} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function JobCard({ job, onOpen }: { job: JobListRow; onOpen: () => void }) {
  const attached = getBillCount(job.attached_bills);
  const suggested = getBillCount(job.suggested_bills);
  const created = new Date(job.created_at).toLocaleDateString('en-AU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  return (
    <article className="job-mobile-card card" aria-label={`Job ${job.job_number}`}>
      <div className="job-mobile-card__header">
        <div>
          <a
            href={`/jobs/${job.id}`}
            onClick={(e) => {
              e.preventDefault();
              onOpen();
            }}
            style={{ fontWeight: 700, color: 'var(--text-link)', textDecoration: 'none' }}
          >
            <code>{job.job_number}</code> · {job.name}
          </a>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem', marginTop: '0.15rem' }}>
            Created {created}
          </div>
        </div>
        <Pill status={job.status} />
      </div>
      <div className="job-mobile-card__metrics">
        <div>
          <span>Bills attached</span>
          <strong style={{ color: attached > 0 ? 'var(--text-success)' : 'var(--text-body)' }}>
            {attached}
          </strong>
        </div>
        <div>
          <span>Bills suggested</span>
          <strong style={{ color: suggested > 0 ? 'var(--text-warning)' : 'var(--text-body)' }}>
            {suggested}
          </strong>
        </div>
      </div>
    </article>
  );
}

interface CustomerOption {
  id: string;
  name: string;
}

function CreateJobForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { currentOrg } = useOrg();
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [name, setName] = useState('');
  const [jobNumber, setJobNumber] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [budget, setBudget] = useState(0);
  const [startDate, setStartDate] = useState(() => todayLocal(orgTimeZone(currentOrg)));
  const [endDate, setEndDate] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Load customers + auto-generate next job number
  useEffect(() => {
    if (!currentOrg) return;
    void (async () => {
      const [{ data: custs }, { data: maxRow }] = await Promise.all([
        supabase
          .from('customers')
          .select('id, name')
          .eq('organization_id', currentOrg.id)
          .is('deleted_at', null)
          .order('name'),
        supabase
          .from('jobs')
          .select('job_number')
          .eq('organization_id', currentOrg.id)
          .order('job_number', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      setCustomers((custs ?? []) as CustomerOption[]);
      const last = maxRow?.job_number ?? '';
      const m = last.match(/^J(\d+)$/);
      const next = m ? parseInt(m[1], 10) + 1 : 1;
      setJobNumber(`J${String(next).padStart(4, '0')}`);
    })();
  }, [currentOrg]);

  const submit = async () => {
    if (!currentOrg || !name.trim() || !jobNumber.trim()) return;
    setBusy(true);
    const { data, error } = await supabase
      .from('jobs')
      .insert({
        organization_id: currentOrg.id,
        job_number: jobNumber.trim(),
        name: name.trim(),
        description: description.trim() || null,
        customer_id: customerId || null,
        status: 'active' as JobStatus,
        budget_cents: budget > 0 ? Math.round(budget * 100) : null,
        start_date: startDate || null,
        end_date: endDate || null,
        currency_code: 'AUD',
      })
      .select('id')
      .single();
    setBusy(false);
    if (error) {
      setErr(formatActionError('create the job', error.message));
      return;
    }
    onCreated(data.id);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', padding: '0.5rem' }}>
      <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Plus size={18} style={{ color: 'var(--text-link)' }} />
        Create New Job
      </h3>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: '1rem',
        }}
      >
        <Field label="Job number *">
          <input
            value={jobNumber}
            onChange={(e) => setJobNumber(e.target.value)}
            className="form-input"
          />
        </Field>
        <Field label="Name / address *">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. 1 Schablon Close, Ormeau Hills"
            className="form-input"
          />
        </Field>
      </div>

      <Field label="Customer">
        <select
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          className="form-select"
        >
          <option value="">— no customer (link later) —</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Description">
        <textarea
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="form-textarea"
        />
      </Field>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '1rem',
        }}
      >
        <Field label="Budget (AUD)">
          <input
            type="number"
            step="0.01"
            value={budget}
            onChange={(e) => setBudget(parseFloat(e.target.value) || 0)}
            className="form-input"
          />
        </Field>
        <Field label="Start date">
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="form-input"
          />
        </Field>
        <Field label="End date (est.)">
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="form-input"
          />
        </Field>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
        <button
          onClick={submit}
          disabled={busy || !name.trim() || !jobNumber.trim()}
          className="btn btn-primary"
          style={{ padding: '0.625rem 1.25rem' }}
        >
          <Activity size={14} />
          <span>{busy ? 'Creating…' : 'Create job'}</span>
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
      {err && (
        <div
          role="alert"
          className="badge badge-danger"
          style={{ display: 'block', padding: '0.625rem', textTransform: 'none' }}
        >
          {err}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const id = useId();
  const control = isValidElement(children)
    ? cloneElement(children as React.ReactElement<{ id?: string }>, { id })
    : children;

  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <label htmlFor={id} className="form-label" style={{ fontSize: '0.725rem' }}>
        {label}
      </label>
      <div style={{ marginTop: '0.25rem' }}>{control}</div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  type,
  icon: Icon,
  sub,
  formatter,
}: {
  label: string;
  value: number;
  type: 'success' | 'danger' | 'warning' | 'info' | 'neutral';
  icon: LucideIcon;
  sub?: string;
  formatter?: (val: number) => string;
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
        <AnimatedNumber value={value} formatter={formatter} />
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

function Pill({ status }: { status: string }) {
  let badgeClass = 'badge-neutral';
  if (status === 'active' || status === 'completed') badgeClass = 'badge-success';
  else if (status === 'paused') badgeClass = 'badge-warning';
  else if (status === 'cancelled' || status === 'archived') badgeClass = 'badge-danger';

  return <span className={`badge ${badgeClass}`}>{status.replace('_', ' ')}</span>;
}
