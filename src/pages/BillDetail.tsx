import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useBill, getBillFileUrl, type BillDetail as Bill } from '@/hooks/useBill';
import { JobPicker } from '@/components/JobPicker';
import { MoveToOrgButton } from '@/components/MoveToOrgButton';
import { supabase } from '@/lib/supabase';
import { formatMoney } from '@/lib/money';

export function BillDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { bill, loading, error, refresh } = useBill(id);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (bill) {
      void getBillFileUrl(bill.storage_key).then(setFileUrl);
    }
  }, [bill]);

  if (loading) return <p style={{ color: '#888' }}>Loading bill…</p>;
  if (error || !bill) {
    return (
      <section>
        <h1>Bill not found</h1>
        <p style={{ color: 'salmon' }}>{error ?? 'No bill with that id.'}</p>
        <Link to="/bills">← back to bills</Link>
      </section>
    );
  }

  const attachToJob = async (jobId: string) => {
    setBusy(true);
    setActionError(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('No session');

      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/bills-attach`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ bill_id: bill.id, job_id: jobId }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) {
        throw new Error(body.error ?? `Attach failed (${res.status})`);
      }
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const reocr = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error('No session');
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/bills-extract`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ bill_id: bill.id }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error ?? `Re-OCR failed (${res.status})`);
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <Link to="/bills" style={{ color: '#888', fontSize: 13 }}>
        ← back to bills
      </Link>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: '0.5rem' }}>
        <h1 style={{ margin: 0 }}>
          {bill.supplier_name_raw ?? <span style={{ color: '#888' }}>Bill {bill.id.slice(0, 8)}</span>}
        </h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <PersonalToggle bill={bill} onChange={() => void refresh()} />
          <MoveToOrgButton
            table="bills"
            rowId={bill.id}
            currentOrgId={bill.organization_id}
            fkColumnsToNull={['supplier_id', 'job_id', 'suggested_job_id']}
            onMoved={() => { window.location.href = '/bills'; }}
          />
        </div>
      </div>
      <StatusBar bill={bill} />

      {actionError && (
        <div style={{ padding: '0.75rem', background: '#3d1818', color: '#e9a3a3', borderRadius: 4, marginBottom: '1rem' }}>
          {actionError}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
        {/* Left: file preview */}
        <div>
          <h3 style={{ fontSize: 14, color: '#aaa', marginBottom: '0.5rem' }}>Original document</h3>
          <div
            style={{
              background: '#0a0a0a',
              border: '1px solid #2a2a2a',
              borderRadius: 4,
              minHeight: 600,
              maxHeight: '85vh',
              overflow: 'auto',
              padding: '0.5rem',
            }}
          >
            {fileUrl ? (
              bill.mime_type === 'application/pdf' ? (
                <iframe
                  src={fileUrl}
                  title={bill.original_filename}
                  style={{ width: '100%', height: '80vh', border: 'none' }}
                />
              ) : bill.mime_type.startsWith('image/') ? (
                <a href={fileUrl} target="_blank" rel="noreferrer">
                  <img
                    src={fileUrl}
                    alt={bill.original_filename}
                    style={{ width: '100%', height: 'auto', display: 'block' }}
                  />
                </a>
              ) : (
                <p style={{ color: '#888', padding: '1rem' }}>
                  Preview not supported for {bill.mime_type}.{' '}
                  <a href={fileUrl} target="_blank" rel="noreferrer" style={{ color: '#86c7a3' }}>
                    Download
                  </a>
                </p>
              )
            ) : (
              <p style={{ color: '#888', padding: '1rem' }}>Loading preview…</p>
            )}
          </div>
        </div>

        {/* Right: extracted data + actions */}
        <div>
          <h3 style={{ fontSize: 14, color: '#aaa', marginBottom: '0.5rem' }}>Extracted</h3>
          <Field label="Supplier" value={bill.supplier_name_raw} />
          <Field label="ABN" value={bill.supplier_abn} mono />
          <Field label="Invoice #" value={bill.invoice_number} mono />
          <Field label="Date" value={bill.invoice_date} />
          <Field label="Due" value={bill.due_date} />
          <Field
            label="Total inc GST"
            value={bill.total_inc_gst_cents != null ? formatMoney(bill.total_inc_gst_cents) : null}
            highlight
          />
          <Field label="GST" value={bill.gst_cents != null ? formatMoney(bill.gst_cents) : null} />
          <Field
            label="Subtotal ex GST"
            value={bill.subtotal_ex_gst_cents != null ? formatMoney(bill.subtotal_ex_gst_cents) : null}
          />
          <Field label="Job ref" value={bill.job_reference_raw} mono />
          <Field
            label="OCR"
            value={
              bill.ocr_provider
                ? `${bill.raw_extracted?._extraction_method ?? '?'} via ${bill.ocr_provider} (${bill.ocr_confidence ?? '?'})`
                : null
            }
          />

          {bill.line_items.length > 0 && (
            <>
              <h3 style={{ fontSize: 14, color: '#aaa', marginTop: '1.5rem', marginBottom: '0.5rem' }}>
                Line items
              </h3>
              <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #2a2a2a', color: '#888' }}>
                    <th style={{ textAlign: 'left', padding: '0.4rem' }}>Description</th>
                    <th style={{ textAlign: 'right', padding: '0.4rem' }}>Qty</th>
                    <th style={{ textAlign: 'right', padding: '0.4rem' }}>Unit</th>
                    <th style={{ textAlign: 'right', padding: '0.4rem' }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {bill.line_items.map((li) => (
                    <tr key={li.id} style={{ borderBottom: '1px solid #1a1a1a' }}>
                      <td style={{ padding: '0.4rem' }}>{li.description}</td>
                      <td style={{ textAlign: 'right', padding: '0.4rem' }}>{li.quantity}</td>
                      <td style={{ textAlign: 'right', padding: '0.4rem' }}>
                        {formatMoney(li.unit_price_cents)}
                      </td>
                      <td style={{ textAlign: 'right', padding: '0.4rem', fontWeight: 600 }}>
                        {formatMoney(li.total_cents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {/* Attach UI */}
          <h3 style={{ fontSize: 14, color: '#aaa', marginTop: '1.5rem', marginBottom: '0.5rem' }}>
            {bill.status === 'attached' || bill.status === 'paid' ? 'Attached job' : 'Attach to a job'}
          </h3>

          {bill.status === 'attached' || bill.status === 'paid' ? (
            <div
              style={{
                padding: '0.75rem',
                background: '#0d2f1f',
                border: '1px solid #1c5135',
                borderRadius: 4,
              }}
            >
              <div style={{ fontWeight: 600 }}>
                <code style={{ color: '#86c7a3' }}>
                  {bill.attached_job?.job_number ?? bill.job_id?.slice(0, 8)}
                </code>{' '}
                <span style={{ color: '#aaa', fontWeight: 400 }}>{bill.attached_job?.name}</span>
              </div>
              {bill.xero_invoice_id && (
                <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
                  Xero: <code>{bill.xero_invoice_id}</code> · status {bill.xero_status}
                </div>
              )}
            </div>
          ) : (
            <>
              {bill.suggested_job && (
                <div
                  style={{
                    padding: '0.75rem',
                    background: '#1a1a1a',
                    border: '1px solid #2a2a2a',
                    borderRadius: 4,
                    marginBottom: '0.75rem',
                  }}
                >
                  <div style={{ fontSize: 12, color: '#aaa', marginBottom: '0.5rem' }}>
                    Suggested ({Math.round((bill.suggested_match_score ?? 0) * 100)}% match):
                  </div>
                  <div style={{ marginBottom: '0.5rem' }}>
                    <code style={{ color: '#86c7a3' }}>{bill.suggested_job.job_number}</code>{' '}
                    <span style={{ color: '#aaa' }}>{bill.suggested_job.name}</span>
                  </div>
                  <button
                    onClick={() => attachToJob(bill.suggested_job!.id)}
                    disabled={busy}
                    style={{
                      padding: '0.4rem 0.75rem',
                      background: '#1c5135',
                      color: '#fff',
                      border: '1px solid #2da565',
                      borderRadius: 4,
                      cursor: busy ? 'wait' : 'pointer',
                      fontSize: 13,
                    }}
                  >
                    {busy ? 'Attaching…' : 'Attach to suggested job'}
                  </button>
                </div>
              )}

              <div style={{ marginBottom: '0.5rem' }}>
                <JobPicker onPick={(job) => attachToJob(job.id)} busy={busy} />
              </div>

              <button
                onClick={reocr}
                disabled={busy}
                style={{
                  padding: '0.4rem 0.75rem',
                  background: 'transparent',
                  color: '#aaa',
                  border: '1px solid #444',
                  borderRadius: 4,
                  cursor: busy ? 'wait' : 'pointer',
                  fontSize: 12,
                  marginTop: '0.75rem',
                }}
              >
                Re-run extraction
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function PersonalToggle({ bill, onChange }: { bill: Bill; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    await supabase.from('bills').update({ is_personal: !bill.is_personal }).eq('id', bill.id);
    setBusy(false);
    onChange();
  };
  return (
    <button
      onClick={toggle}
      disabled={busy}
      style={{
        padding: '0.3rem 0.75rem',
        background: bill.is_personal ? '#3d2818' : 'transparent',
        color: bill.is_personal ? '#f0c47a' : '#aaa',
        border: '1px solid ' + (bill.is_personal ? '#d28d4a' : '#333'),
        borderRadius: 3,
        fontSize: 12,
        cursor: busy ? 'wait' : 'pointer',
      }}
      title="Tag as a personal (non-business) expense — excluded from P&L, BAS, and tax set-aside."
    >
      {bill.is_personal ? '★ Personal' : 'Mark personal'}
    </button>
  );
}

function StatusBar({ bill }: { bill: Bill }) {
  const colour =
    bill.status === 'attached' || bill.status === 'paid'
      ? '#86c7a3'
      : bill.status === 'verified'
        ? '#d2c886'
        : '#888';
  return (
    <div style={{ fontSize: 13, color: '#888', marginBottom: '1.5rem' }}>
      <span style={{ color: colour, fontWeight: 600, textTransform: 'uppercase' }}>
        {bill.status}
      </span>{' '}
      · uploaded {new Date(bill.created_at).toLocaleString()} · {bill.original_filename}
    </div>
  );
}

function Field({
  label,
  value,
  mono,
  highlight,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
  highlight?: boolean;
}) {
  return (
    <div style={{ display: 'flex', padding: '0.4rem 0', borderBottom: '1px solid #1a1a1a' }}>
      <div style={{ fontSize: 12, color: '#888', width: 130 }}>{label}</div>
      <div
        style={{
          fontSize: highlight ? 16 : 13,
          fontWeight: highlight ? 600 : 400,
          fontFamily: mono ? 'ui-monospace, monospace' : undefined,
          color: value ? '#fff' : '#666',
        }}
      >
        {value ?? '—'}
      </div>
    </div>
  );
}
