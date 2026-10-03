import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOrg } from '@/hooks/useOrg';
import { useOrgRole } from '@/hooks/useOrgRole';
import { ReadOnlyNotice } from '@/components/ReadOnlyNotice';
import { useSuppliers, type SupplierRow } from '@/hooks/useSuppliers';
import { supabase } from '@/lib/supabase';
import { formatMoney, formatMoneyCompact } from '@/lib/money';
import { formatLoadError, formatActionError } from '@/lib/errorMessages';
import { SkeletonTable } from '@/components/Skeleton';
import { LoadMoreButton } from '@/components/LoadMoreButton';
import { Truck, BarChart, Plus, X } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';

interface BarChartProps {
  items: { label: string; value: number }[];
  max: number;
}

function HorizontalBarChart({ items, max }: BarChartProps) {
  const BAR_HEIGHT = 22;
  const LABEL_W = 160;
  const VALUE_W = 80;
  const BAR_W = 260;
  const ROW_GAP = 10;
  const totalHeight = items.length * (BAR_HEIGHT + ROW_GAP);

  return (
    <svg
      width={LABEL_W + BAR_W + VALUE_W + 16}
      height={totalHeight}
      role="img"
      aria-label="Top 5 suppliers by spend"
    >
      {items.map((item, i) => {
        const y = i * (BAR_HEIGHT + ROW_GAP);
        const barWidth = max > 0 ? (item.value / max) * BAR_W : 0;
        return (
          <g key={item.label}>
            {/* supplier name */}
            <text
              x={LABEL_W - 8}
              y={y + BAR_HEIGHT / 2 + 1}
              textAnchor="end"
              dominantBaseline="middle"
              fill="var(--text-body)"
              fontSize={12}
              fontFamily="var(--font-sans)"
            >
              {item.label.length > 22 ? item.label.slice(0, 20) + '…' : item.label}
            </text>
            {/* track */}
            <rect x={LABEL_W} y={y} width={BAR_W} height={BAR_HEIGHT} fill="var(--bg-app)" rx={4} />
            {/* fill */}
            <rect
              x={LABEL_W}
              y={y}
              width={barWidth}
              height={BAR_HEIGHT}
              fill="var(--accent-primary)"
              rx={4}
            />
            {/* value */}
            <text
              x={LABEL_W + BAR_W + 8}
              y={y + BAR_HEIGHT / 2 + 1}
              dominantBaseline="middle"
              fill="var(--text-title)"
              fontSize={12}
              fontWeight={700}
              fontFamily="var(--font-sans)"
            >
              {formatMoneyCompact(item.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function SuppliersPage() {
  const { currentOrg } = useOrg();
  const { suppliers, spendMap, loading, loadingMore, error, hasMore, loadMore, refresh } =
    useSuppliers();
  const { canWrite } = useOrgRole();
  const readOnly = !canWrite('books');
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);

  if (!currentOrg) {
    return (
      <section className="animated-fade-in">
        <h1>Suppliers</h1>
        <p style={{ color: 'var(--text-muted)' }}>Pick an organisation to see suppliers.</p>
      </section>
    );
  }

  const totalSpend = Array.from(spendMap.values()).reduce((a, b) => a + b, 0);

  const top5 = suppliers
    .map((s) => ({ label: s.name, value: spendMap.get(s.id) ?? 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
  const chartMax = top5[0]?.value ?? 0;

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
              <Truck size={24} style={{ color: 'var(--text-link)' }} /> Suppliers
            </>
          }
        />
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {!loading && (
            <div
              className="badge badge-neutral"
              style={{
                padding: '0.4rem 0.75rem',
                fontSize: '0.8rem',
                display: 'flex',
                gap: '0.35rem',
                alignItems: 'center',
                textTransform: 'none',
              }}
            >
              <span>{suppliers.length} suppliers</span>
              <span>·</span>
              <span style={{ color: 'var(--text-success)', fontWeight: 'bold' }}>
                {formatMoney(totalSpend)} spend
              </span>
            </div>
          )}
          <button
            onClick={() => setShowCreate(true)}
            disabled={readOnly}
            className="btn btn-primary"
            aria-label="+ New supplier"
          >
            <Plus size={16} />
            <span>New supplier</span>
          </button>
        </div>
      </div>

      {readOnly && <ReadOnlyNotice area="books" />}

      {showCreate && (
        <CreateSupplierForm
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false);
            void refresh();
            navigate(`/suppliers/${id}`);
          }}
        />
      )}

      {/* Top 5 spend SVG chart */}
      {!loading && !error && top5.length > 0 && (
        <div
          className="card"
          style={{
            marginBottom: '2.5rem',
            padding: '1.25rem 1.5rem',
            display: 'inline-block',
            maxWidth: '100%',
            overflowX: 'auto',
          }}
        >
          <div
            style={{
              fontSize: '0.725rem',
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: '1rem',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: '0.25rem',
            }}
          >
            <BarChart size={14} style={{ color: 'var(--text-link)' }} />
            Top 5 Suppliers by Spend YTD
          </div>
          <HorizontalBarChart items={top5} max={chartMax} />
        </div>
      )}

      {loading ? (
        <SkeletonTable rows={5} cols={7} />
      ) : error ? (
        <div
          className="badge badge-danger"
          style={{ display: 'block', padding: '0.75rem', textTransform: 'none' }}
        >
          {formatLoadError('suppliers', error)}
        </div>
      ) : suppliers.length === 0 ? (
        <EmptyState>No suppliers found for {currentOrg.name}.</EmptyState>
      ) : (
        <>
          <div className="suppliers-table-view table-premium-container">
            <table className="table-premium">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>ABN</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Account Code</th>
                  <th style={{ textAlign: 'right' }}>Balance Owing</th>
                  <th style={{ textAlign: 'right' }}>Total Spend</th>
                </tr>
              </thead>
              <tbody>
                {suppliers.map((s) => (
                  <tr
                    key={s.id}
                    style={{ cursor: 'pointer' }}
                    onClick={() => navigate(`/suppliers/${s.id}`)}
                  >
                    <td style={{ fontWeight: 600, color: 'var(--text-title)' }}>{s.name}</td>
                    <td>
                      {s.abn ? (
                        <code>{s.abn}</code>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      )}
                    </td>
                    <td>
                      {s.email ? (
                        <span style={{ fontSize: '0.875rem' }}>{s.email}</span>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      )}
                    </td>
                    <td>
                      {s.contact_phone ? (
                        <span style={{ fontSize: '0.875rem' }}>{s.contact_phone}</span>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      )}
                    </td>
                    <td>
                      {s.default_account_code ? (
                        <span
                          className="badge badge-neutral"
                          style={{ fontSize: '11px', fontFamily: 'ui-monospace, monospace' }}
                        >
                          {s.default_account_code}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      )}
                    </td>
                    <td
                      style={{
                        textAlign: 'right',
                        fontWeight: 600,
                        color:
                          s.current_balance_owing_cents && s.current_balance_owing_cents > 0
                            ? 'var(--text-danger)'
                            : 'var(--text-body)',
                      }}
                    >
                      {s.current_balance_owing_cents != null ? (
                        formatMoney(s.current_balance_owing_cents)
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      )}
                    </td>
                    <td
                      style={{
                        textAlign: 'right',
                        color: 'var(--text-link)',
                        fontWeight: 600,
                      }}
                    >
                      {formatMoney(spendMap.get(s.id) ?? 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="suppliers-card-view" aria-label="Supplier cards">
            {suppliers.map((s) => (
              <SupplierCard
                key={s.id}
                supplier={s}
                spendCents={spendMap.get(s.id) ?? 0}
                onOpen={() => navigate(`/suppliers/${s.id}`)}
              />
            ))}
          </div>
          {hasMore && (
            <LoadMoreButton
              label="Load more suppliers"
              loading={loadingMore}
              onClick={() => void loadMore()}
            />
          )}
        </>
      )}
    </section>
  );
}

function SupplierCard({
  supplier,
  spendCents,
  onOpen,
}: {
  supplier: SupplierRow;
  spendCents: number;
  onOpen: () => void;
}) {
  const owing = supplier.current_balance_owing_cents;
  return (
    <article className="supplier-mobile-card card" aria-label={`Supplier ${supplier.name}`}>
      <div className="supplier-mobile-card__header">
        <div>
          <a
            href={`/suppliers/${supplier.id}`}
            onClick={(e) => {
              e.preventDefault();
              onOpen();
            }}
            style={{ fontWeight: 700, color: 'var(--text-link)', textDecoration: 'none' }}
          >
            {supplier.name}
          </a>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: '0.15rem' }}>
            {supplier.email ?? 'No email'}
            {supplier.contact_phone ? ` · ${supplier.contact_phone}` : ''}
          </div>
          {supplier.abn && (
            <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem', marginTop: '0.15rem' }}>
              ABN: <code>{supplier.abn}</code>
            </div>
          )}
        </div>
        {supplier.default_account_code && (
          <span
            className="badge badge-neutral"
            style={{ fontSize: '11px', fontFamily: 'ui-monospace, monospace' }}
          >
            {supplier.default_account_code}
          </span>
        )}
      </div>

      <div className="supplier-mobile-card__metrics">
        <div>
          <span>Balance owing</span>
          <strong style={{ color: owing && owing > 0 ? 'var(--text-danger)' : 'var(--text-body)' }}>
            {owing != null ? formatMoney(owing) : '—'}
          </strong>
        </div>
        <div>
          <span>Total spend</span>
          <strong style={{ color: 'var(--text-link)' }}>{formatMoney(spendCents)}</strong>
        </div>
      </div>
    </article>
  );
}

function CreateSupplierForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { currentOrg } = useOrg();
  const [name, setName] = useState('');
  const [abn, setAbn] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [accountCode, setAccountCode] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('30');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!currentOrg || !name.trim()) return;
    setBusy(true);
    setErr(null);
    const { data, error } = await supabase
      .from('suppliers')
      .insert({
        organization_id: currentOrg.id,
        name: name.trim(),
        abn: abn.trim() || null,
        email: email.trim() || null,
        contact_phone: phone.trim() || null,
        default_account_code: accountCode.trim() || null,
        payment_terms_days: Number(paymentTerms) || 30,
      })
      .select('id')
      .single();
    setBusy(false);
    if (error) {
      setErr(formatActionError('create the supplier', error.message));
      return;
    }
    onCreated((data as { id: string }).id);
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
        <h3 style={{ margin: 0, fontSize: '1.15rem' }}>New Supplier</h3>
        <button
          onClick={onClose}
          className="btn btn-ghost"
          style={{ padding: '0.2rem 0.4rem' }}
          aria-label="Close new supplier form"
        >
          <X size={16} />
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: '1rem',
          }}
        >
          <Field label="Name *">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Supplier business name"
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
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: '1rem',
          }}
        >
          <Field label="Email">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="accounts@supplier.com"
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

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '1rem',
          }}
        >
          <Field label="Default account code">
            <input
              value={accountCode}
              onChange={(e) => setAccountCode(e.target.value)}
              placeholder="6-1000"
              className="form-input"
            />
          </Field>
          <Field label="Payment terms">
            <input
              type="number"
              min={0}
              value={paymentTerms}
              onChange={(e) => setPaymentTerms(e.target.value)}
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

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
          <button onClick={submit} disabled={busy || !name.trim()} className="btn btn-primary">
            <Plus size={16} />
            <span>{busy ? 'Creating…' : 'Create supplier'}</span>
          </button>
          <button onClick={onClose} disabled={busy} className="btn btn-secondary">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
