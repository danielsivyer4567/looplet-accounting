import { useNavigate } from 'react-router-dom';
import { useOrg } from '@/contexts/OrgContext';
import { useSuppliers } from '@/hooks/useSuppliers';
import { formatMoney, formatMoneyCompact } from '@/lib/money';
import { SkeletonTable } from '@/components/Skeleton';

// ---------------------------------------------------------------------------
// Top-5 horizontal bar chart (dependency-free inline SVG)
// ---------------------------------------------------------------------------

interface BarChartProps {
  items: Array<{ label: string; value: number }>;
  max: number;
}

function HorizontalBarChart({ items, max }: BarChartProps) {
  const BAR_HEIGHT = 22;
  const LABEL_W = 160;
  const VALUE_W = 80;
  const BAR_W = 260;
  const ROW_GAP = 10;
  const totalHeight = items.length * (BAR_HEIGHT + ROW_GAP);

  return (
    <svg
      width={LABEL_W + BAR_W + VALUE_W + 16}
      height={totalHeight}
      role="img"
      aria-label="Top 5 suppliers by spend"
    >
      {items.map((item, i) => {
        const y = i * (BAR_HEIGHT + ROW_GAP);
        const barWidth = max > 0 ? (item.value / max) * BAR_W : 0;
        return (
          <g key={item.label}>
            {/* supplier name */}
            <text
              x={LABEL_W - 8}
              y={y + BAR_HEIGHT / 2 + 1}
              textAnchor="end"
              dominantBaseline="middle"
              fill="#aaa"
              fontSize={12}
            >
              {item.label.length > 22 ? item.label.slice(0, 20) + '…' : item.label}
            </text>
            {/* track */}
            <rect x={LABEL_W} y={y} width={BAR_W} height={BAR_HEIGHT} fill="#2a2a2a" rx={3} />
            {/* fill */}
            <rect x={LABEL_W} y={y} width={barWidth} height={BAR_HEIGHT} fill="#2da565" rx={3} />
            {/* value */}
            <text
              x={LABEL_W + BAR_W + 8}
              y={y + BAR_HEIGHT / 2 + 1}
              dominantBaseline="middle"
              fill="#86c7a3"
              fontSize={12}
              fontWeight={600}
            >
              {formatMoneyCompact(item.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SuppliersPage() {
  const { currentOrg } = useOrg();
  const { suppliers, spendMap, loading, error } = useSuppliers();
  const navigate = useNavigate();

  if (!currentOrg) {
    return (
      <section>
        <h1>Suppliers</h1>
        <p style={{ color: '#888' }}>Pick an organisation to see suppliers.</p>
      </section>
    );
  }

  const totalSpend = Array.from(spendMap.values()).reduce((a, b) => a + b, 0);

  // Top 5 by spend for chart
  const top5 = suppliers
    .map((s) => ({ label: s.name, value: spendMap.get(s.id) ?? 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
  const chartMax = top5[0]?.value ?? 0;

  return (
    <section>
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.5rem' }}>
        <h1 style={{ margin: 0 }}>Suppliers</h1>
        {!loading && (
          <span style={{ color: '#888', fontSize: 13 }}>
            {suppliers.length} supplier{suppliers.length !== 1 ? 's' : ''} &middot;{' '}
            <span style={{ color: '#86c7a3' }}>{formatMoney(totalSpend)}</span> total spend
          </span>
        )}
      </div>

      {/* Top-5 chart */}
      {!loading && !error && top5.length > 0 && (
        <div
          style={{
            background: '#1a1a1a',
            border: '1px solid #2a2a2a',
            borderRadius: 6,
            padding: '1.25rem 1.5rem',
            marginTop: '1rem',
            marginBottom: '1.5rem',
            display: 'inline-block',
          }}
        >
          <div style={{ fontSize: 11, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: '0.75rem' }}>
            Top 5 by spend
          </div>
          <HorizontalBarChart items={top5} max={chartMax} />
        </div>
      )}

      {loading ? (
        <SkeletonTable rows={5} cols={7} />
      ) : error ? (
        <p style={{ color: 'salmon' }}>Failed to load: {error}</p>
      ) : suppliers.length === 0 ? (
        <p style={{ color: '#888' }}>No suppliers found for {currentOrg.name}.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
                <th style={th}>Name</th>
                <th style={th}>ABN</th>
                <th style={th}>Email</th>
                <th style={th}>Phone</th>
                <th style={th}>Account code</th>
                <th style={thRight}>Balance owing</th>
                <th style={thRight}>Total spend</th>
              </tr>
            </thead>
            <tbody>
              {suppliers.map((s) => (
                <tr
                  key={s.id}
                  style={{ borderBottom: '1px solid #1a1a1a', cursor: 'pointer' }}
                  onClick={() => void navigate(`/suppliers/${s.id}`)}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLTableRowElement).style.background = '#202020';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLTableRowElement).style.background = '';
                  }}
                >
                  <td style={{ ...td, fontWeight: 500 }}>{s.name}</td>
                  <td style={td}>
                    {s.abn ? (
                      <code style={{ color: '#888', fontSize: 12 }}>{s.abn}</code>
                    ) : (
                      <span style={{ color: '#444' }}>—</span>
                    )}
                  </td>
                  <td style={td}>
                    {s.email ? (
                      <span style={{ color: '#aaa', fontSize: 13 }}>{s.email}</span>
                    ) : (
                      <span style={{ color: '#444' }}>—</span>
                    )}
                  </td>
                  <td style={td}>
                    {s.contact_phone ? (
                      <span style={{ color: '#aaa', fontSize: 13 }}>{s.contact_phone}</span>
                    ) : (
                      <span style={{ color: '#444' }}>—</span>
                    )}
                  </td>
                  <td style={td}>
                    {s.default_account_code ? (
                      <code style={{ color: '#d2c886', fontSize: 12 }}>{s.default_account_code}</code>
                    ) : (
                      <span style={{ color: '#444' }}>—</span>
                    )}
                  </td>
                  <td style={tdRight}>
                    {s.current_balance_owing_cents != null ? (
                      <span style={{ color: s.current_balance_owing_cents > 0 ? '#e9a3a3' : '#aaa' }}>
                        {formatMoney(s.current_balance_owing_cents)}
                      </span>
                    ) : (
                      <span style={{ color: '#444' }}>—</span>
                    )}
                  </td>
                  <td style={{ ...tdRight, color: '#86c7a3', fontWeight: 500 }}>
                    {formatMoney(spendMap.get(s.id) ?? 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const th: React.CSSProperties = {
  padding: '0.5rem 0.75rem',
  textAlign: 'left',
  fontSize: 12,
  color: '#888',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  fontWeight: 500,
};
const thRight: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '0.65rem 0.75rem' };
const tdRight: React.CSSProperties = { ...td, textAlign: 'right' };
