import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';
import { usePaymentRunDetail, type PaymentRunRow, type PaymentRunItem } from '@/hooks/usePaymentRuns';
import { formatMoney } from '@/lib/money';
import { SkeletonTable } from '@/components/Skeleton';

const STATUS_COLORS: Record<PaymentRunRow['status'], string> = {
  draft:     '#888',
  approved:  '#d2c886',
  exported:  '#86c7a3',
  paid:      '#7799d6',
  cancelled: '#555',
};

export function PaymentRunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { currentOrg } = useOrg();
  const { run, items, loading, error, refresh } = usePaymentRunDetail(id);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  if (!currentOrg) {
    return (
      <section>
        <h1>Payment Run</h1>
        <p style={{ color: '#888' }}>Pick an organisation.</p>
      </section>
    );
  }

  if (loading) return <SkeletonTable rows={6} cols={5} />;
  if (error) return <p style={{ color: 'salmon' }}>Error: {error}</p>;
  if (!run) return <p style={{ color: '#888' }}>Payment run not found.</p>;

  const callFn = async (fnName: string, body: Record<string, unknown>) => {
    setActionBusy(true);
    setActionErr(null);
    setActionMsg(null);

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { setActionErr('Not authenticated.'); setActionBusy(false); return; }

    const resp = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${fnName}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify(body),
      },
    );
    const result = await resp.json() as Record<string, unknown>;
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
    if (err) { setActionErr(err.message); return; }
    setActionMsg('Payment run approved.');
    void refresh();
  };

  const handleDownloadAba = async () => {
    const result = await callFn('payment-runs-aba-export', {
      organization_id: currentOrg.id,
      payment_run_id: run.id,
    });
    if (!result) return;

    // Trigger browser download
    const content = result['content'] as string;
    const filename = result['filename'] as string;
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    setActionMsg(`Downloaded ${filename} (${Math.round((result['aba_file_size_bytes'] as number | undefined ?? blob.size) / 1024 * 10) / 10} KB)`);
    void refresh();
  };

  const handleMarkPaid = async () => {
    const result = await callFn('payment-runs-mark-paid', { payment_run_id: run.id });
    if (!result) return;
    setActionMsg(`Marked as paid. ${result['bills_updated'] ?? ''} bills updated.`);
    void refresh();
  };

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: '0.5rem' }}>
        <Link to="/payment-runs" style={{ color: '#666', fontSize: 13, textDecoration: 'none' }}>
          &larr; Payment runs
        </Link>
      </div>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>Payment Run — {run.pay_date}</h1>
          <div style={{ display: 'flex', gap: 16, fontSize: 13, color: '#888', flexWrap: 'wrap' }}>
            <span>
              <StatusPill status={run.status} />
            </span>
            <span>{run.bill_count} bills</span>
            <span style={{ color: '#ccc', fontWeight: 600 }}>{formatMoney(run.total_cents)} total</span>
            {run.aba_file_generated_at && (
              <span>
                ABA exported{' '}
                {new Date(run.aba_file_generated_at).toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'short' })}
              </span>
            )}
          </div>
          {run.notes && (
            <p style={{ fontSize: 12, color: '#888', marginTop: 6 }}>{run.notes}</p>
          )}
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: '1.5rem' }}>
        {run.status === 'draft' && (
          <button
            onClick={() => void handleApprove()}
            disabled={actionBusy}
            style={btnSecondary}
          >
            {actionBusy ? 'Working…' : 'Approve'}
          </button>
        )}

        {(run.status === 'draft' || run.status === 'approved') && (
          <button
            onClick={() => void handleDownloadAba()}
            disabled={actionBusy}
            style={btnPrim}
          >
            {actionBusy ? 'Generating…' : 'Download ABA file'}
          </button>
        )}

        {run.status === 'exported' && (
          <button
            onClick={() => void handleDownloadAba()}
            disabled={actionBusy}
            style={{ ...btnPrim, background: '#1c3a5a', borderColor: '#4a90d9' }}
          >
            {actionBusy ? 'Generating…' : 'Re-download ABA file'}
          </button>
        )}

        {(run.status === 'approved' || run.status === 'exported') && (
          <button
            onClick={() => void handleMarkPaid()}
            disabled={actionBusy}
            style={{ ...btnSecondary, borderColor: '#7799d6', color: '#7799d6' }}
          >
            {actionBusy ? 'Working…' : 'Mark as paid'}
          </button>
        )}
      </div>

      {actionMsg && <p style={{ color: '#86c7a3', fontSize: 13, marginBottom: 12 }}>{actionMsg}</p>}
      {actionErr && <p style={{ color: 'salmon', fontSize: 13, marginBottom: 12 }}>{actionErr}</p>}

      {/* Items table */}
      {items.length === 0 ? (
        <p style={{ color: '#888' }}>No items in this payment run.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
                <th style={th}>Payee name</th>
                <th style={th}>BSB</th>
                <th style={th}>Account</th>
                <th style={th}>Reference</th>
                <th style={thRight}>Amount</th>
                <th style={th}>Bill</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <PaymentItemRow key={item.id} item={item} runStatus={run.status} onSaved={() => void refresh()} />
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '1px solid #2a2a2a' }}>
                <td colSpan={4} style={{ ...td, color: '#888', fontStyle: 'italic' }}>Total</td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>
                  {formatMoney(items.reduce((s, i) => s + i.amount_cents, 0))}
                </td>
                <td style={td} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Per-row component with inline edit for payee fields
