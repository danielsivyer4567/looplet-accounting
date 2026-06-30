import { useState, useCallback } from 'react';
import { CheckCheck, RefreshCw, Zap, CheckCircle, Loader2 } from 'lucide-react';
import { useAllocationQueue } from '@/hooks/useAllocationQueue';
import { useOrg } from '@/hooks/useOrg';
import { supabase } from '@/lib/supabase';
import { formatMoney } from '@/lib/money';
import { SkeletonTable } from '@/components/Skeleton';

// ---------------------------------------------------------------------------
// Inline confidence badge — numeric score (0–1), not the AutomationConfidence
// enum used by ConfidenceBadge, so we render a plain tailwind-style badge.
// ---------------------------------------------------------------------------

function ScoreBadge({ score }: { score: number | null }) {
  if (score == null) {
    return (
      <span
        className="badge"
        style={{
          background: 'var(--bg-subtle, #1a1a1a)',
          color: 'var(--text-muted)',
          border: '1px solid var(--border-subtle)',
          fontSize: '0.72rem',
        }}
      >
        No suggestion
      </span>
    );
  }

  const pct = Math.round(score * 100);

  if (pct >= 85) {
    return (
      <span
        className="badge"
        style={{
          background: 'rgba(34,197,94,0.12)',
          color: '#22c55e',
          border: '1px solid rgba(34,197,94,0.3)',
          fontSize: '0.72rem',
        }}
      >
        {pct}%
      </span>
    );
  }

  if (pct >= 50) {
    return (
      <span
        className="badge"
        style={{
          background: 'rgba(245,158,11,0.12)',
          color: '#f59e0b',
          border: '1px solid rgba(245,158,11,0.3)',
          fontSize: '0.72rem',
        }}
      >
        {pct}%
      </span>
    );
  }

  return (
    <span
      className="badge"
      style={{
        background: 'var(--bg-subtle, #1a1a1a)',
        color: 'var(--text-muted)',
        border: '1px solid var(--border-subtle)',
        fontSize: '0.72rem',
      }}
    >
      {pct}%
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type BusyAction = 'auto_accept' | 'rematch' | 'full' | null;

export function AllocationQueuePanel() {
  const { currentOrg } = useOrg();
  const { bills, loading, error, refresh } = useAllocationQueue();
  const [busy, setBusy] = useState<BusyAction>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Computed stats from the bill list
  const autoAcceptCount = bills.filter(
    (b) => b.suggested_match_score != null && b.suggested_match_score >= 0.85,
  ).length;
  const needsReviewCount = bills.filter(
    (b) =>
      b.suggested_match_score != null &&
      b.suggested_match_score >= 0.5 &&
      b.suggested_match_score < 0.85,
  ).length;
  const unmatchedCount = bills.filter(
    (b) => b.suggested_match_score == null || b.suggested_match_score < 0.5,
  ).length;

  const invokeMode = useCallback(
    async (mode: 'auto_accept' | 'rematch' | 'full', minScore?: number) => {
      if (!currentOrg) return;
      setBusy(mode);
      setToast(null);

      try {
        const { data, error: fnErr } = await supabase.functions.invoke<{
          auto_accept?: unknown;
          rematch?: unknown;
          error?: string;
        }>('bills-allocate-batch', {
          body: {
            org_id: currentOrg.id,
            mode,
            ...(minScore != null ? { min_score: minScore } : {}),
          },
        });

        if (fnErr) throw new Error(fnErr.message);
        if (data?.error) throw new Error(data.error);

        let message = '';
        if (mode === 'auto_accept') message = 'Auto-accept complete.';
        else if (mode === 'rematch') message = 'Re-match complete.';
        else message = 'Full pipeline complete.';

        setToast({ type: 'success', message });
        await refresh();
      } catch (e) {
        setToast({
          type: 'error',
          message: e instanceof Error ? e.message : 'Action failed',
        });
      } finally {
        setBusy(null);
      }
    },
    [currentOrg, refresh],
  );

  const handleAutoAccept = () => invokeMode('auto_accept', 0.85);
  const handleRematch = () => invokeMode('rematch');
  const handleFull = () => invokeMode('full', 0.85);

  const displayBills = bills.slice(0, 50);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {/* Header row */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          gap: '0.75rem',
        }}
      >
        <div>
          <h2
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              fontSize: '1.05rem',
              fontWeight: 600,
              margin: 0,
            }}
          >
            <Zap size={18} style={{ color: 'var(--accent-primary)' }} />
            Job Allocation Queue
          </h2>
          {!loading && (
            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: '0.25rem 0 0' }}>
              {autoAcceptCount > 0 && (
                <>
                  <span style={{ color: '#22c55e' }}>{autoAcceptCount} ready to auto-accept</span>
                  {(needsReviewCount > 0 || unmatchedCount > 0) && ' · '}
                </>
              )}
              {needsReviewCount > 0 && (
                <>
                  <span style={{ color: '#f59e0b' }}>{needsReviewCount} need review</span>
                  {unmatchedCount > 0 && ' · '}
                </>
              )}
              {unmatchedCount > 0 && (
                <span style={{ color: 'var(--text-muted)' }}>{unmatchedCount} unmatched</span>
              )}
              {bills.length === 0 && !loading && (
                <span>No unallocated bills</span>
              )}
            </p>
          )}
        </div>

        {/* Action buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            className="btn btn-primary"
            style={{ fontSize: '0.8rem', padding: '0.4rem 0.85rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
            disabled={busy !== null || loading}
            onClick={handleAutoAccept}
          >
            {busy === 'auto_accept' ? (
              <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />
            ) : (
              <CheckCheck size={13} />
            )}
            Auto-Accept (≥85%)
          </button>

          <button
            className="btn btn-secondary"
            style={{ fontSize: '0.8rem', padding: '0.4rem 0.85rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
            disabled={busy !== null || loading}
            onClick={handleRematch}
          >
            {busy === 'rematch' ? (
              <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />
            ) : (
              <RefreshCw size={13} />
            )}
            Re-match All
          </button>

          <button
            className="btn btn-ghost"
            style={{ fontSize: '0.8rem', padding: '0.4rem 0.85rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
            disabled={busy !== null || loading}
            onClick={handleFull}
          >
            {busy === 'full' ? (
              <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />
            ) : (
              <Zap size={13} />
            )}
            Run Full Pipeline
          </button>
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div
          className={toast.type === 'error' ? 'badge badge-danger' : 'badge'}
          style={{
            display: 'block',
            padding: '0.5rem 0.75rem',
            textTransform: 'none',
            fontSize: '0.825rem',
            ...(toast.type === 'success'
              ? {
                  background: 'rgba(34,197,94,0.12)',
                  color: '#22c55e',
                  border: '1px solid rgba(34,197,94,0.3)',
                }
              : {}),
          }}
        >
          {toast.message}
        </div>
      )}

      {/* Fetch error */}
      {error && (
        <div
          className="badge badge-danger"
          style={{ display: 'block', padding: '0.5rem 0.75rem', textTransform: 'none' }}
        >
          Failed to load queue: {error}
        </div>
      )}

      {/* Body */}
      {loading ? (
        <SkeletonTable rows={6} cols={6} />
      ) : bills.length === 0 ? (
        <div
          style={{
            padding: '2.5rem',
            textAlign: 'center',
            color: 'var(--text-muted)',
            fontSize: '0.875rem',
            border: '1px dashed var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '0.5rem',
          }}
        >
          <CheckCircle size={32} style={{ color: '#22c55e', opacity: 0.7 }} />
          <span>All bills are allocated</span>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%', fontSize: '0.85rem' }}>
            <thead>
              <tr>
                <th>Supplier</th>
                <th>Invoice #</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th>Suggested Job</th>
                <th style={{ textAlign: 'center' }}>Confidence</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {displayBills.map((bill) => {
                const date = bill.invoice_date
                  ? new Date(bill.invoice_date).toLocaleDateString('en-AU', {
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric',
                    })
                  : bill.created_at
                  ? new Date(bill.created_at).toLocaleDateString('en-AU', {
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric',
                    })
                  : '—';

                const suggestedJob = bill.suggested_job;
                const jobLabel = suggestedJob
                  ? `${suggestedJob.job_number} – ${suggestedJob.name}`
                  : bill.job_reference_raw ?? '—';

                return (
                  <tr key={bill.id}>
                    <td>
                      <span
                        style={{
                          display: 'block',
                          maxWidth: '180px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontWeight: 500,
                        }}
                        title={bill.supplier_name_raw ?? undefined}
                      >
                        {bill.supplier_name_raw ?? <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      </span>
                    </td>
                    <td style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                      {bill.invoice_number ?? '—'}
                    </td>
                    <td
                      style={{
                        textAlign: 'right',
                        fontVariantNumeric: 'tabular-nums',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {bill.total_inc_gst_cents != null
                        ? formatMoney(bill.total_inc_gst_cents)
                        : '—'}
                    </td>
                    <td>
                      <span
                        style={{
                          display: 'block',
                          maxWidth: '220px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          color: suggestedJob ? 'var(--text-title)' : 'var(--text-muted)',
                        }}
                        title={suggestedJob ? jobLabel : undefined}
                      >
                        {jobLabel}
                      </span>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <ScoreBadge score={bill.suggested_match_score} />
                    </td>
                    <td style={{ color: 'var(--text-muted)', fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
                      {date}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {bills.length > 50 && (
            <p
              style={{
                margin: '0.5rem 0 0',
                fontSize: '0.75rem',
                color: 'var(--text-muted)',
                textAlign: 'right',
              }}
            >
              Showing 50 of {bills.length} bills. Run Auto-Accept or Re-match to reduce the queue.
            </p>
          )}
        </div>
      )}

      {/* Refresh link */}
      {!loading && bills.length > 0 && (
        <div style={{ textAlign: 'right' }}>
          <button
            className="btn btn-ghost"
            style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}
            onClick={() => void refresh()}
            disabled={busy !== null}
          >
            Refresh
          </button>
        </div>
      )}
    </div>
  );
}
