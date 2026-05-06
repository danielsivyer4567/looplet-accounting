import { Link, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useInvoices } from '@/hooks/useInvoices';
import { useOrg } from '@/contexts/OrgContext';
import { formatMoney } from '@/lib/money';
import { SkeletonCard, SkeletonTable } from '@/components/Skeleton';

const STATUS_FILTERS = ['all', 'draft', 'sent', 'partially_paid', 'paid', 'overdue', 'void'] as const;
type Filter = typeof STATUS_FILTERS[number];

export function InvoicesPage() {
  const { currentOrg } = useOrg();
  const [filter, setFilter] = useState<Filter>('all');
  const { invoices, loading, error } = useInvoices(filter === 'all' ? undefined : { status: filter });
  const navigate = useNavigate();

  if (!currentOrg) return <section><h1>Invoices</h1><p style={{ color: '#888' }}>Pick an organisation.</p></section>;

  // Aggregate KPIs over the *full* (unfiltered) result
  const totalInvoiced = invoices.reduce((a, i) => a + (i.total_inc_gst_cents ?? 0), 0);
  const totalPaid = invoices.reduce((a, i) => a + (i.amount_paid_cents ?? 0), 0);
  const totalOwing = invoices.reduce((a, i) => a + (i.balance_due_cents ?? 0), 0);
  const overdueCount = invoices.filter((i) => i.status === 'overdue').length;

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Invoices</h1>
        <button onClick={() => navigate('/invoices/new')} style={primaryBtn}>+ Raise invoice</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, maxWidth: 1100 }}>
        <Kpi label="Total invoiced" value={formatMoney(totalInvoiced)} colour="#86c7a3" />
        <Kpi label="Total paid" value={formatMoney(totalPaid)} colour="#86c7a3" sub={`${invoices.length} invoices`} />
        <Kpi label="Outstanding" value={formatMoney(totalOwing)} colour={totalOwing > 0 ? '#d2c886' : '#888'} />
        <Kpi label="Overdue" value={overdueCount > 0 ? `${overdueCount}` : '0'} colour={overdueCount > 0 ? '#e9a3a3' : '#888'} sub={overdueCount > 0 ? 'needs chasing' : 'all good'} />
      </div>

      <div style={{ marginTop: 20, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            style={{
              padding: '0.3rem 0.75rem',
              background: filter === s ? '#1c4868' : 'transparent',
              color: filter === s ? '#fff' : '#aaa',
              border: '1px solid ' + (filter === s ? '#5096d8' : '#333'),
              borderRadius: 3, fontSize: 12, cursor: 'pointer',
            }}
          >
            {s}
          </button>
        ))}
      </div>

      {loading ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, maxWidth: 1100, marginTop: 20 }}>
            {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>
          <div style={{ marginTop: 16 }}>
            <SkeletonTable rows={6} cols={9} />
          </div>
        </>
      ) : error ? (
        <p style={{ color: 'salmon', marginTop: 16 }}>{error}</p>
      ) : invoices.length === 0 ? (
        <div style={{ marginTop: 24, padding: 16, background: '#0e0e0e', border: '1px dashed #2a2a2a', borderRadius: 4, color: '#888', fontSize: 13 }}>
          No invoices yet. Raise one to start tracking AR.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 16 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
                <th style={th}>#</th>
                <th style={th}>Customer</th>
                <th style={th}>Job</th>
                <th style={th}>Issued</th>
                <th style={th}>Due</th>
                <th style={th}>Status</th>
                <th style={thRight}>Total</th>
                <th style={thRight}>Paid</th>
                <th style={thRight}>Balance</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr
                  key={inv.id}
                  style={{ borderBottom: '1px solid #1a1a1a', cursor: 'pointer' }}
                  onClick={() => navigate(`/invoices/${inv.id}`)}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = '#202020'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = ''; }}
                >
                  <td style={td}><code style={{ color: '#aaa', fontSize: 12 }}>{inv.invoice_number}</code></td>
                  <td style={td}>{inv.customer?.name ?? <span style={{ color: '#444' }}>—</span>}</td>
                  <td style={td}>
                    {inv.job ? (
                      <Link to={`/jobs/${inv.job.id}`} onClick={(e) => e.stopPropagation()} style={{ color: '#86c7a3', fontSize: 12 }}>
                        {inv.job.job_number}
                      </Link>
                    ) : <span style={{ color: '#444' }}>—</span>}
                  </td>
                  <td style={td}>{inv.issue_date}</td>
                  <td style={td}>{inv.due_date}</td>
                  <td style={td}><StatusPill status={inv.status} /></td>
                  <td style={tdRight}>{formatMoney(inv.total_inc_gst_cents)}</td>
                  <td style={tdRight}>{formatMoney(inv.amount_paid_cents)}</td>
                  <td style={{ ...tdRight, color: inv.balance_due_cents > 0 ? '#d2c886' : '#86c7a3' }}>{formatMoney(inv.balance_due_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Kpi({ label, value, colour, sub }: { label: string; value: string; colour: string; sub?: string }) {
  return (
    <div style={{ padding: 12, background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 6 }}>
      <div style={{ fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ marginTop: 4, fontSize: 18, color: colour, fontWeight: 600 }}>{value}</div>
      {sub && <div style={{ marginTop: 3, fontSize: 11, color: '#888' }}>{sub}</div>}
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const c = status === 'paid' ? '#86c7a3'
    : status === 'sent' ? '#5096d8'
    : status === 'partially_paid' ? '#d2c886'
    : status === 'overdue' ? '#e9a3a3'
    : status === 'void' ? '#666'
    : '#888';
  return <span style={{ padding: '0.15rem 0.5rem', fontSize: 11, borderRadius: 3, background: '#222', color: c, textTransform: 'uppercase' }}>{status}</span>;
}

const primaryBtn: React.CSSProperties = { padding: '0.5rem 1rem', background: '#1c4868', color: '#fff', border: '1px solid #5096d8', borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const th: React.CSSProperties = { padding: '0.4rem 0.5rem', textAlign: 'left', fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 500 };
const thRight: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '0.5rem' };
const tdRight: React.CSSProperties = { ...td, textAlign: 'right' };
