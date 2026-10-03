import { useEffect, useState, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { formatMoney } from '@/lib/money';
import { MoveToOrgButton } from '@/components/MoveToOrgButton';
import { DetailPageSkeleton } from '@/components/Skeleton';
import { ArchiveButton } from '@/components/ArchiveButton';
import {
  ChevronLeft,
  Briefcase,
  Calendar,
  User,
  DollarSign,
  Wallet,
  FileText,
  Edit3,
  Save,
  Plus,
  AlertTriangle,
  Unlink,
  Percent,
  TrendingUp,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Stat } from '@/components/ui/Stat';
import { StatusBadge } from '@/components/ui/StatusBadge';

interface JobRow {
  id: string;
  organization_id: string;
  job_number: string;
  name: string;
  description: string | null;
  status: string;
  budget_cents: number | null;
  currency_code: string;
  start_date: string | null;
  end_date: string | null;
  customer_id: string | null;
  site_address: Record<string, unknown> | null;
  created_at: string;
  deleted_at: string | null;
}

interface PnlRow {
  revenue_inc_gst_cents: number | null;
  revenue_ex_gst_cents: number | null;
  gst_collected_cents: number | null;
  cost_bills_cents: number | null;
  cost_wages_cents: number | null;
  cost_overhead_cents: number | null;
  gst_input_credit_cents: number | null;
  total_cost_cents: number | null;
  gross_profit_cents: number | null;
}

interface BillRow {
  id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  total_inc_gst_cents: number | null;
  status: string;
  supplier_id: string | null;
  supplier_name_raw: string | null;
}

interface CustomerRow {
  id: string;
  name: string;
  email: string | null;
}

interface InvoiceSparkRow {
  id: string;
  invoice_date: string | null;
  total_inc_gst_cents: number | null;
  status: string;
}

interface SparkBucket {
  weekStart: Date;
  cumCost: number;
  cumRevenue: number;
}

const JOB_STATUSES = ['quoted', 'active', 'on_hold', 'completed', 'cancelled', 'archived'];

export function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { currentOrg } = useOrg();
  const navigate = useNavigate();
  const [job, setJob] = useState<JobRow | null>(null);
  const [pnl, setPnl] = useState<PnlRow | null>(null);
  const [bills, setBills] = useState<BillRow[]>([]);
  const [invoicesSpark, setInvoicesSpark] = useState<InvoiceSparkRow[]>([]);
  const [customer, setCustomer] = useState<CustomerRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<JobRow>>({});
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!currentOrg || !id) return;
    setLoading(true);
    const [jobRes, pnlRes, billsRes, invoicesRes] = await Promise.all([
      supabase
        .from('jobs')
        .select('*')
        .eq('id', id)
        .eq('organization_id', currentOrg.id)
        .maybeSingle(),
      supabase
        .from('v_job_pnl')
        .select('*')
        .eq('job_id', id)
        .eq('organization_id', currentOrg.id)
        .maybeSingle(),
      supabase
        .from('bills')
        .select(
          'id, invoice_number, invoice_date, total_inc_gst_cents, status, supplier_id, supplier_name_raw',
        )
        .eq('job_id', id)
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .order('invoice_date', { ascending: false, nullsFirst: false }),
      supabase
        .from('invoices')
        .select('id, invoice_date, total_inc_gst_cents, status')
        .eq('job_id', id)
        .eq('organization_id', currentOrg.id)
        .not('status', 'in', '(void)')
        .order('invoice_date', { ascending: true, nullsFirst: false }),
    ]);
    if (jobRes.error) setError(jobRes.error.message);
    setJob((jobRes.data ?? null) as JobRow | null);
    setPnl((pnlRes.data ?? null) as PnlRow | null);
    setBills((billsRes.data ?? []) as BillRow[]);
    setInvoicesSpark((invoicesRes.data ?? []) as InvoiceSparkRow[]);

    if (jobRes.data?.customer_id) {
      const { data: cust } = await supabase
        .from('customers')
        .select('id, name, email')
        .eq('id', jobRes.data.customer_id)
        .maybeSingle();
      setCustomer((cust ?? null) as CustomerRow | null);
    } else {
      setCustomer(null);
    }
    setLoading(false);
  }, [currentOrg, id]);

  useEffect(() => void refresh(), [refresh]);

  const startEdit = () => {
    if (!job) return;
    setDraft({
      name: job.name,
      description: job.description ?? '',
      status: job.status,
      budget_cents: job.budget_cents,
      start_date: job.start_date,
      end_date: job.end_date,
    });
    setEditing(true);
  };

  const save = async () => {
    if (!job) return;
    setSaving(true);
    const payload: Partial<JobRow> = {
      name: (draft.name ?? job.name).trim(),
      description: (draft.description ?? '').trim() || null,
      status: draft.status ?? job.status,
      budget_cents: draft.budget_cents != null ? Number(draft.budget_cents) : null,
      start_date: draft.start_date || null,
      end_date: draft.end_date || null,
    };
    const { error: saveErr } = await supabase.from('jobs').update(payload).eq('id', job.id);
    setSaving(false);
    if (saveErr) {
      setError(saveErr.message);
      return;
    }
    setEditing(false);
    void refresh();
  };

  const detachBill = async (billId: string) => {
    if (!confirm('Detach this bill from the job?')) return;
    await supabase.from('bills').update({ job_id: null, status: 'verified' }).eq('id', billId);
    void refresh();
  };

  if (!currentOrg) return null;
  if (loading) return <DetailPageSkeleton tableCols={5} />;
  if (!job) {
    return (
      <section className="animated-fade-in" style={{ padding: '2rem 0', textAlign: 'center' }}>
        <h2>Job not found</h2>
        <Link to="/jobs" className="btn btn-secondary" style={{ marginTop: '1rem' }}>
          <ChevronLeft size={16} /> Back to jobs
        </Link>
      </section>
    );
  }

  // KPIs
  const revenue = pnl?.revenue_inc_gst_cents ?? 0;
  const totalCost = pnl?.total_cost_cents ?? 0;
  const grossProfit = pnl?.gross_profit_cents ?? 0;
  const margin = revenue > 0 ? (grossProfit / revenue) * 100 : null;
  const budget = job.budget_cents ?? 0;
  const budgetPct = budget > 0 ? (totalCost / budget) * 100 : null;

  // Warnings
  const overBudget = budgetPct != null && budgetPct >= 90;
  const lowMargin = margin != null && margin < 20;

  return (
    <section className="animated-fade-in">
      {/* Back link */}
      <Link
        to="/jobs"
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
        <span>All jobs</span>
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
        <div>
          <PageHeader
            title={
              <>
                <code style={{ color: 'var(--text-muted)', fontSize: '1.25rem' }}>
                  {' '}
                  {job.job_number}{' '}
                </code>{' '}
                <span>{job.name}</span>
              </>
            }
            style={{ flexWrap: 'wrap' }}
          />
          <div
            style={{
              marginTop: '0.25rem',
              fontSize: '0.825rem',
              color: 'var(--text-muted)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              flexWrap: 'wrap',
            }}
          >
            <StatusBadge status={job.status} />
            <span>•</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
              <Calendar size={12} />
              {job.start_date ?? '—'}
              {job.end_date ? ` → ${job.end_date}` : ''}
            </span>
            {customer && (
              <>
                <span>•</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                  <User size={12} />
                  <Link to={`/customers/${customer.id}`} style={{ fontWeight: 600 }}>
                    {customer.name}
                  </Link>
                </span>
              </>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {customer && (
            <button
              onClick={() => navigate(`/invoices/new?job_id=${job.id}&customer_id=${customer.id}`)}
              className="btn btn-primary"
            >
              <Plus size={16} />
              <span>Raise Invoice</span>
            </button>
          )}
          {!editing && (
            <button onClick={startEdit} className="btn btn-secondary">
              <Edit3 size={14} />
              <span>Edit</span>
            </button>
          )}
          <MoveToOrgButton
            table="jobs"
            rowId={job.id}
            currentOrgId={job.organization_id}
            fkColumnsToNull={['customer_id']}
            onMoved={() => {
              window.location.href = '/jobs';
            }}
          />
          <ArchiveButton
            table="jobs"
            rowId={job.id}
            isArchived={!!job.deleted_at}
            onChange={(nowArchived) => {
              if (nowArchived) {
                window.location.href = '/jobs';
              } else {
                void refresh();
              }
            }}
          />
        </div>
      </div>

      {/* Warning banner */}
      {(overBudget || lowMargin) && (
        <div
          className="badge badge-warning"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            padding: '0.875rem 1rem',
            marginBottom: '1.5rem',
            textTransform: 'none',
            fontSize: '0.875rem',
            width: '100%',
            justifyContent: 'flex-start',
          }}
        >
          <AlertTriangle size={16} />
          <span>
            {overBudget && `${budgetPct?.toFixed(0)}% of budget consumed. `}
            {lowMargin && `Gross margin is currently low (${margin?.toFixed(1)}%).`}
          </span>
        </div>
      )}

      {/* Edit Card / Description */}
      {editing ? (
        <div className="card" style={{ marginBottom: '1.5rem', maxWidth: '850px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <Field label="Name *">
              <input
                value={draft.name ?? ''}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                className="form-input"
              />
            </Field>

            <Field label="Description">
              <textarea
                value={draft.description ?? ''}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                rows={2}
                className="form-textarea"
              />
            </Field>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                gap: '1rem',
              }}
            >
              <Field label="Status">
                <select
                  value={draft.status ?? job.status}
                  onChange={(e) => setDraft({ ...draft, status: e.target.value })}
                  className="form-select"
                >
                  {JOB_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Budget (AUD)">
                <input
                  type="number"
                  step="0.01"
                  value={draft.budget_cents != null ? (draft.budget_cents / 100).toFixed(2) : ''}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      budget_cents: e.target.value
                        ? Math.round(parseFloat(e.target.value) * 100)
                        : null,
                    })
                  }
                  placeholder="e.g. 5000.00"
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
              <Field label="Start Date">
                <input
                  type="date"
                  value={draft.start_date ?? ''}
                  onChange={(e) => setDraft({ ...draft, start_date: e.target.value })}
                  className="form-input"
                />
              </Field>
              <Field label="End Date">
                <input
                  type="date"
                  value={draft.end_date ?? ''}
                  onChange={(e) => setDraft({ ...draft, end_date: e.target.value })}
                  className="form-input"
                />
              </Field>
            </div>

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
      ) : job.description ? (
        <p
          style={{
            marginTop: '0.5rem',
            marginBottom: '1.5rem',
            color: 'var(--text-body)',
            fontSize: '0.95rem',
            lineHeight: '1.5',
            maxWidth: '800px',
          }}
        >
          {job.description}
        </p>
      ) : null}

      {/* KPI Cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '1rem',
          marginBottom: '2rem',
        }}
      >
        <Stat label="Revenue inc GST" value={formatMoney(revenue)} tone="success" icon={Wallet} />
        <Stat
          label="Total Cost"
          value={formatMoney(totalCost)}
          tone="danger"
          icon={DollarSign}
          sub={`bills ${formatMoney(pnl?.cost_bills_cents ?? 0)}`}
        />
        <Stat
          label="Gross Profit"
          value={formatMoney(grossProfit)}
          tone={grossProfit > 0 ? 'success' : 'danger'}
          icon={TrendingUp}
          sub={margin != null ? `${margin.toFixed(1)}% margin` : '—'}
        />
        <Stat
          label="Budget"
          value={budget ? formatMoney(budget) : '—'}
          tone="info"
          icon={Briefcase}
          sub={budgetPct != null ? `${budgetPct.toFixed(0)}% used` : 'no budget set'}
        />
      </div>

      {/* Budget consumption progress bar */}
      {budget > 0 && (
        <div className="card" style={{ marginBottom: '2rem', padding: '1.25rem' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: '0.825rem',
              fontWeight: 600,
              marginBottom: '0.5rem',
            }}
          >
            <span style={{ color: 'var(--text-body)' }}>Budget Consumption</span>
            <span
              style={{
                color:
                  budgetPct && budgetPct >= 100 ? 'var(--text-danger)' : 'var(--accent-primary)',
              }}
            >
              {budgetPct?.toFixed(1)}% ({formatMoney(totalCost)} of {formatMoney(budget)})
            </span>
          </div>
          <div
            style={{
              height: '8px',
              background: 'var(--bg-hover)',
              borderRadius: 'var(--radius-full)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${Math.min(budgetPct ?? 0, 100)}%`,
                background:
                  budgetPct && budgetPct >= 100 ? 'var(--accent-danger)' : 'var(--accent-primary)',
                borderRadius: 'var(--radius-full)',
                transition: 'width 0.4s ease',
              }}
            />
          </div>
        </div>
      )}

      {/* Margin Trend Chart */}
      <div
        className="card"
        style={{ marginBottom: '2rem', display: 'flex', flexDirection: 'column' }}
      >
        <MarginSparkline bills={bills} invoices={invoicesSpark} jobStartDate={job.start_date} />
      </div>

      {/* Cost Breakdown */}
      <div className="card" style={{ marginBottom: '2rem', maxWidth: '600px' }}>
        <h3
          style={{
            fontSize: '1.1rem',
            marginBottom: '1rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.35rem',
          }}
        >
          <Percent size={16} style={{ color: 'var(--text-muted)' }} />
          Cost Breakdown
        </h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <div style={breakdownRow}>
            <span>Bills (Supplier Invoices)</span>
            <span style={{ fontWeight: 600, color: 'var(--text-danger)' }}>
              {formatMoney(pnl?.cost_bills_cents ?? 0)}
            </span>
          </div>
          <div style={breakdownRow}>
            <span>Wages (Employee Labour)</span>
            <span style={{ fontWeight: 600, color: 'var(--text-body)' }}>
              {formatMoney(pnl?.cost_wages_cents ?? 0)}
            </span>
          </div>
          <div style={breakdownRow}>
            <span>Overhead (Allocated)</span>
            <span style={{ fontWeight: 600, color: 'var(--text-body)' }}>
              {formatMoney(pnl?.cost_overhead_cents ?? 0)}
            </span>
          </div>
          <div
            style={{
              ...breakdownRow,
              borderTop: '1px solid var(--border-subtle)',
              paddingTop: '0.75rem',
              marginTop: '0.5rem',
              fontWeight: 700,
              fontSize: '0.95rem',
            }}
          >
            <span style={{ color: 'var(--text-title)' }}>Total cost</span>
            <span style={{ color: 'var(--text-title)' }}>{formatMoney(totalCost)}</span>
          </div>
          <div
            style={{
              ...breakdownRow,
              borderBottom: 'none',
              color: 'var(--text-muted)',
              fontSize: '0.825rem',
            }}
          >
            <span>GST input credit</span>
            <span>{formatMoney(pnl?.gst_input_credit_cents ?? 0)}</span>
          </div>
        </div>
      </div>

      {/* Attached Bills */}
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
        Attached bills ({bills.length})
      </h2>
      {bills.length === 0 ? (
        <EmptyState>No bills attached yet.</EmptyState>
      ) : (
        <div className="table-premium-container">
          <table className="table-premium">
            <thead>
              <tr>
                <th>Supplier</th>
                <th>Invoice #</th>
                <th>Date</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Total inc GST</th>
                <th style={{ width: '100px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {bills.map((b) => (
                <tr
                  key={b.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => navigate(`/bills/${b.id}`)}
                >
                  <td>
                    {b.supplier_id ? (
                      <Link
                        to={`/suppliers/${b.supplier_id}`}
                        onClick={(e) => e.stopPropagation()}
                        style={{ fontWeight: 600 }}
                      >
                        {b.supplier_name_raw ?? '(linked)'}
                      </Link>
                    ) : (
                      (b.supplier_name_raw ?? <span style={{ color: 'var(--text-muted)' }}>—</span>)
                    )}
                  </td>
                  <td>
                    <code>{b.invoice_number ?? '—'}</code>
                  </td>
                  <td>{b.invoice_date ?? '—'}</td>
                  <td>
                    <StatusBadge status={b.status} />
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>
                    {b.total_inc_gst_cents != null ? (
                      formatMoney(b.total_inc_gst_cents)
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>—</span>
                    )}
                  </td>
                  <td>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void detachBill(b.id);
                      }}
                      className="btn btn-secondary"
                      style={{
                        padding: '0.25rem 0.5rem',
                        fontSize: '0.75rem',
                        color: 'var(--text-danger)',
                      }}
                    >
                      <Unlink size={12} style={{ marginRight: '0.25rem' }} />
                      <span>Detach</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function getMonday(d: Date): Date {
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function buildSparkBuckets(
  bills: BillRow[],
  invoices: InvoiceSparkRow[],
  jobStartDate: string | null,
): SparkBucket[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const allDates: Date[] = [];
  if (jobStartDate) allDates.push(new Date(jobStartDate));
  for (const b of bills) {
    if (b.invoice_date) allDates.push(new Date(b.invoice_date));
  }
  for (const inv of invoices) {
    if (inv.invoice_date) allDates.push(new Date(inv.invoice_date));
  }
  if (allDates.length === 0) return [];

  const minDate = allDates.reduce((a, b) => (a < b ? a : b));
  const startMonday = getMonday(minDate);
  const endMonday = getMonday(today);

  const weeks: Date[] = [];
  const cur = new Date(startMonday);
  while (cur <= endMonday) {
    weeks.push(new Date(cur));
    cur.setDate(cur.getDate() + 7);
  }
  if (weeks.length === 0) return [];

  const billsByWeek = new Map<number, number>();
  for (const b of bills) {
    if (!b.invoice_date || b.total_inc_gst_cents == null) continue;
    const d = new Date(b.invoice_date);
    const mon = getMonday(d);
    const idx = Math.round((mon.getTime() - startMonday.getTime()) / (7 * 86400000));
    billsByWeek.set(idx, (billsByWeek.get(idx) ?? 0) + b.total_inc_gst_cents);
  }
  const invoicesByWeek = new Map<number, number>();
  for (const inv of invoices) {
    if (!inv.invoice_date || inv.total_inc_gst_cents == null) continue;
    const d = new Date(inv.invoice_date);
    const mon = getMonday(d);
    const idx = Math.round((mon.getTime() - startMonday.getTime()) / (7 * 86400000));
    invoicesByWeek.set(idx, (invoicesByWeek.get(idx) ?? 0) + inv.total_inc_gst_cents);
  }

  let cumCost = 0;
  let cumRevenue = 0;
  return weeks.map((weekStart, i) => {
    cumCost += billsByWeek.get(i) ?? 0;
    cumRevenue += invoicesByWeek.get(i) ?? 0;
    return { weekStart, cumCost, cumRevenue };
  });
}

function MarginSparkline({
  bills,
  invoices,
  jobStartDate,
}: {
  bills: BillRow[];
  invoices: InvoiceSparkRow[];
  jobStartDate: string | null;
}) {
  const buckets = buildSparkBuckets(bills, invoices, jobStartDate);

  const W = 600;
  const H = 140;
  const PAD = { top: 12, right: 16, bottom: 24, left: 8 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  if (buckets.length < 2) {
    const hasAny = bills.length > 0 || invoices.length > 0;
    return (
      <div style={{ padding: '0.5rem' }}>
        <h3
          style={{
            fontSize: '0.825rem',
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            marginBottom: '0.5rem',
          }}
        >
          Margin Trend
        </h3>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', margin: 0 }}>
          {hasAny
            ? 'Not enough data yet — need events in at least 2 different weeks.'
            : 'Not enough data yet.'}
        </p>
      </div>
    );
  }

  const maxVal = Math.max(...buckets.map((b) => Math.max(b.cumCost, b.cumRevenue)), 1);
  const minMargin = Math.min(...buckets.map((b) => b.cumRevenue - b.cumCost));
  const maxMargin = Math.max(...buckets.map((b) => b.cumRevenue - b.cumCost));

  const yMin = Math.min(0, minMargin);
  const yMax = Math.max(maxVal, maxMargin);
  const yRange = yMax - yMin || 1;

  const xScale = (i: number) => PAD.left + (i / (buckets.length - 1)) * chartW;
  const yScale = (v: number) => PAD.top + chartH - ((v - yMin) / yRange) * chartH;

  const polyPoints = (vals: number[]) =>
    vals.map((v, i) => `${xScale(i).toFixed(1)},${yScale(v).toFixed(1)}`).join(' ');

  const costPts = polyPoints(buckets.map((b) => b.cumCost));
  const revPts = polyPoints(buckets.map((b) => b.cumRevenue));
  const marginPts = polyPoints(buckets.map((b) => b.cumRevenue - b.cumCost));

  const zeroY = yScale(0);

  return (
    <div style={{ padding: '0.5rem', width: '100%', overflowX: 'auto' }}>
      <h3
        style={{
          fontSize: '0.825rem',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginBottom: '1rem',
        }}
      >
        Margin Trend (Weekly Cumulative)
      </h3>

      <div style={{ minWidth: `${W}px` }}>
        <svg
          width="100%"
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="Job margin trend sparkline showing cumulative cost, revenue, and margin by week"
          style={{ display: 'block', overflow: 'visible' }}
        >
          {/* Zero baseline */}
          <line
            x1={PAD.left}
            y1={zeroY}
            x2={W - PAD.right}
            y2={zeroY}
            stroke="var(--border-subtle)"
            strokeWidth={1.5}
            strokeDasharray="4,4"
          />

          {/* Cumulative cost — red */}
          <polyline
            points={costPts}
            fill="none"
            stroke="var(--accent-danger)"
            strokeWidth={2.5}
            strokeLinejoin="round"
          />
          {/* Cumulative revenue — green */}
          <polyline
            points={revPts}
            fill="none"
            stroke="var(--accent-success)"
            strokeWidth={2.5}
            strokeLinejoin="round"
          />
          {/* Margin (revenue - cost) — primary theme color */}
          <polyline
            points={marginPts}
            fill="none"
            stroke="var(--accent-primary)"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeDasharray="2,2"
          />

          {/* Axis labels: first and last week */}
          <text x={PAD.left} y={H - 4} fontSize={9} fill="var(--text-muted)" fontWeight={600}>
            {buckets[0]?.weekStart.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}
          </text>
          <text
            x={W - PAD.right}
            y={H - 4}
            fontSize={9}
            fill="var(--text-muted)"
            fontWeight={600}
            textAnchor="end"
          >
            {buckets[buckets.length - 1]?.weekStart.toLocaleDateString('en-AU', {
              day: 'numeric',
              month: 'short',
            })}
          </text>
        </svg>
      </div>

      <div style={{ display: 'flex', gap: '1.25rem', marginTop: '1rem', flexWrap: 'wrap' }}>
        <Legend colour="var(--accent-success)" label="Cumulative Revenue" />
        <Legend colour="var(--accent-danger)" label="Cumulative Cost" />
        <Legend colour="var(--accent-primary)" label="Cumulative Margin" dotted />
      </div>
    </div>
  );
}

function Legend({ colour, label, dotted }: { colour: string; label: string; dotted?: boolean }) {
  return (
    <span
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.35rem',
        fontSize: '0.825rem',
        color: 'var(--text-muted)',
        fontWeight: 500,
      }}
    >
      <span
        style={{
          display: 'inline-block',
          width: '16px',
          height: '3px',
          background: dotted ? 'transparent' : colour,
          borderTop: dotted ? `3px dotted ${colour}` : 'none',
          borderRadius: 'var(--radius-full)',
        }}
      />
      {label}
    </span>
  );
}

const breakdownRow: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  padding: '0.625rem 0',
  fontSize: '0.875rem',
  color: 'var(--text-body)',
  borderBottom: '1px solid var(--border-subtle)',
  width: '100%',
};
