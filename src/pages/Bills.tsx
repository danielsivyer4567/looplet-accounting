import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useOrg } from '@/hooks/useOrg';
import { useBills, type BillListRow } from '@/hooks/useBills';
import { enqueueJob } from '@/lib/automationJobs';
import { formatMoney, formatMoneyCompact } from '@/lib/money';
import { SkeletonTable } from '@/components/Skeleton';
import { XeroStatusPill } from '@/components/XeroStatusPill';
import { DocumentPreviewModal } from '@/components/DocumentPreviewModal';
import { InsightAreaChart, InsightBarList, InsightPanel } from '@/components/InsightCharts';
import { AnimatedNumber } from '@/components/AnimatedNumber';
import { ConfidenceBadge } from '@/components/ConfidenceBadge';
import type { AutomationConfidence } from '@/lib/automationDecision';
import { AllocationQueuePanel } from '@/components/AllocationQueuePanel';
import { LoadMoreButton } from '@/components/LoadMoreButton';
import {
  Plus,
  Eye,
  AlertTriangle,
  FileText,
  Wallet,
  DollarSign,
  type LucideIcon,
} from 'lucide-react';

const filters: { label: string; value: BillListRow['status'] | null }[] = [
  { label: 'All Bills', value: null },
  { label: 'Received', value: 'received' },
  { label: 'Verified', value: 'verified' },
  { label: 'Attached', value: 'attached' },
  { label: 'Paid', value: 'paid' },
];

