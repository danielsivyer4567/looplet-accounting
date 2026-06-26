import { Link } from 'react-router-dom';
import { FileSpreadsheet, Layers, TrendingUp, Coins, Calendar } from 'lucide-react';

const REPORTS = [
  {
    to: '/reports/bas',
    title: 'BAS Quarterly (GST)',
    description:
      'GST collected on sales minus GST paid on purchases, by AU fiscal quarter. Personal-flagged expenses excluded.',
    status: 'live',
    icon: Calendar,
  },
  {
    to: '/reports/cash-flow',
    title: 'Cash Flow Forecast',
    description:
      'Weekly inflows from outstanding invoices and outflows from unpaid bills. Forward visibility on bank balances.',
    status: 'live',
    icon: TrendingUp,
  },
  {
    to: null,
    title: 'P&L by Job (Export)',
    description:
      'Per-job profit & loss with attached bills, wages, overhead allocation, and revenue from invoices. PDF/CSV export.',
    status: 'planned',
    icon: FileSpreadsheet,
  },
  {
    to: '/reports/balance-sheet',
    title: 'Balance Sheet',
    description:
      'Assets (bank balances, AR), liabilities (AP, debts), equity. Approximate rollup based on bills/invoices.',
    status: 'live',
    icon: Coins,
  },
  {
    to: null,
    title: 'Tax Summary (Annual)',
    description:
      'Annual income, deductible expenses, GST summary, depreciation. Aligned to AU tax-return categories.',
    status: 'planned',
    icon: Layers,
  },
];

export function ReportsIndexPage() {
  return (
    <section className="animated-fade-in">
      <h1 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <FileSpreadsheet size={24} style={{ color: 'var(--accent-primary)' }} />
        Reports
      </h1>
      <p
        style={{
          color: 'var(--text-muted)',
          fontSize: '0.875rem',
          marginBottom: '2rem',
          maxWidth: '720px',
          lineHeight: '1.5',
        }}
      >
        Cross-cutting financial reports and summaries. Drill down into specific quarterly details or
        export raw data for compliance.
      </p>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          gap: '1.25rem',
          maxWidth: '1100px',
        }}
      >
        {REPORTS.map((r) => {
          const Icon = r.icon;
          const cardContent = (
            <div
              key={r.title}
              className="card"
              style={{
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                opacity: r.status === 'planned' ? 0.6 : 1,
                cursor: r.to ? 'pointer' : 'default',
                padding: '1.5rem',
                position: 'relative',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  marginBottom: '0.75rem',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Icon
                    size={20}
                    style={{
                      color: r.status === 'live' ? 'var(--accent-primary)' : 'var(--text-muted)',
                    }}
                  />
                  <h3 style={{ fontSize: '1rem', margin: 0, fontWeight: 700 }}>{r.title}</h3>
                </div>
                <span
                  className={`badge ${r.status === 'live' ? 'badge-success' : 'badge-neutral'}`}
                  style={{ fontSize: '0.675rem' }}
                >
                  {r.status}
                </span>
              </div>
              <p
                style={{
                  color: 'var(--text-muted)',
                  fontSize: '0.825rem',
                  margin: 0,
                  lineHeight: '1.5',
                  flexGrow: 1,
                }}
              >
                {r.description}
              </p>
            </div>
          );

          return r.to ? (
            <Link key={r.title} to={r.to} style={{ textDecoration: 'none', color: 'inherit' }}>
              {cardContent}
            </Link>
          ) : (
            cardContent
          );
        })}
      </div>
    </section>
  );
}
