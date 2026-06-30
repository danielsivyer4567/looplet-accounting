import { useState } from 'react';
import { Check, CheckCheck, ChevronDown, Tag, Zap } from 'lucide-react';
import { formatMoney } from '@/lib/money';
import { useBankCodingQueue, type CodingQueueRow } from '@/hooks/useBankCodingQueue';

const CATEGORY_OPTIONS = [
  { code: 'materials', label: 'Materials' },
  { code: 'subcontractor', label: 'Subcontractor' },
  { code: 'motor_vehicle', label: 'Motor vehicle' },
  { code: 'fuel', label: 'Fuel' },
  { code: 'plant_equipment', label: 'Plant & equipment' },
  { code: 'insurance', label: 'Insurance' },
  { code: 'telephone_internet', label: 'Telephone & internet' },
  { code: 'subscriptions_saas', label: 'Subscriptions' },
  { code: 'office_supplies', label: 'Office supplies' },
  { code: 'travel', label: 'Travel' },
  { code: 'meals_entertainment', label: 'Meals & entertainment' },
  { code: 'professional_fees', label: 'Professional fees' },
  { code: 'rent', label: 'Rent' },
  { code: 'utilities', label: 'Utilities' },
  { code: 'bank_fees', label: 'Bank fees' },
  { code: 'marketing', label: 'Marketing' },
  { code: 'training', label: 'Training' },
  { code: 'uniform_ppe', label: 'Uniform & PPE' },
  { code: 'ato_bas_super', label: 'ATO / BAS / Super' },
  { code: 'customer_payment', label: 'Customer payment' },
  { code: 'refunds', label: 'Refunds' },
  { code: 'employee_wages', label: 'Employee wages' },
  { code: 'personal_expense', label: 'Personal' },
  { code: 'uncategorized', label: 'Needs review' },
];

function confidenceColor(c: number): string {
  if (c >= 0.88) return 'var(--color-success)';
  if (c >= 0.6) return 'var(--color-warning, #f59e0b)';
  return 'var(--color-danger, #ef4444)';
}

