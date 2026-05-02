import { useEffect, useState, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';
import { formatMoney } from '@/lib/money';

interface Supplier {
  id: string;
  name: string;
  abn: string | null;
  email: string | null;
  contact_phone: string | null;
  default_account_code: string | null;
  payment_terms_days: number;
  current_balance_owing_cents: number | null;
  created_at: string;
}

interface BillRow {
  id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  total_inc_gst_cents: number | null;
  status: string;
  job_id: string | null;
}

export function SupplierDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { currentOrg } = useOrg();
  const navigate = useNavigate();
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [bills, setBills] = useState<BillRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<Supplier>>({});
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!currentOrg || !id) return;
    setLoading(true);
    const [supRes, billRes] = await Promise.all([
      supabase
        .from('suppliers')
        .select('id, name, abn, email, contact_phone, default_account_code, payment_terms_days, current_balance_owing_cents, created_at')
        .eq('id', id)
        .eq('organization_id', currentOrg.id)
        .maybeSingle(),
      supabase
        .from('bills')
        .select('id, invoice_number, invoice_date, due_date, total_inc_gst_cents, status, job_id')
        .eq('supplier_id', id)
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .order('invoice_date', { ascending: false, nullsFirst: false }),
    ]);
    if (supRes.error) setError(supRes.error.message);
    setSupplier((supRes.data ?? null) as Supplier | null);
    setBills((billRes.data ?? []) as BillRow[]);
    setLoading(false);
  }, [currentOrg, id]);

  useEffect(() => void refresh(), [refresh]);

  const startEdit = () => {
    if (!supplier) return;
    setDraft({
      name: supplier.name,
      abn: supplier.abn ?? '',
      email: supplier.email ?? '',
      contact_phone: supplier.contact_phone ?? '',
      default_account_code: supplier.default_account_code ?? '',
      payment_terms_days: supplier.payment_terms_days,
    });
    setEditing(true);
  };

  const save = async () => {
    if (!supplier) return;
    setSaving(true);
    const payload: Partial<Supplier> = {
      name: (draft.name ?? supplier.name).trim(),
      abn: draft.abn?.toString().trim() || null,
      email: draft.email?.toString().trim() || null,
      contact_phone: draft.contact_phone?.toString().trim() || null,
      default_account_code: draft.default_account_code?.toString().trim() || null,
      payment_terms_days: Number(draft.payment_terms_days ?? supplier.payment_terms_days),
    };
    const { error: saveErr } = await supabase
      .from('suppliers')
      .update(payload)
      .eq('id', supplier.id);
    setSaving(false);
    if (saveErr) { setError(saveErr.message); return; }
    setEditing(false);
    void refresh();
  };

  if (!currentOrg) return null;
  if (loading) return <section><h1>Supplier</h1><p style={{ color: '#888' }}>Loading…</p></section>;
  if (!supplier) return (
    <section>
      <h1>Supplier not found</h1>
      <Link to="/suppliers" style={{ color: '#86c7a3' }}>&larr; Back to suppliers</Link>
    </section>
  );

  // Stats
  const totalSpend = bills.reduce((acc, b) => acc + (b.total_inc_gst_cents ?? 0), 0);
  const unpaid = bills.filter((b) => b.status !== 'paid' && b.status !== 'void');
  const balanceOwing = unpaid.reduce((acc, b) => acc + (b.total_inc_gst_cents ?? 0), 0);
  const billsAttached = bills.filter((b) => b.job_id).length;

  return (
    <section>
      <Link to="/suppliers" style={{ color: '#86c7a3', fontSize: 13 }}>&larr; All suppliers</Link>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: '0.5rem' }}>
        <h1 style={{ margin: 0 }}>{supplier.name}</h1>
        {!editing && (
          <button onClick={startEdit} style={editBtn}>✎ Edit</button>
        )}
      </div>

      {editing ? (
        <div style={card}>
          <div style={grid2}>
            <Field label="Name"><input value={draft.name ?? ''} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={inp} /></Field>
            <Field label="ABN"><input value={draft.abn ?? ''} onChange={(e) => setDraft({ ...draft, abn: e.target.value })} style={inp} /></Field>
          </div>
          <div style={grid2}>
            <Field label="Email"><input value={draft.email ?? ''} onChange={(e) => setDraft({ ...draft, email: e.target.value })} style={inp} /></Field>
            <Field label="Phone"><input value={draft.contact_phone ?? ''} onChange={(e) => setDraft({ ...draft, contact_phone: e.target.value })} style={inp} /></Field>
          </div>
          <div style={grid2}>
            <Field label="Default account code (Xero)"><input value={draft.default_account_code ?? ''} onChange={(e) => setDraft({ ...draft, default_account_code: e.target.value })} placeholder="e.g. 310" style={inp} /></Field>
            <Field label="Payment terms (days)"><input type="number" value={draft.payment_terms_days ?? 30} onChange={(e) => setDraft({ ...draft, payment_terms_days: Number(e.target.value) })} style={inp} /></Field>
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button onClick={() => void save()} disabled={saving} style={primaryBtn}>{saving ? 'Saving…' : 'Save'}</button>
            <button onClick={() => setEditing(false)} disabled={saving} style={ghostBtn}>Cancel</button>
          </div>
          {error && <p style={{ color: 'salmon', fontSize: 12, marginTop: 8 }}>{error}</p>}
        </div>
      ) : (
        <div style={{ ...card, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
          <Stat label="ABN" value={supplier.abn ?? '—'} />
          <Stat label="Email" value={supplier.email ?? '—'} />
          <Stat label="Phone" value={supplier.contact_phone ?? '—'} />
          <Stat label="Default account code" value={supplier.default_account_code ?? '—'} mono />
          <Stat label="Payment terms" value={`${supplier.payment_terms_days} days`} />
          <Stat label="Created" value={new Date(supplier.created_at).toLocaleDateString()} />
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginTop: 16 }}>
        <KpiCard label="Total spend" value={formatMoney(totalSpend)} colour="#86c7a3" />
        <KpiCard label="Balance owing" value={formatMoney(balanceOwing)} colour={balanceOwing > 0 ? '#e9a3a3' : '#888'} sub={`${unpaid.length} unpaid`} />
        <KpiCard label="Bills" value={String(bills.length)} colour="#aaa" sub={`${billsAttached} attached to jobs`} />
      </div>

      <h2 style={{ fontSize: 14, marginTop: 24, marginBottom: 8 }}>Bills from this supplier</h2>
      {bills.length === 0 ? (
        <p style={{ color: '#888', fontSize: 13 }}>No bills yet from this supplier.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
              <th style={th}>Invoice #</th>
              <th style={th}>Date</th>
              <th style={th}>Due</th>
              <th style={th}>Status</th>
              <th style={th}>Job</th>
              <th style={thRight}>Total inc GST</th>
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
                <td style={td}><code style={{ color: '#aaa', fontSize: 12 }}>{b.invoice_number ?? '—'}</code></td>
                <td style={td}>{b.invoice_date ?? '—'}</td>
                <td style={td}>{b.due_date ?? '—'}</td>
                <td style={td}><StatusPill status={b.status} /></td>
                <td style={td}>{b.job_id ? <span style={{ color: '#86c7a3', fontSize: 11 }}>✓ attached</span> : <span style={{ color: '#666', fontSize: 11 }}>—</span>}</td>
                <td style={tdRight}>{b.total_inc_gst_cents != null ? formatMoney(b.total_inc_gst_cents) : <span style={{ color: '#444' }}>—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
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

function StatusPill({ status }: { status: string }) {
  const colour = status === 'paid' ? '#86c7a3'
    : status === 'attached' ? '#5096d8'
    : status === 'verified' ? '#d2c886'
    : status === 'void' ? '#666'
    : '#888';
  return (
    <span style={{ padding: '0.15rem 0.5rem', fontSize: 11, borderRadius: 3, background: '#222', color: colour, textTransform: 'uppercase' }}>{status}</span>
  );
}

const card: React.CSSProperties = {
  marginTop: 12, padding: 16,
  background: '#0e0e0e', border: '1px solid #2a2a2a', borderRadius: 6, maxWidth: 920,
};
const grid2: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 };
const inp: React.CSSProperties = {
  width: '100%', padding: '6px 8px',
  background: '#000', color: '#ddd', border: '1px solid #333', borderRadius: 3, fontSize: 12,
};
const editBtn: React.CSSProperties = {
  padding: '0.3rem 0.75rem',
  background: 'transparent', color: '#aaa',
  border: '1px solid #333', borderRadius: 3, fontSize: 12, cursor: 'pointer',
};
const primaryBtn: React.CSSProperties = {
  padding: '0.4rem 1rem', background: '#1c4868', color: '#fff',
  border: '1px solid #5096d8', borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: 'pointer',
};
const ghostBtn: React.CSSProperties = {
  padding: '0.4rem 1rem', background: 'transparent', color: '#aaa',
  border: '1px solid #333', borderRadius: 4, fontSize: 12, cursor: 'pointer',
};
const th: React.CSSProperties = {
  padding: '0.4rem 0.5rem', textAlign: 'left',
  fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 500,
};
const thRight: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '0.5rem' };
const tdRight: React.CSSProperties = { ...td, textAlign: 'right' };
