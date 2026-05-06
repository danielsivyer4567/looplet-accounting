import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';
import { formatMoney } from '@/lib/money';
import { downloadCsv } from '@/lib/csv';
import { SkeletonTable } from '@/components/Skeleton';

interface FlowRow {
  week_start: string;
  source_type: 'invoice' | 'bill';
  amount_cents: number;
}

interface AggRow {
  week_start: string;
  inflow: number;
  outflow: number;
  net: number;
}

export function CashFlowPage() {
  const { currentOrg } = useOrg();
  const [rows, setRows] = useState<AggRow[]>([]);
  const [openingBalance, setOpeningBalance] = useState(0);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);

    const [flowRes, bankRes] = await Promise.all([
      supabase
        .from('v_cash_flow_weekly')
        .select('*')
        .eq('organization_id', currentOrg.id)
        .order('week_start', { ascending: true }),
      supabase
        .from('bank_accounts')
        .select('current_balance_cents')
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null),
    ]);

    // Sum all active bank account balances for this org
    const opening = ((bankRes.data ?? []) as { current_balance_cents: number | null }[])
      .reduce((sum, acct) => sum + (acct.current_balance_cents ?? 0), 0);
    setOpeningBalance(opening);

    const agg = new Map<string, AggRow>();
    for (const r of (flowRes.data ?? []) as FlowRow[]) {
      const cur = agg.get(r.week_start) ?? { week_start: r.week_start, inflow: 0, outflow: 0, net: 0 };
      if (r.source_type === 'invoice') cur.inflow += r.amount_cents;
      else cur.outflow += Math.abs(r.amount_cents);
      cur.net = cur.inflow - cur.outflow;
      agg.set(r.week_start, cur);
    }
    const sorted = Array.from(agg.values()).sort((a, b) => a.week_start.localeCompare(b.week_start));

    // Running balance seeded from opening (sum of bank account balances)
    let running = opening;
    const withRunning = sorted.map((r) => {
      running += r.net;
      return { ...r, running };
    });
    setRows(withRunning);
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => void refresh(), [refresh]);

  if (!currentOrg) return null;

  const totalIn = rows.reduce((a, r) => a + r.inflow, 0);
  const totalOut = rows.reduce((a, r) => a + r.outflow, 0);
  const finalRunning = rows.length > 0 ? (rows[rows.length - 1] as AggRow & { running: number }).running : openingBalance;
  const max = Math.max(...rows.map((r) => Math.max(r.inflow, r.outflow)), 1);

  const handleExport = () => {
    if (rows.length === 0) return;
    // ISO week number helper (YYYY-Www)
    const firstWeek = rows[0].week_start.replace(/-/g, '').slice(0, 6);
    const lastWeek = rows[rows.length - 1].week_start.replace(/-/g, '').slice(0, 6);
    const filename = `cash-flow-${firstWeek}-to-${lastWeek}.csv`;
    const exportRows = rows.map((r) => ({
      'Week start': r.week_start,
      'Inflow (AUD)': (r.inflow / 100).toFixed(2),
      'Outflow (AUD)': (r.outflow / 100).toFixed(2),
      'Net (AUD)': (r.net / 100).toFixed(2),
      'Running balance (AUD)': ((r as Record<string, unknown>).running as number / 100).toFixed(2),
    }));
    downloadCsv(filename, exportRows);
  };

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <Link to="/reports" style={{ color: '#86c7a3', fontSize: 13 }}>&larr; Reports</Link>
        {rows.length > 0 && (
          <button onClick={handleExport} style={exportBtn} aria-label="Export cash flow data as CSV">
            &#8659; Export CSV
          </button>
        )}
      </div>
      <h1 style={{ marginTop: '0.5rem' }}>Cash flow forecast</h1>
      <p style={{ color: '#888', fontSize: 13 }}>
        Weekly buckets of unpaid invoices (expected receipts) and unpaid bills (expected payments).
        Personal-flagged bills excluded.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, maxWidth: 1100, marginTop: 16 }}>
        <Kpi label="Opening balance" value={formatMoney(openingBalance)} colour={openingBalance >= 0 ? '#aaa' : '#e9a3a3'} />
        <Kpi label="Expected receipts" value={formatMoney(totalIn)} colour="#86c7a3" />
        <Kpi label="Expected payments" value={formatMoney(totalOut)} colour="#e9a3a3" />
        <Kpi label="Projected closing" value={formatMoney(finalRunning)} colour={finalRunning >= 0 ? '#86c7a3' : '#e9a3a3'} />
      </div>

      {loading ? (
        <div style={{ marginTop: 16 }}>
          <SkeletonTable rows={6} cols={6} />
        </div>
      ) : rows.length === 0 ? (
        <div style={{ marginTop: 24, padding: 16, background: '#0e0e0e', border: '1px dashed #2a2a2a', borderRadius: 4, color: '#888', fontSize: 13 }}>
          Nothing committed yet. As invoices land and bills arrive (with due dates), the forecast populates.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 16 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
                <th style={th}>Week starting</th>
                <th style={thRight}>Inflow (invoices)</th>
                <th style={thRight}>Outflow (bills)</th>
                <th style={thRight}>Net</th>
                <th style={thRight}>Running</th>
                <th style={th}>Distribution</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const inWidth = (r.inflow / max) * 120;
                const outWidth = (r.outflow / max) * 120;
                return (
                  <tr key={r.week_start} style={{ borderBottom: '1px solid #1a1a1a' }}>
                    <td style={td}>{r.week_start}</td>
                    <td style={{ ...tdRight, color: '#86c7a3' }}>{r.inflow > 0 ? formatMoney(r.inflow) : '—'}</td>
                    <td style={{ ...tdRight, color: '#e9a3a3' }}>{r.outflow > 0 ? formatMoney(-r.outflow) : '—'}</td>
                    <td style={{ ...tdRight, color: r.net >= 0 ? '#86c7a3' : '#e9a3a3', fontWeight: 600 }}>{formatMoney(r.net)}</td>
                    <td style={{ ...tdRight, color: (r as any).running >= 0 ? '#aaa' : '#e9a3a3' }}>{formatMoney((r as any).running)}</td>
                    <td style={td}>
                      <div style={{ display: 'flex', alignItems: 'center', height: 16 }}>
                        <div style={{ width: inWidth, height: 8, background: '#2da565', marginRight: 2 }} />
                        <div style={{ width: outWidth, height: 8, background: '#a52d2d' }} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ marginTop: 32, padding: 10, background: '#0e0e0e', border: '1px dashed #2a2a2a', borderRadius: 4, fontSize: 12, color: '#666' }}>
        Future: payment-pattern smoothing (avg days late), scenario modelling (what-if X invoice paid late).
      </p>
    </section>
  );
}

function Kpi({ label, value, colour }: { label: string; value: string; colour: string }) {
  return (
    <div style={{ padding: 12, background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 6 }}>
      <div style={{ fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ marginTop: 4, fontSize: 18, color: colour, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

const th: React.CSSProperties = { padding: '0.4rem 0.5rem', textAlign: 'left', fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 500 };
const thRight: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '0.5rem' };
const tdRight: React.CSSProperties = { ...td, textAlign: 'right' };
const exportBtn: React.CSSProperties = { padding: '0.25rem 0.75rem', background: 'transparent', color: '#86c7a3', border: '1px solid #2da565', borderRadius: 4, fontSize: 12, cursor: 'pointer' };
