import { useEffect, useState, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { formatMoney } from '@/lib/money';
import { downloadCsv } from '@/lib/csv';
import { SkeletonTable } from '@/components/Skeleton';

interface BalanceSheetRow {
  organization_id: string;
  as_of_date: string;
  category: 'asset' | 'liability' | 'equity';
  line_item: string;
  amount_cents: number;
}

export function BalanceSheetPage() {
  const { currentOrg } = useOrg();
  const [rows, setRows] = useState<BalanceSheetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [asOfDate, setAsOfDate] = useState<string>(() => new Date().toISOString().slice(0, 10));

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    setError(null);
    // The view evaluates "as of CURRENT_DATE" server-side — the picker is
    // descriptive in v1; future improvement is a parameterised SECURITY DEFINER
    // function that takes a date arg.
    const { data, error: e } = await supabase
      .from('v_balance_sheet')
      .select('*')
      .eq('organization_id', currentOrg.id);
    if (e) setError(e.message);
    setRows((data ?? []) as BalanceSheetRow[]);
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => void refresh(), [refresh]);

  const { assets, liabilities, equity, totalAssets, totalLiabilities, netEquity } = useMemo(() => {
    const assets = rows.filter((r) => r.category === 'asset');
    const liabilities = rows.filter((r) => r.category === 'liability');
    const equity = rows.filter((r) => r.category === 'equity');
    const totalAssets = assets.reduce((acc, r) => acc + Number(r.amount_cents ?? 0), 0);
    const totalLiabilities = liabilities.reduce((acc, r) => acc + Number(r.amount_cents ?? 0), 0);
    const netEquity = totalAssets - totalLiabilities;
    return { assets, liabilities, equity, totalAssets, totalLiabilities, netEquity };
  }, [rows]);

  const handleExport = () => {
    if (rows.length === 0) return;
    const filename = `balance-sheet-${asOfDate}.csv`;
    const exportRows = rows.map((r) => ({
      'As of': r.as_of_date,
      Category: r.category,
      'Line item': r.line_item,
      'Amount (AUD)': (Number(r.amount_cents) / 100).toFixed(2),
    }));
    // Append totals
    exportRows.push({
      'As of': asOfDate,
      Category: 'asset',
      'Line item': 'TOTAL ASSETS',
      'Amount (AUD)': (totalAssets / 100).toFixed(2),
    });
    exportRows.push({
      'As of': asOfDate,
      Category: 'liability',
      'Line item': 'TOTAL LIABILITIES',
      'Amount (AUD)': (totalLiabilities / 100).toFixed(2),
    });
    exportRows.push({
      'As of': asOfDate,
      Category: 'equity',
      'Line item': 'NET EQUITY',
      'Amount (AUD)': (netEquity / 100).toFixed(2),
    });
    downloadCsv(filename, exportRows);
  };

  if (!currentOrg) return null;

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <Link to="/reports" style={{ color: '#86c7a3', fontSize: 13 }}>&larr; Reports</Link>
        {rows.length > 0 && (
          <button onClick={handleExport} style={exportBtn} aria-label="Export balance sheet as CSV">
            &#8659; Export CSV
          </button>
        )}
      </div>

      <h1 style={{ marginTop: '0.5rem' }}>Balance sheet</h1>
      <p style={{ color: '#888', fontSize: 13, maxWidth: 720 }}>
        Snapshot of what the business owns vs owes. Approximation — unsettled GST and current-quarter GST collected
        are based on bills/invoices, not a true general-ledger journal. Personal-flagged bills and debts are excluded.
      </p>

      {/* Date picker (descriptive in v1) */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 12, color: '#888' }}>
          As of:&nbsp;
          <input
            type="date"
            value={asOfDate}
            onChange={(e) => setAsOfDate(e.target.value)}
            style={{
              background: '#1a1a1a',
              color: '#ddd',
              border: '1px solid #2a2a2a',
              borderRadius: 4,
              padding: '0.25rem 0.4rem',
              fontSize: 12,
            }}
          />
        </label>
        <span style={{ fontSize: 11, color: '#666' }}>(view currently always reflects today; historical as-of coming soon)</span>
      </div>

      {/* Net worth headline */}
      <div
        style={{
          marginTop: 20,
          padding: 20,
          background: '#0e0e0e',
          border: '1px solid #2a2a2a',
          borderRadius: 6,
          display: 'flex',
          gap: 24,
          flexWrap: 'wrap',
          alignItems: 'baseline',
        }}
      >
        <div>
          <div style={{ fontSize: 11, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Net worth (assets &minus; liabilities)
          </div>
          <div
            style={{
              marginTop: 6,
              fontSize: 32,
              fontWeight: 700,
              color: netEquity >= 0 ? '#86c7a3' : '#e9a3a3',
            }}
          >
            {formatMoney(netEquity)}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 16, marginLeft: 'auto' }}>
          <Mini label="Total assets" value={formatMoney(totalAssets)} colour="#86c7a3" />
          <Mini label="Total liabilities" value={formatMoney(totalLiabilities)} colour="#e9a3a3" />
        </div>
      </div>

      {loading ? (
        <div style={{ marginTop: 16 }}>
          <SkeletonTable rows={4} cols={3} />
        </div>
      ) : error ? (
        <p style={{ color: 'salmon', marginTop: 16 }}>{error}</p>
      ) : rows.length === 0 ? (
        <div style={emptyBox}>
          No data yet. Add bank accounts, bills, invoices, and debts to populate the balance sheet.
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: 16,
            marginTop: 20,
          }}
        >
          <Column title="Assets" colour="#86c7a3" rows={assets} totalCents={totalAssets} />
          <Column title="Liabilities" colour="#e9a3a3" rows={liabilities} totalCents={totalLiabilities} />
          <Column
            title="Equity"
            colour={netEquity >= 0 ? '#86c7a3' : '#e9a3a3'}
            rows={equity.length > 0 ? equity : [{
              organization_id: currentOrg.id,
              as_of_date: asOfDate,
              category: 'equity' as const,
              line_item: 'Net equity (assets − liabilities)',
              amount_cents: netEquity,
            }]}
            totalCents={netEquity}
          />
        </div>
      )}

      <p style={{ marginTop: 32, padding: 10, background: '#0e0e0e', border: '1px dashed #2a2a2a', borderRadius: 4, fontSize: 12, color: '#666' }}>
        Future: true general-ledger schema (journal entries + chart of accounts), historical as-of-date snapshots, depreciation schedules, retained-earnings vs current-period equity split.
      </p>
    </section>
  );
}

