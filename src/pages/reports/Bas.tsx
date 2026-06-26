import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { formatMoney } from '@/lib/money';
import { downloadCsv } from '@/lib/csv';
import { SkeletonTable } from '@/components/Skeleton';
import {
  ChevronLeft,
  Download,
  AlertTriangle,
  Calendar,
  DollarSign,
  Wallet,
  Info,
  type LucideIcon,
} from 'lucide-react';

interface BasRow {
  fy_start_year: number;
  quarter_num: number;
  quarter_start: string;
  quarter_end: string;
  due_date: string;
  gst_collected_cents: number;
  gst_paid_cents: number;
  net_gst_cents: number;
  sales_ex_gst_cents: number;
  purchases_ex_gst_cents: number;
  invoice_count: number;
  bill_count: number;
}

interface CoverageRow {
  organization_id: string;
  fy_start_year: number;
  quarter_num: number;
  bills_in_scope: number;
  bills_complete: number;
  bills_gst_estimated: number;
  coverage_pct: number;
  gst_ready: boolean;
}

const QUARTER_NAMES = ['', 'Q1 (Jul-Sep)', 'Q2 (Oct-Dec)', 'Q3 (Jan-Mar)', 'Q4 (Apr-Jun)'];

const coverageKey = (fy: number, q: number) => `${fy}-${q}`;

