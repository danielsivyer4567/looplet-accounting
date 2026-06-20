import { useEffect, useState, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { formatMoney } from '@/lib/money';
import { MoveToOrgButton } from '@/components/MoveToOrgButton';
import { ArchiveButton } from '@/components/ArchiveButton';

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
      supabase.from('customers').select('*').eq('id', id).eq('organization_id', currentOrg.id).maybeSingle(),
      supabase.from('v_customer_pnl').select('*').eq('customer_id', id).eq('organization_id', currentOrg.id).maybeSingle(),
      supabase.from('invoices')
        .select('id, invoice_number, status, issue_date, due_date, total_inc_gst_cents, amount_paid_cents, balance_due_cents, job_id')
        .eq('customer_id', id).eq('organization_id', currentOrg.id).is('deleted_at', null).order('issue_date', { ascending: false }),
      supabase.from('jobs')
        .select('id, job_number, name, status, start_date, end_date, budget_cents')
        .eq('customer_id', id).eq('organization_id', currentOrg.id).is('deleted_at', null).order('created_at', { ascending: false }),
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
    setDraft({ name: customer.name, abn: customer.abn ?? '', email: customer.email ?? '', phone: customer.phone ?? '', notes: customer.notes ?? '' });
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
    if (e) { setError(e.message); return; }
    setEditing(false);
    void refresh();
  };

  if (!currentOrg) return null;
  if (loading) return <section><h1>Customer</h1><p style={{ color: '#888' }}>Loading…</p></section>;
  if (!customer) return (
    <section>
      <h1>Customer not found</h1>
      <Link to="/customers" style={{ color: '#86c7a3' }}>&larr; Back to customers</Link>
    </section>
  );

  return (
    <section>
      <Link to="/customers" style={{ color: '#86c7a3', fontSize: 13 }}>&larr; All customers</Link>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: '0.5rem' }}>
        <h1 style={{ margin: 0 }}>{customer.name}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => navigate(`/invoices/new?customer_id=${customer.id}`)} style={btnPrim}>+ Raise invoice</button>
          <MoveToOrgButton table="customers" rowId={customer.id} currentOrgId={currentOrg.id} onMoved={() => { window.location.href = '/customers'; }} />
          {!editing && <button onClick={startEdit} style={btnGhost}>✎ Edit</button>}
          <ArchiveButton
            table="customers"
            rowId={customer.id}
            isArchived={!!customer.deleted_at}
            onChange={(nowArchived) => {
              if (nowArchived) { window.location.href = '/customers'; }
              else { void refresh(); }
            }}
          />
        </div>
      </div>

      {editing ? (
        <div style={card}>
          <div style={grid2}>
            <Field label="Name"><input value={draft.name ?? ''} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={inp} /></Field>
            <Field label="ABN"><input value={draft.abn ?? ''} onChange={(e) => setDraft({ ...draft, abn: e.target.value })} style={inp} /></Field>
          </div>
          <div style={grid2}>
            <Field label="Email"><input value={draft.email ?? ''} onChange={(e) => setDraft({ ...draft, email: e.target.value })} style={inp} /></Field>
            <Field label="Phone"><input value={draft.phone ?? ''} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} style={inp} /></Field>
          </div>
          <Field label="Notes"><textarea rows={2} value={draft.notes ?? ''} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} style={inp} /></Field>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button onClick={save} disabled={saving} style={btnPrim}>{saving ? 'Saving…' : 'Save'}</button>
            <button onClick={() => setEditing(false)} disabled={saving} style={btnGhost}>Cancel</button>
          </div>
          {error && <p style={{ color: 'salmon', fontSize: 12, marginTop: 8 }}>{error}</p>}
        </div>
      ) : (
        <div style={{ ...card, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          <Stat label="ABN" value={customer.abn ?? '—'} />
          <Stat label="Email" value={customer.email ?? '—'} />
          <Stat label="Phone" value={customer.phone ?? '—'} />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginTop: 16, maxWidth: 1100 }}>
        <Kpi label="Invoices" value={String(pnl?.invoice_count ?? 0)} colour="#aaa" />
        <Kpi label="Total invoiced" value={formatMoney(pnl?.total_invoiced_cents ?? 0)} colour="#86c7a3" />
        <Kpi label="Paid" value={formatMoney(pnl?.total_paid_cents ?? 0)} colour="#86c7a3" />
        <Kpi label="Outstanding" value={formatMoney(pnl?.balance_owing_cents ?? 0)} colour={(pnl?.balance_owing_cents ?? 0) > 0 ? '#d2c886' : '#888'} sub={(pnl?.overdue_cents ?? 0) > 0 ? `${formatMoney(pnl?.overdue_cents ?? 0)} overdue` : undefined} />
      </div>

      <h2 style={h2}>Jobs ({jobs.length})</h2>
      {jobs.length === 0 ? (
        <p style={{ color: '#888', fontSize: 13 }}>No jobs for this customer yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr style={{ borderBottom: '1px solid #2a2a2a' }}>
            <th style={th}>Job #</th><th style={th}>Name</th><th style={th}>Status</th><th style={th}>Start</th><th style={th}>End</th><th style={thRight}>Budget</th>
          </tr></thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id} style={{ borderBottom: '1px solid #1a1a1a', cursor: 'pointer' }} onClick={() => navigate(`/jobs/${j.id}`)}>
                <td style={td}><code style={{ color: '#aaa' }}>{j.job_number}</code></td>
                <td style={td}>{j.name}</td>
                <td style={td}><Pill status={j.status} /></td>
                <td style={td}>{j.start_date ?? '—'}</td>
                <td style={td}>{j.end_date ?? '—'}</td>
                <td style={tdRight}>{j.budget_cents != null ? formatMoney(j.budget_cents) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 style={h2}>Invoices ({invoices.length})</h2>
      {invoices.length === 0 ? (
        <p style={{ color: '#888', fontSize: 13 }}>No invoices for this customer yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr style={{ borderBottom: '1px solid #2a2a2a' }}>
            <th style={th}>#</th><th style={th}>Issued</th><th style={th}>Due</th><th style={th}>Status</th><th style={thRight}>Total</th><th style={thRight}>Balance</th>
          </tr></thead>
          <tbody>
            {invoices.map((inv) => (
              <tr key={inv.id} style={{ borderBottom: '1px solid #1a1a1a', cursor: 'pointer' }} onClick={() => navigate(`/invoices/${inv.id}`)}>
                <td style={td}><code style={{ color: '#aaa' }}>{inv.invoice_number}</code></td>
                <td style={td}>{inv.issue_date}</td>
                <td style={td}>{inv.due_date}</td>
                <td style={td}><Pill status={inv.status} /></td>
                <td style={tdRight}>{formatMoney(inv.total_inc_gst_cents)}</td>
                <td style={{ ...tdRight, color: inv.balance_due_cents > 0 ? '#d2c886' : '#86c7a3' }}>{formatMoney(inv.balance_due_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: 'block', fontSize: 11, color: '#888', marginTop: 6 }}><div style={{ marginBottom: 3 }}>{label}</div>{children}</label>;
}
function Stat({ label, value }: { label: string; value: string }) {
  return <div><div style={{ fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div><div style={{ marginTop: 3, color: '#ddd', fontSize: 13 }}>{value}</div></div>;
}
function Kpi({ label, value, colour, sub }: { label: string; value: string; colour: string; sub?: string | undefined }) {
  return (
    <div style={{ padding: 12, background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 6 }}>
      <div style={{ fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ marginTop: 4, fontSize: 18, color: colour, fontWeight: 600 }}>{value}</div>
      {sub && <div style={{ marginTop: 3, fontSize: 11, color: '#888' }}>{sub}</div>}
    </div>
  );
}
function Pill({ status }: { status: string }) {
  const c = status === 'paid' || status === 'completed' || status === 'active' ? '#86c7a3'
    : status === 'sent' ? '#5096d8'
    : status === 'partially_paid' || status === 'quoted' ? '#d2c886'
    : status === 'overdue' ? '#e9a3a3'
    : status === 'void' || status === 'cancelled' ? '#666' : '#888';
  return <span style={{ padding: '0.15rem 0.5rem', fontSize: 11, borderRadius: 3, background: '#222', color: c, textTransform: 'uppercase' }}>{status}</span>;
}

const card: React.CSSProperties = { marginTop: 12, padding: 16, background: '#0e0e0e', border: '1px solid #2a2a2a', borderRadius: 6, maxWidth: 1100 };
const grid2: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 };
const inp: React.CSSProperties = { width: '100%', padding: '6px 8px', background: '#000', color: '#ddd', border: '1px solid #333', borderRadius: 3, fontSize: 12 };
const h2: React.CSSProperties = { fontSize: 14, marginTop: 24, marginBottom: 8 };
const th: React.CSSProperties = { padding: '0.4rem 0.5rem', textAlign: 'left', fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 500 };
const thRight: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '0.5rem' };
const tdRight: React.CSSProperties = { ...td, textAlign: 'right' };
const btnPrim: React.CSSProperties = { padding: '0.4rem 1rem', background: '#1c4868', color: '#fff', border: '1px solid #5096d8', borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: 'pointer' };
const btnGhost: React.CSSProperties = { padding: '0.4rem 1rem', background: 'transparent', color: '#aaa', border: '1px solid #333', borderRadius: 4, fontSize: 12, cursor: 'pointer' };
