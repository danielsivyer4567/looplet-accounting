import { useEffect, useState, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';
import { formatMoney } from '@/lib/money';
import { MoveToOrgButton } from '@/components/MoveToOrgButton';

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
      supabase.from('jobs').select('*').eq('id', id).eq('organization_id', currentOrg.id).maybeSingle(),
      supabase.from('v_job_pnl').select('*').eq('job_id', id).eq('organization_id', currentOrg.id).maybeSingle(),
      supabase.from('bills')
        .select('id, invoice_number, invoice_date, total_inc_gst_cents, status, supplier_id, supplier_name_raw')
        .eq('job_id', id).eq('organization_id', currentOrg.id).is('deleted_at', null)
        .order('invoice_date', { ascending: false, nullsFirst: false }),
      supabase.from('invoices')
        .select('id, invoice_date, total_inc_gst_cents, status')
        .eq('job_id', id).eq('organization_id', currentOrg.id)
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
    if (saveErr) { setError(saveErr.message); return; }
    setEditing(false);
    void refresh();
  };

  const detachBill = async (billId: string) => {
    if (!confirm('Detach this bill from the job?')) return;
    await supabase.from('bills').update({ job_id: null, status: 'verified' }).eq('id', billId);
    void refresh();
  };

  if (!currentOrg) return null;
  if (loading) return <section><h1>Job</h1><p style={{ color: '#888' }}>Loading…</p></section>;
  if (!job) return (
    <section>
      <h1>Job not found</h1>
      <Link to="/jobs" style={{ color: '#86c7a3' }}>&larr; Back to jobs</Link>
    </section>
  );

  // KPIs
  const revenue = pnl?.revenue_inc_gst_cents ?? 0;
  const totalCost = pnl?.total_cost_cents ?? 0;
  const grossProfit = pnl?.gross_profit_cents ?? 0;
  const margin = revenue > 0 ? (grossProfit / revenue) * 100 : null;
  const budget = job.budget_cents ?? 0;
  const budgetRemaining = budget - totalCost;
  const budgetPct = budget > 0 ? (totalCost / budget) * 100 : null;

  // Margin alert if costs exceed 80% of revenue (or 90% of budget if no revenue yet)
  const overBudget = budgetPct != null && budgetPct >= 90;
  const lowMargin = margin != null && margin < 20;

  return (
    <section>
      <Link to="/jobs" style={{ color: '#86c7a3', fontSize: 13 }}>&larr; All jobs</Link>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: '0.5rem' }}>
        <div>
          <h1 style={{ margin: 0 }}>
            <code style={{ color: '#888', fontSize: 18 }}>{job.job_number}</code>{' '}
            <span style={{ marginLeft: 8 }}>{job.name}</span>
          </h1>
          <div style={{ marginTop: 4, fontSize: 13, color: '#888' }}>
            <StatusPill status={job.status} />
            {' · '}
            {job.start_date ?? '—'}{job.end_date ? ` → ${job.end_date}` : ''}
            {customer && (
              <>
                {' · '}
                <Link to={`/customers/${customer.id}`} style={{ color: '#86c7a3' }}>{customer.name}</Link>
              </>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {customer && (
            <button onClick={() => navigate(`/invoices/new?job_id=${job.id}&customer_id=${customer.id}`)} style={primaryBtn}>+ Raise invoice</button>
          )}
          {!editing && <button onClick={startEdit} style={editBtn}>✎ Edit</button>}
          <MoveToOrgButton
            table="jobs"
            rowId={job.id}
            currentOrgId={job.organization_id}
            fkColumnsToNull={['customer_id']}
            onMoved={() => { window.location.href = '/jobs'; }}
          />
        </div>
      </div>

      {(overBudget || lowMargin) && (
        <div style={{ marginTop: 12, padding: 10, background: '#3d2818', border: '1px solid #d28d4a', borderRadius: 4, fontSize: 13, color: '#f0c47a' }}>
          ⚠ {overBudget && `${budgetPct?.toFixed(0)}% of budget consumed.`}
          {overBudget && lowMargin && ' '}
          {lowMargin && `Gross margin only ${margin?.toFixed(1)}%.`}
        </div>
      )}

      {editing ? (
        <div style={card}>
          <Field label="Name"><input value={draft.name ?? ''} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={inp} /></Field>
          <Field label="Description"><textarea value={draft.description ?? ''} onChange={(e) => setDraft({ ...draft, description: e.target.value })} rows={2} style={inp} /></Field>
          <div style={grid2}>
            <Field label="Status">
              <select value={draft.status ?? job.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })} style={inp}>
                {JOB_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Budget (AUD)">
              <input type="number" step="0.01"
                value={draft.budget_cents != null ? (draft.budget_cents / 100).toFixed(2) : ''}
                onChange={(e) => setDraft({ ...draft, budget_cents: e.target.value ? Math.round(parseFloat(e.target.value) * 100) : null })}
                placeholder="e.g. 5000.00" style={inp} />
            </Field>
          </div>
          <div style={grid2}>
            <Field label="Start date"><input type="date" value={draft.start_date ?? ''} onChange={(e) => setDraft({ ...draft, start_date: e.target.value })} style={inp} /></Field>
            <Field label="End date"><input type="date" value={draft.end_date ?? ''} onChange={(e) => setDraft({ ...draft, end_date: e.target.value })} style={inp} /></Field>
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button onClick={() => void save()} disabled={saving} style={primaryBtn}>{saving ? 'Saving…' : 'Save'}</button>
            <button onClick={() => setEditing(false)} disabled={saving} style={ghostBtn}>Cancel</button>
          </div>
          {error && <p style={{ color: 'salmon', fontSize: 12, marginTop: 8 }}>{error}</p>}
        </div>
      ) : job.description && (
        <p style={{ marginTop: 12, color: '#aaa', fontSize: 14, maxWidth: 800 }}>{job.description}</p>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginTop: 20, maxWidth: 1100 }}>
        <Kpi label="Revenue inc GST" value={formatMoney(revenue)} colour="#86c7a3" />
        <Kpi label="Total cost" value={formatMoney(totalCost)} colour="#e9a3a3" sub={`bills ${formatMoney(pnl?.cost_bills_cents ?? 0)}`} />
        <Kpi label="Gross profit" value={formatMoney(grossProfit)} colour={grossProfit > 0 ? '#86c7a3' : '#e9a3a3'} sub={margin != null ? `${margin.toFixed(1)}% margin` : '—'} />
        <Kpi label="Budget" value={budget ? formatMoney(budget) : '—'} colour="#aaa" sub={budgetPct != null ? `${budgetPct.toFixed(0)}% used` : 'no budget set'} />
      </div>

      <MarginSparkline
        bills={bills}
        invoices={invoicesSpark}
        jobStartDate={job.start_date}
      />

      <div style={{ marginTop: 20 }}>
        <h2 style={{ fontSize: 14, marginBottom: 8 }}>Cost breakdown</h2>
        <div style={breakdownRow}><span>Bills (supplier invoices)</span><span style={{ color: '#e9a3a3' }}>{formatMoney(pnl?.cost_bills_cents ?? 0)}</span></div>
        <div style={breakdownRow}><span>Wages (employee labour)</span><span style={{ color: '#888' }}>{formatMoney(pnl?.cost_wages_cents ?? 0)}</span></div>
        <div style={breakdownRow}><span>Overhead (allocated)</span><span style={{ color: '#888' }}>{formatMoney(pnl?.cost_overhead_cents ?? 0)}</span></div>
        <div style={{ ...breakdownRow, borderTop: '1px solid #2a2a2a', fontWeight: 600 }}>
          <span>Total cost</span><span>{formatMoney(totalCost)}</span>
        </div>
        <div style={breakdownRow}><span>GST input credit</span><span style={{ color: '#aaa' }}>{formatMoney(pnl?.gst_input_credit_cents ?? 0)}</span></div>
      </div>

      <h2 style={{ fontSize: 14, marginTop: 24, marginBottom: 8 }}>Attached bills ({bills.length})</h2>
      {bills.length === 0 ? (
        <p style={{ color: '#888', fontSize: 13 }}>No bills attached yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
              <th style={th}>Supplier</th>
              <th style={th}>Invoice #</th>
              <th style={th}>Date</th>
              <th style={th}>Status</th>
              <th style={thRight}>Total inc GST</th>
              <th style={thRight}></th>
            </tr>
          </thead>
          <tbody>
            {bills.map((b) => (
              <tr
                key={b.id}
                style={{ borderBottom: '1px solid #1a1a1a', cursor: 'pointer' }}
                onClick={() => navigate(`/bills/${b.id}`)}
                onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = '#202020'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = ''; }}
              >
                <td style={td}>
                  {b.supplier_id ? (
                    <Link to={`/suppliers/${b.supplier_id}`} onClick={(e) => e.stopPropagation()} style={{ color: '#86c7a3', fontSize: 13 }}>
                      {b.supplier_name_raw ?? '(linked)'}
                    </Link>
                  ) : (
                    b.supplier_name_raw ?? <span style={{ color: '#666' }}>—</span>
                  )}
                </td>
                <td style={td}><code style={{ color: '#aaa', fontSize: 12 }}>{b.invoice_number ?? '—'}</code></td>
                <td style={td}>{b.invoice_date ?? '—'}</td>
                <td style={td}><StatusPill status={b.status} /></td>
                <td style={tdRight}>{b.total_inc_gst_cents != null ? formatMoney(b.total_inc_gst_cents) : <span style={{ color: '#444' }}>—</span>}</td>
                <td style={tdRight}>
                  <button onClick={(e) => { e.stopPropagation(); void detachBill(b.id); }} style={detachBtn}>detach</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p style={{ marginTop: 32, padding: 10, background: '#0e0e0e', border: '1px dashed #2a2a2a', borderRadius: 4, fontSize: 12, color: '#666' }}>
        Future: invoices, payments received, timesheet hours allocated, margin trend chart.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Margin sparkline — pure inline SVG, no chart library
// Shows cumulative cost (red), cumulative revenue (green), margin (white)
// over weekly buckets from the first event to today.
// ---------------------------------------------------------------------------

function getMonday(d: Date): Date {
  const date = new Date(d);
  const day = date.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
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

  // Collect all dates to find range
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

  // Build list of weekly bucket start dates
  const weeks: Date[] = [];
  const cur = new Date(startMonday);
  while (cur <= endMonday) {
    weeks.push(new Date(cur));
    cur.setDate(cur.getDate() + 7);
  }
  if (weeks.length === 0) return [];

  // Map events to week index
  const billsByWeek = new Map<number, number>(); // weekIdx -> cumulative cost cents
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
  const H = 100;
  const PAD = { top: 8, right: 16, bottom: 20, left: 8 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  // At least 2 points to draw lines
  if (buckets.length < 2) {
    const hasAny = bills.length > 0 || invoices.length > 0;
    return (
      <div style={{ marginTop: 16, padding: 12, background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 6, maxWidth: W, display: 'inline-block' }}>
        <div style={{ fontSize: 11, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Margin trend</div>
        <p style={{ color: '#555', fontSize: 12, margin: 0 }}>{hasAny ? 'Not enough data yet — need events in at least 2 different weeks.' : 'Not enough data yet.'}</p>
      </div>
    );
  }

  const maxVal = Math.max(
    ...buckets.map((b) => Math.max(b.cumCost, b.cumRevenue)),
    1,
  );
  const minMargin = Math.min(...buckets.map((b) => b.cumRevenue - b.cumCost));
  const maxMargin = Math.max(...buckets.map((b) => b.cumRevenue - b.cumCost));

  // Unified Y scale: include 0 and all values
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

  // Zero line y position
  const zeroY = yScale(0);

  return (
    <div style={{ marginTop: 16, padding: '12px 16px', background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 6, maxWidth: W + 32, display: 'inline-block' }}>
      <div style={{ fontSize: 11, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Margin trend</div>
      <svg
        width={W}
        height={H}
        role="img"
        aria-label="Job margin trend sparkline showing cumulative cost, revenue, and margin by week"
        style={{ display: 'block', overflow: 'visible' }}
      >
        {/* Zero baseline */}
        <line x1={PAD.left} y1={zeroY} x2={W - PAD.right} y2={zeroY} stroke="#2a2a2a" strokeWidth={1} strokeDasharray="3,3" />

        {/* Cumulative cost — red */}
        <polyline points={costPts} fill="none" stroke="#e9a3a3" strokeWidth={1.5} strokeLinejoin="round" />
        {/* Cumulative revenue — green */}
        <polyline points={revPts} fill="none" stroke="#86c7a3" strokeWidth={1.5} strokeLinejoin="round" />
        {/* Margin (revenue - cost) — white */}
        <polyline points={marginPts} fill="none" stroke="#ffffff" strokeWidth={1} strokeLinejoin="round" strokeOpacity={0.55} />

        {/* Axis labels: first and last week */}
        <text x={PAD.left} y={H - 2} fontSize={9} fill="#555">{buckets[0].weekStart.toISOString().slice(0, 10)}</text>
        <text x={W - PAD.right} y={H - 2} fontSize={9} fill="#555" textAnchor="end">{buckets[buckets.length - 1].weekStart.toISOString().slice(0, 10)}</text>
      </svg>
      <div style={{ display: 'flex', gap: 14, marginTop: 6 }}>
        <Legend colour="#86c7a3" label="Cum. revenue" />
        <Legend colour="#e9a3a3" label="Cum. cost" />
        <Legend colour="rgba(255,255,255,0.55)" label="Margin" />
      </div>
    </div>
  );
}

function Legend({ colour, label }: { colour: string; label: string }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#888' }}>
      <span style={{ display: 'inline-block', width: 14, height: 2, background: colour, borderRadius: 1 }} />
      {label}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', fontSize: 11, color: '#888', marginTop: 6 }}>
      <div style={{ marginBottom: 3 }}>{label}</div>
      {children}
    </label>
  );
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

function StatusPill({ status }: { status: string }) {
  const c = status === 'paid' || status === 'completed' || status === 'active' ? '#86c7a3'
    : status === 'attached' ? '#5096d8'
    : status === 'verified' || status === 'quoted' ? '#d2c886'
    : status === 'void' || status === 'cancelled' ? '#666'
    : status === 'on_hold' ? '#d28d4a'
    : '#888';
  return <span style={{ padding: '0.15rem 0.5rem', fontSize: 11, borderRadius: 3, background: '#222', color: c, textTransform: 'uppercase' }}>{status}</span>;
}

const card: React.CSSProperties = { marginTop: 12, padding: 16, background: '#0e0e0e', border: '1px solid #2a2a2a', borderRadius: 6, maxWidth: 920 };
const grid2: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 };
const inp: React.CSSProperties = { width: '100%', padding: '6px 8px', background: '#000', color: '#ddd', border: '1px solid #333', borderRadius: 3, fontSize: 12 };
const editBtn: React.CSSProperties = { padding: '0.3rem 0.75rem', background: 'transparent', color: '#aaa', border: '1px solid #333', borderRadius: 3, fontSize: 12, cursor: 'pointer' };
const primaryBtn: React.CSSProperties = { padding: '0.4rem 1rem', background: '#1c4868', color: '#fff', border: '1px solid #5096d8', borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const ghostBtn: React.CSSProperties = { padding: '0.4rem 1rem', background: 'transparent', color: '#aaa', border: '1px solid #333', borderRadius: 4, fontSize: 12, cursor: 'pointer' };
const breakdownRow: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 13, color: '#ddd', borderBottom: '1px solid #1a1a1a', maxWidth: 600 };
const th: React.CSSProperties = { padding: '0.4rem 0.5rem', textAlign: 'left', fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 500 };
const thRight: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '0.5rem' };
const tdRight: React.CSSProperties = { ...td, textAlign: 'right' };
const detachBtn: React.CSSProperties = { background: 'transparent', color: '#888', border: '1px solid #333', borderRadius: 3, fontSize: 11, padding: '0.15rem 0.5rem', cursor: 'pointer' };
