import { useNavigate } from 'react-router-dom';
import { useOrg } from '@/hooks/useOrg';
import { useSuppliers } from '@/hooks/useSuppliers';
import { formatMoney, formatMoneyCompact } from '@/lib/money';
import { SkeletonTable } from '@/components/Skeleton';
import { Truck, BarChart } from 'lucide-react';

interface BarChartProps {
  items: { label: string; value: number }[];
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
              fill="var(--text-body)"
              fontSize={12}
              fontFamily="var(--font-sans)"
            >
              {item.label.length > 22 ? item.label.slice(0, 20) + '…' : item.label}
            </text>
            {/* track */}
            <rect x={LABEL_W} y={y} width={BAR_W} height={BAR_HEIGHT} fill="var(--bg-app)" rx={4} />
            {/* fill */}
            <rect x={LABEL_W} y={y} width={barWidth} height={BAR_HEIGHT} fill="var(--accent-primary)" rx={4} />
            {/* value */}
            <text
              x={LABEL_W + BAR_W + 8}
              y={y + BAR_HEIGHT / 2 + 1}
              dominantBaseline="middle"
              fill="var(--text-title)"
              fontSize={12}
              fontWeight={700}
              fontFamily="var(--font-sans)"
            >
              {formatMoneyCompact(item.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function SuppliersPage() {
  const { currentOrg } = useOrg();
  const { suppliers, spendMap, loading, error } = useSuppliers();
  const navigate = useNavigate();

  if (!currentOrg) {
    return (
      <section className="animated-fade-in">
        <h1>Suppliers</h1>
        <p style={{ color: 'var(--text-muted)' }}>Pick an organisation to see suppliers.</p>
      </section>
    );
  }

  const totalSpend = Array.from(spendMap.values()).reduce((a, b) => a + b, 0);

  const top5 = suppliers
    .map((s) => ({ label: s.name, value: spendMap.get(s.id) ?? 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
  const chartMax = top5[0]?.value ?? 0;

  return (
    <section className="animated-fade-in">
      {/* Header section */}
      <div 
        style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center', 
          marginBottom: '1.5rem',
          flexWrap: 'wrap',
          gap: '1rem'
        }}
      >
        <h1 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Truck size={24} style={{ color: 'var(--accent-primary)' }} />
          Suppliers
        </h1>
        {!loading && (
          <div className="badge badge-neutral" style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', display: 'flex', gap: '0.35rem', alignItems: 'center', textTransform: 'none' }}>
            <span>{suppliers.length} suppliers</span>
            <span>·</span>
            <span style={{ color: 'var(--text-success)', fontWeight: 'bold' }}>{formatMoney(totalSpend)} spend</span>
          </div>
        )}
      </div>

      {/* Top 5 spend SVG chart */}
      {!loading && !error && top5.length > 0 && (
        <div
          className="card"
          style={{
            marginBottom: '2.5rem',
            padding: '1.25rem 1.5rem',
            display: 'inline-block',
            maxWidth: '100%',
            overflowX: 'auto'
          }}
        >
          <div 
            style={{ 
              fontSize: '0.725rem', 
              color: 'var(--text-muted)', 
              textTransform: 'uppercase', 
              letterSpacing: '0.05em', 
              marginBottom: '1rem',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: '0.25rem'
            }}
          >
            <BarChart size={14} style={{ color: 'var(--accent-primary)' }} />
            Top 5 Suppliers by Spend YTD
          </div>
          <HorizontalBarChart items={top5} max={chartMax} />
        </div>
      )}

      {loading ? (
        <SkeletonTable rows={5} cols={7} />
      ) : error ? (
        <div className="badge badge-danger" style={{ display: 'block', padding: '0.75rem', textTransform: 'none' }}>Failed to load: {error}</div>
      ) : suppliers.length === 0 ? (
        <div 
          style={{ 
            padding: '2.5rem', 
            background: 'var(--bg-card)', 
            border: '1px dashed var(--border-subtle)', 
            borderRadius: 'var(--radius-md)', 
            color: 'var(--text-muted)', 
            textAlign: 'center',
            fontSize: '0.9rem' 
          }}
        >
          No suppliers found for {currentOrg.name}.
        </div>
      ) : (
        <div className="table-premium-container">
          <table className="table-premium">
            <thead>
              <tr>
                <th>Name</th>
                <th>ABN</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Account Code</th>
                <th style={{ textAlign: 'right' }}>Balance Owing</th>
                <th style={{ textAlign: 'right' }}>Total Spend</th>
              </tr>
            </thead>
            <tbody>
              {suppliers.map((s) => (
                <tr
                  key={s.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => navigate(`/suppliers/${s.id}`)}
                >
                  <td style={{ fontWeight: 600, color: 'var(--text-title)' }}>{s.name}</td>
                  <td>
                    {s.abn ? (
                      <code>{s.abn}</code>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>—</span>
                    )}
                  </td>
                  <td>
                    {s.email ? (
                      <span style={{ fontSize: '0.875rem' }}>{s.email}</span>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>—</span>
                    )}
                  </td>
                  <td>
                    {s.contact_phone ? (
                      <span style={{ fontSize: '0.875rem' }}>{s.contact_phone}</span>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>—</span>
                    )}
                  </td>
                  <td>
                    {s.default_account_code ? (
                      <span className="badge badge-neutral" style={{ fontSize: '11px', fontFamily: 'ui-monospace, monospace' }}>
                        {s.default_account_code}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>—</span>
                    )}
                  </td>
                  <td style={{ 
                    textAlign: 'right',
                    fontWeight: 600,
                    color: s.current_balance_owing_cents && s.current_balance_owing_cents > 0 ? 'var(--text-danger)' : 'var(--text-body)'
                  }}>
                    {s.current_balance_owing_cents != null ? (
                      formatMoney(s.current_balance_owing_cents)
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>—</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', color: 'var(--accent-primary)', fontWeight: 600 }}>
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
