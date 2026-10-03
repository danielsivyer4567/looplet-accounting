import { Link, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { useInvoices, type InvoiceListRow } from '@/hooks/useInvoices';
import { useOrg } from '@/hooks/useOrg';
import { formatLoadError } from '@/lib/errorMessages';
import { formatMoney, formatMoneyCompact } from '@/lib/money';
import { SkeletonCard, SkeletonTable } from '@/components/Skeleton';
import { InsightAreaChart, InsightBarList, InsightPanel } from '@/components/InsightCharts';
import { LoadMoreButton } from '@/components/LoadMoreButton';
import { FileText, Plus, DollarSign, Wallet, Clock } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { Stat } from '@/components/ui/Stat';
import { StatusBadge } from '@/components/ui/StatusBadge';

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

  // Aggregate KPIs over the invoices loaded so far (paginated — see loadedSub label)
  const totalInvoiced = invoices.reduce((a, i) => a + (i.total_inc_gst_cents ?? 0), 0);
  const loadedSub = hasMore ? `first ${invoices.length} loaded — partial total` : undefined;
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
        <PageHeader title="Invoices" />
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
        <Stat
          label="Total invoiced"
          value={totalInvoiced}
          tone="info"
          icon={FileText}
          sub={loadedSub}
          formatter={formatMoney}
        />
        <Stat
          label="Total paid"
          value={totalPaid}
          tone="success"
          icon={Wallet}
          sub={loadedSub ?? `${invoices.length} invoices`}
          formatter={formatMoney}
        />
        <Stat
          label="Outstanding"
          value={totalOwing}
          tone={totalOwing > 0 ? 'warning' : 'neutral'}
          icon={DollarSign}
          sub={loadedSub}
          formatter={formatMoney}
        />
        <Stat
          label="Overdue"
          value={overdueCount}
          tone={overdueCount > 0 ? 'danger' : 'neutral'}
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
        <EmptyState>No invoices yet. Raise one to start tracking Accounts Receivable.</EmptyState>
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
                      <StatusBadge status={inv.status} />
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
            style={{ fontWeight: 700, color: 'var(--text-link)', textDecoration: 'none' }}
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
        <StatusBadge status={invoice.status} />
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
