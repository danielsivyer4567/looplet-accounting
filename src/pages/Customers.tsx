import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOrg } from '@/hooks/useOrg';
import { useCustomers } from '@/hooks/useCustomers';
import type { BillingAddress, CustomerRow } from '@/hooks/useCustomers';
import { supabase } from '@/lib/supabase';
import { formatLoadError, formatActionError } from '@/lib/errorMessages';
import { SkeletonTable } from '@/components/Skeleton';
import { Plus, Users, X } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Field } from '@/components/ui/Field';
import { Stat } from '@/components/ui/Stat';

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
      <section className="animated-fade-in">
        <h1>Customers</h1>
        <p style={{ color: 'var(--text-muted)' }}>Pick an organisation to see customers.</p>
      </section>
    );
  }

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
        <PageHeader
          title={
            <>
              <Users size={24} style={{ color: 'var(--text-link)' }} /> Customers
            </>
          }
        />
        <button
          onClick={() => setShowCreate(true)}
          className="btn btn-primary"
          aria-label="+ New customer"
        >
          <Plus size={16} />
          <span>New customer</span>
        </button>
      </div>

      {showCreate && (
        <CreateCustomerForm
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false);
            void refresh();
            navigate(`/customers/${id}`);
          }}
        />
      )}

      {/* Customer Count Card */}
      {!loading && !error && (
        <Stat
          label="Total customers"
          value={String(customers.length)}
          sub={customers.length === 1 ? 'customer' : 'customers'}
          style={{ display: 'inline-flex', marginBottom: '1.5rem', minWidth: '180px' }}
        />
      )}

      {loading ? (
        <SkeletonTable rows={5} cols={5} />
      ) : error ? (
        <div
          className="badge badge-danger"
          style={{ display: 'block', padding: '0.75rem', textTransform: 'none' }}
        >
          {formatLoadError('customers', error)}
        </div>
      ) : customers.length === 0 ? (
        <div
          style={{
            padding: '2.5rem 2rem',
            background: 'var(--bg-card)',
            border: '1px dashed var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--text-muted)',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '0.75rem',
          }}
        >
          <Users size={40} style={{ color: 'var(--text-link)', opacity: 0.7 }} />
          <h3 style={{ margin: 0, color: 'var(--text-title)', fontSize: '1.1rem' }}>
            No customers yet
          </h3>
          <p style={{ margin: 0, fontSize: '0.9rem', maxWidth: '420px' }}>
            No customers found for {currentOrg.name}. Add your first customer to start raising
            invoices and tracking who owes you.
          </p>
          <button
            onClick={() => setShowCreate(true)}
            className="btn btn-primary"
            aria-label="Add your first customer"
            style={{ marginTop: '0.25rem' }}
          >
            <Plus size={16} />
            <span>Add your first customer</span>
          </button>
        </div>
      ) : (
        <>
          <div className="customers-table-view table-premium-container">
            <table className="table-premium">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Billing Address</th>
                  <th>ABN</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr
                    key={c.id}
                    style={{ cursor: 'pointer' }}
                    onClick={() => navigate(`/customers/${c.id}`)}
                  >
                    <td style={{ fontWeight: 600, color: 'var(--text-title)' }}>{c.name}</td>
                    <td>
                      {c.email ? (
                        <span style={{ fontSize: '0.875rem' }}>{c.email}</span>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      )}
                    </td>
                    <td>
                      {c.phone ? (
                        <span style={{ fontSize: '0.875rem' }}>{c.phone}</span>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      )}
                    </td>
                    <td>
                      <span style={{ fontSize: '0.875rem' }}>
                        {formatAddress(c.billing_address)}
                      </span>
                    </td>
                    <td>
                      {c.abn ? (
                        <code>{c.abn}</code>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="customers-card-view" aria-label="Customer cards">
            {customers.map((c) => (
              <CustomerCard key={c.id} customer={c} onOpen={() => navigate(`/customers/${c.id}`)} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function CustomerCard({ customer, onOpen }: { customer: CustomerRow; onOpen: () => void }) {
  const address = formatAddress(customer.billing_address);
  return (
    <article className="customer-mobile-card card" aria-label={`Customer ${customer.name}`}>
      <div className="customer-mobile-card__header">
        <div>
          <a
            href={`/customers/${customer.id}`}
            onClick={(e) => {
              e.preventDefault();
              onOpen();
            }}
            style={{ fontWeight: 700, color: 'var(--text-link)', textDecoration: 'none' }}
          >
            {customer.name}
          </a>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: '0.15rem' }}>
            {customer.email ?? 'No email'}
            {customer.phone ? ` · ${customer.phone}` : ''}
          </div>
          {customer.abn && (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem', marginTop: '0.15rem' }}>
              ABN: <code>{customer.abn}</code>
            </div>
          )}
        </div>
      </div>
      {address !== '—' && (
        <div className="customer-mobile-card__row">
          <span>Billing</span>
          <span style={{ textAlign: 'right', fontSize: '0.8rem' }}>{address}</span>
        </div>
      )}
    </article>
  );
}

function CreateCustomerForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
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
    const billing_address =
      line1 || city || postcode
        ? {
            line1: line1 || undefined,
            city: city || undefined,
            state: state || undefined,
            postcode: postcode || undefined,
          }
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
    if (error) {
      setErr(formatActionError('create the customer', error.message));
      return;
    }
    onCreated(data.id);
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
        <h3 style={{ margin: 0, fontSize: '1.15rem' }}>New Customer</h3>
        <button
          onClick={onClose}
          className="btn btn-ghost"
          aria-label="Close"
          style={{ padding: '0.2rem 0.4rem' }}
        >
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
          <Field label="Name *">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Customer name or business"
              className="form-input"
            />
          </Field>
          <Field label="ABN">
            <input
              value={abn}
              onChange={(e) => setAbn(e.target.value)}
              placeholder="12 345 678 901"
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
          <Field label="Email">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email@domain.com"
              className="form-input"
            />
          </Field>
          <Field label="Phone">
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="0400 000 000"
              className="form-input"
            />
          </Field>
        </div>

        <Field label="Address line 1">
          <input
            value={line1}
            onChange={(e) => setLine1(e.target.value)}
            placeholder="123 Street Rd"
            className="form-input"
          />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '0.75rem' }}>
          <Field label="City">
            <input
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="Brisbane"
              className="form-input"
            />
          </Field>
          <Field label="State">
            <input
              value={state}
              onChange={(e) => setState(e.target.value)}
              placeholder="QLD"
              className="form-input"
            />
          </Field>
          <Field label="Postcode">
            <input
              value={postcode}
              onChange={(e) => setPostcode(e.target.value)}
              placeholder="4000"
              className="form-input"
            />
          </Field>
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

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
          <button
            onClick={submit}
            disabled={busy || !name.trim()}
            className="btn btn-primary"
            style={{ padding: '0.625rem 1.25rem' }}
          >
            {busy ? 'Creating…' : 'Create customer'}
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
