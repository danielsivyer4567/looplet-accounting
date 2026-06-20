import { Link } from 'react-router-dom';
import { useOrg } from '@/hooks/useOrg';
import { usePaymentRuns, type PaymentRunRow } from '@/hooks/usePaymentRuns';
import { formatMoney } from '@/lib/money';
import { SkeletonTable } from '@/components/Skeleton';

const STATUS_COLORS: Record<PaymentRunRow['status'], string> = {
  draft:     '#888',
  approved:  '#d2c886',
  exported:  '#86c7a3',
  paid:      '#7799d6',
  cancelled: '#555',
};

export function PaymentRunsPage() {
  const { currentOrg } = useOrg();
  const { runs, loading, error } = usePaymentRuns();

  if (!currentOrg) {
    return (
      <section>
        <h1>Payment Runs</h1>
        <p style={{ color: '#888' }}>Pick an organisation to see payment runs.</p>
      </section>
    );
  }

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Payment Runs</h1>
        <Link
          to="/payment-runs/new"
          style={{
            padding: '0.5rem 1rem',
            background: '#1c5135',
            color: '#fff',
            border: '1px solid #2da565',
            borderRadius: 4,
            textDecoration: 'none',
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          + New payment run
        </Link>
      </div>
      <p style={{ color: '#888', fontSize: 13, marginTop: 4 }}>
        Batch-pay multiple bills via a single ABA (Cemtex) bank file upload.
      </p>

      {loading ? (
        <SkeletonTable rows={5} cols={6} />
      ) : error ? (
        <p style={{ color: 'salmon' }}>Failed: {error}</p>
      ) : runs.length === 0 ? (
        <p style={{ color: '#888', marginTop: '2rem' }}>
          No payment runs yet.{' '}
          <Link to="/payment-runs/new" style={{ color: '#86c7a3' }}>
            Create your first one
          </Link>
          .
        </p>
      ) : (
        <div style={{ overflowX: 'auto', marginTop: '1.5rem' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
                <th style={th}>Pay date</th>
                <th style={th}>Bills</th>
                <th style={thRight}>Total</th>
                <th style={th}>Status</th>
                <th style={th}>ABA exported</th>
                <th style={th}>Created</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr
                  key={run.id}
                  style={{ borderBottom: '1px solid #1a1a1a' }}
                >
                  <td style={td}>
                    <Link
                      to={`/payment-runs/${run.id}`}
                      style={{ color: '#86c7a3', textDecoration: 'none' }}
                    >
                      {run.pay_date}
                    </Link>
                  </td>
                  <td style={td}>{run.bill_count}</td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    {formatMoney(run.total_cents)}
                  </td>
                  <td style={td}>
                    <span
                      style={{
                        fontSize: 11,
                        padding: '2px 6px',
                        borderRadius: 3,
                        background: STATUS_COLORS[run.status] + '33',
                        color: STATUS_COLORS[run.status],
                        fontWeight: 600,
                        textTransform: 'uppercase',
                      }}
                    >
                      {run.status}
                    </span>
                  </td>
                  <td style={td}>
                    {run.aba_file_generated_at
                      ? new Date(run.aba_file_generated_at).toLocaleString('en-AU', { dateStyle: 'short', timeStyle: 'short' })
                      : <span style={{ color: '#555' }}>—</span>}
                  </td>
                  <td style={td}>
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
const td: React.CSSProperties = {
  padding: '0.6rem 0.75rem',
  fontSize: 13,
  color: '#ccc',
};
