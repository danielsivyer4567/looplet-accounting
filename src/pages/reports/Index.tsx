import { Link } from 'react-router-dom';

const REPORTS = [
  {
    to: '/reports/bas',
    title: 'BAS quarterly (GST)',
    description: 'GST collected on sales minus GST paid on purchases, by AU fiscal quarter. Personal-flagged expenses excluded.',
    status: 'live',
  },
  {
    to: '/reports/cash-flow',
    title: 'Cash flow forecast',
    description: 'Weekly inflows from outstanding invoices and outflows from unpaid bills. Forward visibility on what hits the bank when.',
    status: 'live',
  },
  {
    to: null,
    title: 'P&L by job (export)',
    description: 'Per-job profit & loss with attached bills, wages, overhead allocation, and revenue from invoices. PDF/CSV export.',
    status: 'planned',
  },
  {
    to: '/reports/balance-sheet',
    title: 'Balance sheet',
    description: 'Assets (bank balances, AR), liabilities (AP, debts), equity. Approximate — based on bills/invoices, not a true GL ledger.',
    status: 'live',
  },
  {
    to: null,
    title: 'Tax summary (annual)',
    description: 'Annual income, deductible expenses, GST summary, depreciation. Aligned to AU tax-return categories.',
    status: 'planned',
  },
];

export function ReportsIndexPage() {
  return (
    <section>
      <h1>Reports</h1>
      <p style={{ color: '#888', fontSize: 13, maxWidth: 720 }}>
        Cross-cutting financial views. Drill in for detail or export.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, marginTop: 16, maxWidth: 1100 }}>
        {REPORTS.map((r) => {
          const card = (
            <div
              key={r.title}
              style={{
                padding: 16,
                background: '#1a1a1a',
                border: '1px solid #2a2a2a',
                borderRadius: 6,
                opacity: r.status === 'planned' ? 0.5 : 1,
                cursor: r.to ? 'pointer' : 'default',
                height: '100%',
                boxSizing: 'border-box',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <h2 style={{ fontSize: 15, margin: 0 }}>{r.title}</h2>
                <span style={{
                  fontSize: 10,
                  textTransform: 'uppercase',
                  padding: '0.15rem 0.5rem',
                  borderRadius: 3,
                  background: r.status === 'live' ? '#0d2f1f' : '#2a2a2a',
                  color: r.status === 'live' ? '#86c7a3' : '#888',
                  border: '1px solid ' + (r.status === 'live' ? '#1c5135' : '#444'),
                }}>{r.status}</span>
              </div>
              <p style={{ color: '#888', fontSize: 12, marginTop: 8, lineHeight: 1.4 }}>{r.description}</p>
            </div>
          );
          return r.to ? <Link key={r.title} to={r.to} style={{ textDecoration: 'none', color: 'inherit' }}>{card}</Link> : card;
        })}
      </div>
    </section>
  );
}
