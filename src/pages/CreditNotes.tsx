import { useEffect, useMemo, useState } from 'react';
import { FileMinus2, Loader2, Plus, ReceiptText } from 'lucide-react';
import {
  type CreditNoteKind,
  type CreditNoteSourceOption,
  useCreditNotes,
} from '@/hooks/useCreditNotes';
import { useOrg } from '@/hooks/useOrg';
import { formatMoney } from '@/lib/money';
import { SkeletonTable } from '@/components/Skeleton';

function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

function inputToCents(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100);
}

export function CreditNotesPage() {
  const { currentOrg } = useOrg();
  const {
    notes,
    customerSources,
    supplierSources,
    loading,
    error,
    createCustomer,
    createSupplier,
  } = useCreditNotes();
  const [kind, setKind] = useState<CreditNoteKind>('customer');
  const [sourceId, setSourceId] = useState('');
  const [creditNoteNumber, setCreditNoteNumber] = useState('');
  const [creditNoteDate, setCreditNoteDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [subtotal, setSubtotal] = useState('0.00');
  const [gst, setGst] = useState('0.00');
  const [accountCode, setAccountCode] = useState('4000');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const sources: CreditNoteSourceOption[] = kind === 'customer' ? customerSources : supplierSources;
  const selectedSource = useMemo(
    () => sources.find((source) => source.id === sourceId) ?? sources[0] ?? null,
    [sourceId, sources],
  );

  useEffect(() => {
    if (!selectedSource) {
      setSourceId('');
      setSubtotal('0.00');
      setGst('0.00');
      return;
    }
    if (sourceId !== selectedSource.id) setSourceId(selectedSource.id);
    setSubtotal(centsToInput(selectedSource.subtotal_ex_gst_cents));
    setGst(centsToInput(selectedSource.gst_cents));
  }, [selectedSource, sourceId]);

  useEffect(() => {
    setAccountCode(kind === 'customer' ? '4000' : '5000');
    setSourceId('');
    setMessage(null);
    setActionError(null);
  }, [kind]);

  if (!currentOrg) {
    return (
      <section className="animated-fade-in">
        <h1>Credit notes</h1>
        <p style={{ color: 'var(--text-muted)' }}>Pick an organisation to see credit notes.</p>
      </section>
    );
  }

  const totalCredits = notes.reduce((sum, note) => sum + note.total_inc_gst_cents, 0);
  const customerCount = notes.filter((note) => note.kind === 'customer').length;
  const supplierCount = notes.filter((note) => note.kind === 'supplier').length;

  const submit = async () => {
    setActionError(null);
    setMessage(null);
    if (!selectedSource) {
      setActionError('Select a source document first.');
      return;
    }
    if (!creditNoteNumber.trim()) {
      setActionError('Credit note number is required.');
      return;
    }
    const subtotalCents = inputToCents(subtotal);
    const gstCents = inputToCents(gst);
    if (subtotalCents + gstCents <= 0) {
      setActionError('Credit note total must be greater than zero.');
      return;
    }

    setBusy(true);
    try {
      if (kind === 'customer') {
        await createCustomer({
          invoiceId: selectedSource.id,
          creditNoteNumber,
          creditNoteDate,
          subtotalExGstCents: subtotalCents,
          gstCents,
          revenueAccountCode: accountCode,
          reason,
        });
      } else {
        await createSupplier({
          billId: selectedSource.id,
          creditNoteNumber,
          creditNoteDate,
          subtotalExGstCents: subtotalCents,
          gstCents,
          counterAccountCode: accountCode,
          reason,
        });
      }
      setCreditNoteNumber('');
      setReason('');
      setMessage('Credit note posted to the general ledger.');
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="animated-fade-in">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '1rem',
          flexWrap: 'wrap',
          marginBottom: '1.5rem',
        }}
      >
        <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <FileMinus2 size={24} style={{ color: 'var(--accent-primary)' }} />
          Credit notes
        </h1>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '1rem',
          marginBottom: '1.5rem',
        }}
      >
        <SummaryCard label="Total credits" value={formatMoney(totalCredits)} />
        <SummaryCard label="Customer credits" value={customerCount.toLocaleString()} />
        <SummaryCard label="Supplier credits" value={supplierCount.toLocaleString()} />
      </div>

      <div className="card" style={{ padding: '1.25rem', marginBottom: '1.5rem' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '1rem',
            flexWrap: 'wrap',
            marginBottom: '1rem',
          }}
        >
          <h2
            style={{
              margin: 0,
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              fontSize: '1.1rem',
            }}
          >
            <ReceiptText size={16} style={{ color: 'var(--text-muted)' }} />
            New credit note
          </h2>
          <div
            style={{
              display: 'inline-flex',
              gap: '0.25rem',
              padding: '0.25rem',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-panel)',
            }}
          >
            {(['customer', 'supplier'] as const).map((option) => (
              <button
                key={option}
                className="btn"
                onClick={() => setKind(option)}
                style={{
                  border: 'none',
                  padding: '0.35rem 0.65rem',
                  background: kind === option ? 'var(--accent-primary)' : 'transparent',
                  color: kind === option ? 'var(--text-on-accent)' : 'var(--text-muted)',
                  textTransform: 'capitalize',
                }}
              >
                {option}
              </button>
            ))}
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
            gap: '0.9rem',
          }}
        >
          <Field label={kind === 'customer' ? 'Source invoice' : 'Source bill'}>
            <select
              className="form-select"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
            >
              {sources.length === 0 ? (
                <option value="">No source documents</option>
              ) : (
                sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.label}
                  </option>
                ))
              )}
            </select>
          </Field>
          <Field label="Credit note #">
            <input
              className="form-input"
              value={creditNoteNumber}
              onChange={(e) => setCreditNoteNumber(e.target.value)}
              placeholder={kind === 'customer' ? 'CN-1001' : 'SCN-1001'}
            />
          </Field>
          <Field label="Date">
            <input
              type="date"
              className="form-input"
              value={creditNoteDate}
              onChange={(e) => setCreditNoteDate(e.target.value)}
            />
          </Field>
          <Field label="Account code">
            <input
              className="form-input"
              value={accountCode}
              onChange={(e) => setAccountCode(e.target.value)}
            />
          </Field>
          <Field label="Subtotal ex GST">
            <input
              type="number"
              min="0"
              step="0.01"
              className="form-input"
              value={subtotal}
              onChange={(e) => setSubtotal(e.target.value)}
            />
          </Field>
          <Field label="GST">
            <input
              type="number"
              min="0"
              step="0.01"
              className="form-input"
              value={gst}
              onChange={(e) => setGst(e.target.value)}
            />
          </Field>
          <Field label="Reason">
            <input
              className="form-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Return, rebate, adjustment"
            />
          </Field>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            flexWrap: 'wrap',
            marginTop: '1rem',
          }}
        >
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? <Loader2 size={14} /> : <Plus size={14} />}
            <span>Post credit note</span>
          </button>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            Total: {formatMoney(inputToCents(subtotal) + inputToCents(gst))}
          </span>
        </div>
        {message && (
          <p style={{ color: 'var(--text-success)', fontSize: '0.85rem', marginBottom: 0 }}>
            {message}
          </p>
        )}
        {actionError && (
          <p style={{ color: 'var(--text-danger)', fontSize: '0.85rem', marginBottom: 0 }}>
            {actionError}
          </p>
        )}
      </div>

      {loading ? (
        <SkeletonTable rows={5} cols={7} />
      ) : error ? (
        <div
          className="badge badge-danger"
          style={{ display: 'block', padding: '0.75rem', textTransform: 'none' }}
        >
          {error}
        </div>
      ) : notes.length === 0 ? (
        <div
          style={{
            padding: '2rem',
            border: '1px dashed var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--text-muted)',
            textAlign: 'center',
          }}
        >
          No credit notes posted yet.
        </div>
      ) : (
        <div className="table-premium-container">
          <table className="table-premium">
            <thead>
              <tr>
                <th>Credit note</th>
                <th>Type</th>
                <th>Counterparty</th>
                <th>Source</th>
                <th>Date</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {notes.map((note) => (
                <tr key={`${note.kind}-${note.id}`}>
                  <td>
                    <code style={{ fontSize: '0.78rem' }}>{note.credit_note_number}</code>
                  </td>
                  <td style={{ textTransform: 'capitalize' }}>{note.kind}</td>
                  <td style={{ fontWeight: 600 }}>{note.counterparty_name}</td>
                  <td>{note.source_number}</td>
                  <td>{note.credit_note_date}</td>
                  <td>
                    <span className={note.journal_entry_id ? 'badge badge-success' : 'badge'}>
                      {note.status}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>
                    {formatMoney(note.total_inc_gst_cents)}
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
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
      <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)', fontWeight: 700 }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="card" style={{ padding: '1rem' }}>
      <div
        style={{
          fontSize: '0.68rem',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          fontWeight: 700,
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: '0.35rem',
          fontSize: '1.35rem',
          color: 'var(--text-title)',
          fontWeight: 800,
          fontFamily: 'var(--font-title)',
        }}
      >
        {value}
      </div>
    </div>
  );
}
