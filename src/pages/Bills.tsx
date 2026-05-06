import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useOrg } from '@/contexts/OrgContext';
import { useBills, type BillListRow } from '@/hooks/useBills';
import { formatMoney } from '@/lib/money';
import { SkeletonTable } from '@/components/Skeleton';

const statusColors: Record<BillListRow['status'], string> = {
  received: '#888',
  verified: '#d2c886',
  attached: '#86c7a3',
  paid: '#7799d6',
  void: '#666',
};

const filters: Array<{ label: string; value: BillListRow['status'] | null }> = [
  { label: 'All', value: null },
  { label: 'Received', value: 'received' },
  { label: 'Verified', value: 'verified' },
  { label: 'Attached', value: 'attached' },
  { label: 'Paid', value: 'paid' },
];

export function BillsPage() {
  const { currentOrg } = useOrg();
  const [filter, setFilter] = useState<BillListRow['status'] | null>(null);
  const { bills, loading, error } = useBills(filter ?? undefined);

  if (!currentOrg) {
    return (
      <section>
        <h1>Bills</h1>
        <p style={{ color: '#888' }}>Pick an organisation to see bills.</p>
      </section>
    );
  }

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Bills</h1>
        <Link
          to="/bills/upload"
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
          + Upload bill
        </Link>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem', marginTop: '1rem' }}>
        {filters.map((f) => (
          <button
            key={f.label}
            onClick={() => setFilter(f.value)}
            style={{
              padding: '0.4rem 0.75rem',
              background: filter === f.value ? '#2a2a2a' : 'transparent',
              color: filter === f.value ? '#fff' : '#888',
              border: '1px solid #2a2a2a',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <SkeletonTable rows={6} cols={7} />
      ) : error ? (
        <p style={{ color: 'salmon' }}>Failed: {error}</p>
      ) : bills.length === 0 ? (
        <p style={{ color: '#888' }}>No bills{filter ? ` with status "${filter}"` : ''}.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
                <th style={th}>Date</th>
                <th style={th}>Supplier</th>
                <th style={th}>Invoice #</th>
                <th style={th}>Job</th>
                <th style={thRight}>Total</th>
                <th style={th}>Status</th>
                <th style={th}>Xero</th>
              </tr>
            </thead>
            <tbody>
              {bills.map((b) => (
                <tr
                  key={b.id}
                  style={{ borderBottom: '1px solid #1a1a1a', cursor: 'pointer' }}
                  onClick={() => (window.location.href = `/bills/${b.id}`)}
                >
                  <td style={td}>{b.invoice_date ?? '—'}</td>
                  <td style={td}>
                    <Link to={`/bills/${b.id}`} style={{ color: '#fff', textDecoration: 'none' }}>
                      {b.supplier_name_raw ?? <span style={{ color: '#666' }}>—</span>}
                    </Link>
                  </td>
                  <td style={td}>
                    <code style={{ color: '#888' }}>{b.invoice_number ?? '—'}</code>
                  </td>
                  <td style={td}>
                    {b.attached_job?.job_number ? (
                      <code style={{ color: '#86c7a3' }}>{b.attached_job.job_number}</code>
                    ) : (
                      <span style={{ color: '#666' }}>—</span>
                    )}
                  </td>
                  <td style={tdRight}>{formatMoney(b.total_inc_gst_cents)}</td>
                  <td style={td}>
                    <span
                      style={{
                        padding: '0.15rem 0.5rem',
                        fontSize: 11,
                        borderRadius: 3,
                        background: '#222',
                        color: statusColors[b.status],
                        textTransform: 'uppercase',
                      }}
                    >
                      {b.status}
                    </span>
                  </td>
                  <td style={td}>
                    <span style={{ fontSize: 11, color: b.xero_status === 'synced' ? '#86c7a3' : '#888' }}>
                      {b.xero_status}
                    </span>
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
  padding: '0.5rem 0.75rem',
  textAlign: 'left',
  fontSize: 12,
  color: '#888',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  fontWeight: 500,
};
const thRight: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '0.65rem 0.75rem' };
const tdRight: React.CSSProperties = { ...td, textAlign: 'right' };