function Column({
  title,
  colour,
  rows,
  totalCents,
}: {
  title: string;
  colour: string;
  rows: BalanceSheetRow[];
  totalCents: number;
}) {
  return (
    <div
      style={{
        padding: 16,
        background: '#1a1a1a',
        border: '1px solid #2a2a2a',
        borderRadius: 6,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <h2 style={{ fontSize: 13, margin: 0, color: colour, textTransform: 'uppercase', letterSpacing: 0.5 }}>{title}</h2>
      <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0 0', flex: 1 }}>
        {rows.length === 0 ? (
          <li style={{ fontSize: 12, color: '#666', padding: '6px 0' }}>—</li>
        ) : (
          rows.map((r, i) => (
            <li
              key={`${r.line_item}-${i}`}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 8,
                fontSize: 13,
                padding: '6px 0',
                borderBottom: '1px dotted #2a2a2a',
              }}
            >
              <span style={{ color: '#ddd' }}>{r.line_item}</span>
              <span style={{ color: '#aaa', fontVariantNumeric: 'tabular-nums' }}>
                {formatMoney(Number(r.amount_cents))}
              </span>
            </li>
          ))
        )}
      </ul>
      <div
        style={{
          marginTop: 12,
          paddingTop: 10,
          borderTop: '1px solid #2a2a2a',
          display: 'flex',
          justifyContent: 'space-between',
          fontWeight: 600,
          fontSize: 14,
        }}
      >
        <span style={{ color: '#fff' }}>Total</span>
        <span style={{ color: colour, fontVariantNumeric: 'tabular-nums' }}>{formatMoney(totalCents)}</span>
      </div>
    </div>
  );
}

function Mini({ label, value, colour }: { label: string; value: string; colour: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ marginTop: 4, fontSize: 16, color: colour, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

const exportBtn: React.CSSProperties = {
  padding: '0.25rem 0.75rem',
  background: 'transparent',
  color: '#86c7a3',
  border: '1px solid #2da565',
  borderRadius: 4,
  fontSize: 12,
  cursor: 'pointer',
};
const emptyBox: React.CSSProperties = {
  marginTop: 24,
  padding: 16,
  background: '#0e0e0e',
  border: '1px dashed #2a2a2a',
  borderRadius: 4,
  color: '#888',
  fontSize: 13,
};
