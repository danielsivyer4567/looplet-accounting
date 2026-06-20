import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useBill, getBillFileUrl, type BillDetail as Bill } from '@/hooks/useBill';
import { JobPicker } from '@/components/JobPicker';
import { MoveToOrgButton } from '@/components/MoveToOrgButton';
import { AllocationSplitButton } from '@/components/AllocationSplitButton';
import { supabase } from '@/lib/supabase';
import { formatMoney } from '@/lib/money';
import { useOrg } from '@/hooks/useOrg';

// ---------------------------------------------------------------------------
// Draft shape for the edit form. Money fields are stored as dollar strings
// so the user types "$123.45" naturally; we convert to cents on save.
// ---------------------------------------------------------------------------
interface BillDraft {
  supplier_name_raw: string;
  supplier_abn: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string;
  total_inc_gst_dollars: string;
  gst_dollars: string;
  subtotal_ex_gst_dollars: string;
  job_reference_raw: string;
  notes: string;
}

function billToDraft(bill: Bill): BillDraft {
  const cents2str = (c: number | null) =>
    c != null ? (c / 100).toFixed(2) : '';
  return {
    supplier_name_raw: bill.supplier_name_raw ?? '',
    supplier_abn: bill.supplier_abn ?? '',
    invoice_number: bill.invoice_number ?? '',
    invoice_date: bill.invoice_date ?? '',
    due_date: bill.due_date ?? '',
    total_inc_gst_dollars: cents2str(bill.total_inc_gst_cents),
    gst_dollars: cents2str(bill.gst_cents),
    subtotal_ex_gst_dollars: cents2str(bill.subtotal_ex_gst_cents),
    job_reference_raw: bill.job_reference_raw ?? '',
    notes: bill.notes ?? '',
  };
}

/** Parse a dollar string to cents integer (null if blank / not a number). */
function parseDollarsToCents(s: string): number | null {
  const trimmed = s.trim().replace(/^\$/, '');
  if (trimmed === '') return null;
  const n = parseFloat(trimmed);
  if (isNaN(n)) return null;
  return Math.round(n * 100);
}

/**
 * AU GST auto-compute rules:
 * 1. total given, gst blank  → gst = round(total / 11)
 * 2. subtotal + gst given, total blank → total = subtotal + gst
 * Returns updated cents values (null = leave as-is / blank).
 */
function autoComputeGst(draft: BillDraft): {
  total: number | null;
  gst: number | null;
  subtotal: number | null;
} {
  const total = parseDollarsToCents(draft.total_inc_gst_dollars);
  const gst = parseDollarsToCents(draft.gst_dollars);
  const subtotal = parseDollarsToCents(draft.subtotal_ex_gst_dollars);

  let resolvedTotal = total;
  let resolvedGst = gst;
  let resolvedSubtotal = subtotal;

  // Rule 1: total given, gst blank
  if (total != null && gst == null) {
    resolvedGst = Math.round(total / 11);
    if (subtotal == null) {
      resolvedSubtotal = total - resolvedGst;
    }
  }

  // Rule 2: subtotal + gst given, total blank
  if (subtotal != null && gst != null && total == null) {
    resolvedTotal = subtotal + gst;
  }

  return { total: resolvedTotal, gst: resolvedGst, subtotal: resolvedSubtotal };
}