export function BillsPage() {
  const { currentOrg } = useOrg();
  const [filter, setFilter] = useState<BillListRow['status'] | null>(null);
  const [showNonBills, setShowNonBills] = useState(false);
  const { bills, loading, loadingMore, error, refresh, hasMore, loadMore } = useBills(
    filter ?? undefined,
    100,
    showNonBills,
  );
  const [repushingId, setRepushingId] = useState<string | null>(null);
  const [previewBill, setPreviewBill] = useState<BillListRow | null>(null);
  const navigate = useNavigate();

  const handleRepush = async (bill: BillListRow) => {
    if (!currentOrg) return;
    setRepushingId(bill.id);
    try {
      await enqueueJob({
        organizationId: currentOrg.id,
        jobKind: 'xero_push',
        sourceKind: 'bill',
        sourceId: bill.id,
        priority: 4,
        payload: { bill_id: bill.id, source: 'bill_repush' },
      });
      await refresh();
    } finally {
      setRepushingId(null);
    }
  };

  if (!currentOrg) {
    return (
      <section className="animated-fade-in">
        <h1>Bills</h1>
        <p style={{ color: 'var(--text-muted)' }}>Pick an organisation to see bills.</p>
      </section>
    );
  }

  // Aggregate KPIs
  const totalBilled = bills.reduce((a, b) => a + (b.total_inc_gst_cents ?? 0), 0);
  const totalPaid = bills
    .filter((b) => b.status === 'paid')
    .reduce((a, b) => a + (b.total_inc_gst_cents ?? 0), 0);
  const totalOutstanding = bills
    .filter((b) => b.status !== 'paid' && b.status !== 'void')
    .reduce((a, b) => a + (b.total_inc_gst_cents ?? 0), 0);

  // Supplier Mix (Top 5) - creative classification
  const supplierSpendMap = new Map<string, number>();
  bills.forEach((b) => {
    const name = b.supplier_name_raw?.trim() || 'Unknown Supplier';
    const cents = b.total_inc_gst_cents ?? 0;
    supplierSpendMap.set(name, (supplierSpendMap.get(name) || 0) + cents);
  });
  const supplierSpendItems = Array.from(supplierSpendMap.entries())
    .map(([label, value]) => ({
      label,
      value,
      displayValue: formatMoneyCompact(value),
      tone: 'danger' as const,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);

  // Chronological trends for Bills
  let runningPayableCents = 0;
  let runningBilledCents = 0;
  let runningPaidCents = 0;

  const billsChronological = bills
    .filter((b) => b.invoice_date)
    .slice()
    .sort((a, b) => (a.invoice_date || '').localeCompare(b.invoice_date || ''));

  const payableTrendItems = billsChronological.length
    ? billsChronological.map((b) => {
        if (b.status !== 'paid' && b.status !== 'void') {
          runningPayableCents += b.total_inc_gst_cents ?? 0;
        }
        return {
          label: new Date(b.invoice_date || '').toLocaleDateString('en-AU', {
            day: '2-digit',
            month: 'short',
          }),
          value: runningPayableCents,
        };
      })
    : [{ label: 'No bills', value: 0 }];

  const billedTrendItems = billsChronological.map((b) => {
    runningBilledCents += b.total_inc_gst_cents ?? 0;
    return {
      label: new Date(b.invoice_date || '').toLocaleDateString('en-AU', {
        day: '2-digit',
        month: 'short',
      }),
      value: runningBilledCents,
    };
  });

  const paidTrendItems = billsChronological.map((b) => {
    if (b.status === 'paid') {
      runningPaidCents += b.total_inc_gst_cents ?? 0;
    }
    return {
      label: new Date(b.invoice_date || '').toLocaleDateString('en-AU', {
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
        <h1 style={{ margin: 0 }}>Bills</h1>
        <Link to="/bills/upload" className="btn btn-primary">
          <Plus size={16} />
          <span>Upload bill</span>
        </Link>
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
          label="Total Billed"
          value={totalBilled}
          type="neutral"
          icon={FileText}
          formatter={formatMoney}
        />
        <Kpi
          label="Total Paid"
          value={totalPaid}
          type="success"
          icon={Wallet}
          sub={`${bills.filter((b) => b.status === 'paid').length} bills`}
          formatter={formatMoney}
        />
        <Kpi
          label="Outstanding AP"
          value={totalOutstanding}
          type={totalOutstanding > 0 ? 'danger' : 'neutral'}
          icon={DollarSign}
          formatter={formatMoney}
        />
      </div>

      {/* Charts Section */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: '1rem',
          marginBottom: '1.5rem',
        }}
      >
        <InsightPanel title="Payable pulse" eyebrow="Cash outflow obligations">
          <InsightAreaChart
            title="Open AP drift"
            items={payableTrendItems}
            tone={totalOutstanding > 0 ? 'danger' : 'success'}
            series={[
              { label: 'Received', items: billedTrendItems, tone: 'warning' },
              { label: 'Paid', items: paidTrendItems, tone: 'success' },
            ]}
            markerLabel="Outstanding"
            formatValue={formatMoneyCompact}
          />
        </InsightPanel>
        <InsightPanel title="Supplier mix" eyebrow="Top supplier spend">
          <InsightBarList items={supplierSpendItems} formatValue={formatMoneyCompact} />
        </InsightPanel>
      </div>

      <AllocationQueuePanel />

      {/* Filter and Option controls */}
      <div
        style={{
          display: 'flex',
          gap: '1rem',
          marginBottom: '1.5rem',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          background: 'var(--bg-panel)',
          padding: '0.75rem 1rem',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        {/* Status segmented controls */}
        <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
          {filters.map((f) => (
            <button
              key={f.label}
              onClick={() => setFilter(f.value)}
              className="btn"
              style={{
                padding: '0.35rem 0.75rem',
                fontSize: '0.75rem',
                fontWeight: 600,
                borderRadius: 'var(--radius-sm)',
                background: filter === f.value ? 'var(--accent-primary)' : 'transparent',
                color: filter === f.value ? 'var(--text-on-accent)' : 'var(--text-muted)',
                border: 'none',
              }}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Checkbox item */}
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            fontSize: '0.825rem',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            fontWeight: 500,
          }}
          title="Show documents the intake classifier flagged as non-invoices (logos, photos, screenshots)"
        >
          <input
            type="checkbox"
            checked={showNonBills}
            onChange={(e) => setShowNonBills(e.target.checked)}
            style={{ cursor: 'pointer' }}
          />
          Show non-invoices
        </label>
      </div>

      {loading ? (
        <SkeletonTable rows={6} cols={7} />
      ) : error ? (
        <div
          className="badge badge-danger"
          style={{ display: 'block', padding: '0.75rem', textTransform: 'none' }}
        >
          Failed: {error}
        </div>
      ) : bills.length === 0 ? (
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
          No bills found{filter ? ` with status "${filter}"` : ''}.
        </div>
      ) : (
        <>
          <div className="bills-table-view table-premium-container">
            <table className="table-premium">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Supplier</th>
                  <th>Invoice #</th>
                  <th>Job</th>
                  <th style={{ textAlign: 'right' }}>Total</th>
                  <th>Status</th>
                  <th>Conf.</th>
                  <th>Xero</th>
                  <th style={{ width: '80px' }}>Doc</th>
                </tr>
              </thead>
              <tbody>
                {bills.map((b) => (
                  <tr
                    key={b.id}
                    style={{ cursor: 'pointer' }}
                    onClick={() => navigate(`/bills/${b.id}`)}
                  >
                    <td style={{ whiteSpace: 'nowrap' }}>{b.invoice_date ?? '—'}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{ fontWeight: 600, color: 'var(--text-title)' }}>
                          {b.supplier_name_raw ?? (
                            <span style={{ color: 'var(--text-muted)' }}>—</span>
                          )}
                        </span>
                        {b.is_probable_bill === false && (
                          <span
                            className="badge badge-danger"
                            style={{
                              fontSize: '9px',
                              padding: '1px 5px',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '2px',
                            }}
                            title="Classified by intake as not an invoice"
                          >
                            <AlertTriangle size={10} />
                            {b.document_kind ?? 'non-invoice'}
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      {b.attached_job?.job_number ? (
                        <code style={{ color: 'var(--accent-success)', fontWeight: 600 }}>
                          {b.attached_job.job_number}
                        </code>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>
                      {formatMoney(b.total_inc_gst_cents)}
                    </td>
                    <td>
                      <StatusBadge status={b.status} />
                    </td>
                    <td>
                      {b.automation_confidence ? (
                        <ConfidenceBadge
                          confidence={b.automation_confidence as AutomationConfidence}
                        />
                      ) : (
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>—</span>
                      )}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <XeroStatusPill
                        xeroStatus={b.xero_status}
                        onRepush={() => handleRepush(b)}
                        repushBusy={repushingId === b.id}
                      />
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => setPreviewBill(b)}
                        title="View source document"
                        className="btn btn-secondary"
                        style={{
                          padding: '0.25rem 0.5rem',
                          fontSize: '0.725rem',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.25rem',
                        }}
                      >
                        <Eye size={12} />
                        <span>View</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="bills-card-view" aria-label="Bill cards">
            {bills.map((b) => (
              <BillCard
                key={b.id}
                bill={b}
                repushBusy={repushingId === b.id}
                onOpen={() => navigate(`/bills/${b.id}`)}
                onRepush={() => handleRepush(b)}
                onPreview={() => setPreviewBill(b)}
              />
            ))}
          </div>
          {hasMore && (
            <LoadMoreButton
              label="Load more bills"
              loading={loadingMore}
              onClick={() => void loadMore()}
            />
          )}
        </>
      )}
      <DocumentPreviewModal bill={previewBill} onClose={() => setPreviewBill(null)} />
    </section>
  );
}

function BillCard({
  bill,
  repushBusy,
  onOpen,
  onRepush,
  onPreview,
}: {
  bill: BillListRow;
  repushBusy: boolean;
  onOpen: () => void;
  onRepush: () => void;
  onPreview: () => void;
}) {
  return (
    <article className="bill-mobile-card card" aria-label={`Bill ${bill.supplier_name_raw ?? 'unknown supplier'}`}>
      <div className="bill-mobile-card__header">
        <div>
          <a
            href={`/bills/${bill.id}`}
            onClick={(e) => {
              e.preventDefault();
              onOpen();
            }}
            style={{ fontWeight: 700, color: 'var(--accent-primary)', textDecoration: 'none' }}
          >
            {bill.supplier_name_raw ?? 'Unknown supplier'}
          </a>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: '0.15rem' }}>
            {bill.invoice_date ?? 'No date'}
            {bill.attached_job?.job_number ? ` · ${bill.attached_job.job_number}` : ''}
          </div>
          {bill.is_probable_bill === false && (
            <span
              className="badge badge-danger"
              style={{ fontSize: '9px', padding: '1px 5px', marginTop: '0.25rem', display: 'inline-flex', alignItems: 'center', gap: '2px' }}
              title="Classified by intake as not an invoice"
            >
              <AlertTriangle size={10} />
              {bill.document_kind ?? 'non-invoice'}
            </span>
          )}
        </div>
        <StatusBadge status={bill.status} />
      </div>

      <div className="bill-mobile-card__metrics">
        <div>
          <span>Total</span>
          <strong>{formatMoney(bill.total_inc_gst_cents)}</strong>
        </div>
        <div>
          <span>Confidence</span>
          <strong>
            {bill.automation_confidence ? (
              <ConfidenceBadge confidence={bill.automation_confidence as AutomationConfidence} />
            ) : (
              '—'
            )}
          </strong>
        </div>
      </div>

      <div className="bill-mobile-card__row">
        <span>Xero</span>
        <XeroStatusPill xeroStatus={bill.xero_status} onRepush={onRepush} repushBusy={repushBusy} />
      </div>

      <div className="bill-mobile-card__actions">
        <button
          onClick={onPreview}
          title="View source document"
          className="btn btn-secondary"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
        >
          <Eye size={14} />
          <span>View document</span>
        </button>
      </div>
    </article>
  );
}

function StatusBadge({ status }: { status: BillListRow['status'] }) {
  let badgeClass = 'badge-neutral';
  if (status === 'received') badgeClass = 'badge-neutral';
  else if (status === 'verified') badgeClass = 'badge-warning';
  else if (status === 'attached') badgeClass = 'badge-success';
  else if (status === 'paid') badgeClass = 'badge-info';

  return <span className={`badge ${badgeClass}`}>{status}</span>;
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
