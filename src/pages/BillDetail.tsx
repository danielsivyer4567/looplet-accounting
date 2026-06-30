import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useBill, getBillFileUrl, type BillDetail as Bill } from '@/hooks/useBill';
import { JobPicker } from '@/components/JobPicker';
import { MoveToOrgButton } from '@/components/MoveToOrgButton';
import { AllocationSplitButton } from '@/components/AllocationSplitButton';
import { supabase } from '@/lib/supabase';
import { formatMoney } from '@/lib/money';
import { useOrg } from '@/hooks/useOrg';
import { ConfidenceBadge } from '@/components/ConfidenceBadge';
import type {
  AutomationConfidence,
  DecisionSourceKind,
  DecisionKind,
  FeedbackSourceKind,
} from '@/lib/automationDecision';
import { recordOverride, recordFeedback } from '@/lib/automationDecision';
import {
  ChevronLeft,
  ChevronDown,
  Edit3,
  Save,
  X,
  RefreshCw,
  FileText,
  Briefcase,
  FolderOpen,
  AlertTriangle,
  Star,
  Check,
} from 'lucide-react';

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
  const cents2str = (c: number | null) => (c != null ? (c / 100).toFixed(2) : '');
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

function parseDollarsToCents(s: string): number | null {
  const trimmed = s.trim().replace(/^\$/, '');
  if (trimmed === '') return null;
  const n = parseFloat(trimmed);
  if (isNaN(n)) return null;
  return Math.round(n * 100);
}

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

  if (total != null && gst == null) {
    resolvedGst = Math.round(total / 11);
    if (subtotal == null) {
      resolvedSubtotal = total - resolvedGst;
    }
  }

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

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<BillDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [rerunQueued, setRerunQueued] = useState(false);
  const [decisionState, setDecisionState] = useState<{
    confidence: AutomationConfidence;
    decisionId: string;
    decisionKind: string;
    sourceKind: string;
    sourceId: string;
    suggestedTreatment: unknown;
    reasonCodes: string[];
  } | null>(null);

  useEffect(() => {
    if (bill) {
      void getBillFileUrl(bill.storage_key).then(setFileUrl);
    }
  }, [bill]);

  useEffect(() => {
    if (!bill) return;
    void supabase.rpc('get_bill_decisions', { p_bill_ids: [bill.id] }).then(({ data }) => {
      if (data && data.length > 0) {
        const d = (
          data as {
            confidence: AutomationConfidence;
            decision_id: string;
            decision_kind: string;
            suggested_treatment: unknown;
            bill_id: string;
            reason_codes?: string[];
          }[]
        )[0];
        if (d) {
          setDecisionState({
            confidence: d.confidence,
            decisionId: d.decision_id,
            decisionKind: d.decision_kind,
            sourceKind: 'bill_upload',
            sourceId: d.bill_id,
            suggestedTreatment: d.suggested_treatment,
            reasonCodes: (d as { reason_codes?: string[] }).reason_codes ?? [],
          });
        }
      }
    });
  }, [bill]);

  if (loading) {
    return (
      <section className="animated-fade-in">
        <p style={{ color: 'var(--text-muted)' }}>Loading bill details…</p>
      </section>
    );
  }
  if (error || !bill) {
    return (
      <section className="animated-fade-in" style={{ padding: '2rem 0', textAlign: 'center' }}>
        <AlertTriangle size={48} style={{ color: 'var(--accent-danger)', marginBottom: '1rem' }} />
        <h2>Bill not found</h2>
        <p style={{ color: 'var(--text-muted)' }}>{error ?? 'No bill with that ID.'}</p>
        <Link to="/bills" className="btn btn-secondary" style={{ marginTop: '1rem' }}>
          <ChevronLeft size={16} /> Back to bills
        </Link>
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
    const feedbackChanges: { sourceKind: FeedbackSourceKind; prev: unknown; next: unknown }[] = [];
    if (draft.supplier_name_raw.trim() !== (bill.supplier_name_raw ?? '')) {
      feedbackChanges.push({
        sourceKind: 'supplier',
        prev: bill.supplier_name_raw,
        next: draft.supplier_name_raw.trim(),
      });
    }
    if (draft.job_reference_raw.trim() !== (bill.job_reference_raw ?? '')) {
      feedbackChanges.push({
        sourceKind: 'job_tag',
        prev: bill.job_reference_raw,
        next: draft.job_reference_raw.trim(),
      });
    }
    const parsedGst = parseDollarsToCents(draft.gst_dollars);
    if (parsedGst !== null && parsedGst !== bill.gst_cents) {
      feedbackChanges.push({ sourceKind: 'gst_treatment', prev: bill.gst_cents, next: parsedGst });
    }
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

      const { error: saveErr } = await supabase.from('bills').update(payload).eq('id', bill.id);

      if (saveErr) {
        setActionError(saveErr.message);
        return;
      }

      await refresh();
      if (feedbackChanges.length > 0) {
        void Promise.all(
          feedbackChanges.map((c) =>
            recordFeedback({
              organizationId: bill.organization_id,
              sourceKind: c.sourceKind,
              sourceId: bill.id,
              previousValue: c.prev,
              newValue: c.next,
              correctionReason: 'user_edit',
              // eslint-disable-next-line @typescript-eslint/no-empty-function
            }).catch(() => {}),
          ),
        );
      }
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
    setRerunQueued(false);
    try {
      const { error } = await supabase.rpc('enqueue_automation_job', {
        p_org_id: bill.organization_id,
        p_job_kind: 'bill_extract',
        p_source_kind: 'bill',
        p_source_id: bill.id,
        p_priority: 5,
        p_payload: { force: true },
      });
      if (error) throw error;
      setRerunQueued(true);
      setTimeout(() => setRerunQueued(false), 3000);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="animated-fade-in">
      {/* Top back navigation */}
      <Link
        to="/bills"
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
        <span>Back to bills</span>
      </Link>

      {/* Header controls bar */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '0.5rem',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <FileText size={24} style={{ color: 'var(--accent-primary)' }} />
          {bill.supplier_name_raw ?? (
            <span style={{ color: 'var(--text-muted)' }}>Bill {bill.id.slice(0, 8)}</span>
          )}
        </h1>

        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {savedFlash && (
            <span
              className="badge badge-success"
              style={{ padding: '0.4rem 0.75rem', textTransform: 'none' }}
            >
              ✓ Saved
            </span>
          )}
          {rerunQueued && (
            <span
              className="badge badge-info"
              style={{ padding: '0.4rem 0.75rem', textTransform: 'none' }}
            >
              ✓ Queued for re-extraction
            </span>
          )}

          {decisionState && <ConfidenceBadge confidence={decisionState.confidence} />}

          {decisionState?.confidence === 'quick_confirm' && (
            <button
              className="btn btn-primary"
              style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', lineHeight: 1 }}
              onClick={async () => {
                try {
                  const orgId = bill.organization_id;
                  await recordOverride({
                    originalDecisionId: decisionState.decisionId,
                    organizationId: orgId,
                    sourceKind: decisionState.sourceKind as DecisionSourceKind,
                    sourceId: decisionState.sourceId,
                    decisionKind: decisionState.decisionKind as DecisionKind,
                    suggestedTreatment: decisionState.suggestedTreatment,
                    confidence: 'auto_post',
                    overrideReason: 'quick_confirm',
                  });
                  setDecisionState({
                    ...decisionState,
                    confidence: 'auto_post',
                  });
                  setSavedFlash(true);
                  setTimeout(() => setSavedFlash(false), 2000);
                } catch {
                  setActionError('Failed to confirm');
                }
              }}
            >
              <Check size={14} /> Quick Confirm
            </button>
          )}

          <PersonalToggle bill={bill} onChange={() => void refresh()} />

          {!editing && (
            <button onClick={startEdit} className="btn btn-secondary">
              <Edit3 size={14} />
              <span>Edit Details</span>
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
            onMoved={() => {
              window.location.href = '/bills';
            }}
          />
        </div>
      </div>

      {decisionState && decisionState.reasonCodes.length > 0 && (
        <DecisionReasonPanel
          confidence={decisionState.confidence}
          reasonCodes={decisionState.reasonCodes}
        />
      )}

      <StatusBar bill={bill} />

      {actionError && (
        <div
          className="badge badge-danger"
          style={{
            display: 'block',
            padding: '0.75rem',
            marginBottom: '1.5rem',
            textTransform: 'none',
          }}
        >
          {actionError}
        </div>
      )}

      {/* Two Column Split View */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(450px, 1fr))',
          gap: '1.5rem',
          alignItems: 'start',
        }}
      >
        {/* Left Side: Document Preview Pane */}
        <div>
          <h3
            style={{
              fontSize: '0.875rem',
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: '0.5rem',
            }}
          >
            Original Document
          </h3>
          <div
            className="card"
            style={{
              padding: '0.5rem',
              height: '75vh',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {fileUrl ? (
              bill.mime_type === 'application/pdf' ? (
                <iframe
                  src={fileUrl}
                  title={bill.original_filename}
                  style={{
                    width: '100%',
                    height: '100%',
                    border: 'none',
                    borderRadius: 'var(--radius-sm)',
                  }}
                />
              ) : bill.mime_type.startsWith('image/') ? (
                <div
                  style={{
                    height: '100%',
                    overflow: 'auto',
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                  }}
                >
                  <a href={fileUrl} target="_blank" rel="noreferrer" style={{ width: '100%' }}>
                    <img
                      src={fileUrl}
                      alt={bill.original_filename}
                      style={{
                        width: '100%',
                        height: 'auto',
                        display: 'block',
                        borderRadius: 'var(--radius-sm)',
                      }}
                    />
                  </a>
                </div>
              ) : (
                <p style={{ color: 'var(--text-muted)', padding: '1rem', textAlign: 'center' }}>
                  Preview not supported for {bill.mime_type}.{' '}
                  <a href={fileUrl} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>
                    Download file
                  </a>
                </p>
              )
            ) : (
              <p style={{ color: 'var(--text-muted)', padding: '1.5rem', textAlign: 'center' }}>
                Loading preview…
              </p>
            )}
          </div>
        </div>

        {/* Right Side: Data Fields & Actions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '0.5rem',
              }}
            >
              <h3
                style={{
                  fontSize: '0.875rem',
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  margin: 0,
                }}
              >
                Extracted Data
              </h3>
              {editing && (
                <div style={{ display: 'flex', gap: '0.35rem' }}>
                  <button
                    onClick={() => void saveBill()}
                    disabled={saving}
                    className="btn btn-primary"
                    style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem' }}
                  >
                    <Save size={12} />
                    <span>{saving ? 'Saving…' : 'Save'}</span>
                  </button>
                  <button
                    onClick={cancelEdit}
                    disabled={saving}
                    className="btn btn-secondary"
                    style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem' }}
                  >
                    <X size={12} />
                    <span>Cancel</span>
                  </button>
                </div>
              )}
            </div>

            <div className="card" style={{ padding: '1.25rem 1.5rem' }}>
              {editing && draft ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <EditField label="Supplier">
                    <input
                      value={draft.supplier_name_raw}
                      onChange={(e) => setField('supplier_name_raw', e.target.value)}
                      className="form-input"
                      placeholder="Supplier name"
                    />
                  </EditField>
                  <EditField label="ABN">
                    <input
                      value={draft.supplier_abn}
                      onChange={(e) => setField('supplier_abn', e.target.value)}
                      className="form-input"
                      style={{ fontFamily: 'ui-monospace, monospace' }}
                      placeholder="XX XXX XXX XXX"
                    />
                  </EditField>
                  <EditField label="Invoice #">
                    <input
                      value={draft.invoice_number}
                      onChange={(e) => setField('invoice_number', e.target.value)}
                      className="form-input"
                      style={{ fontFamily: 'ui-monospace, monospace' }}
                      placeholder="INV-001"
                    />
                  </EditField>
                  <EditField label="Invoice Date">
                    <input
                      type="date"
                      value={draft.invoice_date}
                      onChange={(e) => setField('invoice_date', e.target.value)}
                      className="form-input"
                    />
                  </EditField>
                  <EditField label="Due Date">
                    <input
                      type="date"
                      value={draft.due_date}
                      onChange={(e) => setField('due_date', e.target.value)}
                      className="form-input"
                    />
                  </EditField>
                  <EditField
                    label="Total inc GST"
                    hint="Auto-computes GST = total ÷ 11 if GST left blank"
                  >
                    <input
                      value={draft.total_inc_gst_dollars}
                      onChange={(e) => setField('total_inc_gst_dollars', e.target.value)}
                      className="form-input"
                      style={{ fontWeight: 600 }}
                      placeholder="0.00"
                    />
                  </EditField>
                  <EditField label="GST Share">
                    <input
                      value={draft.gst_dollars}
                      onChange={(e) => setField('gst_dollars', e.target.value)}
                      className="form-input"
                      placeholder="0.00"
                    />
                  </EditField>
                  <EditField label="Subtotal ex GST">
                    <input
                      value={draft.subtotal_ex_gst_dollars}
                      onChange={(e) => setField('subtotal_ex_gst_dollars', e.target.value)}
                      className="form-input"
                      placeholder="0.00"
                    />
                  </EditField>
                  <EditField label="Job Reference">
                    <input
                      value={draft.job_reference_raw}
                      onChange={(e) => setField('job_reference_raw', e.target.value)}
                      className="form-input"
                      style={{ fontFamily: 'ui-monospace, monospace' }}
                      placeholder="e.g. JOB-042"
                    />
                  </EditField>
                  <EditField label="Internal Notes">
                    <textarea
                      value={draft.notes}
                      onChange={(e) => setField('notes', e.target.value)}
                      className="form-textarea"
                      style={{ minHeight: '60px' }}
                      placeholder="Internal notes…"
                    />
                  </EditField>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <Field label="Supplier" value={bill.supplier_name_raw} />
                  <Field label="ABN" value={bill.supplier_abn} mono />
                  <Field label="Invoice #" value={bill.invoice_number} mono />
                  <Field label="Date" value={bill.invoice_date} />
                  <Field label="Due" value={bill.due_date} />
                  <Field
                    label="Total inc GST"
                    value={
                      bill.total_inc_gst_cents != null
                        ? formatMoney(bill.total_inc_gst_cents)
                        : null
                    }
                    highlight
                  />
                  <Field
                    label="GST"
                    value={bill.gst_cents != null ? formatMoney(bill.gst_cents) : null}
                  />
                  <Field
                    label="Subtotal ex GST"
                    value={
                      bill.subtotal_ex_gst_cents != null
                        ? formatMoney(bill.subtotal_ex_gst_cents)
                        : null
                    }
                  />
                  <Field label="Job Reference" value={bill.job_reference_raw} mono />
                  {bill.notes && <Field label="Notes" value={bill.notes} />}
                  <Field
                    label="OCR Intake Info"
                    value={
                      bill.ocr_provider
                        ? `${bill.raw_extracted?._extraction_method ?? '?'} via ${bill.ocr_provider} (confidence: ${Math.round((bill.ocr_confidence ?? 0) * 100)}%)`
                        : null
                    }
                  />
                </div>
              )}
            </div>
          </div>

          <ExtractionHistory billId={bill.id} />

          {/* Line items section */}
          {bill.line_items.length > 0 && (
            <div>
              <h3
                style={{
                  fontSize: '0.875rem',
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  marginBottom: '0.5rem',
                }}
              >
                Line Items
              </h3>
              <div className="table-premium-container">
                <table className="table-premium">
                  <thead>
                    <tr>
                      <th>Description</th>
                      <th style={{ textAlign: 'right', width: '60px' }}>Qty</th>
                      <th style={{ textAlign: 'right', width: '100px' }}>Unit</th>
                      <th style={{ textAlign: 'right', width: '100px' }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bill.line_items.map((li) => (
                      <tr key={li.id}>
                        <td>{li.description}</td>
                        <td style={{ textAlign: 'right' }}>{li.quantity}</td>
                        <td style={{ textAlign: 'right' }}>{formatMoney(li.unit_price_cents)}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>
                          {formatMoney(li.total_cents)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Splits allocations */}
          <EffectiveAllocations billId={bill.id} />

          {/* Job attachment panel */}
          <div>
            <h3
              style={{
                fontSize: '0.875rem',
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                marginBottom: '0.5rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.25rem',
              }}
            >
              <Briefcase size={14} />
              {bill.status === 'attached' || bill.status === 'paid'
                ? 'Attached Job'
                : 'Attach to a Job'}
            </h3>

            {bill.status === 'attached' || bill.status === 'paid' ? (
              <div
                className="card"
                style={{
                  borderLeft: '4px solid var(--accent-success)',
                  padding: '1rem 1.25rem',
                }}
              >
                <div style={{ fontWeight: 700, color: 'var(--text-title)' }}>
                  <code
                    style={{
                      color: 'var(--text-success)',
                      fontSize: '0.875rem',
                      marginRight: '0.5rem',
                    }}
                  >
                    {bill.attached_job?.job_number ?? bill.job_id?.slice(0, 8)}
                  </code>{' '}
                  <span>{bill.attached_job?.name}</span>
                </div>
                {bill.xero_invoice_id && (
                  <div
                    style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}
                  >
                    Xero ID: <code>{bill.xero_invoice_id}</code> · Sync: {bill.xero_status}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {bill.suggested_job &&
                  (() => {
                    const suggestedJob = bill.suggested_job;
                    return (
                      <div
                        className="card"
                        style={{
                          padding: '1rem',
                          borderLeft: '4px solid var(--accent-primary)',
                        }}
                      >
                        <div
                          style={{
                            fontSize: '0.75rem',
                            color: 'var(--text-muted)',
                            fontWeight: 600,
                            textTransform: 'uppercase',
                            marginBottom: '0.35rem',
                          }}
                        >
                          Suggested Match ({Math.round((bill.suggested_match_score ?? 0) * 100)}%
                          confidence):
                        </div>
                        <div style={{ marginBottom: '0.75rem', fontWeight: 600 }}>
                          <code style={{ color: 'var(--accent-primary)', marginRight: '0.5rem' }}>
                            {suggestedJob.job_number}
                          </code>
                          <span style={{ color: 'var(--text-title)' }}>{suggestedJob.name}</span>
                        </div>
                        <button
                          onClick={() => attachToJob(suggestedJob.id)}
                          disabled={busy}
                          className="btn btn-primary"
                          style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem' }}
                        >
                          Attach to suggested job
                        </button>
                      </div>
                    );
                  })()}

                <div className="card" style={{ padding: '1rem' }}>
                  <div
                    style={{
                      fontSize: '0.75rem',
                      color: 'var(--text-muted)',
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      marginBottom: '0.5rem',
                    }}
                  >
                    Search Job List
                  </div>
                  <JobPicker onPick={(job) => attachToJob(job.id)} busy={busy} />
                </div>

                <button
                  onClick={reocr}
                  disabled={busy}
                  className="btn btn-secondary"
                  style={{ alignSelf: 'flex-start' }}
                >
                  <RefreshCw size={12} />
                  <span>Rerun extraction</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function EffectiveAllocations({ billId }: { billId: string }) {
  const { organizations } = useOrg();
  const [rows, setRows] = useState<
    | {
        organization_id: string;
        is_host: boolean;
        percentage: number;
        effective_total_inc_gst_cents: number;
        effective_gst_cents: number;
      }[]
    | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from('v_bill_effective_allocations')
        .select(
          'organization_id, is_host, percentage, effective_total_inc_gst_cents, effective_gst_cents',
        )
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
    return () => {
      cancelled = true;
    };
  }, [billId]);

  if (!rows || rows.length <= 1) return null;

  return (
    <div>
      <h3
        style={{
          fontSize: '0.875rem',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginBottom: '0.5rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.25rem',
        }}
      >
        <FolderOpen size={14} />
        Effective allocations
      </h3>
      <div className="table-premium-container">
        <table className="table-premium">
          <thead>
            <tr>
              <th>Business</th>
              <th style={{ textAlign: 'right', width: '80px' }}>Share</th>
              <th style={{ textAlign: 'right' }}>Effective inc GST</th>
              <th style={{ textAlign: 'right' }}>Effective GST</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const orgName =
                organizations.find((o) => o.id === r.organization_id)?.name ??
                r.organization_id.slice(0, 8);
              return (
                <tr key={r.organization_id}>
                  <td style={{ fontWeight: 600, color: 'var(--text-title)' }}>
                    {r.is_host && (
                      <span style={{ color: 'var(--accent-success)', marginRight: 4 }}>★</span>
                    )}
                    {orgName}
                    {r.is_host && (
                      <span
                        style={{
                          color: 'var(--text-muted)',
                          fontSize: '0.75rem',
                          fontWeight: 'normal',
                        }}
                      >
                        {' '}
                        (host)
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', fontFamily: 'ui-monospace, monospace' }}>
                    {r.percentage.toFixed(2)}%
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>
                    {formatMoney(r.effective_total_inc_gst_cents)}
                  </td>
                  <td style={{ textAlign: 'right' }}>{formatMoney(r.effective_gst_cents)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
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
      className="btn"
      style={{
        background: bill.is_personal ? 'var(--bg-warning-subtle)' : 'transparent',
        color: bill.is_personal ? 'var(--text-warning)' : 'var(--text-muted)',
        border:
          '1px solid ' + (bill.is_personal ? 'var(--accent-warning)' : 'var(--border-subtle)'),
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.25rem',
      }}
      title="Tag as a personal (non-business) expense — excluded from P&L, BAS, and tax set-aside."
    >
      <Star size={14} fill={bill.is_personal ? 'currentColor' : 'none'} />
      <span>{bill.is_personal ? 'Personal Expense' : 'Mark Personal'}</span>
    </button>
  );
}

function StatusBar({ bill }: { bill: Bill }) {
  let badgeClass = 'badge-neutral';
  if (bill.status === 'attached') badgeClass = 'badge-success';
  else if (bill.status === 'paid') badgeClass = 'badge-info';
  else if (bill.status === 'verified') badgeClass = 'badge-warning';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        fontSize: '0.825rem',
        color: 'var(--text-muted)',
        marginBottom: '1.5rem',
        flexWrap: 'wrap',
      }}
    >
      <span className={`badge ${badgeClass}`}>{bill.status}</span>
      <span>·</span>
      <span>Uploaded: {new Date(bill.created_at).toLocaleString('en-AU')}</span>
      <span>·</span>
      <span>
        File: <code>{bill.original_filename}</code>
      </span>
    </div>
  );
}

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
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        padding: '0.35rem 0',
        borderBottom: '1px solid var(--border-subtle)',
        gap: 12,
      }}
    >
      <div style={{ width: 130, flexShrink: 0, paddingTop: 6 }}>
        <span className="form-label" style={{ fontSize: '0.725rem' }}>
          {label}
        </span>
        {hint && (
          <div
            style={{
              fontSize: '0.675rem',
              color: 'var(--text-muted)',
              marginTop: 2,
              lineHeight: 1.3,
            }}
          >
            {hint}
          </div>
        )}
      </div>
      <div style={{ flex: 1 }}>{children}</div>
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
    <div
      style={{
        display: 'flex',
        padding: '0.5rem 0',
        borderBottom: '1px solid var(--border-subtle)',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
      }}
    >
      <span style={{ fontSize: '0.825rem', color: 'var(--text-muted)', fontWeight: 500 }}>
        {label}
      </span>
      <span
        style={{
          fontSize: '0.875rem',
          fontWeight: highlight || mono ? 700 : 500,
          color: highlight ? 'var(--text-warning)' : 'var(--text-title)',
          fontFamily: mono ? 'ui-monospace, monospace' : 'inherit',
        }}
      >
        {value ?? '—'}
      </span>
    </div>
  );
}

interface ExtractionVersion {
  id: string;
  provider: string;
  method: string;
  confidence: number | null;
  created_at: string;
}

function ExtractionHistory({ billId }: { billId: string }) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<ExtractionVersion[] | null>(null);

  useEffect(() => {
    if (!open || versions !== null) return;
    void supabase
      .from('document_extraction_versions')
      .select('id, provider, method, confidence, created_at')
      .eq('bill_id', billId)
      .order('created_at', { ascending: false })
      .then(({ data }) => setVersions((data ?? []) as ExtractionVersion[]));
  }, [open, billId, versions]);

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.35rem',
          fontSize: '0.875rem',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          fontWeight: 600,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
          marginBottom: open ? '0.5rem' : 0,
        }}
      >
        <ChevronDown
          size={14}
          style={{ transition: 'transform 0.15s', transform: open ? 'rotate(180deg)' : 'none' }}
        />
        Extraction History
      </button>
      {open && (
        <div className="card" style={{ padding: '0.75rem 1rem' }}>
          {versions === null ? (
            <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: '0.825rem' }}>Loading…</p>
          ) : versions.length === 0 ? (
            <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: '0.825rem' }}>
              No extraction history recorded yet.
            </p>
          ) : (
            <div className="table-premium-container">
              <table className="table-premium">
                <thead>
                  <tr>
                    <th>Method</th>
                    <th>Provider</th>
                    <th style={{ textAlign: 'right' }}>Confidence</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {versions.map((v) => (
                    <tr key={v.id}>
                      <td>
                        <code>{v.method}</code>
                      </td>
                      <td>{v.provider}</td>
                      <td style={{ textAlign: 'right', fontFamily: 'ui-monospace, monospace' }}>
                        {v.confidence != null ? `${Math.round(v.confidence * 100)}%` : '—'}
                      </td>
                      <td style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                        {new Date(v.created_at).toLocaleString('en-AU')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const REASON_CODE_LABELS: Record<string, string> = {
  ocr_text_extraction: 'Extracted from digital PDF text',
  ocr_vision_extraction: 'Extracted via vision OCR',
  cache_hit: 'Matched an identical document seen before',
  gst_derived: 'GST estimated at 1/11 (not shown on document)',
  job_matched_exact: 'Exact job reference match found',
  job_matched_fuzzy: 'Fuzzy job match suggested',
  probable_non_invoice: 'Document may not be an invoice',
};

const CONFIDENCE_EXPLAIN: Record<AutomationConfidence, string> = {
  auto_post: 'Posted automatically',
  quick_confirm: 'Looplet is confident — one click to confirm',
  review_needed: 'Check the details before approving',
  advisor_required: "Needs your accountant's input",
  blocked_external: 'Waiting on external information',
};

function DecisionReasonPanel({
  confidence,
  reasonCodes,
}: {
  confidence: AutomationConfidence;
  reasonCodes: string[];
}) {
  if (reasonCodes.length === 0) return null;
  return (
    <div
      style={{
        background: 'var(--bg-panel)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        padding: '0.75rem 1rem',
        fontSize: '0.8rem',
        color: 'var(--text-muted)',
        marginTop: '0.75rem',
      }}
    >
      <div style={{ fontWeight: 600, color: 'var(--text-body)', marginBottom: '0.35rem' }}>
        How Looplet worked this out
      </div>
      <div style={{ marginBottom: '0.25rem' }}>{CONFIDENCE_EXPLAIN[confidence]}</div>
      <ul style={{ margin: '0.35rem 0 0 1rem', padding: 0, lineHeight: 1.6 }}>
        {reasonCodes.map((code) => (
          <li key={code}>{REASON_CODE_LABELS[code] ?? code}</li>
        ))}
      </ul>
    </div>
  );
}
