import { Link, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useInvoices, type InvoiceListRow } from '@/hooks/useInvoices';
import { useOrg } from '@/hooks/useOrg';
import { formatLoadError } from '@/lib/errorMessages';
import { formatMoney, formatMoneyCompact } from '@/lib/money';
import { SkeletonCard, SkeletonTable } from '@/components/Skeleton';
import { InsightAreaChart, InsightBarList, InsightPanel } from '@/components/InsightCharts';
import { AnimatedNumber } from '@/components/AnimatedNumber';
import { LoadMoreButton } from '@/components/LoadMoreButton';
import { FileText, Plus, DollarSign, Wallet, Clock, type LucideIcon } from 'lucide-react';

const STATUS_FILTERS = [
  'all',
  'draft',
  'sent',
  'partially_paid',
  'paid',
  'overdue',
  'void',
] as const;
type Filter = (typeof STATUS_FILTERS)[number];

export function InvoicesPage() {
  const { currentOrg } = useOrg();
  const [filter, setFilter] = useState<Filter>('all');
  const { invoices, loading, loadingMore, error, hasMore, loadMore } = useInvoices(
    filter === 'all' ? undefined : { status: filter },
  );
  const navigate = useNavigate();

  if (!currentOrg) {
    return (
      <section className="animated-fade-in">
        <h1>Invoices</h1>
        <p style={{ color: 'var(--text-muted)' }}>Pick an organisation to see invoices.</p>
      </section>
    );
  }

  // Aggregate KPIs over the *full* (unfiltered) result
  const totalInvoiced = invoices.reduce((a, i) => a + (i.total_inc_gst_cents ?? 0), 0);
  const totalPaid = invoices.reduce((a, i) => a + (i.amount_paid_cents ?? 0), 0);
  const totalOwing = invoices.reduce((a, i) => a + (i.balance_due_cents ?? 0), 0);
  const overdueCount = invoices.filter((i) => i.status === 'overdue').length;
  const statusItems = STATUS_FILTERS.filter((status) => status !== 'all').map(
    (status) =>
      ({
        label: status.replace('_', ' '),
        value: invoices.filter((invoice) => invoice.status === status).length,
        displayValue: `${invoices.filter((invoice) => invoice.status === status).length} invoices`,
        tone:
          status === 'paid'
            ? 'success'
            : status === 'overdue'
              ? 'danger'
              : status === 'partially_paid'
                ? 'warning'
                : status === 'sent'
                  ? 'info'
                  : 'neutral',
      }) as const,
  );
  const receivableItems = [
    {
      label: 'Total invoiced',
      value: totalInvoiced,
      displayValue: formatMoneyCompact(totalInvoiced),
      tone: 'info' as const,
    },
    {
      label: 'Collected',
      value: totalPaid,
      displayValue: formatMoneyCompact(totalPaid),
      tone: 'success' as const,
    },
    {
      label: 'Still owing',
      value: totalOwing,
      displayValue: formatMoneyCompact(totalOwing),
      tone: totalOwing > 0 ? ('warning' as const) : ('success' as const),
    },
  ];
  let runningReceivableCents = 0;
  let runningInvoicedCents = 0;
  let runningPaidCents = 0;
  const invoiceTrendSource = invoices
    .slice()
    .sort((a, b) => a.issue_date.localeCompare(b.issue_date));
  const receivableTrendItems = invoices.length
    ? invoiceTrendSource.map((invoice) => {
        runningReceivableCents += invoice.balance_due_cents ?? 0;
        return {
          label: new Date(invoice.issue_date).toLocaleDateString('en-AU', {
            day: '2-digit',
            month: 'short',
          }),
          value: runningReceivableCents,
        };
      })
    : [{ label: 'No invoices', value: 0 }];
  const invoicedTrendItems = invoiceTrendSource.map((invoice) => {
    runningInvoicedCents += invoice.total_inc_gst_cents ?? 0;
    return {
      label: new Date(invoice.issue_date).toLocaleDateString('en-AU', {
        day: '2-digit',
        month: 'short',
      }),
      value: runningInvoicedCents,
    };
  });
  const paidTrendItems = invoiceTrendSource.map((invoice) => {
    runningPaidCents += invoice.amount_paid_cents ?? 0;
    return {
      label: new Date(invoice.issue_date).toLocaleDateString('en-AU', {
        day: '2-digit',
        month: 'short',
      }),
      value: runningPaidCents,
    };
  });

  return (
    <section className="animated-fade-in">
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
        <h1 style={{ margin: 0 }}>Invoices</h1>
        <button onClick={() => navigate('/invoices/new')} className="btn btn-primary">
          <Plus size={16} />
          <span>Raise invoice</span>
        </button>
      </div>

      {/* KPIs Section */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '1rem',
          marginBottom: '1.5rem',
        }}
      >
        <Kpi
          label="Total invoiced"
          value={totalInvoiced}
          type="info"
          icon={FileText}
          formatter={formatMoney}
        />
        <Kpi
          label="Total paid"
          value={totalPaid}
          type="success"
          icon={Wallet}
          sub={`${invoices.length} invoices`}
          formatter={formatMoney}
        />
        <Kpi
          label="Outstanding"
          value={totalOwing}
          type={totalOwing > 0 ? 'warning' : 'neutral'}
          icon={DollarSign}
          formatter={formatMoney}
        />
        <Kpi
          label="Overdue"
          value={overdueCount}
          type={overdueCount > 0 ? 'danger' : 'neutral'}
          icon={Clock}
          sub={overdueCount > 0 ? 'Needs chasing' : 'All good'}
        />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: '1rem',
          marginBottom: '1.5rem',
        }}
      >
        <InsightPanel title="Receivable pulse" eyebrow="Cash conversion">
          <InsightAreaChart
            title="Open AR drift"
            items={receivableTrendItems}
            tone={totalOwing > 0 ? 'warning' : 'success'}
            series={[
              { label: 'Invoiced', items: invoicedTrendItems, tone: 'info' },
              { label: 'Collected', items: paidTrendItems, tone: 'success' },
            ]}
            markerLabel="Visible"
            formatValue={formatMoneyCompact}
          />
        </InsightPanel>
        <InsightPanel title="Invoice shape" eyebrow="Visible AR">
          <InsightBarList
            items={[...receivableItems, ...statusItems.filter((item) => item.value > 0)]}
            formatValue={formatMoneyCompact}
          />
        </InsightPanel>
      </div>

      {/* Filter Buttons Segment */}
      <div
        style={{
          marginBottom: '1.5rem',
          display: 'flex',
          gap: '0.35rem',
          flexWrap: 'wrap',
          background: 'var(--bg-panel)',
          padding: '0.35rem',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border-subtle)',
          width: 'fit-content',
        }}
      >
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className="btn"
            style={{
              padding: '0.35rem 0.75rem',
              fontSize: '0.75rem',
              fontWeight: 600,
              textTransform: 'capitalize',
              borderRadius: 'var(--radius-sm)',
              background: filter === s ? 'var(--accent-primary)' : 'transparent',
              color: filter === s ? 'var(--text-on-accent)' : 'var(--text-muted)',
              border: 'none',
              boxShadow: filter === s ? 'var(--shadow-sm)' : 'none',
            }}
          >
            {s.replace('_', ' ')}
          </button>
        ))}
      </div>

      {loading ? (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: '1rem',
              marginTop: '1.5rem',
            }}
          >
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
          <div style={{ marginTop: '1.5rem' }}>
            <SkeletonTable rows={6} cols={9} />
          </div>
        </>
      ) : error ? (
        <div
          role="alert"
          className="badge badge-danger"
          style={{ display: 'block', padding: '0.75rem', textTransform: 'none' }}
        >
          {formatLoadError('invoices', error)}
        </div>
      ) : invoices.length === 0 ? (
        <div
          style={{
            padding: '2.5rem',
            background: 'var(--bg-card)',
            border: '1px dashed var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--text-muted)',
            textAlign: 'center',
            fontSize: '0.9rem',
          }}
        >
          No invoices yet. Raise one to start tracking Accounts Receivable.
        </div>
      ) : (
        <>
          <div className="invoices-table-view table-premium-container">
            <table className="table-premium">
              <thead>
                <tr>
                  <th>Invoice #</th>
                  <th>Customer</th>
                  <th>Job</th>
                  <th>Issued</th>
                  <th>Due</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right' }}>Total</th>
                  <th style={{ textAlign: 'right' }}>Paid</th>
                  <th style={{ textAlign: 'right' }}>Balance</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr
                    key={inv.id}
                    style={{ cursor: 'pointer' }}
                    onClick={() => navigate(`/invoices/${inv.id}`)}
                  >
                    <td>
                      <code style={{ fontSize: '0.775rem' }}>{inv.invoice_number}</code>
                    </td>
                    <td style={{ fontWeight: 600, color: 'var(--text-title)' }}>
                      {inv.customer?.name ?? <span style={{ color: 'var(--text-muted)' }}>—</span>}
                    </td>
                    <td>
                      {inv.job ? (
                        <Link
                          to={`/jobs/${inv.job.id}`}
                          onClick={(e) => e.stopPropagation()}
                          style={{
                            fontWeight: 600,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.25rem',
                          }}
                        >
                          <code>{inv.job.job_number}</code>
                        </Link>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      )}
                    </td>
                    <td>{inv.issue_date}</td>
                    <td>{inv.due_date}</td>
                    <td>
                      <StatusPill status={inv.status} />
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>
                      {formatMoney(inv.total_inc_gst_cents)}
                    </td>
                    <td style={{ textAlign: 'right', color: 'var(--text-success)' }}>
                      {formatMoney(inv.amount_paid_cents)}
                    </td>
                    <td
                      style={{
                        textAlign: 'right',
                        fontWeight: 700,
                        color:
                          inv.balance_due_cents > 0 ? 'var(--text-warning)' : 'var(--text-success)',
                      }}
                    >
                      {formatMoney(inv.balance_due_cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="invoices-card-view" aria-label="Invoice cards">
            {invoices.map((inv) => (
              <InvoiceCard
                key={inv.id}
                invoice={inv}
                onOpen={() => navigate(`/invoices/${inv.id}`)}
              />
            ))}
          </div>
          {hasMore && (
            <LoadMoreButton
              label="Load more invoices"
              loading={loadingMore}
              onClick={() => void loadMore()}
            />
          )}
        </>
      )}
    </section>
  );
}

