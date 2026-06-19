import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';
import { formatMoney } from '@/lib/money';
import { downloadCsv } from '@/lib/csv';
import { SkeletonTable } from '@/components/Skeleton';

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

// v_bas_gst_coverage — not in generated types yet, queried via cast below.
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
      // View absent from generated types — relation cast to `never`, result
      // shape set via .returns<T>(). RLS (security_invoker) already scopes to
      // the caller's orgs; we filter to the current org client-side below.
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

  // BAS readiness gate: quarters whose bills are below 95% amount+GST coverage
  // produce understated GST-paid figures — flag them before lodgement.
  const provisional = rows.filter((r) => {
    const c = coverage.get(coverageKey(r.fy_start_year, r.quarter_num));
    return c && c.bills_in_scope > 0 && !c.gst_ready;
  });

  const handleExport = () => {
    if (provisional.length > 0) {
      const labels = provisional
        .map((r) => `${r.fy_start_year}-${(r.fy_start_year + 1).toString().slice(2)} ${QUARTER_NAMES[r.quarter_num]}`)
        .join(', ');
      const proceed = window.confirm(
        `GST data is incomplete for: ${labels}.\n\nThe GST-paid figures for these quarters are provisional and likely understated. Finish OCR / review before lodging.\n\nExport anyway?`,
      );
      if (!proceed) return;
    }
    const last = rows[0];
    if (!last) return;
    const today = new Date();
    // Use the most recent row's quarter label for the filename
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
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <Link to="/reports" style={{ color: '#86c7a3', fontSize: 13 }}>&larr; Reports</Link>
        {rows.length > 0 && (
          <button onClick={handleExport} style={exportBtn} aria-label="Export BAS data as CSV">
            &#8659; Export CSV
          </button>
        )}
      </div>
      <h1 style={{ marginTop: '0.5rem' }}>BAS quarterly</h1>
      <p style={{ color: '#888', fontSize: 13 }}>
        GST collected from sales (invoices) minus GST paid on purchases (bills).
        Personal-flagged bills are excluded. Due 28 days after each quarter end.
      </p>

      {!loading && provisional.length > 0 && (
        <div style={{ marginTop: 16, padding: 12, background: '#2a1f0e', border: '1px solid #6b5320', borderRadius: 4, color: '#e9c46a', fontSize: 13 }}>
          <strong>GST data incomplete.</strong> {provisional.length} quarter{provisional.length > 1 ? 's are' : ' is'} below 95% bill coverage,
          so the GST-paid (purchases) figures are provisional and likely understated. Finish OCR /
          review on{' '}
          <Link to="/bills" style={{ color: '#e9c46a', textDecoration: 'underline' }}>Bills</Link>{' '}
          before lodging.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, maxWidth: 900, marginTop: 16 }}>
        <Kpi label="Net GST (lifetime)" value={formatMoney(totalNet)} colour={totalNet > 0 ? '#e9a3a3' : '#86c7a3'} sub={totalNet > 0 ? 'owed to ATO' : 'refundable'} />
        <Kpi label="Total sales ex GST" value={formatMoney(totalSales)} colour="#86c7a3" />
        <Kpi label="Total purchases ex GST" value={formatMoney(totalPurchases)} colour="#aaa" />
      </div>

      {loading ? (
        <div style={{ marginTop: 16 }}>
          <SkeletonTable rows={4} cols={9} />
        </div>
      ) : error ? (
        <p style={{ color: 'salmon', marginTop: 16 }}>{error}</p>
      ) : rows.length === 0 ? (
        <div style={{ marginTop: 24, padding: 16, background: '#0e0e0e', border: '1px dashed #2a2a2a', borderRadius: 4, color: '#888', fontSize: 13 }}>
          No data yet. Issue some invoices and process some bills to start a BAS rollup.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 16 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
                <th style={th}>FY</th>
                <th style={th}>Quarter</th>
                <th style={th}>Period</th>
                <th style={th}>Due</th>
                <th style={thRight}>Sales ex GST</th>
                <th style={thRight}>Purchases ex GST</th>
                <th style={thRight}>GST collected</th>
                <th style={thRight}>GST paid</th>
                <th style={thRight}>Net GST</th>
                <th style={thRight}>Bill coverage</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.fy_start_year}-${r.quarter_num}`} style={{ borderBottom: '1px solid #1a1a1a' }}>
                  <td style={td}>{r.fy_start_year}-{(r.fy_start_year + 1).toString().slice(2)}</td>
                  <td style={td}><strong>{QUARTER_NAMES[r.quarter_num]}</strong></td>
                  <td style={td}><code style={{ color: '#888', fontSize: 11 }}>{r.quarter_start} → {r.quarter_end}</code></td>
                  <td style={td}>
                    {r.due_date}
                    {isOverdue(r.due_date) && r.net_gst_cents > 0 && <span style={{ marginLeft: 6, color: '#e9a3a3', fontSize: 11 }}>OVERDUE</span>}
                  </td>
                  <td style={tdRight}>{formatMoney(r.sales_ex_gst_cents)}</td>
                  <td style={tdRight}>{formatMoney(r.purchases_ex_gst_cents)}</td>
                  <td style={{ ...tdRight, color: '#86c7a3' }}>{formatMoney(r.gst_collected_cents)}</td>
                  <td style={{ ...tdRight, color: '#aaa' }}>{formatMoney(r.gst_paid_cents)}</td>
                  <td style={{ ...tdRight, color: r.net_gst_cents > 0 ? '#e9a3a3' : '#86c7a3', fontWeight: 600 }}>
                    {formatMoney(r.net_gst_cents)}
                  </td>
                  <td style={tdRight}>{renderCoverage(coverage.get(coverageKey(r.fy_start_year, r.quarter_num)))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p style={{ marginTop: 32, padding: 10, background: '#0e0e0e', border: '1px dashed #2a2a2a', borderRadius: 4, fontSize: 12, color: '#666' }}>
        Future: PAYG withholding rollup, ATO BAS file export, in-product e-lodgement (requires Standard Business Reporting), historical comparison charts.
      </p>
    </section>
  );
}

function renderCoverage(c: CoverageRow | undefined) {
  if (!c || c.bills_in_scope === 0) return <span style={{ color: '#555', fontSize: 11 }}>—</span>;
  const colour = c.gst_ready ? '#86c7a3' : '#e9c46a';
  return (
    <span style={{ color: colour, fontSize: 12 }} title={`${c.bills_complete}/${c.bills_in_scope} bills with amount+GST${c.bills_gst_estimated > 0 ? ` · ${c.bills_gst_estimated} GST estimated` : ''}`}>
      {c.gst_ready ? '✓ ' : '⚠ '}{c.coverage_pct}%
    </span>
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

const th: React.CSSProperties = { padding: '0.4rem 0.5rem', textAlign: 'left', fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 500 };
const thRight: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '0.5rem' };
const tdRight: React.CSSProperties = { ...td, textAlign: 'right' };
const exportBtn: React.CSSProperties = { padding: '0.25rem 0.75rem', background: 'transparent', color: '#86c7a3', border: '1px solid #2da565', borderRadius: 4, fontSize: 12, cursor: 'pointer' };
