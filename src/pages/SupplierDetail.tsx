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
  Building2,
  DollarSign,
  Wallet,
  FileSpreadsheet,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Stat } from '@/components/ui/Stat';
import { StatusBadge } from '@/components/ui/StatusBadge';

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
  deleted_at: string | null;
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
        .select(
          'id, name, abn, email, contact_phone, default_account_code, payment_terms_days, current_balance_owing_cents, created_at, deleted_at',
        )
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
    if (saveErr) {
      setError(saveErr.message);
      return;
    }
    setEditing(false);
    void refresh();
  };

  if (!currentOrg) return null;
  if (loading) return <DetailPageSkeleton tableCols={5} />;
  if (!supplier) {
    return (
      <section className="animated-fade-in" style={{ padding: '2rem 0', textAlign: 'center' }}>
        <h2>Supplier not found</h2>
        <Link to="/suppliers" className="btn btn-secondary" style={{ marginTop: '1rem' }}>
          <ChevronLeft size={16} /> Back to suppliers
        </Link>
      </section>
    );
  }

  // Stats
  const totalSpend = bills.reduce((acc, b) => acc + (b.total_inc_gst_cents ?? 0), 0);
  const unpaid = bills.filter((b) => b.status !== 'paid' && b.status !== 'void');
  const balanceOwing = unpaid.reduce((acc, b) => acc + (b.total_inc_gst_cents ?? 0), 0);
  const billsAttached = bills.filter((b) => b.job_id).length;

  return (
    <section className="animated-fade-in">
      {/* Back button */}
      <Link
        to="/suppliers"
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
        <span>All suppliers</span>
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
        <PageHeader title={<><Building2 size={24} style={{ color: 'var(--text-link)' }} /> {supplier.name}</>} />

        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            onClick={() => navigate(`/bills/new?supplier_id=${supplier.id}`)}
            className="btn btn-primary"
          >
            <Plus size={16} />
            <span>New bill</span>
          </button>

          <MoveToOrgButton
            table="suppliers"
            rowId={supplier.id}
            currentOrgId={currentOrg.id}
            onMoved={() => {
              window.location.href = '/suppliers';
            }}
          />

          {!editing && (
            <button onClick={startEdit} className="btn btn-secondary">
              <Edit3 size={14} />
              <span>Edit</span>
            </button>
          )}

          <ArchiveButton
            table="suppliers"
            rowId={supplier.id}
            isArchived={!!supplier.deleted_at}
            onChange={(nowArchived) => {
              if (nowArchived) {
                window.location.href = '/suppliers';
              } else {
                void refresh();
              }
            }}
          />
        </div>
      </div>

      {/* Edit Form / Detail Card */}
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
                  value={draft.contact_phone ?? ''}
                  onChange={(e) => setDraft({ ...draft, contact_phone: e.target.value })}
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
              <Field label="Default Account Code (Xero)">
                <input
                  value={draft.default_account_code ?? ''}
                  onChange={(e) => setDraft({ ...draft, default_account_code: e.target.value })}
                  placeholder="e.g. 310"
                  className="form-input"
                />
              </Field>
              <Field label="Payment Terms (days)">
                <input
                  type="number"
                  value={draft.payment_terms_days ?? 30}
                  onChange={(e) =>
                    setDraft({ ...draft, payment_terms_days: Number(e.target.value) })
                  }
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
          <Stat variant="inline" label="ABN" value={supplier.abn ?? '—'} />
          <Stat variant="inline" label="Email" value={supplier.email ?? '—'} />
          <Stat variant="inline" label="Phone" value={supplier.contact_phone ?? '—'} />
          <Stat variant="inline" label="Default Account Code" value={supplier.default_account_code ?? '—'} mono />
          <Stat variant="inline" label="Payment Terms" value={`${supplier.payment_terms_days} days`} />
          <Stat variant="inline" label="Created" value={new Date(supplier.created_at).toLocaleDateString()} />
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
        <Stat label="Total Spend" value={formatMoney(totalSpend)} tone="neutral" icon={Wallet} />
        <Stat
          label="Balance Owing"
          value={formatMoney(balanceOwing)}
          tone={balanceOwing > 0 ? 'danger' : 'neutral'}
          icon={DollarSign}
          sub={`${unpaid.length} unpaid`}
        />
        <Stat
          label="Bills Received"
          value={String(bills.length)}
          tone="info"
          icon={FileSpreadsheet}
          sub={`${billsAttached} attached to jobs`}
        />
      </div>

      {/* Bills table */}
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
        Bills from this supplier
      </h2>
      {bills.length === 0 ? (
        <EmptyState>No bills yet from this supplier.</EmptyState>
      ) : (
        <div className="table-premium-container">
          <table className="table-premium">
            <thead>
              <tr>
                <th>Invoice #</th>
                <th>Date</th>
                <th>Due</th>
                <th>Status</th>
                <th>Job</th>
                <th style={{ textAlign: 'right' }}>Total inc GST</th>
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
                    <code>{b.invoice_number ?? '—'}</code>
                  </td>
                  <td>{b.invoice_date ?? '—'}</td>
                  <td>{b.due_date ?? '—'}</td>
                  <td>
                    <StatusBadge tones={{ attached: 'info', verified: 'success' }} status={b.status} />
                  </td>
                  <td>
                    {b.job_id ? (
                      <span className="badge badge-success">Attached</span>
                    ) : (
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.825rem' }}>—</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>
                    {b.total_inc_gst_cents != null ? (
                      formatMoney(b.total_inc_gst_cents)
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>—</span>
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