export function BillDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { bill, loading, error, refresh } = useBill(id);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Edit-mode state
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<BillDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

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

  const startEdit = () => {
    setDraft(billToDraft(bill));
    setEditing(true);
    setSavedFlash(false);
    setActionError(null);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft(null);
    setActionError(null);
  };

  const saveBill = async () => {
    if (!draft) return;
    setSaving(true);
    setActionError(null);
    try {
      const computed = autoComputeGst(draft);
      const payload: Record<string, unknown> = {
        supplier_name_raw: draft.supplier_name_raw.trim() || null,
        supplier_abn: draft.supplier_abn.trim() || null,
        invoice_number: draft.invoice_number.trim() || null,
        invoice_date: draft.invoice_date.trim() || null,
        due_date: draft.due_date.trim() || null,
        total_inc_gst_cents: computed.total,
        gst_cents: computed.gst,
        subtotal_ex_gst_cents: computed.subtotal,
        job_reference_raw: draft.job_reference_raw.trim() || null,
        notes: draft.notes.trim() || null,
      };

      const { error: saveErr } = await supabase
        .from('bills')
        .update(payload)
        .eq('id', bill.id);

      if (saveErr) {
        setActionError(saveErr.message);
        return;
      }

      await refresh();
      setEditing(false);
      setDraft(null);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);
    } finally {
      setSaving(false);
    }
  };

  const setField = <K extends keyof BillDraft>(key: K, value: BillDraft[K]) => {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

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
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {savedFlash && (
            <span style={{ fontSize: 12, color: '#86c7a3', fontWeight: 600 }}>✓ Saved</span>
          )}
          <PersonalToggle bill={bill} onChange={() => void refresh()} />
          {!editing && (
            <button onClick={startEdit} style={editBtnStyle}>
              ✎ Edit
            </button>
          )}
          <AllocationSplitButton
            resourceType="bill"
            resourceId={bill.id}
            hostOrgId={bill.organization_id}
            onSaved={() => void refresh()}
          />
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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <h3 style={{ fontSize: 14, color: '#aaa', margin: 0 }}>Extracted</h3>
            {editing && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => void saveBill()}
                  disabled={saving}
                  style={primaryBtnStyle}
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button
                  onClick={cancelEdit}
                  disabled={saving}
                  style={ghostBtnStyle}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>

          {editing && draft ? (
            <>
              <EditField label="Supplier">
                <input
                  value={draft.supplier_name_raw}
                  onChange={(e) => setField('supplier_name_raw', e.target.value)}
                  style={inpStyle}
                  placeholder="Supplier name"
                />
              </EditField>
              <EditField label="ABN">
                <input
                  value={draft.supplier_abn}
                  onChange={(e) => setField('supplier_abn', e.target.value)}
                  style={{ ...inpStyle, fontFamily: 'ui-monospace, monospace' }}
                  placeholder="XX XXX XXX XXX"
                />
              </EditField>
              <EditField label="Invoice #">
                <input
                  value={draft.invoice_number}
                  onChange={(e) => setField('invoice_number', e.target.value)}
                  style={{ ...inpStyle, fontFamily: 'ui-monospace, monospace' }}
                  placeholder="INV-001"
                />
              </EditField>
              <EditField label="Date">
                <input
                  type="date"
                  value={draft.invoice_date}
                  onChange={(e) => setField('invoice_date', e.target.value)}
                  style={inpStyle}
                />
              </EditField>
              <EditField label="Due">
                <input
                  type="date"
                  value={draft.due_date}
                  onChange={(e) => setField('due_date', e.target.value)}
                  style={inpStyle}
                />
              </EditField>
              <EditField label="Total inc GST" hint="Auto-computes GST = total ÷ 11 if GST left blank">
                <input
                  value={draft.total_inc_gst_dollars}
                  onChange={(e) => setField('total_inc_gst_dollars', e.target.value)}
                  style={{ ...inpStyle, fontWeight: 600 }}
                  placeholder="0.00"
                />
              </EditField>
              <EditField label="GST">
                <input
                  value={draft.gst_dollars}
                  onChange={(e) => setField('gst_dollars', e.target.value)}
                  style={inpStyle}
                  placeholder="0.00"
                />
              </EditField>
              <EditField label="Subtotal ex GST">
                <input
                  value={draft.subtotal_ex_gst_dollars}
                  onChange={(e) => setField('subtotal_ex_gst_dollars', e.target.value)}
                  style={inpStyle}
                  placeholder="0.00"
                />
              </EditField>
              <EditField label="Job ref">
                <input
                  value={draft.job_reference_raw}
                  onChange={(e) => setField('job_reference_raw', e.target.value)}
                  style={{ ...inpStyle, fontFamily: 'ui-monospace, monospace' }}
                  placeholder="e.g. JOB-042"
                />
              </EditField>
              <EditField label="Notes">
                <textarea
                  value={draft.notes}
                  onChange={(e) => setField('notes', e.target.value)}
                  style={{ ...inpStyle, height: 72, resize: 'vertical', lineHeight: '1.4' }}
                  placeholder="Internal notes…"
                />
              </EditField>
            </>
          ) : (
            <>
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
              {bill.notes && <Field label="Notes" value={bill.notes} />}
            </>
          )}

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

          {/* Effective per-org allocation (shown only when splits exist) */}
          <EffectiveAllocations billId={bill.id} />

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
              {bill.suggested_job && (() => {
                const suggestedJob = bill.suggested_job;
                return (
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
                    <code style={{ color: '#86c7a3' }}>{suggestedJob.job_number}</code>{' '}
                    <span style={{ color: '#aaa' }}>{suggestedJob.name}</span>
                  </div>
                  <button
                    onClick={() => attachToJob(suggestedJob.id)}
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
                );
              })()}

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

/**
 * Effective per-org allocation table — surfaces the split math so the user
 * can see, e.g., "Business A gets $66 of this $120 bill, Business B gets $54."
 * Renders nothing when there are no splits (only a single host row).
 */
function EffectiveAllocations({ billId }: { billId: string }) {
  const { organizations } = useOrg();
  const [rows, setRows] = useState<{
    organization_id: string;
    is_host: boolean;
    percentage: number;
    effective_total_inc_gst_cents: number;
    effective_gst_cents: number;
  }[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from('v_bill_effective_allocations')
        .select('organization_id, is_host, percentage, effective_total_inc_gst_cents, effective_gst_cents')
        .eq('bill_id', billId);
      if (cancelled) return;
      if (error || !data) {
        setRows([]);
        return;
      }
      setRows(
        data.map((r) => ({
          organization_id: r.organization_id as string,
          is_host: !!r.is_host,
          percentage: Number(r.percentage),
          effective_total_inc_gst_cents: Number(r.effective_total_inc_gst_cents) || 0,
          effective_gst_cents: Number(r.effective_gst_cents) || 0,
        })),
      );
    })();
    return () => { cancelled = true; };
  }, [billId]);

  if (!rows || rows.length <= 1) return null; // only host row → no splits → hide

  return (
    <>
      <h3 style={{ fontSize: 14, color: '#aaa', marginTop: '1.5rem', marginBottom: '0.5rem' }}>
        Effective allocation
      </h3>
      <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #2a2a2a', color: '#888' }}>
            <th style={{ textAlign: 'left', padding: '0.4rem' }}>Business</th>
            <th style={{ textAlign: 'right', padding: '0.4rem' }}>Share</th>
            <th style={{ textAlign: 'right', padding: '0.4rem' }}>Effective inc GST</th>
            <th style={{ textAlign: 'right', padding: '0.4rem' }}>Effective GST</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const orgName = organizations.find((o) => o.id === r.organization_id)?.name
              ?? r.organization_id.slice(0, 8);
            return (
              <tr key={r.organization_id} style={{ borderBottom: '1px solid #1a1a1a' }}>
                <td style={{ padding: '0.4rem' }}>
                  {r.is_host && <span style={{ color: '#86c7a3', marginRight: 4 }}>★</span>}
                  {orgName}
                  {r.is_host && <span style={{ color: '#666', fontSize: 11 }}> (host)</span>}
                </td>
                <td style={{ textAlign: 'right', padding: '0.4rem', fontFamily: 'ui-monospace, monospace' }}>
                  {r.percentage.toFixed(2)}%
                </td>
                <td style={{ textAlign: 'right', padding: '0.4rem', fontWeight: 600 }}>
                  {formatMoney(r.effective_total_inc_gst_cents)}
                </td>
                <td style={{ textAlign: 'right', padding: '0.4rem' }}>
                  {formatMoney(r.effective_gst_cents)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
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

// ---------------------------------------------------------------------------
// Shared style constants (mirrors SupplierDetail pattern)
// ---------------------------------------------------------------------------
const editBtnStyle: React.CSSProperties = {
  padding: '0.3rem 0.75rem',
  background: 'transparent',
  color: '#aaa',
  border: '1px solid #333',
  borderRadius: 3,
  fontSize: 12,
  cursor: 'pointer',
};

const primaryBtnStyle: React.CSSProperties = {
  padding: '0.4rem 1rem',
  background: '#1c4868',
  color: '#fff',
  border: '1px solid #5096d8',
  borderRadius: 4,
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
};

const ghostBtnStyle: React.CSSProperties = {
  padding: '0.4rem 1rem',
  background: 'transparent',
  color: '#aaa',
  border: '1px solid #333',
  borderRadius: 4,
  fontSize: 12,
  cursor: 'pointer',
};

const inpStyle: React.CSSProperties = {
  width: '100%',
  padding: '5px 8px',
  background: '#000',
  color: '#ddd',
  border: '1px solid #333',
  borderRadius: 3,
  fontSize: 12,
  boxSizing: 'border-box',
};

// ---------------------------------------------------------------------------
// EditField — label + arbitrary input child, same row layout as Field
// ---------------------------------------------------------------------------
function EditField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', padding: '0.35rem 0', borderBottom: '1px solid #1a1a1a', gap: 8 }}>
      <div style={{ fontSize: 12, color: '#888', width: 130, flexShrink: 0, paddingTop: 6 }}>
        {label}
        {hint && (
          <div style={{ fontSize: 10, color: '#555', marginTop: 2, lineHeight: 1.3 }}>{hint}</div>
        )}
      </div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Field — read-only display row
// ---------------------------------------------------------------------------
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