export function BasReportPage() {
  const { currentOrg } = useOrg();
  const [rows, setRows] = useState<BasRow[]>([]);
  const [coverage, setCoverage] = useState<Map<string, CoverageRow>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    const [bas, cov] = await Promise.all([
      supabase
        .from('v_bas_quarterly')
        .select('*')
        .eq('organization_id', currentOrg.id)
        .order('fy_start_year', { ascending: false })
        .order('quarter_num', { ascending: false }),
      supabase
        .from('v_bas_gst_coverage' as never)
        .select('*')
        .returns<CoverageRow[]>(),
    ]);
    if (bas.error) setError(bas.error.message);
    setRows((bas.data ?? []) as BasRow[]);
    const covRows = (cov.data ?? []).filter((c) => c.organization_id === currentOrg.id);
    setCoverage(new Map(covRows.map((c) => [coverageKey(c.fy_start_year, c.quarter_num), c])));
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => void refresh(), [refresh]);

  if (!currentOrg) return null;

  const today = new Date();
  const isOverdue = (due: string) => new Date(due) < today;

  const totalNet = rows.reduce((a, r) => a + r.net_gst_cents, 0);
  const totalSales = rows.reduce((a, r) => a + r.sales_ex_gst_cents, 0);
  const totalPurchases = rows.reduce((a, r) => a + r.purchases_ex_gst_cents, 0);

  const provisional = rows.filter((r) => {
    const c = coverage.get(coverageKey(r.fy_start_year, r.quarter_num));
    return c && c.bills_in_scope > 0 && !c.gst_ready;
  });

  const handleExport = () => {
    if (provisional.length > 0) {
      const labels = provisional
        .map(
          (r) =>
            `${r.fy_start_year}-${(r.fy_start_year + 1).toString().slice(2)} ${QUARTER_NAMES[r.quarter_num]}`,
        )
        .join(', ');
      const proceed = window.confirm(
        `GST data is incomplete for: ${labels}.\n\nThe GST-paid figures for these quarters are provisional and likely understated. Finish OCR / review before lodging.\n\nExport anyway?`,
      );
      if (!proceed) return;
    }
    const last = rows[0];
    if (!last) return;
    const today = new Date();
    const filename = `bas-${last.fy_start_year}-Q${last.quarter_num}-export-${today.toISOString().slice(0, 10)}.csv`;
    const exportRows = rows.map((r) => ({
      FY: `${r.fy_start_year}-${(r.fy_start_year + 1).toString().slice(2)}`,
      Quarter: QUARTER_NAMES[r.quarter_num],
      'Quarter start': r.quarter_start,
      'Quarter end': r.quarter_end,
      'Due date': r.due_date,
      'Sales ex GST': (r.sales_ex_gst_cents / 100).toFixed(2),
      'Purchases ex GST': (r.purchases_ex_gst_cents / 100).toFixed(2),
      'GST collected': (r.gst_collected_cents / 100).toFixed(2),
      'GST paid': (r.gst_paid_cents / 100).toFixed(2),
      'Net GST': (r.net_gst_cents / 100).toFixed(2),
      'Invoice count': r.invoice_count,
      'Bill count': r.bill_count,
    }));
    downloadCsv(filename, exportRows);
  };

  return (
    <section className="animated-fade-in">
      {/* Navigation & Export Action */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1rem',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        <Link
          to="/reports"
          style={{
            color: 'var(--text-muted)',
            fontSize: '0.825rem',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.25rem',
          }}
        >
          <ChevronLeft size={14} />
          <span>Reports</span>
        </Link>

        {rows.length > 0 && (
          <button
            onClick={handleExport}
            className="btn btn-secondary"
            aria-label="Export BAS data as CSV"
          >
            <Download size={14} />
            <span>Export CSV</span>
          </button>
        )}
      </div>

      <h1 style={{ margin: 0 }}>BAS Quarterly (GST)</h1>
      <p
        style={{
          color: 'var(--text-muted)',
          fontSize: '0.875rem',
          marginTop: '0.25rem',
          marginBottom: '1.5rem',
          maxWidth: '800px',
          lineHeight: '1.5',
        }}
      >
        GST collected from sales (invoices) minus GST paid on purchases (bills). Personal-flagged
        bills are excluded. Due 28 days after each quarter end.
      </p>

      {/* Provisional Warning Banner */}
      {!loading && provisional.length > 0 && (
        <div
          className="badge badge-warning"
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '0.5rem',
            padding: '0.875rem 1rem',
            marginBottom: '1.5rem',
            textTransform: 'none',
            fontSize: '0.875rem',
            lineHeight: '1.4',
            width: '100%',
            justifyContent: 'flex-start',
          }}
        >
          <AlertTriangle size={16} style={{ marginTop: '2px', flexShrink: 0 }} />
          <span>
            <strong>GST Data Incomplete:</strong> {provisional.length} quarter
            {provisional.length > 1 ? 's have' : ' has'} below 95% bill coverage. The GST-paid
            (purchases) figures are provisional and likely understated. Finish OCR / review on{' '}
            <Link
              to="/bills"
              style={{ color: 'inherit', textDecoration: 'underline', fontWeight: 600 }}
            >
              Bills
            </Link>{' '}
            before lodging.
          </span>
        </div>
      )}

      {/* KPI Cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: '1rem',
          marginBottom: '2rem',
        }}
      >
        <KpiCard
          label="Net GST (Lifetime)"
          value={formatMoney(totalNet)}
          type={totalNet > 0 ? 'danger' : 'success'}
          icon={Calendar}
          sub={totalNet > 0 ? 'owed to ATO' : 'refundable'}
        />
        <KpiCard
          label="Total Sales ex GST"
          value={formatMoney(totalSales)}
          type="success"
          icon={Wallet}
        />
        <KpiCard
          label="Total Purchases ex GST"
          value={formatMoney(totalPurchases)}
          type="neutral"
          icon={DollarSign}
        />
      </div>

      {loading ? (
        <SkeletonTable rows={4} cols={10} />
      ) : error ? (
        <div
          className="badge badge-danger"
          style={{ display: 'block', padding: '1rem', textTransform: 'none' }}
        >
          {error}
        </div>
      ) : rows.length === 0 ? (
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
          No BAS data yet. Issue invoices and process bills to start a BAS rollup.
        </div>
      ) : (
        <div className="table-premium-container">
          <table className="table-premium">
            <thead>
              <tr>
                <th>FY</th>
                <th>Quarter</th>
                <th>Period</th>
                <th>Due Date</th>
                <th style={{ textAlign: 'right' }}>Sales ex GST</th>
                <th style={{ textAlign: 'right' }}>Purchases ex GST</th>
                <th style={{ textAlign: 'right' }}>GST Collected</th>
                <th style={{ textAlign: 'right' }}>GST Paid</th>
                <th style={{ textAlign: 'right' }}>Net GST</th>
                <th style={{ textAlign: 'right' }}>Bill Coverage</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.fy_start_year}-${r.quarter_num}`}>
                  <td>
                    {r.fy_start_year}-{(r.fy_start_year + 1).toString().slice(2)}
                  </td>
                  <td style={{ fontWeight: 600 }}>{QUARTER_NAMES[r.quarter_num]}</td>
                  <td>
                    <code style={{ fontSize: '0.75rem' }}>
                      {r.quarter_start} → {r.quarter_end}
                    </code>
                  </td>
                  <td>
                    {r.due_date}
                    {isOverdue(r.due_date) && r.net_gst_cents > 0 && (
                      <span
                        className="badge badge-danger"
                        style={{
                          marginLeft: '0.5rem',
                          padding: '0.15rem 0.35rem',
                          fontSize: '0.625rem',
                        }}
                      >
                        OVERDUE
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>{formatMoney(r.sales_ex_gst_cents)}</td>
                  <td style={{ textAlign: 'right' }}>{formatMoney(r.purchases_ex_gst_cents)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--text-success)' }}>
                    {formatMoney(r.gst_collected_cents)}
                  </td>
                  <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>
                    {formatMoney(r.gst_paid_cents)}
                  </td>
                  <td
                    style={{
                      textAlign: 'right',
                      fontWeight: 700,
                      color: r.net_gst_cents > 0 ? 'var(--text-danger)' : 'var(--text-success)',
                    }}
                  >
                    {formatMoney(r.net_gst_cents)}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {renderCoverage(coverage.get(coverageKey(r.fy_start_year, r.quarter_num)))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Info Callout */}
      <div
        className="card"
        style={{
          marginTop: '2.5rem',
          background: 'var(--bg-hover)',
          border: '1px dashed var(--border-subtle)',
          padding: '1.25rem',
          display: 'flex',
          gap: '0.75rem',
          alignItems: 'flex-start',
        }}
      >
        <Info
          size={16}
          style={{ flexShrink: 0, color: 'var(--accent-primary)', marginTop: '2px' }}
        />
        <div style={{ fontSize: '0.825rem', color: 'var(--text-muted)', lineHeight: '1.5' }}>
          <span
            style={{
              fontWeight: 600,
              color: 'var(--text-title)',
              display: 'block',
              marginBottom: '0.25rem',
            }}
          >
            BAS Reporting Details
          </span>
          Future updates will support PAYG withholding rollup calculations, ATO BAS lodgement SBR
          integrations, and year-over-year comparative charts.
        </div>
      </div>
    </section>
  );
}

function renderCoverage(c: CoverageRow | undefined) {
  if (!c || c.bills_in_scope === 0) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  const badgeClass = c.gst_ready ? 'badge-success' : 'badge-warning';
  return (
    <span
      className={`badge ${badgeClass}`}
      style={{
        textTransform: 'none',
        padding: '0.25rem 0.5rem',
        display: 'inline-flex',
        gap: '0.25rem',
        alignItems: 'center',
      }}
      title={`${c.bills_complete}/${c.bills_in_scope} bills with amount+GST${c.bills_gst_estimated > 0 ? ` · ${c.bills_gst_estimated} GST estimated` : ''}`}
    >
      {c.gst_ready ? '✓ ' : '⚠ '}
      <span>{c.coverage_pct}%</span>
    </span>
  );
}

function KpiCard({
  label,
  value,
  type,
  icon: Icon,
  sub,
}: {
  label: string;
  value: string;
  type: 'success' | 'danger' | 'warning' | 'info' | 'neutral';
  icon: LucideIcon;
  sub?: string;
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
        {value}
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
