import { useState } from 'react';
import { useApprovals, type ApprovalRow } from '@/hooks/useApprovals';
import { SkeletonCard } from '@/components/Skeleton';
import { ShieldCheck, CheckCircle2, X } from 'lucide-react';

const MUTED = 'var(--text-muted, #6b7280)';

function humanizeType(t: string): string {
  return t.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function ErrorBadge({ message }: { message: string }) {
  return (
    <div
      className="badge badge-danger"
      style={{ display: 'block', padding: '0.75rem', textTransform: 'none', marginTop: '0.5rem' }}
    >
      {message}
    </div>
  );
}

function ApprovalCard({
  approval,
  onApprove,
  onReject,
}: {
  approval: ApprovalRow;
  onApprove: (id: string) => Promise<void>;
  onReject: (id: string, reason: string) => Promise<void>;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // On success the row leaves the queue (the hook refreshes), so the component
  // unmounts — only the failure path needs to clear `busy`.
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const doReject = () => {
    if (!reason.trim()) {
      setErr('A reason is required to reject.');
      return;
    }
    void run(() => onReject(approval.id, reason.trim()));
  };

  return (
    <div className="card" style={{ padding: '1rem', marginBottom: '0.75rem' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: '1rem',
          alignItems: 'flex-start',
        }}
      >
        <div>
          <span className="badge badge-warning">Tier 2 · approval required</span>
          <div style={{ fontWeight: 600, marginTop: '0.5rem' }}>
            {humanizeType(approval.resource_type)} · {approval.resource_id.slice(0, 8)}
          </div>
          <div style={{ fontSize: '0.85rem', color: MUTED, marginTop: '0.25rem' }}>
            Requested {new Date(approval.requested_at).toLocaleString('en-AU')}
          </div>
          <div style={{ fontSize: '0.75rem', color: MUTED, marginTop: '0.25rem' }}>
            Binds to {approval.payload_hash.slice(0, 12)}…
          </div>
        </div>
        {!rejecting && (
          <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0 }}>
            <button
              className="btn btn-primary"
              onClick={() => void run(() => onApprove(approval.id))}
              disabled={busy}
            >
              <CheckCircle2 size={16} /> Approve
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => {
                setRejecting(true);
                setErr(null);
              }}
              disabled={busy}
            >
              <X size={16} /> Reject
            </button>
          </div>
        )}
      </div>

      {rejecting && (
        <div style={{ marginTop: '0.75rem' }}>
          <label className="form-label" htmlFor={`reason-${approval.id}`}>
            Reason for rejection
          </label>
          <textarea
            id={`reason-${approval.id}`}
            className="form-textarea"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this being rejected? (recorded on the approval and the audit trail)"
            rows={2}
          />
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button className="btn btn-secondary" onClick={doReject} disabled={busy}>
              Confirm rejection
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                setRejecting(false);
                setReason('');
                setErr(null);
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {err && <ErrorBadge message={err} />}
    </div>
  );
}

export function ApprovalsPage() {
  const { pending, loading, error, approve, reject } = useApprovals();

  return (
    <section className="animated-fade-in">
      <div
        style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}
      >
        <ShieldCheck size={22} />
        <h1 style={{ margin: 0 }}>Approvals</h1>
      </div>
      <p style={{ color: MUTED, marginTop: 0 }}>
        Payments, payroll and super files, and prepared returns that need sign-off before they run.
        An approval binds to the exact content requested — editing it afterwards re-requires
        approval. Approving a return does not lodge it with the ATO.
      </p>

      {error && <ErrorBadge message={error} />}

      {loading ? (
        <div aria-busy="true" aria-label="Loading approvals">
          <SkeletonCard />
        </div>
      ) : pending.length === 0 ? (
        <div className="card" style={{ padding: '1.5rem', textAlign: 'center', color: MUTED }}>
          Nothing awaiting approval. Tier-2 actions (paying a payment run, finalising payroll)
          appear here.
        </div>
      ) : (
        pending.map((a) => (
          <ApprovalCard key={a.id} approval={a} onApprove={approve} onReject={reject} />
        ))
      )}
    </section>
  );
}
