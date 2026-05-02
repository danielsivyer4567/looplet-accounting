import { useNavigate } from 'react-router-dom';
import { useOrg } from '@/contexts/OrgContext';
import { useCustomers } from '@/hooks/useCustomers';
import type { BillingAddress } from '@/hooks/useCustomers';

function formatAddress(addr: BillingAddress | null): string {
  if (!addr) return '—';
  const parts = [addr.line1, addr.city, addr.state, addr.postcode].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : '—';
}

export function CustomersPage() {
  const { currentOrg } = useOrg();
  const { customers, loading, error } = useCustomers();
  const navigate = useNavigate();

  if (!currentOrg) {
    return (
      <section>
        <h1>Customers</h1>
        <p style={{ color: '#888' }}>Pick an organisation to see customers.</p>
      </section>
    );
  }

  return (
    <section>
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '1rem' }}>
        <h1 style={{ margin: 0 }}>Customers</h1>
        {!loading && (
          <span style={{ color: '#888', fontSize: 13 }}>
            {customers.length} customer{customers.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Count card */}
      {!loading && !error && (
        <div
          style={{
            display: 'inline-flex',
            flexDirection: 'column',
            padding: '1rem 1.5rem',
            background: '#1a1a1a',
            border: '1px solid #2a2a2a',
            borderRadius: 6,
            marginBottom: '1.5rem',
          }}
        >
          <span style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Total customers
          </span>
          <span style={{ fontSize: 32, fontWeight: 700, color: '#86c7a3', marginTop: '0.25rem' }}>
            {customers.length}
          </span>
        </div>
      )}

      {loading ? (
        <p style={{ color: '#888' }}>Loading…</p>
      ) : error ? (
        <p style={{ color: 'salmon' }}>Failed to load: {error}</p>
      ) : customers.length === 0 ? (
        <p style={{ color: '#888' }}>No customers found for {currentOrg.name}.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
              <th style={th}>Name</th>
              <th style={th}>Email</th>
              <th style={th}>Phone</th>
              <th style={th}>Billing address</th>
              <th style={th}>ABN</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr
                key={c.id}
                style={{ borderBottom: '1px solid #1a1a1a', cursor: 'pointer' }}
                onClick={() => void navigate(`/customers/${c.id}`)}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLTableRowElement).style.background = '#202020';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLTableRowElement).style.background = '';
                }}
              >
                <td style={{ ...td, fontWeight: 500 }}>{c.name}</td>
                <td style={td}>
                  {c.email ? (
                    <span style={{ color: '#aaa', fontSize: 13 }}>{c.email}</span>
                  ) : (
                    <span style={{ color: '#444' }}>—</span>
                  )}
                </td>
                <td style={td}>
                  {c.phone ? (
                    <span style={{ color: '#aaa', fontSize: 13 }}>{c.phone}</span>
                  ) : (
                    <span style={{ color: '#444' }}>—</span>
                  )}
                </td>
                <td style={td}>
                  <span style={{ color: '#aaa', fontSize: 13 }}>
                    {formatAddress(c.billing_address)}
                  </span>
                </td>
                <td style={td}>
                  {c.abn ? (
                    <code style={{ color: '#888', fontSize: 12 }}>{c.abn}</code>
                  ) : (
                    <span style={{ color: '#444' }}>—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
const td: React.CSSProperties = { padding: '0.65rem 0.75rem' };
