import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';
import { formatMoney } from '@/lib/money';

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

const QUARTER_NAMES = ['', 'Q1 (Jul-Sep)', 'Q2 (Oct-Dec)', 'Q3 (Jan-Mar)', 'Q4 (Apr-Jun)'];

export function BasReportPage() {
  const { currentOrg } = useOrg();
  const [rows, setRows] = useState<BasRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    const { data, error: e } = await supabase
      .from('v_bas_quarterly')
      .select('*')
      .eq('organization_id', currentOrg.id)
      .order('fy_start_year', { ascending: false })
      .order('quarter_num', { ascending: false });
    if (e) setError(e.message);
    setRows((data ?? []) as BasRow[]);
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => void refresh(), [refresh]);

  if (!currentOrg) return null;

  const today = new Date();
  const isOverdue = (due: string) => new Date(due) < today;

  const totalNet = rows.reduce((a, r) => a + r.net_gst_cents, 0);
  const totalSales = rows.reduce((a, r) => a + r.sales_ex_gst_cents, 0);
  const totalPurchases = rows.reduce((a, r) => a + r.purchases_ex_gst_cents, 0);

  return (
    <section>
      <Link to="/reports" style={{ color: '#86c7a3', fontSize: 13 }}>&larr; Reports</Link>
      <h1 style={{ marginTop: '0.5rem' }}>BAS quarterly</h1>
      <p style={{ color: '#888', fontSize: 13 }}>
        GST collected from sales (invoices) minus GST paid on purchases (bills).
        Personal-flagged bills are excluded. Due 28 days after each quarter end.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, maxWidth: 900, marginTop: 16 }}>
        <Kpi label="Net GST (lifetime)" value={formatMoney(totalNet)} colour={totalNet > 0 ? '#e9a3a3' : '#86c7a3'} sub={totalNet > 0 ? 'owed to ATO' : 'refundable'} />
        <Kpi label="Total sales ex GST" value={formatMoney(totalSales)} colour="#86c7a3" />
        <Kpi label="Total purchases ex GST" value={formatMoney(totalPurchases)} colour="#aaa" />
      </div>

      {loading ? (
        <p style={{ color: '#888', marginTop: 16 }}>Loading…</p>
      ) : error ? (
        <p style={{ color: 'salmon', marginTop: 16 }}>{error}</p>
      ) : rows.length === 0 ? (
        <div style={{ marginTop: 24, padding: 16, background: '#0e0e0e', border: '1px dashed #2a2a2a', borderRadius: 4, color: '#888', fontSize: 13 }}>
          No data yet. Issue some invoices and process some bills to start a BAS rollup.
        </div>
      ) : (
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
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p style={{ marginTop: 32, padding: 10, background: '#0e0e0e', border: '1px dashed #2a2a2a', borderRadius: 4, fontSize: 12, color: '#666' }}>
        Future: PAYG withholding rollup, ATO BAS file export, in-product e-lodgement (requires Standard Business Reporting), historical comparison charts.
      </p>
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

const th: React.CSSProperties = { padding: '0.4rem 0.5rem', textAlign: 'left', fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 500 };
const thRight: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '0.5rem' };
const tdRight: React.CSSProperties = { ...td, textAlign: 'right' };
