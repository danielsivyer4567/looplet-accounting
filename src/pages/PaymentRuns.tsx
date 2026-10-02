import { Link } from 'react-router-dom';
import { useOrg } from '@/hooks/useOrg';
import { usePaymentRuns, type PaymentRunRow } from '@/hooks/usePaymentRuns';
import { formatLoadError } from '@/lib/errorMessages';
import { formatMoney } from '@/lib/money';
import { SkeletonTable } from '@/components/Skeleton';
import { Layers, Plus } from 'lucide-react';

export function PaymentRunsPage() {
  const { currentOrg } = useOrg();
  const { runs, loading, error } = usePaymentRuns();

  if (!currentOrg) {
    return (
      <section className="animated-fade-in">
        <h1>Payment Runs</h1>
        <p style={{ color: 'var(--text-muted)' }}>Pick an organisation to see payment runs.</p>
      </section>
    );
  }

  return (
    <section className="animated-fade-in">
      {/* Header section */}
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
        <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Layers size={24} style={{ color: 'var(--text-link)' }} />
          Payment Runs
        </h1>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <Link to="/payment-runs/new" className="btn btn-primary">
            <Plus size={16} />
            <span>New payment run</span>
          </Link>
        </div>
      </div>

      <p
        style={{
          color: 'var(--text-muted)',
          fontSize: '0.875rem',
          marginTop: '-0.5rem',
          marginBottom: '1.5rem',
          lineHeight: '1.5',
        }}
      >
        Batch-pay multiple bills via a single ABA (Cemtex) bank file upload.
      </p>

      {loading ? (
        <SkeletonTable rows={5} cols={6} />
      ) : error ? (
        <div
          className="badge badge-danger"
          style={{ display: 'block', padding: '1rem', textTransform: 'none' }}
        >
          {formatLoadError('payment runs', error)}
        </div>
      ) : runs.length === 0 ? (
        <div
          style={{
            padding: '3rem 1.5rem',
            background: 'var(--bg-card)',
            border: '1px dashed var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            textAlign: 'center',
            color: 'var(--text-muted)',
          }}
        >
          No payment runs yet.{' '}
          <Link to="/payment-runs/new" style={{ fontWeight: 600 }}>
            Create your first one
          </Link>
          .
        </div>
      ) : (
        <div className="table-premium-container">
          <table className="table-premium">
            <thead>
              <tr>
                <th>Pay date</th>
                <th>Bills</th>
                <th style={{ textAlign: 'right' }}>Total</th>
                <th>Status</th>
                <th>ABA exported</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>
                    <Link to={`/payment-runs/${run.id}`} style={{ fontWeight: 600 }}>
                      {run.pay_date}
                    </Link>
                  </td>
                  <td>{run.bill_count}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>
                    {formatMoney(run.total_cents)}
                  </td>
                  <td>
                    <Pill status={run.status} />
                  </td>
                  <td style={{ fontSize: '0.825rem' }}>
                    {run.aba_file_generated_at ? (
                      new Date(run.aba_file_generated_at).toLocaleString('en-AU', {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>—</span>
                    )}
                  </td>
                  <td style={{ color: 'var(--text-muted)', fontSize: '0.825rem' }}>
                    {new Date(run.created_at).toLocaleDateString('en-AU')}
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

function Pill({ status }: { status: PaymentRunRow['status'] }) {
  let badgeClass = 'badge-neutral';
  if (status === 'paid' || status === 'exported') badgeClass = 'badge-success';
  else if (status === 'approved') badgeClass = 'badge-info';
  else if (status === 'draft') badgeClass = 'badge-warning';
  else if (status === 'cancelled') badgeClass = 'badge-danger';

  return <span className={`badge ${badgeClass}`}>{status}</span>;
}
