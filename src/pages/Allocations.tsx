import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useOrg } from '@/hooks/useOrg';
import { useAllocationQueue, type AllocationQueueRow } from '@/hooks/useAllocationQueue';
import { useJobs } from '@/hooks/useJobs';
import type { JobListRow } from '@/hooks/useJobs';
import { supabase } from '@/lib/supabase';
import { formatMoney } from '@/lib/money';
import { SkeletonLine } from '@/components/Skeleton';
import { GitPullRequest, Eye, EyeOff, CheckCircle2, ChevronRight, X } from 'lucide-react';

// Fetch storage fields from bills table on-demand (not in v_allocation_queue)
function BillPreviewPane({ bill, onClose }: { bill: AllocationQueueRow; onClose: () => void }) {
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSignedUrl(null);
    setUrlError(null);
    setMimeType(null);

    // Fetch storage_key + mime_type from bills table (not exposed in the queue view)
    supabase
      .from('bills')
      .select('storage_key, mime_type')
      .eq('id', bill.bill_id)
      .single()
      .then(({ data, error }) => {
        if (cancelled || error || !data) return;
        const { storage_key, mime_type } = data as { storage_key: string; mime_type: string };
        setMimeType(mime_type);
        supabase.storage
          .from('bills')
          .createSignedUrl(storage_key, 300)
          .then(({ data: urlData, error: urlErr }) => {
            if (cancelled) return;
            if (urlErr || !urlData?.signedUrl) {
              setUrlError(urlErr?.message ?? 'Could not generate preview URL');
            } else {
              setSignedUrl(urlData.signedUrl);
            }
          });
      });

    return () => {
      cancelled = true;
    };
  }, [bill.bill_id]);

  const isPdf = mimeType === 'application/pdf';

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        width: '400px',
        maxWidth: '85vw',
        height: '100vh',
        background: 'var(--bg-panel)',
        borderLeft: '1px solid var(--border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 100,
        boxShadow: 'var(--shadow-lg)',
        animation: 'fadeIn 0.3s ease',
      }}
      role="complementary"
      aria-label="Bill PDF preview"
    >
      {/* Header */}
      <div
        style={{
          padding: '1rem',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}
      >
        <div style={{ minWidth: 0, flex: 1, marginRight: '0.5rem' }}>
          <div
            style={{
              fontWeight: 700,
              fontSize: '0.875rem',
              color: 'var(--text-title)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {bill.supplier_name_raw ?? 'Preview'}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: '0.15rem' }}>
            {bill.invoice_date ?? ''}
            {bill.invoice_number ? ` · #${bill.invoice_number}` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexShrink: 0 }}>
          {signedUrl && (
            <a
              href={`/bills/${bill.bill_id}`}
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--accent-primary)', fontSize: '0.75rem', fontWeight: 600 }}
            >
              Open page &rarr;
            </a>
          )}
          <button
            onClick={onClose}
            aria-label="Close preview"
            className="btn btn-ghost"
            style={{ padding: '0.2rem 0.4rem' }}
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', background: '#e2e8f0' }}>
        {urlError ? (
          <div
            style={{
              padding: 20,
              color: 'var(--text-danger)',
              fontSize: '0.875rem',
              background: 'var(--bg-panel)',
              height: '100%',
            }}
          >
            <p style={{ margin: 0, fontWeight: 'bold' }}>Could not load preview:</p>
            <p style={{ margin: '4px 0 0', color: 'var(--text-muted)' }}>{urlError}</p>
            <p style={{ marginTop: 12 }}>
              <Link
                to={`/bills/${bill.bill_id}`}
                style={{ color: 'var(--accent-primary)', fontWeight: 600 }}
              >
                Open bill detail page instead &rarr;
              </Link>
            </p>
          </div>
        ) : !signedUrl ? (
          <div
            style={{
              padding: 20,
              color: 'var(--text-muted)',
              fontSize: '0.875rem',
              background: 'var(--bg-panel)',
              height: '100%',
            }}
          >
            Generating preview…
          </div>
        ) : isPdf ? (
          <iframe
            src={signedUrl}
            title={`Bill preview — ${bill.supplier_name_raw ?? bill.bill_id}`}
            style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
          />
        ) : (
          <div style={{ height: '100%', overflowY: 'auto', padding: 12 }}>
            <img
              src={signedUrl}
              alt={`Bill from ${bill.supplier_name_raw ?? 'supplier'}`}
              style={{
                width: '100%',
                borderRadius: 'var(--radius-sm)',
                boxShadow: 'var(--shadow-sm)',
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export function AllocationsPage() {
  const { currentOrg } = useOrg();
  const { queue, loading, error, refresh } = useAllocationQueue();
  const { jobs } = useJobs();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [previewBillId, setPreviewBillId] = useState<string | null>(null);

  const previewBill = previewBillId
    ? (queue.find((b) => b.bill_id === previewBillId) ?? null)
    : null;

  if (!currentOrg) {
    return (
      <section className="animated-fade-in">
        <h1>Allocations</h1>
        <p style={{ color: 'var(--text-muted)' }}>
          Pick an organisation to see the allocation queue.
        </p>
      </section>
    );
  }

  if (loading) {
    return (
      <section className="animated-fade-in">
        <h1>Allocations</h1>
        <div
          style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '1rem' }}
        >
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="card"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
              }}
            >
              <SkeletonLine width="30%" height={16} />
              <SkeletonLine width="50%" height={12} />
              <SkeletonLine width="20%" height={12} />
            </div>
          ))}
        </div>
      </section>
    );
  }
  if (error) {
    return (
      <div
        className="badge badge-danger"
        style={{ display: 'block', padding: '0.75rem', textTransform: 'none' }}
      >
        Failed to load: {error}
      </div>
    );
  }

  if (queue.length === 0) {
    return (
      <section className="animated-fade-in" style={{ padding: '2rem 0' }}>
        <h1 style={{ marginBottom: '0.5rem' }}>Allocations</h1>
        <div
          style={{
            padding: '2.5rem 2rem',
            background: 'var(--bg-success-subtle)',
            border: '1px dashed var(--accent-success)',
            borderRadius: 'var(--radius-lg)',
            color: 'var(--text-success)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '1rem',
            maxWidth: '650px',
            margin: '2rem auto',
            textAlign: 'center',
          }}
        >
          <CheckCircle2 size={48} />
          <div>
            <h3
              style={{ color: 'var(--text-success)', margin: '0 0 0.25rem 0', fontSize: '1.15rem' }}
            >
              Allocation Inbox Zero!
            </h3>
            <p style={{ margin: 0, fontSize: '0.875rem', opacity: 0.85 }}>
              Every single bill has been attached to a job.
            </p>
          </div>
          <p
            style={{
              color: 'var(--text-muted)',
              fontSize: '0.775rem',
              lineHeight: '1.5',
              margin: '0.5rem 0 0 0',
              maxWidth: '480px',
            }}
          >
            Bills land here when they are processed but couldn't auto-attach. This happens when no
            exact job reference match is found, extraction confidence is low, or no job details were
            parsed.
          </p>
        </div>
      </section>
    );
  }

  const confirmAttach = async (bill: AllocationQueueRow, jobId: string) => {
    setBusyId(bill.bill_id);
    setActionError(null);
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) {
      setActionError('Not signed in');
      setBusyId(null);
      return;
    }
    try {
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/bills-attach`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ bill_id: bill.bill_id, job_id: jobId }),
      });
      if (!res.ok) {
        const body = await res.text();
        setActionError(`Attach failed: ${body}`);
        return;
      }
      await refresh();
    } finally {
      setBusyId(null);
    }
  };

  const rejectSuggestion = async (billId: string) => {
    setBusyId(billId);
    await supabase
      .from('bills')
      .update({ suggested_job_id: null, suggested_match_score: null })
      .eq('id', billId);
    await refresh();
    setBusyId(null);
  };

  const billsWithSuggestion = queue.filter((b) => b.suggested_job_id != null);

  const bulkAttachAllSuggestions = async () => {
    if (billsWithSuggestion.length === 0) return;
    if (
      !confirm(
        `Attach ${billsWithSuggestion.length} bill${billsWithSuggestion.length === 1 ? '' : 's'} to their suggested job? You can detach individually if any are wrong.`,
      )
    )
      return;
    setBulkBusy(true);
    setBulkMsg(`Attaching 0 / ${billsWithSuggestion.length}…`);
    let n = 0;
    for (const b of billsWithSuggestion) {
      if (!b.suggested_job_id) continue;
      await supabase
        .from('bills')
        .update({
          job_id: b.suggested_job_id,
          suggested_job_id: null,
          suggested_match_score: null,
          status: 'attached',
        })
        .eq('id', b.bill_id);
      n += 1;
      setBulkMsg(`Attaching ${n} / ${billsWithSuggestion.length}…`);
    }
    setBulkMsg(`✓ Attached ${n} bills.`);
    setBulkBusy(false);
    await refresh();
  };

  const quickAssignToJob = async (billId: string, jobId: string) => {
    setBusyId(billId);
    await supabase
      .from('bills')
      .update({
        job_id: jobId,
        suggested_job_id: null,
        suggested_match_score: null,
        status: 'attached',
      })
      .eq('id', billId);
    await refresh();
    setBusyId(null);
  };

  const previewOpen = previewBill !== null;

  return (
    <>
      <section
        style={{
          marginRight: previewOpen ? '420px' : 0,
          transition: 'margin-right 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
        className="animated-fade-in"
      >
        <div style={{ marginBottom: '1.5rem' }}>
          <h1
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              marginBottom: '0.25rem',
            }}
          >
            <GitPullRequest size={24} style={{ color: 'var(--accent-primary)' }} />
            Allocations
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', margin: 0 }}>
            {queue.length} bill{queue.length === 1 ? '' : 's'} waiting to be allocated to jobs.
          </p>
        </div>

        {actionError && (
          <div
            className="badge badge-danger"
            style={{
              display: 'block',
              padding: '0.75rem',
              marginBottom: '1rem',
              textTransform: 'none',
            }}
          >
            {actionError}
          </div>
        )}

        {billsWithSuggestion.length > 0 && (
          <div
            style={{
              marginTop: '1rem',
              marginBottom: '1.5rem',
              padding: '1rem 1.25rem',
              background: 'var(--bg-success-subtle)',
              border: '1px solid rgba(16, 185, 129, 0.2)',
              borderRadius: 'var(--radius-md)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '0.75rem',
            }}
          >
            <div style={{ color: 'var(--text-success)', fontSize: '0.875rem', fontWeight: 600 }}>
              {billsWithSuggestion.length} bills have suggested matches.
            </div>
            <button
              onClick={bulkAttachAllSuggestions}
              disabled={bulkBusy}
              className="btn btn-primary"
              style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem' }}
            >
              {bulkBusy ? 'Attaching…' : `✓ Bulk-attach all ${billsWithSuggestion.length}`}
            </button>
            {bulkMsg && (
              <div
                style={{
                  color: 'var(--text-muted)',
                  fontSize: '0.75rem',
                  width: '100%',
                  marginTop: '0.25rem',
                }}
              >
                {bulkMsg}
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {queue.map((b) => (
            <BillCard
              key={b.bill_id}
              bill={b}
              busy={busyId === b.bill_id}
              jobs={jobs}
              isPreviewing={previewBillId === b.bill_id}
              onConfirm={(jobId) => confirmAttach(b, jobId)}
              onReject={() => rejectSuggestion(b.bill_id)}
              onQuickAssign={(jobId) => quickAssignToJob(b.bill_id, jobId)}
              onPreview={() => setPreviewBillId(previewBillId === b.bill_id ? null : b.bill_id)}
            />
          ))}
        </div>
      </section>

      {/* Slide-out Preview Panel */}
      {previewBill && <BillPreviewPane bill={previewBill} onClose={() => setPreviewBillId(null)} />}
    </>
  );
}

function BillCard({
  bill,
  busy,
  jobs,
  isPreviewing,
  onConfirm,
  onReject,
  onQuickAssign,
  onPreview,
}: {
  bill: AllocationQueueRow;
  busy: boolean;
  jobs: JobListRow[];
  isPreviewing: boolean;
  onConfirm: (jobId: string) => void;
  onReject: () => void;
  onQuickAssign: (jobId: string) => void;
  onPreview: () => void;
}) {
  const score = bill.score ?? 0;
  const hasSugg = bill.suggested_job_id != null;

  let scoreClass = 'badge-neutral';
  if (score >= 0.85) scoreClass = 'badge-success';
  else if (score >= 0.65) scoreClass = 'badge-warning';

  return (
    <div
      className="card"
      style={{
        padding: '1.25rem',
        borderLeft: isPreviewing
          ? '4px solid var(--accent-primary)'
          : '1px solid var(--border-subtle)',
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: '1rem',
      }}
    >
      <div style={{ flex: 1, minWidth: '300px' }}>
        <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-title)' }}>
          {bill.supplier_name_raw ?? (
            <span style={{ color: 'var(--text-muted)' }}>No supplier extracted</span>
          )}
        </div>
        <div
          style={{
            fontSize: '0.8rem',
            color: 'var(--text-muted)',
            marginTop: '0.25rem',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.5rem',
            alignItems: 'center',
          }}
        >
          <span style={{ fontWeight: 600, color: 'var(--text-body)' }}>
            {formatMoney(bill.total_inc_gst_cents)}
          </span>
          <span>·</span>
          <code>{bill.invoice_number ?? '—'}</code>
          <span>·</span>
          <span>{bill.invoice_date ?? '—'}</span>
        </div>

        <div style={{ fontSize: '0.775rem', color: 'var(--text-body)', marginTop: '0.35rem' }}>
          Job Reference (raw):{' '}
          {bill.job_reference_raw ? (
            <code style={{ color: 'var(--text-warning)', fontWeight: 600 }}>
              {bill.job_reference_raw}
            </code>
          ) : (
            <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>None extracted</span>
          )}
        </div>

        {/* Preview Button Trigger */}
        <button
          onClick={onPreview}
          className="btn btn-ghost"
          style={{
            marginTop: '0.5rem',
            padding: '0.2rem 0.5rem',
            fontSize: '0.75rem',
            marginLeft: '-0.5rem',
          }}
          aria-pressed={isPreviewing}
        >
          {isPreviewing ? <EyeOff size={12} /> : <Eye size={12} />}
          <span>{isPreviewing ? 'Close Preview' : 'Show PDF'}</span>
        </button>
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
          minWidth: '280px',
          flexShrink: 0,
        }}
      >
        {hasSugg ? (
          <div
            style={{
              background: 'var(--bg-app)',
              padding: '0.75rem',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-subtle)',
            }}
          >
            <div
              style={{
                fontSize: '0.75rem',
                color: 'var(--text-muted)',
                marginBottom: '0.5rem',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span>AI Suggested Match:</span>
              <span className={`badge ${scoreClass}`} style={{ fontSize: '8px' }}>
                {(score * 100).toFixed(0)}% Match
              </span>
            </div>

            <div
              style={{
                fontSize: '0.85rem',
                fontWeight: 600,
                color: 'var(--text-title)',
                marginBottom: '0.75rem',
              }}
            >
              <code style={{ marginRight: '0.5rem', color: 'var(--accent-primary)' }}>
                {bill.suggested_job_number}
              </code>
              <span>{bill.suggested_job_name}</span>
            </div>

            <div style={{ display: 'flex', gap: '0.35rem' }}>
              <button
                onClick={() => bill.suggested_job_id && onConfirm(bill.suggested_job_id)}
                disabled={busy}
                className="btn btn-primary"
                style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem', flex: 1 }}
              >
                {busy ? 'Attaching…' : 'Approve Match'}
              </button>
              <button
                onClick={onReject}
                disabled={busy}
                className="btn btn-secondary"
                style={{ padding: '0.35rem 0.75rem', fontSize: '0.75rem' }}
              >
                Wrong
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            <select
              onChange={(e) => e.target.value && onQuickAssign(e.target.value)}
              defaultValue=""
              disabled={busy}
              className="form-select"
              style={{ padding: '0.4rem 0.5rem', fontSize: '0.8rem' }}
            >
              <option value="">— Assign to a job —</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.job_number} · {j.name}
                </option>
              ))}
            </select>
            <Link
              to={`/bills/${bill.bill_id}`}
              style={{
                color: 'var(--text-muted)',
                fontSize: '0.75rem',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
                gap: '0.15rem',
              }}
            >
              <span>or open details</span>
              <ChevronRight size={12} />
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
