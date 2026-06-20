import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOrg } from '@/hooks/useOrg';
import { useCustomers } from '@/hooks/useCustomers';
import type { BillingAddress } from '@/hooks/useCustomers';
import { supabase } from '@/lib/supabase';
import { SkeletonTable } from '@/components/Skeleton';

function formatAddress(addr: BillingAddress | null): string {
  if (!addr) return '—';
  const parts = [addr.line1, addr.city, addr.state, addr.postcode].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : '—';
}

export function CustomersPage() {
  const { currentOrg } = useOrg();
  const { customers, loading, error, refresh } = useCustomers();
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);

  if (!currentOrg) {
    return (
      <section>
        <h1>Customers</h1>
        <p style={{ color: '#888' }}>Pick an organisation to see customers.</p>
      </section>
    );
  }

  return (
    <section>
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '1rem' }}>
        <h1 style={{ margin: 0 }}>Customers</h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {!loading && (
            <span style={{ color: '#888', fontSize: 13 }}>
              {customers.length} customer{customers.length !== 1 ? 's' : ''}
            </span>
          )}
          <button onClick={() => setShowCreate(true)} style={primaryBtn}>+ New customer</button>
        </div>
      </div>

      {showCreate && (
        <CreateCustomerForm
          onClose={() => setShowCreate(false)}
          onCreated={(id) => { setShowCreate(false); void refresh(); navigate(`/customers/${id}`); }}
        />
      )}

      {/* Count card */}
      {!loading && !error && (
        <div
          style={{
            display: 'inline-flex',
            flexDirection: 'column',
            padding: '1rem 1.5rem',
            background: '#1a1a1a',
            border: '1px solid #2a2a2a',
            borderRadius: 6,
            marginBottom: '1.5rem',
          }}
        >
          <span style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Total customers
          </span>
          <span style={{ fontSize: 32, fontWeight: 700, color: '#86c7a3', marginTop: '0.25rem' }}>
            {customers.length}
          </span>
        </div>
      )}

      {loading ? (
        <SkeletonTable rows={5} cols={5} />
      ) : error ? (
        <p style={{ color: 'salmon' }}>Failed to load: {error}</p>
      ) : customers.length === 0 ? (
        <p style={{ color: '#888' }}>No customers found for {currentOrg.name}.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
                <th style={th}>Name</th>
                <th style={th}>Email</th>
                <th style={th}>Phone</th>
                <th style={th}>Billing address</th>
                <th style={th}>ABN</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr
                  key={c.id}
                  style={{ borderBottom: '1px solid #1a1a1a', cursor: 'pointer' }}
                  onClick={() => void navigate(`/customers/${c.id}`)}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLTableRowElement).style.background = '#202020';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLTableRowElement).style.background = '';
                  }}
                >
                  <td style={{ ...td, fontWeight: 500 }}>{c.name}</td>
                  <td style={td}>
                    {c.email ? (
                      <span style={{ color: '#aaa', fontSize: 13 }}>{c.email}</span>
                    ) : (
                      <span style={{ color: '#444' }}>—</span>
                    )}
                  </td>
                  <td style={td}>
                    {c.phone ? (
                      <span style={{ color: '#aaa', fontSize: 13 }}>{c.phone}</span>
                    ) : (
                      <span style={{ color: '#444' }}>—</span>
                    )}
                  </td>
                  <td style={td}>
                    <span style={{ color: '#aaa', fontSize: 13 }}>
                      {formatAddress(c.billing_address)}
                    </span>
                  </td>
                  <td style={td}>
                    {c.abn ? (
                      <code style={{ color: '#888', fontSize: 12 }}>{c.abn}</code>
                    ) : (
                      <span style={{ color: '#444' }}>—</span>
                    )}
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

function CreateCustomerForm({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { currentOrg } = useOrg();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [abn, setAbn] = useState('');
  const [line1, setLine1] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('QLD');
  const [postcode, setPostcode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!currentOrg || !name.trim()) return;
    setBusy(true);
    const billing_address = (line1 || city || postcode)
      ? { line1: line1 || undefined, city: city || undefined, state: state || undefined, postcode: postcode || undefined }
      : null;
    const { data, error } = await supabase
      .from('customers')
      .insert({
        organization_id: currentOrg.id,
        name: name.trim(),
        email: email.trim() || null,
        phone: phone.trim() || null,
        abn: abn.trim() || null,
        billing_address,
      })
      .select('id')
      .single();
    setBusy(false);
    if (error) { setErr(error.message); return; }
    onCreated(data.id);
  };

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ fontSize: 14, margin: 0 }}>New customer</h3>
        <button onClick={onClose} style={closeBtn}>×</button>
      </div>
      <div style={grid2}>
        <Field label="Name *"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Customer name or business" style={inp} /></Field>
        <Field label="ABN"><input value={abn} onChange={(e) => setAbn(e.target.value)} placeholder="12 345 678 901" style={inp} /></Field>
      </div>
      <div style={grid2}>
        <Field label="Email"><input value={email} onChange={(e) => setEmail(e.target.value)} style={inp} /></Field>
        <Field label="Phone"><input value={phone} onChange={(e) => setPhone(e.target.value)} style={inp} /></Field>
      </div>
      <Field label="Address line 1"><input value={line1} onChange={(e) => setLine1(e.target.value)} style={inp} /></Field>
      <div style={grid3}>
        <Field label="City"><input value={city} onChange={(e) => setCity(e.target.value)} style={inp} /></Field>
        <Field label="State"><input value={state} onChange={(e) => setState(e.target.value)} style={inp} /></Field>
        <Field label="Postcode"><input value={postcode} onChange={(e) => setPostcode(e.target.value)} style={inp} /></Field>
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button onClick={submit} disabled={busy || !name.trim()} style={primaryBtn}>{busy ? 'Creating…' : 'Create customer'}</button>
        <button onClick={onClose} disabled={busy} style={ghostBtn}>Cancel</button>
      </div>
      {err && <p style={{ color: 'salmon', fontSize: 12, marginTop: 8 }}>{err}</p>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: 'block', fontSize: 11, color: '#888', marginTop: 8 }}><div style={{ marginBottom: 3 }}>{label}</div>{children}</label>;
}

const card: React.CSSProperties = { marginBottom: 16, padding: 16, background: '#0e0e0e', border: '1px solid #2a2a2a', borderRadius: 6, maxWidth: 720 };
const grid2: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 };
const grid3: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 };
const inp: React.CSSProperties = { width: '100%', padding: '6px 8px', background: '#000', color: '#ddd', border: '1px solid #333', borderRadius: 3, fontSize: 12 };
const primaryBtn: React.CSSProperties = { padding: '0.5rem 1rem', background: '#1c4868', color: '#fff', border: '1px solid #5096d8', borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const ghostBtn: React.CSSProperties = { padding: '0.5rem 1rem', background: 'transparent', color: '#aaa', border: '1px solid #333', borderRadius: 4, fontSize: 12, cursor: 'pointer' };
const closeBtn: React.CSSProperties = { background: 'transparent', color: '#888', border: 'none', fontSize: 18, cursor: 'pointer', padding: 0 };

const th: React.CSSProperties = {
  padding: '0.5rem 0.75rem',
  textAlign: 'left',
  fontSize: 12,
  color: '#888',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  fontWeight: 500,
};
const td: React.CSSProperties = { padding: '0.65rem 0.75rem' };