function OverrideSelect({
  row,
  onOverride,
  busy,
}: {
  row: CodingQueueRow;
  onOverride: (code: string) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        className="btn btn-ghost"
        style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', opacity: busy ? 0.5 : 1 }}
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
      >
        Override <ChevronDown size={12} style={{ marginLeft: 2 }} />
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: '100%',
            zIndex: 50,
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-md)',
            minWidth: '180px',
            maxHeight: '260px',
            overflowY: 'auto',
          }}
        >
          {CATEGORY_OPTIONS.map((opt) => (
            <button
              key={opt.code}
              className="btn btn-ghost"
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '0.4rem 0.75rem',
                fontSize: '0.8rem',
                borderRadius: 0,
                fontWeight: opt.code === row.category_code ? 600 : 400,
              }}
              onClick={() => {
                setOpen(false);
                onOverride(opt.code);
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CodingRow({
  row,
  busyId,
  onConfirm,
  onOverride,
}: {
  row: CodingQueueRow;
  busyId: string | null;
  onConfirm: (txnId: string) => void;
  onOverride: (txnId: string, code: string) => void;
}) {
  const busy = busyId === row.bank_transaction_id;
  const isDebit = row.txn_amount_cents < 0;
  const date = new Date(row.txn_posted_at).toLocaleDateString('en-AU', {
    day: '2-digit',
    month: 'short',
  });

  return (
    <tr style={{ opacity: busy ? 0.5 : 1 }}>
      <td style={{ fontSize: '0.8rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
        {date}
      </td>
      <td style={{ maxWidth: '220px' }}>
        <span
          style={{
            fontSize: '0.85rem',
            display: 'block',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={row.txn_description}
        >
          {row.txn_description}
        </span>
      </td>
      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        <span style={{ color: isDebit ? 'var(--text-danger, #ef4444)' : 'var(--color-success)' }}>
          {isDebit ? '-' : '+'}
          {formatMoney(Math.abs(row.txn_amount_cents))}
        </span>
      </td>
      <td>
        {row.category_code && row.category_code !== 'uncategorized' ? (
          <span
            className="badge"
            style={{
              background: 'var(--bg-accent-subtle)',
              color: 'var(--accent-primary)',
              fontSize: '0.75rem',
            }}
          >
            <Tag size={10} style={{ marginRight: 3 }} />
            {row.category_label ?? row.category_code}
          </span>
        ) : (
          <span className="badge badge-warning" style={{ fontSize: '0.75rem' }}>
            Unclear
          </span>
        )}
      </td>
      <td style={{ textAlign: 'center' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.25rem',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              width: '36px',
              height: '4px',
              borderRadius: '2px',
              background: 'var(--border-subtle)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${Math.round(row.confidence * 100)}%`,
                height: '100%',
                background: confidenceColor(row.confidence),
                borderRadius: '2px',
              }}
            />
          </div>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
            {Math.round(row.confidence * 100)}%
          </span>
        </div>
      </td>
      <td>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <button
            className="btn btn-primary"
            style={{ padding: '0.25rem 0.6rem', fontSize: '0.75rem' }}
            disabled={busy || !row.category_code}
            onClick={() => onConfirm(row.bank_transaction_id)}
          >
            <Check size={12} style={{ marginRight: 3 }} />
            Confirm
          </button>
          <OverrideSelect
            row={row}
            busy={busy}
            onOverride={(code) => onOverride(row.bank_transaction_id, code)}
          />
        </div>
      </td>
    </tr>
  );
}

// Named export so Reconciliation page can import it
export function BankTransactionCodingQueue() {
  const { rows, loading, error, busyId, refresh, postDecision, confirmAll } = useBankCodingQueue();
  const [actionError, setActionError] = useState<string | null>(null);

  const handleConfirm = async (txnId: string) => {
    const result = await postDecision(txnId, 'accept');
    if (!result.ok) setActionError(result.error ?? 'Failed');
  };

  const handleOverride = async (txnId: string, code: string) => {
    const result = await postDecision(txnId, 'override', code);
    if (!result.ok) setActionError(result.error ?? 'Failed');
  };

  const handleConfirmAll = async () => {
    setActionError(null);
    await confirmAll(0.8);
  };

  const highConfidenceCount = rows.filter(
    (r) => r.confidence >= 0.8 && r.category_code && r.category_code !== 'uncategorized',
  ).length;

  if (loading) {
    return (
      <div
        style={{
          padding: '2rem',
          textAlign: 'center',
          color: 'var(--text-muted)',
          fontSize: '0.875rem',
        }}
      >
        Loading coding queue…
      </div>
    );
  }

  return (
    <div>
      {/* Section header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '1rem',
          flexWrap: 'wrap',
          gap: '0.75rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Zap size={18} style={{ color: 'var(--accent-primary)' }} />
          <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Coding Queue</h2>
          {rows.length > 0 && (
            <span
              className="badge"
              style={{ background: 'var(--accent-primary)', color: '#fff', fontSize: '0.7rem' }}
            >
              {rows.length}
            </span>
          )}
        </div>
        {highConfidenceCount > 0 && (
          <button
            className="btn btn-primary"
            style={{ fontSize: '0.8rem', padding: '0.4rem 0.9rem' }}
            onClick={handleConfirmAll}
          >
            <CheckCheck size={14} style={{ marginRight: '0.35rem' }} />
            Confirm all ≥80% ({highConfidenceCount})
          </button>
        )}
      </div>

      {(error || actionError) && (
        <div
          className="badge badge-danger"
          style={{
            display: 'block',
            padding: '0.5rem 0.75rem',
            marginBottom: '0.75rem',
            textTransform: 'none',
          }}
        >
          {error ?? actionError}
        </div>
      )}

      {rows.length === 0 ? (
        <div
          style={{
            padding: '2.5rem',
            textAlign: 'center',
            color: 'var(--text-muted)',
            fontSize: '0.875rem',
            border: '1px dashed var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
          }}
        >
          No transactions waiting for coding — the classifier is up to date.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%', fontSize: '0.85rem' }}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Description</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th>Suggested category</th>
                <th style={{ textAlign: 'center' }}>Confidence</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <CodingRow
                  key={row.id}
                  row={row}
                  busyId={busyId}
                  onConfirm={handleConfirm}
                  onOverride={handleOverride}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ marginTop: '0.5rem', textAlign: 'right' }}>
          <button
            className="btn btn-ghost"
            style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}
            onClick={() => void refresh()}
          >
            Refresh
          </button>
        </div>
      )}
    </div>
  );
}
