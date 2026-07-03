import { useEffect, useState, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { formatMoney } from '@/lib/money';
import { MoveToOrgButton } from '@/components/MoveToOrgButton';
import { ArchiveButton } from '@/components/ArchiveButton';
import { DetailPageSkeleton } from '@/components/Skeleton';
import {
  ChevronLeft,
  Plus,
  Edit3,
  Save,
  Users,
  Briefcase,
  FileSpreadsheet,
  DollarSign,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

interface Customer {
  id: string;
  name: string;
  abn: string | null;
  email: string | null;
  phone: string | null;
  billing_address: Record<string, unknown> | null;
  notes: string | null;
  created_at: string;
  deleted_at: string | null;
}

interface Pnl {
  invoice_count: number;
  total_invoiced_cents: number;
  total_paid_cents: number;
  balance_owing_cents: number;
  overdue_cents: number;
}

interface InvoiceListRow {
  id: string;
  invoice_number: string;
  status: string;
  issue_date: string;
  due_date: string;
  total_inc_gst_cents: number;
  amount_paid_cents: number;
  balance_due_cents: number;
  job_id: string | null;
}

interface JobRow {
  id: string;
  job_number: string;
  name: string;
  status: string;
  start_date: string | null;
  end_date: string | null;
  budget_cents: number | null;
}

export function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { currentOrg } = useOrg();
  const navigate = useNavigate();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [pnl, setPnl] = useState<Pnl | null>(null);
  const [invoices, setInvoices] = useState<InvoiceListRow[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<Customer>>({});
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!currentOrg || !id) return;
    setLoading(true);
    const [custRes, pnlRes, invRes, jobsRes] = await Promise.all([
      supabase
        .from('customers')
        .select('*')
        .eq('id', id)
        .eq('organization_id', currentOrg.id)
        .maybeSingle(),
      supabase
        .from('v_customer_pnl')
        .select('*')
        .eq('customer_id', id)
        .eq('organization_id', currentOrg.id)
        .maybeSingle(),
      supabase
        .from('invoices')
        .select(
          'id, invoice_number, status, issue_date, due_date, total_inc_gst_cents, amount_paid_cents, balance_due_cents, job_id',
        )
        .eq('customer_id', id)
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .order('issue_date', { ascending: false }),
      supabase
        .from('jobs')
        .select('id, job_number, name, status, start_date, end_date, budget_cents')
        .eq('customer_id', id)
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .order('created_at', { ascending: false }),
    ]);
    if (custRes.error) setError(custRes.error.message);
    setCustomer((custRes.data ?? null) as Customer | null);
    setPnl((pnlRes.data ?? null) as Pnl | null);
    setInvoices((invRes.data ?? []) as InvoiceListRow[]);
    setJobs((jobsRes.data ?? []) as JobRow[]);
    setLoading(false);
  }, [currentOrg, id]);

  useEffect(() => void refresh(), [refresh]);

  const startEdit = () => {
    if (!customer) return;
    setDraft({
      name: customer.name,
      abn: customer.abn ?? '',
      email: customer.email ?? '',
      phone: customer.phone ?? '',
      notes: customer.notes ?? '',
    });
    setEditing(true);
  };

  const save = async () => {
    if (!customer) return;
    setSaving(true);
    const payload = {
      name: (draft.name ?? customer.name).trim(),
      abn: draft.abn?.toString().trim() || null,
      email: draft.email?.toString().trim() || null,
      phone: draft.phone?.toString().trim() || null,
      notes: draft.notes?.toString().trim() || null,
    };
    const { error: e } = await supabase.from('customers').update(payload).eq('id', customer.id);
    setSaving(false);
    if (e) {
      setError(e.message);
      return;
    }
    setEditing(false);
    void refresh();
  };

  if (!currentOrg) return null;
  if (loading) return <DetailPageSkeleton tableCols={5} />;
  if (!customer) {
    return (
      <section className="animated-fade-in" style={{ padding: '2rem 0', textAlign: 'center' }}>
        <h2>Customer not found</h2>
        <Link to="/customers" className="btn btn-secondary" style={{ marginTop: '1rem' }}>
          <ChevronLeft size={16} /> Back to customers
        </Link>
      </section>
    );
  }

  return (
    <section className="animated-fade-in">
      {/* Back button */}
      <Link
        to="/customers"
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
        <span>All customers</span>
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
        <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Users size={24} style={{ color: 'var(--accent-primary)' }} />
          {customer.name}
        </h1>

        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            onClick={() => navigate(`/invoices/new?customer_id=${customer.id}`)}
            className="btn btn-primary"
          >
            <Plus size={16} />
            <span>Raise invoice</span>
          </button>

          <MoveToOrgButton
            table="customers"
            rowId={customer.id}
            currentOrgId={currentOrg.id}
            onMoved={() => {
              window.location.href = '/customers';
            }}
          />

          {!editing && (
            <button onClick={startEdit} className="btn btn-secondary">
              <Edit3 size={14} />
              <span>Edit</span>
            </button>
          )}

          <ArchiveButton
            table="customers"
            rowId={customer.id}
            isArchived={!!customer.deleted_at}
            onChange={(nowArchived) => {
              if (nowArchived) {
                window.location.href = '/customers';
              } else {
                void refresh();
              }
            }}
          />
        </div>
      </div>

      {/* Contact Info Detail card */}
      {editing ? (
        <div className="card" style={{ marginBottom: '1.5rem', maxWidth: '720px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                gap: '1rem',
              }}
            >
              <Field label="Name">
                <input
                  value={draft.name ?? ''}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  className="form-input"
                />
              </Field>
              <Field label="ABN">
                <input
                  value={draft.abn ?? ''}
                  onChange={(e) => setDraft({ ...draft, abn: e.target.value })}
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
                  type="email"
                  value={draft.email ?? ''}
                  onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                  className="form-input"
                />
              </Field>
              <Field label="Phone">
                <input
                  type="tel"
                  value={draft.phone ?? ''}
                  onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                  className="form-input"
                />
              </Field>
            </div>

            <Field label="Notes">
              <textarea
                rows={3}
                value={draft.notes ?? ''}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                className="form-textarea"
              />
            </Field>

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
            marginBottom: '1.5rem',
          }}
        >
          <Stat label="ABN" value={customer.abn ?? '—'} />
          <Stat label="Email" value={customer.email ?? '—'} />
          <Stat label="Phone" value={customer.phone ?? '—'} />
          {customer.notes && (
            <div
              style={{
                gridColumn: '1 / -1',
                borderTop: '1px solid var(--border-subtle)',
                paddingTop: '1rem',
                marginTop: '0.25rem',
              }}
            >
              <div
                style={{
                  fontSize: '0.675rem',
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  fontWeight: 700,
                  marginBottom: '0.25rem',
                }}
              >
                Notes
              </div>
              <p
                style={{
                  margin: 0,
                  fontSize: '0.875rem',
                  color: 'var(--text-body)',
                  lineHeight: '1.5',
                }}
              >
                {customer.notes}
              </p>
            </div>
          )}
        </div>
      )}

      {/* KPI Cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '1rem',
          marginBottom: '2.5rem',
        }}
      >
        <Kpi
          label="Total Invoices"
          value={String(pnl?.invoice_count ?? 0)}
          type="info"
          icon={FileSpreadsheet}
        />
        <Kpi
          label="Total Invoiced"
          value={formatMoney(pnl?.total_invoiced_cents ?? 0)}
          type="neutral"
          icon={DollarSign}
        />
        <Kpi
          label="Amount Paid"
          value={formatMoney(pnl?.total_paid_cents ?? 0)}
          type="success"
          icon={Wallet}
        />
        <Kpi
          label="Outstanding Balance"
          value={formatMoney(pnl?.balance_owing_cents ?? 0)}
          type={(pnl?.balance_owing_cents ?? 0) > 0 ? 'warning' : 'neutral'}
          icon={DollarSign}
          sub={
            (pnl?.overdue_cents ?? 0) > 0
              ? `${formatMoney(pnl?.overdue_cents ?? 0)} overdue`
              : undefined
          }
        />
      </div>

      {/* Jobs Grid */}
      <h2
        style={{
          fontSize: '1.25rem',
          marginBottom: '0.75rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.35rem',
        }}
      >
        <Briefcase size={16} style={{ color: 'var(--text-muted)' }} />
        Jobs ({jobs.length})
      </h2>
      {jobs.length === 0 ? (
        <div
          style={{
            padding: '2rem',
            background: 'var(--bg-card)',
            border: '1px dashed var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            textAlign: 'center',
            color: 'var(--text-muted)',
            fontSize: '0.875rem',
            marginBottom: '2.5rem',
          }}
        >
          No jobs associated with this customer yet.
        </div>
      ) : (
        <div className="table-premium-container" style={{ marginBottom: '2.5rem' }}>
          <table className="table-premium">
            <thead>
              <tr>
                <th>Job #</th>
                <th>Name</th>
                <th>Status</th>
                <th>Start Date</th>
                <th>End Date</th>
                <th style={{ textAlign: 'right' }}>Budget</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr
                  key={j.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => navigate(`/jobs/${j.id}`)}
                >
                  <td>
                    <code>{j.job_number}</code>
                  </td>
                  <td style={{ fontWeight: 600, color: 'var(--text-title)' }}>{j.name}</td>
                  <td>
                    <Pill status={j.status} />
                  </td>
                  <td>{j.start_date ?? '—'}</td>
                  <td>{j.end_date ?? '—'}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>
                    {j.budget_cents != null ? formatMoney(j.budget_cents) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Invoices List */}
      <h2
        style={{
          fontSize: '1.25rem',
          marginBottom: '0.75rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.35rem',
        }}
      >
        <FileSpreadsheet size={16} style={{ color: 'var(--text-muted)' }} />
        Invoices ({invoices.length})
      </h2>
      {invoices.length === 0 ? (
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
          No invoices raised for this customer yet.
        </div>
      ) : (
        <div className="table-premium-container">
          <table className="table-premium">
            <thead>
              <tr>
                <th>Invoice #</th>
                <th>Issued</th>
                <th>Due</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Total</th>
                <th style={{ textAlign: 'right' }}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr
                  key={inv.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => navigate(`/invoices/${inv.id}`)}
                >
                  <td>
                    <code>{inv.invoice_number}</code>
                  </td>
                  <td>{inv.issue_date}</td>
                  <td>{inv.due_date}</td>
                  <td>
                    <Pill status={inv.status} />
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>
                    {formatMoney(inv.total_inc_gst_cents)}
                  </td>
                  <td
                    style={{
                      textAlign: 'right',
                      fontWeight: 700,
                      color:
                        inv.balance_due_cents > 0 ? 'var(--text-warning)' : 'var(--text-success)',
                    }}
                  >
                    {formatMoney(inv.balance_due_cents)}
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
  sub?: string | undefined;
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

function Pill({ status }: { status: string }) {
  let badgeClass = 'badge-neutral';
  if (status === 'paid' || status === 'completed' || status === 'active')
    badgeClass = 'badge-success';
  else if (status === 'sent') badgeClass = 'badge-info';
  else if (status === 'partially_paid' || status === 'quoted') badgeClass = 'badge-warning';
  else if (status === 'overdue') badgeClass = 'badge-danger';

  return <span className={`badge ${badgeClass}`}>{status.replace('_', ' ')}</span>;
}
