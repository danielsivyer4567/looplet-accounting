import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import {
  usePaymentRunDetail,
  type PaymentRunRow,
  type PaymentRunItem,
} from '@/hooks/usePaymentRuns';
import { formatLoadError } from '@/lib/errorMessages';
import { formatMoney } from '@/lib/money';
import { SkeletonTable } from '@/components/Skeleton';
import {
  ChevronLeft,
  Layers,
  Calendar,
  Wallet,
  CheckCircle,
  Download,
  Edit3,
  Save,
  X,
  Eye,
  AlertTriangle,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { StatusBadge } from '@/components/ui/StatusBadge';

export function PaymentRunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { currentOrg } = useOrg();
  const { run, items, loading, error, refresh } = usePaymentRunDetail(id);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  if (!currentOrg) {
    return (
      <section className="animated-fade-in">
        <h1>Payment Run</h1>
        <p style={{ color: 'var(--text-muted)' }}>Pick an organisation.</p>
      </section>
    );
  }

  if (loading) return <SkeletonTable rows={6} cols={6} />;
  if (error) {
    return (
      <div
        className="badge badge-danger"
        style={{ display: 'block', padding: '1rem', textTransform: 'none' }}
      >
        {formatLoadError('payment run', error)}
      </div>
    );
  }
  if (!run) {
    return (
      <section className="animated-fade-in" style={{ padding: '2rem 0', textAlign: 'center' }}>
        <h2>Payment run not found</h2>
        <Link to="/payment-runs" className="btn btn-secondary" style={{ marginTop: '1rem' }}>
          <ChevronLeft size={16} /> Back to payment runs
        </Link>
      </section>
    );
  }

  const callFn = async (fnName: string, body: Record<string, unknown>) => {
    setActionBusy(true);
    setActionErr(null);
    setActionMsg(null);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      setActionErr('Not authenticated.');
      setActionBusy(false);
      return;
    }

    const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${fnName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(body),
    });
    const result = (await resp.json()) as Record<string, unknown>;
    setActionBusy(false);

    if (!result['ok']) {
      setActionErr((result['error'] as string) ?? 'Unknown error');
      return;
    }
    return result;
  };

  const handleApprove = async () => {
    const { error: err } = await supabase
      .from('payment_runs')
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', run.id);
    if (err) {
      setActionErr(err.message);
      return;
    }
    setActionMsg('Payment run approved.');
    void refresh();
  };

  const handleDownloadAba = async () => {
    const result = await callFn('payment-runs-aba-export', {
      organization_id: currentOrg.id,
      payment_run_id: run.id,
    });
    if (!result) return;

    const content = result['content'] as string;
    const filename = result['filename'] as string;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    setActionMsg(
      `Downloaded ${filename} (${Math.round((((result['aba_file_size_bytes'] as number | undefined) ?? blob.size) / 1024) * 10) / 10} KB)`,
    );
    void refresh();
  };

  const handleMarkPaid = async () => {
    const result = await callFn('payment-runs-mark-paid', { payment_run_id: run.id });
    if (!result) return;
    setActionMsg(`Marked as paid. ${result['bills_updated'] ?? ''} bills updated.`);
    void refresh();
  };

  return (
    <section className="animated-fade-in">
      {/* Back button */}
      <Link
        to="/payment-runs"
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
        <span>Payment runs</span>
      </Link>

      {/* Header Info */}
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
          <PageHeader title={<><Layers size={24} style={{ color: 'var(--text-link)' }} /> Payment Run — {run.pay_date}</>} />
          <div
            style={{
              display: 'flex',
              gap: '0.5rem',
              fontSize: '0.825rem',
              color: 'var(--text-muted)',
              marginTop: '0.25rem',
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
              <Calendar size={12} />
              Pay Date: <strong style={{ color: 'var(--text-title)' }}>{run.pay_date}</strong>
            </span>
            <span>•</span>
            <StatusBadge status={run.status} />
            <span>•</span>
            <span>{run.bill_count} bills</span>
            <span>•</span>
            <span style={{ color: 'var(--text-title)', fontWeight: 600 }}>
              {formatMoney(run.total_cents)} total
            </span>
            {run.aba_file_generated_at && (
              <>
                <span>•</span>
                <span>
                  ABA Exported:{' '}
                  {new Date(run.aba_file_generated_at).toLocaleString('en-AU', {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  })}
                </span>
              </>
            )}
          </div>
          {run.notes && (
            <p
              style={{
                fontSize: '0.875rem',
                color: 'var(--text-muted)',
                marginTop: '0.5rem',
                marginBottom: 0,
              }}
            >
              {run.notes}
            </p>
          )}
        </div>

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {run.status === 'draft' && (
            <button
              onClick={() => void handleApprove()}
              disabled={actionBusy}
              className="btn btn-primary"
            >
              <CheckCircle size={16} />
              <span>{actionBusy ? 'Working…' : 'Approve'}</span>
            </button>
          )}

          {(run.status === 'draft' || run.status === 'approved') && (
            <button
              onClick={() => void handleDownloadAba()}
              disabled={actionBusy}
              className="btn btn-success"
            >
              <Download size={16} />
              <span>{actionBusy ? 'Generating…' : 'Download ABA file'}</span>
            </button>
          )}

          {run.status === 'exported' && (
            <button
              onClick={() => void handleDownloadAba()}
              disabled={actionBusy}
              className="btn btn-success"
            >
              <Download size={16} />
              <span>{actionBusy ? 'Generating…' : 'Re-download ABA file'}</span>
            </button>
          )}

          {(run.status === 'approved' || run.status === 'exported') && (
            <button
              onClick={() => void handleMarkPaid()}
              disabled={actionBusy}
              className="btn btn-secondary"
              style={{ color: 'var(--text-success)', borderColor: 'var(--accent-success)' }}
            >
              <Wallet size={16} />
              <span>{actionBusy ? 'Working…' : 'Mark as paid'}</span>
            </button>
          )}
        </div>
      </div>

      {actionMsg && (
        <div
          className="badge badge-success"
          style={{
            display: 'block',
            padding: '0.75rem',
            marginBottom: '1rem',
            textTransform: 'none',
          }}
        >
          {actionMsg}
        </div>
      )}
      {actionErr && (
        <div
          className="badge badge-danger"
          style={{
            display: 'block',
            padding: '0.75rem',
            marginBottom: '1rem',
            textTransform: 'none',
          }}
        >
          {actionErr}
        </div>
      )}

      {/* Items table */}
      <h2
        style={{
          fontSize: '1.25rem',
          marginBottom: '0.75rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.35rem',
        }}
      >
        <Wallet size={16} style={{ color: 'var(--text-muted)' }} />
        Payment items
      </h2>

      {items.length === 0 ? (
        <EmptyState>No items in this payment run.</EmptyState>
      ) : (
        <div className="table-premium-container">
          <table className="table-premium">
            <thead>
              <tr>
                <th>Payee name</th>
                <th>BSB</th>
                <th>Account</th>
                <th>Reference</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th style={{ width: '120px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <PaymentItemRow
                  key={item.id}
                  item={item}
                  runStatus={run.status}
                  onSaved={() => void refresh()}
                />
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: 'var(--bg-hover)', fontWeight: 700 }}>
                <td
                  colSpan={4}
                  style={{ color: 'var(--text-title)', fontStyle: 'italic', padding: '1rem' }}
                >
                  Total
                </td>
                <td style={{ textAlign: 'right', color: 'var(--text-title)', padding: '1rem' }}>
                  {formatMoney(items.reduce((s, i) => s + i.amount_cents, 0))}
                </td>
                <td style={{ padding: '1rem' }} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

function PaymentItemRow({
  item,
  runStatus,
  onSaved,
}: {
  item: PaymentRunItem;
  runStatus: PaymentRunRow['status'];
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({
    payee_bsb: item.payee_bsb,
    payee_account_number: item.payee_account_number,
    payee_account_name: item.payee_account_name,
  });
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const canEdit = runStatus === 'draft' || runStatus === 'approved';
  const missingBsb = !item.payee_bsb;
  const missingAccount = !item.payee_account_number;

  const save = async () => {
    setSaving(true);
    setSaveErr(null);
    const { error } = await supabase
      .from('payment_run_items')
      .update({
        payee_bsb: draft.payee_bsb,
        payee_account_number: draft.payee_account_number,
        payee_account_name: draft.payee_account_name,
      })
      .eq('id', item.id);
    setSaving(false);
    if (error) {
      setSaveErr(error.message);
      return;
    }
    setEditing(false);
    onSaved();
  };

  if (editing) {
    return (
      <tr style={{ background: 'var(--bg-hover)' }}>
        <td colSpan={5} style={{ padding: '1rem' }}>
          <div
            style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}
          >
            <Field label="Payee name (max 32)">
              <input
                value={draft.payee_account_name}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, payee_account_name: e.target.value.slice(0, 32) }))
                }
                className="form-input"
                style={{ width: '200px', padding: '0.4rem 0.625rem' }}
              />
            </Field>

            <Field label="BSB (NNN-NNN)">
              <input
                value={draft.payee_bsb}
                onChange={(e) => setDraft((d) => ({ ...d, payee_bsb: e.target.value }))}
                placeholder="062-001"
                className="form-input"
                style={{ width: '100px', padding: '0.4rem 0.625rem' }}
              />
            </Field>

            <Field label="Account number">
              <input
                value={draft.payee_account_number}
                onChange={(e) => setDraft((d) => ({ ...d, payee_account_number: e.target.value }))}
                className="form-input"
                style={{ width: '140px', padding: '0.4rem 0.625rem' }}
              />
            </Field>

            <div style={{ display: 'flex', gap: '0.25rem' }}>
              <button
                onClick={() => void save()}
                disabled={saving}
                className="btn btn-primary"
                style={{ padding: '0.45rem 0.75rem', fontSize: '0.825rem' }}
              >
                <Save size={14} />
              </button>
              <button
                onClick={() => setEditing(false)}
                className="btn btn-secondary"
                style={{ padding: '0.45rem 0.75rem', fontSize: '0.825rem' }}
              >
                <X size={14} />
              </button>
            </div>
            {saveErr && (
              <span
                className="badge badge-danger"
                style={{ padding: '0.45rem 0.75rem', textTransform: 'none' }}
              >
                {saveErr}
              </span>
            )}
          </div>
        </td>
        <td style={{ padding: '1rem' }} />
      </tr>
    );
  }

  return (
    <tr>
      <td style={{ fontWeight: 600 }}>
        {item.payee_account_name || <span style={{ color: 'var(--text-muted)' }}>—</span>}
      </td>
      <td>
        {item.payee_bsb ? (
          item.payee_bsb
        ) : (
          <span
            style={{
              color: 'var(--text-warning)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.25rem',
            }}
          >
            <AlertTriangle size={12} />
            {canEdit ? (
              <button
                onClick={() => setEditing(true)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-warning)',
                  padding: 0,
                  textDecoration: 'underline',
                  cursor: 'pointer',
                  fontSize: '0.875rem',
                }}
              >
                add BSB
              </button>
            ) : (
              'missing'
            )}
          </span>
        )}
      </td>
      <td>
        {item.payee_account_number ? (
          maskAccount(item.payee_account_number)
        ) : (
          <span
            style={{
              color: 'var(--text-warning)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.25rem',
            }}
          >
            <AlertTriangle size={12} />
            {canEdit ? (
              <button
                onClick={() => setEditing(true)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-warning)',
                  padding: 0,
                  textDecoration: 'underline',
                  cursor: 'pointer',
                  fontSize: '0.875rem',
                }}
              >
                add account
              </button>
            ) : (
              'missing'
            )}
          </span>
        )}
      </td>
      <td>{item.reference ?? <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
      <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatMoney(item.amount_cents)}</td>
      <td>
        <div style={{ display: 'inline-flex', gap: '0.25rem', alignItems: 'center' }}>
          <Link
            to={`/bills/${item.bill_id}`}
            className="btn btn-secondary"
            style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
          >
            <Eye size={12} />
            <span style={{ marginLeft: '0.25rem' }}>View</span>
          </Link>
          {canEdit && !missingBsb && !missingAccount && (
            <button
              onClick={() => setEditing(true)}
              className="btn btn-secondary"
              style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem' }}
            >
              <Edit3 size={12} />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function maskAccount(acct: string): string {
  if (acct.length <= 4) return acct;
  return '****' + acct.slice(-4);
}