function InvoiceCard({ invoice, onOpen }: { invoice: InvoiceListRow; onOpen: () => void }) {
  return (
    <article className="invoice-mobile-card card" aria-label={`Invoice ${invoice.invoice_number}`}>
      <div className="invoice-mobile-card__header">
        <div>
          <a
            href={`/invoices/${invoice.id}`}
            onClick={(e) => {
              e.preventDefault();
              onOpen();
            }}
            style={{ fontWeight: 700, color: 'var(--accent-primary)', textDecoration: 'none' }}
          >
            <code>{invoice.invoice_number}</code>
          </a>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: '0.15rem' }}>
            {invoice.customer?.name ?? 'No customer'}
            {invoice.job ? ` · ${invoice.job.job_number}` : ''}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem', marginTop: '0.15rem' }}>
            Issued {invoice.issue_date} · Due {invoice.due_date}
          </div>
        </div>
        <StatusPill status={invoice.status} />
      </div>
      <div className="invoice-mobile-card__metrics">
        <div>
          <span>Total</span>
          <strong>{formatMoney(invoice.total_inc_gst_cents)}</strong>
        </div>
        <div>
          <span>Paid</span>
          <strong style={{ color: 'var(--text-success)' }}>
            {formatMoney(invoice.amount_paid_cents)}
          </strong>
        </div>
        <div>
          <span>Balance</span>
          <strong
            style={{
              color: invoice.balance_due_cents > 0 ? 'var(--text-warning)' : 'var(--text-success)',
            }}
          >
            {formatMoney(invoice.balance_due_cents)}
          </strong>
        </div>
      </div>
    </article>
  );
}