// ---------------------------------------------------------------------------

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
    if (error) { setSaveErr(error.message); return; }
    setEditing(false);
    onSaved();
  };

  if (editing) {
    return (
      <tr style={{ background: '#111', borderBottom: '1px solid #2a2a2a' }}>
        <td style={td} colSpan={5}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={{ fontSize: 11, color: '#888' }}>
              <div>Payee name (max 32)</div>
              <input
                value={draft.payee_account_name}
                onChange={(e) => setDraft((d) => ({ ...d, payee_account_name: e.target.value.slice(0, 32) }))}
                style={{ ...inp, width: 200 }}
              />
            </label>
            <label style={{ fontSize: 11, color: '#888' }}>
              <div>BSB (NNN-NNN)</div>
              <input
                value={draft.payee_bsb}
                onChange={(e) => setDraft((d) => ({ ...d, payee_bsb: e.target.value }))}
                placeholder="062-001"
                style={{ ...inp, width: 90 }}
              />
            </label>
            <label style={{ fontSize: 11, color: '#888' }}>
              <div>Account number</div>
              <input
                value={draft.payee_account_number}
                onChange={(e) => setDraft((d) => ({ ...d, payee_account_number: e.target.value }))}
                style={{ ...inp, width: 120 }}
              />
            </label>
            <button onClick={() => void save()} disabled={saving} style={btnPrim}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => setEditing(false)} style={btnGhost}>Cancel</button>
            {saveErr && <span style={{ color: 'salmon', fontSize: 11 }}>{saveErr}</span>}
          </div>
        </td>
        <td style={td} />
      </tr>
    );
  }

  return (
    <tr style={{ borderBottom: '1px solid #1a1a1a' }}>
      <td style={td}>
        {item.payee_account_name || <span style={{ color: '#555' }}>—</span>}
      </td>
      <td style={td}>
        {item.payee_bsb ? (
          item.payee_bsb
        ) : (
          <span style={{ color: '#f4a261' }}>
            {canEdit ? (
              <button onClick={() => setEditing(true)} style={warnBtn}>⚠ add BSB</button>
            ) : '⚠ missing'}
          </span>
        )}
      </td>
      <td style={td}>
        {item.payee_account_number ? (
          maskAccount(item.payee_account_number)
        ) : (
          <span style={{ color: '#f4a261' }}>
            {canEdit ? (
              <button onClick={() => setEditing(true)} style={warnBtn}>⚠ add account</button>
            ) : '⚠ missing'}
          </span>
        )}
      </td>
      <td style={td}>{item.reference ?? <span style={{ color: '#555' }}>—</span>}</td>
      <td style={{ ...td, textAlign: 'right' }}>{formatMoney(item.amount_cents)}</td>
      <td style={td}>
        <Link
          to={`/bills/${item.bill_id}`}
          style={{ color: '#86c7a3', fontSize: 12, textDecoration: 'none' }}
        >
          view
        </Link>
        {canEdit && !missingBsb && !missingAccount && (
          <button
            onClick={() => setEditing(true)}
            style={{ ...btnGhost, marginLeft: 8, fontSize: 11 }}
          >
            edit
          </button>
        )}
      </td>
    </tr>
  );
}

function StatusPill({ status }: { status: PaymentRunRow['status'] }) {
  return (
    <span
      style={{
        fontSize: 11,
        padding: '2px 6px',
        borderRadius: 3,
        background: STATUS_COLORS[status] + '33',
        color: STATUS_COLORS[status],
        fontWeight: 600,
        textTransform: 'uppercase',
      }}
    >
      {status}
    </span>
  );
}

function maskAccount(acct: string): string {
  if (acct.length <= 4) return acct;
  return '****' + acct.slice(-4);
}

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '0.5rem 0.75rem',
  fontSize: 11,
  color: '#666',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};
const thRight: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '0.6rem 0.75rem', fontSize: 13, color: '#ccc' };
const inp: React.CSSProperties = {
  padding: '5px 8px',
  background: '#000',
  color: '#ddd',
  border: '1px solid #333',
  borderRadius: 3,
  fontSize: 12,
};
const btnPrim: React.CSSProperties = {
  padding: '0.4rem 0.8rem',
  background: '#1c5135',
  color: '#fff',
  border: '1px solid #2da565',
  borderRadius: 4,
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
};
const btnSecondary: React.CSSProperties = {
  padding: '0.4rem 0.8rem',
  background: 'transparent',
  color: '#aaa',
  border: '1px solid #444',
  borderRadius: 4,
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
};
const btnGhost: React.CSSProperties = {
  padding: '0.3rem 0.6rem',
  background: 'transparent',
  color: '#666',
  border: '1px solid #333',
  borderRadius: 4,
  fontSize: 12,
  cursor: 'pointer',
};
const warnBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#f4a261',
  fontSize: 12,
  cursor: 'pointer',
  padding: 0,
  textDecoration: 'underline',
};