function Kpi({
  label,
  value,
  type,
  icon: Icon,
  sub,
  formatter = (v: number) => v.toLocaleString(),
}: {
  label: string;
  value: number;
  type: 'success' | 'danger' | 'warning' | 'info' | 'neutral';
  icon: LucideIcon;
  sub?: string;
  formatter?: (val: number) => string;
}) {
  return (
    <div
      className="card"
      style={{
        padding: '1.25rem',
        borderLeft: `4px solid var(--accent-${type === 'neutral' ? 'primary' : type})`,
        position: 'relative',
      }}
    >
      <div
        style={{
          fontSize: '0.675rem',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          fontWeight: 700,
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: '0.35rem',
          fontSize: '1.5rem',
          color: 'var(--text-title)',
          fontWeight: 800,
          fontFamily: 'var(--font-title)',
        }}
      >
        <AnimatedNumber value={value} formatter={formatter} />
      </div>
      {sub ? (
        <div style={{ marginTop: '0.25rem', fontSize: '0.725rem', color: 'var(--text-muted)' }}>
          {sub}
        </div>
      ) : (
        <div style={{ height: '0.725rem', marginTop: '0.25rem' }} />
      )}
      <div
        style={{
          position: 'absolute',
          right: '1rem',
          bottom: '1rem',
          color: `var(--accent-${type === 'neutral' ? 'primary' : type})`,
          opacity: 0.7,
        }}
      >
        <Icon size={18} />
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  let badgeClass = 'badge-neutral';
  if (status === 'paid') badgeClass = 'badge-success';
  else if (status === 'sent') badgeClass = 'badge-info';
  else if (status === 'partially_paid') badgeClass = 'badge-warning';
  else if (status === 'overdue') badgeClass = 'badge-danger';

  return <span className={`badge ${badgeClass}`}>{status.replace('_', ' ')}</span>;
}
